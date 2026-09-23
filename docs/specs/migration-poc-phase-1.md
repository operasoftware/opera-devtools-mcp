# Migration PoC — Phase 1a: Internal CLI Binary + Environment Variable Surface + First-Run Autoconfiguration

**Status:** Implemented (Phase 1a + the first-run autoconfiguration slice of 1b), verified against the working tree.
**Author:** Senior Architect
**Date:** 2026-09-15
**Last reconciled with the tree:** 2026-09-16
**Parent analysis:** `~/work/specs/opera-browser-cli-drop-feasibility-analysis.md`

---

## 0. Reconciliation status

Checked against the tree on 2026-09-16, file by file:

- **Every "New" file in §3.1 and §5.1 exists**, and every file marked **Deleted**
  in §3.1 is gone (`src/bin/opera-devtools.ts`, `scripts/select-cli-name.ts`,
  `src/opera/cli-name.generated.ts`).
- **`docs/UPSTREAM.md` carries the registry rows** §3.4 asked for:
  `src/bin/opera-browser-cli.ts` together with `src/bin/opera-devtools-mcp.ts`,
  `src/opera/{envConfig,pageIdRouting,config,detect,profile}.ts`, and the
  `tests/opera/*` suites. `src/bin/opera-devtools-cli-options.ts` is still
  "Unchanged" as predicted.
- **`npm run verify-upstream-seam` passes** (`62 upstream file(s) diverge, all
registered`), so the seam bookkeeping this migration introduced is intact.
- **`tests/utils.ts` shows the §3.2 divergence** (`CLI_PATH` resolves
  `opera-browser-cli.js`; `createCliEnv()` strips `OPERA_CLI_*` and points `HOME`
  at a throwaway directory).

Three gaps, all recorded rather than silently absorbed:

1. **`docs/architecture.md` was never written.** §3.1 lists it as a new
   Opera-owned document; it is absent from the tree, and `docs/UPSTREAM.md`
   still claims it in the Opera-owned prose list. Either write it (the
   two-process model, the socket protocol, the two usage modes) or drop the row
   from both documents — see §8.
2. **`src/opera/envConfig.ts` gained one export after this document was
   written:** `PERSISTENT_PROFILE_IGNORE_DEFAULT_ARGS`, so the process-lifecycle
   stress suite can launch a persistent profile with exactly the flags
   production reverts (see §4.1). No behaviour change; the constant was already
   in the file.
3. **`package.json` no longer declares `opera-browser-cli`, superseding §3.1's
   `bin` row and §3's acceptance item 7.** npm refuses to write a global binstub
   whose current target lives outside the package being linked (`bin-links`'s
   `check-bin.js`: global, top-level, not forced), so declaring the name failed
   `npm link` — and every `npm install -g` of this package — on a machine that
   has the older repo's CLI, which is exactly this migration's audience. The
   fork's CLI is unaffected as an entry point (`src/bin/opera-browser-cli.ts`
   stays); only its binstub is no longer npm's to write. `npm run link:cli`
   deploys it, replacing the older repo's (`scripts/link.ts`), while `npm link`
   and `npm run link` deploy the MCP server alone and leave the older repo's
   `opera-browser-cli` where it is. `tests/opera/branding.test.ts` loses the
   subtest that asserted the manifest declared both names — the manifest no
   longer does, and re-pinning it would only pin npm's wiring. Consequence for
   releases: a published tarball installs the server's binary only.

Later work that belongs to the same seam, already registered in
`docs/UPSTREAM.md`: the process-lifecycle stress suite (`tests/stress/**`,
`tests/stress/docker/**`, `scripts/stress-docker.js`, `.dockerignore`) and
`docs/stress-testing.md`. It exercises the daemon/MCP/browser process model this
migration produced; it does not change the migration surface.

---

## 1. Context

`opera-browser-cli` is being retired in favor of `opera-devtools-mcp`. The parent feasibility analysis phases the migration into: (0) pre-commit spikes, (1) port the must-haves, (2) dogfood, (3) deprecate. This document scopes **Phase 1a** — the smallest self-contained slice that unblocks in-place drop-in for existing scripted users — plus the first-run autoconfiguration slice of **Phase 1b** (browser detection + config writing), which a usable first command turns out to require:

1. Add `opera-browser-cli` as the fork's internal CLI binary (replaces the retired repo's CLI). Drop the upstream-derived `opera-devtools` daemon CLI entirely.
2. Recognize the `OPERA_CLI_*` environment variables and the `~/.opera-browser-cli/config` file exposed by opera-browser-cli today.
3. Autoconfigure a fresh machine on its first command: detect the installed Opera build and write `~/.opera-browser-cli/config` (or apply the settings in-process when the state dir is unwritable). See §5.

Motivation: users, session hooks, Dockerfiles, and CI pipelines all invoke `opera-browser-cli` and set `OPERA_CLI_*` env vars. The backward-compat surface is the **`opera-devtools-mcp` server binary**: the old `opera-browser-cli` repo binary spawns it directly via stdio JSON-RPC and sets `OPERA_CLI_*` env vars. The server's `envConfig.ts` preamble (§4) translates those env vars into yargs flags without any caller-side changes. The CLI binary name is irrelevant to backward compat — the old repo resolves `pkg.bin["opera-devtools-mcp"]` and never reads `pkg.bin["opera-devtools"]`.

### Decisions taken

| Item                     | Decision                                 | Rationale                                                                                                                                                                                                                                             |
| ------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPERA_CLI_PORT`         | **Drop entirely**                        | Daemon uses Unix sockets (POSIX) / named pipes (Windows); no HTTP port concept.                                                                                                                                                                       |
| `OPERA_CLI_ENABLE_HOOKS` | **Defer to a later phase**               | Requires the `setup` wizard, not yet migrated.                                                                                                                                                                                                        |
| `OPERA_CLI_TAKEOVER`     | **Defer to a later phase**               | Requires the takeover workflow, not yet migrated.                                                                                                                                                                                                     |
| `opera-devtools` binary  | **Drop entirely**                        | The old `opera-browser-cli` repo only calls `opera-devtools-mcp` (server) via stdio JSON-RPC; it never calls `opera-devtools` (daemon CLI). Dropping it has zero backward-compat impact. We are the Opera fork and care only about Opera-based usage. |
| CLI name selection       | **Plain constant, no build-time switch** | `CLI_BIN_NAME = 'opera-browser-cli'` in `branding.ts`. No `select-cli-name.ts` or `cli-name.generated.ts`. One `npm run build` produces both binaries.                                                                                                |

### In scope

- Add `opera-browser-cli` as the sole internal CLI binary; drop `opera-devtools`.
- Five environment variables: `OPERA_CLI_HEADED`, `OPERA_CLI_CHROME_ARGS`, `OPERA_CLI_BROWSER_URL`, `OPERA_CLI_USER_DATA_DIR`, `OPERA_CLI_EXECUTABLE_PATH`.
- The `~/.opera-browser-cli/config` file loader (KEY=VALUE lines, quote-aware, unknown-key detection).
- First-run autoconfiguration: browser detection (`src/opera/detect.ts`), config writing + settings computation (`src/opera/config.ts`), and the `defaultProfileDir` subset (`src/opera/profile.ts`). See §5.

### Out of scope

- Dropped: `OPERA_CLI_PORT`.
- Dropped: `opera-devtools` binary (and its `opera-devtools-cli-options.ts` shim if it becomes dead code).
- Deferred to feature-owning phases: `OPERA_CLI_ENABLE_HOOKS` (setup wizard), `OPERA_CLI_TAKEOVER` (takeover workflow).
- Not touched: compact snapshots, suggestions, the `setup` wizard, `doctor`, `logs`, `run`, `attach`, exit-code table, `--full`/`--raw`, session hooks, OpenClaw. All covered in Phase 1b or later.
- Not touched: `opera-browser-cli` npm-package deprecation notices. Phase 3.

---

## 2. Design Principles

This work must respect the fork's upstream-seam contract (`docs/UPSTREAM.md`):

1. **New behaviour goes in `src/opera/**`.** New files never conflict on intake.
2. **Upstream files get references, not rewrites.** Swap literals for `branding.ts` constants; add hook calls; never copy an upstream block to modify it.
3. **Never fork a file by copying it.** Opera-named paths are re-export shims over upstream implementations.
4. **Generated artifacts are regenerated by `npm run gen`.**
5. **`src/opera/tools/opera.ts` may only export tool definitions.**

**Load-bearing consequence for this phase:** the entire env-var surface lands in one new file under `src/opera/`, and the wiring uses argv-injection so that `src/config/mcp-options.ts` (upstream, already registered) needs **zero additional edits**.

Additionally, the port style is **physical move, not rewrite**: the target functions in `opera-browser-cli` (`parseConfigValue`, `readConfigFile`, `loadConfig`, `findUnknownConfigKeys`, `editDistance`, `KNOWN_CONFIG_KEYS`) are self-contained and portable as-is. They are copied verbatim into `src/opera/envConfig.ts`, filtered to Phase 1a keys.

The Phase 1b ports (`src/opera/config.ts`, `detect.ts`, `profile.ts`) follow the same rule: new Opera-owned files ported verbatim, filtered to the first-run slice (§5).

---

## 3. CLI Binary — `opera-browser-cli` (sole CLI, no compile-time switch)

The fork ships **two** binaries from a single `npm run build`:

| Binary               | Entry point                                                | Role                                                                                                                                |
| -------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `opera-browser-cli`  | `src/bin/opera-browser-cli.ts` → `chrome-devtools.ts`      | New internal CLI (replaces the retired repo's CLI). Daemon-backed: `start`/`status`/`stop`/tool commands.                           |
| `opera-devtools-mcp` | `src/bin/opera-devtools-mcp.ts` → `chrome-devtools-mcp.ts` | MCP server (stdio). Spawned by the daemon, by a direct MCP client, or by the old `opera-browser-cli` repo binary (backward compat). |

The upstream-derived `opera-devtools` daemon CLI binary is **dropped entirely**. The old `opera-browser-cli` repo only ever calls `opera-devtools-mcp` (the server) via stdio JSON-RPC — it never calls `opera-devtools`. Dropping it has zero backward-compat impact. (Evidence: the old repo's `src/bridge.ts:766-787` resolves `pkg.bin["opera-devtools-mcp"]` and builds a `StdioClientTransport`; `pkg.bin["opera-devtools"]` is never read. Its only `spawn()` sites are the bridge process, the Opera executable, and the MCP transport — no daemon code.)

`CLI_BIN_NAME` is a **plain constant** in `branding.ts`:

```ts
export const CLI_BIN_NAME = 'opera-browser-cli';
```

No `scripts/select-cli-name.ts`, no `src/opera/cli-name.generated.ts`, no build-time switch. One build produces both binaries. There is no "rename" — `opera-browser-cli` is a new bin entry, and `opera-devtools` is deleted.

### 3.1 Surface changes

| File                                    | Change                                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/opera/branding.ts`                 | `CLI_BIN_NAME` is a plain constant `'opera-browser-cli'` (no generated re-export). `STATE_DIR_NAME = '.opera-browser-cli'` for the config-file path. |
| `package.json` `bin`                    | `"opera-devtools"` entry **removed**; `"opera-browser-cli": "./build/src/bin/opera-browser-cli.js"` **added**. `"opera-devtools-mcp"` unchanged.     |
| `src/bin/opera-browser-cli.ts`          | **New** Opera-owned bin entry (the sole CLI). Config + autoconfiguration preamble (see §4.3 and §5), then imports `./chrome-devtools.js`.            |
| `src/bin/opera-devtools.ts`             | **Deleted.** No longer needed — the old `opera-browser-cli` repo never calls it.                                                                     |
| `scripts/select-cli-name.ts`            | **Deleted.** No compile-time switch.                                                                                                                 |
| `src/opera/cli-name.generated.ts`       | **Deleted** (and removed from `.gitignore`).                                                                                                         |
| `scripts/prepare.ts`                    | `ensureCliNameGenerated()` **removed**. The function existed only to write the generated file.                                                       |
| `src/bin/opera-devtools-cli-options.ts` | **Unchanged.** `opera-browser-cli` reuses the same options surface; no per-name `-cli-options.ts` fork is needed.                                    |
| `docs/architecture.md`                  | **New** Opera-owned prose: the two-process CLI/daemon model, the socket protocol, the two usage modes. **Not delivered** — see §0 and §8.            |

### 3.2 Tests

No file renames: `CLI_BIN_NAME` is a plain constant (`'opera-browser-cli'`), so the suite always exercises the `opera-browser-cli` binary. These files are already listed in `docs/UPSTREAM.md`'s "Upstream tests we modify" table — the divergence entries update, not the schema.

| File                                 | Change                                                                                                                                                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/utils.ts`                     | `CLI_PATH` resolves `build/src/bin/opera-browser-cli.js`; daemon status strings keep the fixed `opera-devtools-mcp` name; `createCliEnv()` spawns children with a throwaway `HOME` and every `OPERA_CLI_*` stripped, so a real config cannot leak in. |
| `tests/e2e/opera-devtools-*.test.ts` | `describe`/assertions use `CLI_BIN_NAME` (always `'opera-browser-cli'`); pageId positional always omitted (see §4.7).                                                                                                                                 |

`tests/cli.test.ts` is **not** touched: it asserts `mcp-options` parsing (`$0` strings are test
inputs), not the CLI/package name, so this change leaves it alone. Its Opera-name divergence from
upstream is the pre-existing one recorded in `docs/UPSTREAM.md`.

### 3.3 Regenerated artifacts

Run `npm run gen`. The following are auto-updated (never hand-edit):

- `src/config/cli-options.ts` — the command/arg surface the CLI parses (help text references
  `opera-browser-cli`). Written by `scripts/generate-cli.ts`, which is the only writer.
- `docs/tool-reference.md`, `docs/slim-tool-reference.md`, `docs/configuration.md` — from
  `scripts/generate-docs.ts`.

`docs/cli.md` is **not** generated by this repo (no script writes it): it is upstream prose, and it
still documents upstream's `chrome-devtools` usage — including `<pageId>` as the first positional.
Regenerating will not correct it; if the fork wants it to describe `opera-browser-cli` (with the
pageId strip of §4.7), that is a hand edit.

### 3.4 Registry updates — `docs/UPSTREAM.md`

`UPSTREAM.md` is Opera-owned prose (merge=opera-ours). Update:

- **Opera-owned table:** list `src/bin/opera-browser-cli.ts` (sole CLI entry point) and `src/bin/opera-devtools-mcp.ts` together; add `src/opera/envConfig.ts` (see §4), `src/opera/pageIdRouting.ts` (see §4.7), `src/opera/config.ts`, `src/opera/detect.ts`, `src/opera/profile.ts` (see §5). Remove `src/bin/opera-devtools.ts` (deleted). Remove `src/opera/cli-name.generated.ts` and `scripts/select-cli-name.ts` (both deleted).
- **"Upstream files we rename or delete" table:** no second rename for the e2e paths — the earlier `chrome-devtools-*` → `opera-devtools-*` rename stands; the files reference `CLI_BIN_NAME` (always `'opera-browser-cli'`).
- **"Upstream tests we modify" table:** update the `tests/utils.ts` divergence description to note `CLI_PATH` resolves `opera-browser-cli.js`.
- Add a short note on the bin entry: state dir at `~/.opera-browser-cli/config` (matches the CLI binary name for user affordance).

---

## 4. Environment Variable Migration

### 4.1 New file — `src/opera/envConfig.ts` (Opera-owned)

Content is **physically moved** from `opera-browser-cli`, not rewritten. Filtered to Phase 1a scope.

Added later, unchanged in behaviour: `PERSISTENT_PROFILE_IGNORE_DEFAULT_ARGS` is
exported so `tests/stress/helpers.ts` can launch a persistent profile with the
same reverted Puppeteer defaults this file injects in production (a mocked
keychain or `--password-store=basic` launches a real profile logged out, and the
component-extension blockers stop the Opera AI extension loading).

| Symbol                          | Source in opera-browser-cli                                                                                       | Purpose                                                                                                                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KNOWN_CONFIG_KEYS`             | `src/config.ts:23-34`, filtered to 5 entries                                                                      | List of env vars the fork recognizes. `PORT`, `MCP_BIN`, `HOOKS`, `TAKEOVER`, `DEV` omitted.                                                                                                                                         |
| `parseConfigValue(raw)`         | `src/client.ts:81-89`                                                                                             | Strips matching quote pairs; unescapes `\"` and `\'`. Backslashes are not special — matched to opera-browser-cli's parser so legacy values read identically (§4.8).                                                                  |
| `readConfigFile()`              | `src/config.ts:87-105`                                                                                            | Reads `~/.opera-browser-cli/config` as KEY=VALUE lines; `#`-comments and blank lines skipped; malformed lines skipped; unreadable file → `{}` (never fails a run).                                                                   |
| `editDistance(a, b)`            | `src/config.ts:37-53`                                                                                             | Bounded Levenshtein.                                                                                                                                                                                                                 |
| `findUnknownConfigKeys(config)` | `src/config.ts:55-85`                                                                                             | Length-scaled tolerance; returns `{ key, suggestion }[]`.                                                                                                                                                                            |
| `loadOperaCliConfig()`          | `src/client.ts:95-113` (renamed from `loadConfig`)                                                                | Reads the config file, promotes each **recognised** `KEY=VALUE` into `process.env` **only if not already set**, then warns to stderr for any unknown keys returned by `findUnknownConfigKeys` — warned about, never promoted (§4.4). |
| `applyEnvToArgv(argv)`          | Replaces `buildTransportArgs()` at `opera-browser-cli/src/bridge.ts:710` (bridge-specific; not reusable verbatim) | Translates `OPERA_CLI_*` env vars into equivalent yargs flags and appends them to `argv` **only if the corresponding flag is not already present**. See mapping in §4.2.                                                             |

State-dir path is derived from `branding.STATE_DIR_NAME` so future rebranding is a single constant change:

```ts
path.join(os.homedir(), STATE_DIR_NAME, 'config');
```

### 4.2 Env-var → yargs-flag mapping (owned by `applyEnvToArgv`)

| Env var                     | Emitted argv                                                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPERA_CLI_HEADED=1`        | `--headless=false`                                                                                                | Inverted semantics (headed = not headless). `=0` → `--headless=true`. `true`/`false` are accepted too; any other value warns on stderr and injects nothing; blank counts as unset. Skipped if `--headless` already on argv.                                                                                                                                                                                                                                                                                         |
| `OPERA_CLI_CHROME_ARGS`     | `--chromeArg=<flag>` (repeated)                                                                                   | Whitespace-split; no shell quoting; flags containing spaces are not supported (matches opera-browser-cli behaviour verbatim).                                                                                                                                                                                                                                                                                                                                                                                       |
| `OPERA_CLI_BROWSER_URL`     | `--browserUrl=<url>`                                                                                              | Consumed at `src/index.ts:236` — `ensureBrowserConnected` path attaches rather than launching.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `OPERA_CLI_USER_DATA_DIR`   | `--userDataDir=<path>` + six `--ignoreDefaultChromeArg=<flag>` + `--chromeArg=--show-component-extension-options` | Persistent profile (ported verbatim from opera-browser-cli's `buildTransportArgs()`): the `--ignoreDefaultChromeArg` reverts (mocked keychain, `--password-store=basic`, extension/background blockers) keep the profile launching logged-out, and the component-extension flag loads the Opera AI extension. `--isolated` is **not** emitted — yargs declares `userDataDir` `conflicts: ['isolated']`, so the start handler skips `isolated=true` when `userDataDir` is present. Flags skipped if already on argv. |
| `OPERA_CLI_EXECUTABLE_PATH` | `--executablePath=<path>`                                                                                         | Puppeteer launch target.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### 4.3 Wiring — bin-shim preambles

The two preambles are asymmetric by design:

- **`src/bin/opera-browser-cli.ts` (CLI entry point)** calls `loadOperaCliConfig()` and the
  first-run `ensureConfigured(process.argv)` (see §5), then dynamically imports
  `./chrome-devtools.js`. It deliberately does **not** call `applyEnvToArgv()`: the CLI's strict
  per-command parser rejects the synthesized flags on `status`, `stop`, and the tool commands.
  Config values are promoted into `process.env`, which the forked daemon inherits, so the env →
  flag translation can happen once, server-side.

- **`src/bin/opera-devtools-mcp.ts` (MCP server entry point)** calls `loadOperaCliConfig()` and
  `applyEnvToArgv(process.argv)` before importing `./chrome-devtools-mcp.js` — this binary's
  yargs surface accepts every synthesized flag, so the `OPERA_CLI_*` → flag translation belongs
  here.

```ts
// src/bin/opera-browser-cli.ts (new)
import {autoConfigure, shouldAutoConfigure} from '../opera/config.js';
import {loadOperaCliConfig} from '../opera/envConfig.js';
loadOperaCliConfig();
ensureConfigured(process.argv); // local helper — see §5.4
await import('./chrome-devtools.js');
```

```ts
// src/bin/opera-devtools-mcp.ts (existing — add the two lines before the import)
import {loadOperaCliConfig, applyEnvToArgv} from '../opera/envConfig.js';
loadOperaCliConfig();
applyEnvToArgv(process.argv);
await import('./chrome-devtools-mcp.js');
```

The `opera-devtools-mcp` bin is the backward-compat surface: the old `opera-browser-cli` repo
binary spawns it directly via stdio JSON-RPC, and the env/config preamble ensures `OPERA_CLI_*`
env vars and `~/.opera-browser-cli/config` are respected without any caller-side changes.

Both bin shims are already Opera-owned (per `docs/UPSTREAM.md`), so this touches no upstream
files.

### 4.4 Precedence

Falls out of the ordering without special-case code:

```
explicit CLI flag  >  process.env  >  ~/.opera-browser-cli/config  >  yargs default
```

- `loadOperaCliConfig()` promotes the **recognised** config-file entries (`KNOWN_CONFIG_KEYS` only) into
  `process.env`, and **only if not already set** → env beats config. Unknown keys are never promoted:
  the file is user-writable data, and copying arbitrary keys out of it would let a typo (or a stray
  `NODE_OPTIONS`) steer the daemon the CLI spawns.
- `applyEnvToArgv()` promotes env into argv **only if the flag is not already present** → CLI beats env.

### 4.5 Unknown-key handling

`loadOperaCliConfig` calls `findUnknownConfigKeys` after reading the file and prints one stderr warning
per unknown key with the Levenshtein suggestion (or "no suggestion" if none is close enough). Those
keys are warned about and otherwise ignored — never promoted (§4.4). It never fails the run — respects
opera-browser-cli's Configuration Invariant #9: "Config is a cache, not a prerequisite." Note this
means a future phase that reads a new `OPERA_CLI_*` variable must add it to `KNOWN_CONFIG_KEYS`, or the
config file cannot set it (the environment still can).

### 4.6 What `applyEnvToArgv` does NOT do

- Does not consult `src/opera/browserLaunch.ts` or mutate `serverArgs`. Env vars arrive as normal yargs-parsed fields, so `buildLaunchOptions` at `src/opera/browserLaunch.ts:48` picks them up unchanged.
- Does not touch `src/config/mcp-options.ts`. The upstream option definitions already accept the yargs flags we synthesize.
- Does not implement the deferred vars (`ENABLE_HOOKS`, `TAKEOVER`). If those are set, they surface as unknown-key warnings until the owning phase lands.

### 4.7 pageId routing

chrome-devtools-mcp injects a routing `pageId` positional onto most page-scoped tool commands so
the model can target the active page without naming it. The retired `opera-browser-cli` never
routed by pageId, so the internal CLI removes that positional rather than changing downstream
callers:

- **Server side** (`applyEnvToArgv` in `src/opera/envConfig.ts`): when the CLI spawns the daemon
  (`--viaCli`), inject `--no-page-id-routing` so the server does not add the routing argument.
  A direct MCP client (no `--viaCli`) is untouched — pageId routing stays on for MCP clients
  that negotiate it.
- **CLI side** (`src/opera/pageIdRouting.ts`): `withoutRoutingPageId()` strips the routing
  positional from the command surface. The routing positional is identified by the description
  upstream injects (`'Targets a specific page by ID.'`), matched as a _prefix_ because upstream
  appends a caveat to it for `evaluate_script` ("Required when not evaluating in a service
  worker."). Tools with a _real_ `pageId` argument (`select_page`, `close_page`) describe it in
  their own words and keep it.
- **Drift guard** (`tests/opera/pageIdRouting.test.ts`): the strip keys off a string upstream owns,
  so the unit test pins it against the generated command table. It fails if an intake merge rewords
  the description (the strip becomes a silent no-op and the positional comes back), and it asserts
  that only `select_page` and `close_page` expose a `pageId` once stripping has run — a pageId left
  on the CLI surface is not merely useless, the daemon a CLI command spawns (running with
  `--no-page-id-routing`) rejects it as an unknown argument. The durable fix is an explicit marker
  on the upstream `ArgDef` (e.g. `isRoutingArg: true`); until upstream offers one, the test is the
  contract.

With `opera-devtools` dropped, `opera-browser-cli` is the sole CLI binary, so pageId routing is
always stripped for CLI-spawned sessions. The `--viaCli` check remains to distinguish CLI-spawned
sessions from direct MCP client connections.

`src/opera/pageIdRouting.ts` is an Opera-owned file; `src/bin/chrome-devtools.ts` merely imports
it and calls `withoutRoutingPageId()`, keeping the upstream diff at a reference rather
than a rewrite (design rule 2).

### 4.8 Known limitations (deliberate)

- `OPERA_CLI_CHROME_ARGS` is dropped in full when _any_ `--chromeArg` is already on argv — the env
  value is not merged with explicit flags (`applyEnvToArgv` treats the env var as all-or-nothing).
  This matches opera-browser-cli's "CLI wins" rule; per-flag merging is not attempted.
- Config values escape `"` but not `\` (and `parseConfigValue` unescapes only `\"`/`\'`), matching
  opera-browser-cli's parser so pre-existing config files read identically. A value ending in a
  literal backslash followed by a quote loses the backslash on read — inherited from
  opera-browser-cli, and left as-is to keep drop-in reads of legacy files lossless.

---

## 5. First-Run Autoconfiguration (Phase 1b slice)

opera-browser-cli configured a fresh machine on first run instead of telling the user to go and
run `setup`. That behaviour is a prerequisite for a usable drop-in first command, so the relevant
Phase 1b slice is pulled forward here.

### 5.1 New files

| File                   | Purpose                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/opera/detect.ts`  | Opera / Opera Neon detection, Neon first; `detectBrowser()` returns the default. Threads `platform`/`home`/`exists`/`env` seams for tests; candidates are deduped so an empty `home` cannot report one install twice. Results are named by the install directory (`.app`-stripped), not by a substring of the whole path. |
| `src/opera/profile.ts` | `defaultProfileDir()` subset only (macOS bundle id / Windows profile dir, both keyed off the build name from `detect.ts`); lock inspection and endpoint probing arrive with the takeover phase. Threads `platform`/`env` seams.                                                                                           |
| `src/opera/config.ts`  | `writeConfigFile()`, `updateConfigFile()`, `computeAutoConfig()`, `applySettingsToEnv()`, `autoConfigure()`, `shouldAutoConfigure()`.                                                                                                                                                                                     |

All three are Opera-owned files ported from opera-browser-cli (physical move, filtered to this
scope), per design rule 2. The read side and unknown-key detection stay in `envConfig.ts`.

### 5.2 Compute path

`computeAutoConfig(options)` decides the settings for an unconfigured machine:

- Skips when a config file already exists (`~/.opera-browser-cli/config`) or when
  `OPERA_CLI_EXECUTABLE_PATH` / `OPERA_CLI_BROWSER_URL` is already set in the environment.
- Detects the installed Opera build, preferring the browser's **real** profile (the session the user
  is already signed in to), falling back to `~/.opera-browser-cli/profile`.
- Emits `OPERA_CLI_EXECUTABLE_PATH`, `OPERA_CLI_HEADED=1`, and `OPERA_CLI_USER_DATA_DIR`.

The seams (`home`, `platform`, `exists`, `env`, `persist`) make the function pure over its
parameters; production callers use the defaults derived at call time. Detection and the profile-dir
lookup take the same `env` seam, so their Windows branches are testable from any platform without
touching `process.env`.

### 5.3 Write path

`writeConfigFile()` writes `KEY="value"` lines, `mkdir -p`-ing the state dir first (mode `0o700`).
The file is written mode `0o600` (the config path is conventional territory for credentials);
`writeFileSync`'s `mode` only applies on creation, so every write also `chmod`s the file back to
`0o600` — a file that predates the tool (or was hand-written) must not stay world-readable. Values
escape `"` only — see §4.8 for the backslash limitation — and a value containing a newline is
**rejected** with an error rather than written: the reader splits on `\n` and drops what it cannot
parse, so writing one would silently truncate the value on the next read. `updateConfigFile()`
patches a key in place (a null value removes it) and re-writes.

`autoConfigure()` wraps the compute path: when the result is `configured` and `persist !== false`
it writes the file, then `applySettingsToEnv(settings, options.env)` promotes the settings into the
environment this run uses (without overwriting existing values) so the very first command benefits even
if the write fails. The write side takes the same `env` seam the compute path reads, so a caller that
passes one gets both the read **and** the write there instead of in `process.env`. A failed write is
reported on stderr with the path and the reason — the settings still apply in-process, but a broken
state dir must not be silent until `doctor` lands.

### 5.4 Wiring — `ensureConfigured`

`src/bin/opera-browser-cli.ts` defines a local `ensureConfigured(argv)` that runs
`autoConfigure()` unless `shouldAutoConfigure(argv)` deems the invocation a pure query
(`--help`/`--version`, or the `setup`/`logs` commands). On success it prints a one-line
`configured: …` note; with no browser found it points the user at `setup` or
`OPERA_CLI_EXECUTABLE_PATH` (`doctor` suppresses that hint).

### 5.5 Tests

`tests/opera/detect.test.ts`, `tests/opera/config.test.ts`, and `tests/opera/profile.test.ts`
cover detection, compute/write/round-trip, and the profile-dir mapping respectively.

## 6. Tests

### 6.1 New file — `tests/opera/envConfig.test.ts`

Covers:

- `parseConfigValue`: bare value; `"..."`; `'...'`; escaped internal `\"` and `\'`.
- `readConfigFile`: absent file → `{}`; comments (`#`) skipped; blank lines skipped; malformed lines skipped; unreadable file → `{}` (fs-mocked EACCES).
- `findUnknownConfigKeys`: known keys ignored; near-miss returns `suggestion`; unrelated key returns `suggestion: null`.
- `loadOperaCliConfig`: does not overwrite a `process.env` value that is already set; emits stderr warning for unknown keys; **never promotes an unrecognised key** (regression guard: a config file must not be able to inject arbitrary environment variables).
- `applyEnvToArgv`: each of the five mappings; explicit flag on argv wins over env; `HEADED=0` and `HEADED=1` both handled, plus `true`/`false`, an unusable value (warns, injects nothing) and a blank value (unset, silent); `USER_DATA_DIR` emits `--userDataDir` plus the six `--ignoreDefaultChromeArg` reverts and `--chromeArg=--show-component-extension-options` — not `--isolated=false` (yargs conflict); `CHROME_ARGS` whitespace split preserves order and emits nothing for a whitespace-only value; `HOOKS` and `TAKEOVER` env vars ignored (regression guard for the deferred vars). The `--ignoreDefaultChromeArg` list is asserted exactly, so a Puppeteer default-args change intentionally fails this test and forces an explicit revisit. PageId routing: `--viaCli` on argv always injects `--no-page-id-routing` (sole CLI binary — no `CLI_BIN_NAME` branching); no `--viaCli` → no injection.

Subset-port from `opera-browser-cli/test/config.test.ts` where applicable; skip anything referencing bridge/port/hooks/takeover.

### 6.1a Other Opera unit suites

- `tests/opera/config.test.ts`: round-trip of quoted values; a value containing `\n` is rejected rather than
  written (the reader would truncate it); a failed write still applies the settings in-process **and**
  warns on stderr with the config path; `autoConfigure` honours the `env` seam on the write side too
  (settings land in the seam, `process.env` stays clean); an existing file with looser permissions is
  narrowed back to `0o600` by the next write.
- `tests/opera/detect.test.ts`: Neon preference, Developer preference, Linux → nothing, dedupe when
  `home` is empty, Windows roots via the `env` seam (no `process.env` mutation), and build naming that
  ignores unrelated directories.
- `tests/opera/profile.test.ts`: macOS bundle mapping per build; Windows profile folder per build with
  the `env` seam and the home-relative fallback.
- `tests/opera/pageIdRouting.test.ts`: the strip, the caveat-suffixed `evaluate_script` description, and
  the intake guard over the generated command table (see §4.7).

### 6.2 Existing tests

Update per §3.2. `CLI_BIN_NAME` is always `'opera-browser-cli'`; pageId positional always omitted. No behavioural changes beyond the binary name.

---

## 7. Verification

Post-implementation checklist:

1. `npm run build && npm test` — all suites pass.
2. `npm run verify-upstream-seam` — no unregistered drift.
3. `npm run gen` — no diff after regenerate (proves generated artifacts are up to date).
4. Manual smoke tests from a shell:
   - `opera-browser-cli --help` — banner and bin name reflect the new CLI.
   - `OPERA_CLI_EXECUTABLE_PATH=/Applications/Opera.app/Contents/MacOS/Opera opera-browser-cli new_page https://example.com` — launches the specified binary.
   - `OPERA_CLI_HEADED=1 opera-browser-cli new_page https://example.com` — visible window.
   - `OPERA_CLI_HEADED=1 opera-browser-cli --headless=true new_page https://example.com` — CLI flag wins; headless mode.
   - `OPERA_CLI_BROWSER_URL=http://127.0.0.1:9222 opera-browser-cli new_page https://example.com` — attaches, no new browser process.
   - `OPERA_CLI_USER_DATA_DIR=/tmp/opera-profile opera-browser-cli new_page https://example.com` — profile persists across runs; not `--isolated`.
   - `OPERA_CLI_CHROME_ARGS='--enable-gpu --ignore-gpu-blocklist' opera-browser-cli new_page https://example.com` — both flags forwarded to the browser.
   - `mkdir -p ~/.opera-browser-cli && echo 'OPERA_CLI_HEADED=1' > ~/.opera-browser-cli/config && opera-browser-cli new_page https://example.com` — config file loaded.
   - Same as above with a typo (`OPERA_CLI_HAEDED=1`) — stderr warning with suggestion `OPERA_CLI_HEADED`; command still runs.
5. Confirm the MCP-server binary (`opera-devtools-mcp`) respects the env vars — it shares the `envConfig.ts` preamble with the CLI. Set `OPERA_CLI_HEADED=1` in an MCP client's env and observe a visible browser. This is the backward-compat path: the old `opera-browser-cli` repo binary spawns `opera-devtools-mcp` directly, and the preamble translates `OPERA_CLI_*` into yargs flags without any caller-side changes.
6. Backward-compat: simulate the old `opera-browser-cli` repo binary by spawning `opera-devtools-mcp` directly with `OPERA_CLI_*` env vars set and no `--viaCli`. Confirm the env vars are applied (e.g. `OPERA_CLI_HEADED=1` → visible browser) and `--no-page-id-routing` is NOT injected (direct MCP client keeps pageId routing).
7. Confirm `opera-devtools` is no longer installed: `npm link` then `which opera-devtools` → not found; `which opera-browser-cli` → found.

---

## 8. Follow-ups (informational, not this phase)

- **Phase 1b:** compact snapshots (`src/opera/compactSnapshot.ts`), suggestions. (Browser detection, first-run autoconfiguration, and the `defaultProfileDir` subset were pulled forward — see §5.)
- **Phase 1c:** `setup` wizard — unblocks `OPERA_CLI_ENABLE_HOOKS`.
- **Phase 1d:** `doctor`, `logs`, `run`, `attach`, exit-code contract, `--full`/`--raw` flags.
- **Phase 1e:** takeover workflow — unblocks `OPERA_CLI_TAKEOVER`. Requires new daemon-side API per feasibility analysis §2.3.
- **Phase 3:** `opera-browser-cli` npm package deprecation + migration warnings.
- **Outstanding from Phase 1a:** `docs/architecture.md` (the two-process
  CLI/daemon model, the socket protocol, the two usage modes). Either write it or
  remove it from §3.1 and from `docs/UPSTREAM.md`'s Opera-owned prose list — as
  it stands both documents promise a file that is not in the tree.
