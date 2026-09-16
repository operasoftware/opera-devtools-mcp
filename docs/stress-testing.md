# Stress testing the process lifecycle

`tests/stress/` drives real failures against the `opera-browser-cli` daemon: it
kills daemons, MCP servers, browsers and browsers' helper processes, feeds the
daemon malformed socket input, and asserts after every scenario that **no
process was left behind** and that the session **recovered on its own**.

The scenarios, what each one proves, and the current pass/fail expectation are in
[`docs/specs/stress-test-system-plan.md`](./specs/stress-test-system-plan.md).

## Safety model

Read this before running anything outside a container.

- **Only processes this run started are ever signalled.** Every session is
  launched with `--chrome-arg=--stress-session-tag=<sessionId>`, which lands in
  the daemon's, MCP server's and browser's command line. The harness resolves
  what belongs to a session from that marker (plus the descendant tree), and
  refuses to signal anything else — a stray `killProcess` on an unrelated pid
  throws instead of killing it.
- **Signalling is additionally gated** behind `STRESS_ALLOW_PROCESS_KILLS=true`.
  Without it every destructive scenario **skips** (fast, spawning nothing), which
  is why a plain `npm test` is unaffected.
- **Run it in the container by default.** It is disposable: a leaked daemon,
  orphaned browser or exhausted fd table cannot outlive it.
- On a machine with a real Opera/Chrome session, the container is not just
  convenient but safer: the suite's non-isolated scenarios create their own
  profile directories, but only inside the container/throwaway `HOME`.

## Run it locally (Docker)

```sh
npm run test:stress:docker 2>&1 | tee stress-run.log
echo "exit=$?"
```

Both stress variables are read from your shell, so a one-off run needs no edit to
any file:

```sh
STRESS_ITERATIONS=10 STRESS_CHROME_ARGS=--no-sandbox npm run test:stress:docker
```

That script does three things, in order: builds the compiled suite on the host
(`npm run build` — the image ships `build/` rather than compiling it), resolves a
Docker frontend, then runs the container.

It picks the frontend in this order, so it works whether or not the `compose`
CLI plugin is installed:

1. `docker compose -f tests/stress/docker/docker-compose.yml up --build …`
2. `docker-compose -f tests/stress/docker/docker-compose.yml up --build …`
3. `docker build` + `docker run` with equivalent flags

Steps 1 and 2 get the variables through compose's interpolation
(`${STRESS_ITERATIONS:-3}`, `${STRESS_CHROME_ARGS:-}` in the compose file); step
3 has no compose, so the script forwards them to `docker run` itself. An unset or
empty `STRESS_ITERATIONS` means 3 on both paths.

Prerequisites: a **running Docker daemon** (`docker info` must print server
info). On macOS with colima: `colima start`.

### Reading the result

A green run is one line per scenario per round and a table with no failures:

```
[stress] round 1/3 A1 pass 2939ms
…
stress runner: 12 scenarios x 3 rounds

scenario  passes  failures  skipped
A1        3       0         0
…
```

**Exit code 0 means every scenario asserted the robustness property.** That is
the state now, after the supervision work (`STRESS_TEST_ROBUSTNESS_PLAN.md`) and
the page-recovery change (`docs/specs/browser-session-recovery.md`). A red run
prints the failures in the same shape, and the messages are the bug report — a
defect reads like this:

```
documented defects reproduced (1):
  round 1 A1 (12860ms): A1 round 1/3: daemon 1234 survived the restart and is now an invisible orphan; …
```

- A scenario that fails is **not repeated** in later rounds — its defect is
  deterministic, and repeating it would only re-buy the same failure at the cost
  of its timeouts. Passing scenarios _are_ repeated, which is what catches
  flakiness.
- `STRESS_ITERATIONS` (compose sets `3`, the runner's default is `20`) controls
  rounds. Now that the suite is green, raise it for flakiness hunting: 20 rounds
  is ~25 minutes, one pass is ~3 minutes.

### Manual run, without the wrapper

```sh
npm run build
docker build -f tests/stress/docker/Dockerfile -t opera-devtools-stress .
docker run --rm --init --tmpfs /tmp --security-opt seccomp=unconfined \
  -e STRESS_ITERATIONS=3 opera-devtools-stress 2>&1 | tee stress-run.log
```

`--tmpfs /tmp` and the container's throwaway `HOME` are what keep pid files,
sockets and browser profiles from touching the host.

`--init` is not optional. The daemon under test is `detached: true`, so it is
re-parented to pid 1 as soon as the CLI that started it exits. Without a
reaping pid 1 (tini, which `--init` provides) an exited daemon stays in the
process table as a zombie, and `process.kill(pid, 0)` — the liveness check the
suite _and_ the product use — reports a zombie as alive: A1 would report a
reaped daemon as a surviving orphan, and E2 would report that the daemon
"survived SIGKILL". The container would then be measuring itself.

## Run it locally (no Docker)

POSIX only, and it needs a shell that can bind a Unix socket in `/tmp` — a
hardened/sandboxed environment may refuse (`listen EPERM`), in which case the
daemon cannot start at all and no scenario can run.

```sh
npm run build
npm run test:stress 2>&1 | tee stress-run.log   # sets STRESS_ALLOW_PROCESS_KILLS=true
```

Narrower runs, useful while iterating:

```sh
# one scenario family
STRESS_ALLOW_PROCESS_KILLS=true node --import ./build/tests/setup.js \
  --test --test-force-exit --test-timeout=120000 build/tests/stress/daemon-orphan.test.js

# one pass of everything
STRESS_ALLOW_PROCESS_KILLS=true STRESS_ITERATIONS=1 node --import ./build/tests/setup.js \
  --test --test-force-exit --test-timeout=1800000 build/tests/stress/runner.test.js
```

## Deploy it on CI

A ready-to-use workflow ships at
[`.github/workflows/stress-test.yml`](../.github/workflows/stress-test.yml). It
is `workflow_dispatch`-only on purpose: the suite is red while the robustness
work is outstanding, so it never fires on a PR by accident.

Three things in the configuration keep it optional, and each one holds on its own:

1. **No automatic trigger.** The workflow's only event is `workflow_dispatch` —
   no `push`, `pull_request`, `merge_group` or `schedule` — so it cannot run
   because of a commit, a PR or the clock. The `schedule:`/`pull_request:` blocks
   are present but commented out, next to the note that says what to do about
   `continue-on-error` when you uncomment them.
2. **The run step is `continue-on-error: true`**, so even a manual run that
   reproduces every documented defect reports a green job; the outcome lands in
   the step summary and the uploaded `stress-run.log`. Delete that line when the
   scenarios pass to turn it into a hard gate.
3. **The interlock is pinned off in the required workflows.** `npm test` and
   `npm run test:no-build` do collect `build/tests/stress/**` (traced from
   `scripts/test.js`, which globs `build/tests/**/*.test.js`), and the scenarios
   skip unless `STRESS_ALLOW_PROCESS_KILLS` is exactly `true`. `ci.yml` and
   `run-tests.yml` now set it to `'false'` explicitly, so no runner-level
   variable can arm a process-killing suite inside a required check. Locally the
   same collection costs 12 skipped tests and ~0.5s.

`STRESS_ALLOW_PROCESS_KILLS=true` is set in exactly two places: the
`test:stress` npm script (an explicit local invocation) and the stress image's
`Dockerfile` (inside the throwaway container).

Enable it the way you need it:

- **On demand**: Actions → _Stress test (process lifecycle)_ → Run workflow. The
  form takes the two knobs the local path has: `iterations` (the input's own
  `default: '3'` is the single source of the count) and `chrome_args` — the
  escape hatch for a runner whose kernel blocks a sandbox feature the container's
  Chromium needs, i.e. `--no-sandbox`, without editing the workflow. It is
  forwarded as one `-e STRESS_CHROME_ARGS=…` value, so a multi-switch value stays
  intact.
- **Nightly**: uncomment the `schedule:` block. Neither of those triggers has
  dispatch `inputs`, so set `STRESS_ITERATIONS` to a literal in the run step's
  `env:` while you are there — empty means the runner's own default of 20 rounds.
- **On PRs**: uncomment the `pull_request:` block, and while the suite is still
  red keep `continue-on-error: true` on the run step (already set) so the job
  reports without blocking. Delete that line once the scenarios pass, and it
  becomes a hard gate.

Every action is pinned to a commit SHA with its version in a trailing comment,
the same way the required workflows pin theirs; `actions/checkout` and
`actions/setup-node` use the versions the rest of the repository already pins,
and the three Docker/artifact actions were pinned when they were introduced.

What the job needs, and why:

| Step                                                                                     | Why                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `actions/checkout` with `submodules: true`                                               | the host build compiles the vendored `third_party/devtools-frontend`                                                                                                                                                           |
| `actions/setup-node` (24) + `npm ci` with `PUPPETEER_SKIP_DOWNLOAD: true`                | the browser lives in the image, not on the runner                                                                                                                                                                              |
| `npm run build` with `NODE_OPTIONS=--max_old_space_size=4096`                            | a cold `tsc` over the DevTools sources needs more than Node's default heap — this is why the image ships `build/` instead of compiling it                                                                                      |
| `docker/setup-buildx-action` + `docker/build-push-action` with `cache-from/to: type=gha` | keeps the `apt`/`npm ci` layers warm between runs — the `actions: write` permission on the job exists for this cache write; with only `contents: read` BuildKit warns and skips it, so every dispatch would pay the full build |
| `docker run --init --tmpfs /tmp --security-opt seccomp=unconfined`                       | same isolation, init and Chromium sandbox settings the compose file uses — `--init` is what reaps the detached daemons the suite kills (see above)                                                                             |
| `actions/upload-artifact` on `stress-run.log`                                            | the report and the assertion messages are the useful output                                                                                                                                                                    |

Runtime: ~3 minutes for a red pass, plus a few minutes for the first image build.
`ubuntu-latest` runners have a working Docker daemon and the compose plugin, so
the container path is available there without extra setup.

The suite does **not** need privileged mode: it only signals processes of its own
user inside the container. If Chromium refuses to start in the container, add
`-e STRESS_CHROME_ARGS=--no-sandbox` rather than loosening the container itself.

## Reference

| Variable                     | Default             | Effect                                                                |
| ---------------------------- | ------------------- | --------------------------------------------------------------------- |
| `STRESS_ALLOW_PROCESS_KILLS` | unset               | `true` enables signalling; otherwise every destructive scenario skips |
| `STRESS_ITERATIONS`          | `20` (compose: `3`) | rounds of all scenarios                                               |
| `STRESS_CHROME_ARGS`         | unset               | extra Chrome switches for the launched browser, e.g. `--no-sandbox`   |

The Docker wrapper forwards `STRESS_ITERATIONS` and `STRESS_CHROME_ARGS` from
your shell into the container, whichever frontend it ends up using.

| File                                     | Purpose                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `tests/stress/helpers.ts`                | process-table harness: session markers, orphan scans, kill interlock, CLI runner |
| `tests/stress/scenarios.ts`              | all 12 scenarios                                                                 |
| `tests/stress/*.test.ts`                 | per-area `node:test` wrappers (run one family at a time)                         |
| `tests/stress/runner.test.ts`            | orchestrated loop, report and run-level leak check                               |
| `tests/stress/docker/Dockerfile`         | the disposable test image                                                        |
| `tests/stress/docker/docker-compose.yml` | image + isolation settings for local runs                                        |
| `scripts/stress-docker.js`               | builds the host output, resolves a compose frontend, runs it                     |

## Troubleshooting

| Symptom                                                                         | Cause and fix                                                                                                                                         |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unknown shorthand flag: 'f' in -f`                                             | `docker compose` plugin not installed. `npm run test:stress:docker` handles this (falls back to `docker-compose`, then to `docker build`/`run`)       |
| `failed to connect to the docker API … /var/run/docker.sock`                    | no Docker daemon. Start Docker Desktop, or `colima start` on macOS                                                                                    |
| `FATAL ERROR: Ineffective mark-compacts near heap limit` during the image build | an older image revision compiled inside the container. Current images copy the host-built `build/`; rebuild with the current Dockerfile               |
| `cannot connect to the Docker daemon` / image build uploads gigabytes           | missing `.dockerignore` — it prunes the context from ~2.3 GB to ~35 MB (`.git`, `node_modules`, `third_party`)                                        |
| `listen EPERM … server.sock`                                                    | the environment forbids binding Unix sockets, so no daemon can start. Run the suite in the container instead                                          |
| `cannot read the process table (\`ps …\` failed)`                               | `ps` is unavailable or blocked; orphan detection cannot work. The image installs `procps`                                                             |
| Chromium fails to launch in the container                                       | add `-e STRESS_CHROME_ARGS=--no-sandbox` to a manual `docker run`, or run the wrapper as `STRESS_CHROME_ARGS=--no-sandbox npm run test:stress:docker` |
| Every scenario skips with `STRESS_ALLOW_PROCESS_KILLS is not 'true'`            | expected outside the stress run — that is the interlock. Use `npm run test:stress` or the Docker path                                                 |
