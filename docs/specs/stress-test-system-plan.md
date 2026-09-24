# Stress Test System for opera-browser-cli Process Robustness

> **Canonical location**: `docs/specs/stress-test-system-plan.md`.
>
> **Status — implemented, as built.** The step-by-step plan below is retained as
> design history and is **not** an accurate description of the delivered system:
> the file layout, the orphan-detection mechanism, the container build and the
> scenario set all changed while the suite was brought up against real processes.
> The authoritative description of what exists today is
> [**As-built reference**](#as-built-reference) at the end of this document, and
> [docs/stress-testing.md](../stress-testing.md) is the operator's guide
> (how to run it locally and on CI).

## Context

The `opera-browser-cli` → Neon browser path involves four process roles: **CLI client** (per-command, ~120ms), **daemon** (persistent, detached, ppid 1), **MCP server** (child of daemon, stdio JSON-RPC), and **browser + helpers** (child of MCP server, CDP over pipe). The product goal is that this path is **robust and secure**: no leftover/orphan daemon processes, and any abnormal process termination triggers a restart.

The codebase currently has **zero restart/supervision logic** — the daemon is spawned `detached:true` + `unref()`, the MCP server is an unsupervised stdio child with no `onclose`/`exit` handler, and no `disconnected` listener exists on the browser. The liveness check is pid-file-only (`process.kill(pid, 0)`), with no socket probe or process identity verification. This stress test system will **artificially kill or spawn processes** to emulate real-world failure scenarios, running in loops at high concurrency inside a Docker container, and assert that no orphan processes remain and that the system recovers automatically.

This plan covers **8 critical failure scenarios** in the first iteration (A1, A2, B1, B2, C1, C2, D1, E2). The remaining 10 scenarios (A3, A4, A5, B3, B4, C3, D2, D3, E1, E3, F1) are documented as future work and will be added in the next phase.

## Test Infrastructure

### Node Test Runner (existing)

The project uses Node's built-in test runner (`node:test` + `node:assert`) — no jest/vitest/mocha. Tests are TypeScript compiled to `build/tests/**/*.test.js` and run through `scripts/test.js`, which spawns `node --import ./build/tests/setup.js --test --test-force-exit --test-timeout=120000 build/tests/**/*.test.js`.

### Existing Patterns to Reuse

- **`tests/utils.ts` → `runCli(args, sessionId)`**: Spawns the real CLI binary (`build/src/bin/opera-browser-cli.js`) with a clean env (`createCliEnv()` strips `OPERA_CLI_*`, sets throwaway `HOME`, sets `OPERA_CLI_EXECUTABLE_PATH` to bundled Puppeteer Chrome). Returns `{status, stdout, stderr}`.
- **`tests/utils.ts` → `assertDaemonIsRunning(sessionId)` / `assertDaemonIsNotRunning(sessionId)`**: Runs `status` command and asserts on stdout. Reuse for liveness checks, but note they go through the CLI which itself depends on pid-file liveness — the stress test needs direct process-table assertions (see below).
- **`tests/utils.ts` → `createCliEnv()`**: Returns a clean env record. Reuse for all spawned processes.
- **`tests/utils.ts` → `CLI_PATH`**: `path.resolve('build/src/bin', 'opera-browser-cli.js')`. Reuse.
- **`tests/shutdown.test.ts`**: Direct-spawn pattern — spawns a bin with `spawn('node', [binPath, ...args], {stdio: ['pipe','pipe','pipe']})`, uses `waitForExit(child, timeout)` with SIGKILL backstop, asserts exit within budget. This is the template for process-kill tests.
- **`tests/e2e/opera-devtools-start-stop.test.ts`**: Per-test random UUID sessionId, stop-before/after pattern. Reuse the UUID sessionId pattern for isolation.
- **`src/daemon/utils.ts` → `getPidFilePath`, `getSocketPath`, `getDaemonPid`, `isDaemonRunning`**: Import these directly to inspect process state from tests. They take a `sessionId` string.

### New Test Module Structure

All new test files go under `tests/stress/` (this is the delivered layout; see
[As-built reference](#as-built-reference) for what each file actually does):

```
tests/stress/
  helpers.ts                — session-scoped process-table harness, kill interlock, quiet CLI runner
  scenarios.ts              — all 12 scenarios (A1 A2 B1 B2 C1 C2 D1 E2 G1 G2 G3 H1)
  daemon-orphan.test.ts     — scenarios A1, A2
  mcp-server-crash.test.ts  — scenarios B1, B2
  browser-crash.test.ts     — scenarios C1, C2
  malformed-message.test.ts — scenario D1
  oom-kill.test.ts          — scenario E2
  persistent-profile.test.ts — scenarios G1, G2, G3 (non-isolated / persistent profile)
  runner.test.ts            — orchestrates all scenarios in a loop
```

### Docker Container

New file: `docker/stress-test/Dockerfile`

The Docker container provides isolation so process kills, orphans, and FD exhaustion don't affect the host OS. It must:

1. **Base image**: `node:24-slim` (matches `.nvmrc` = `v24`).
2. **Install Chrome**: The bundled Puppeteer Chrome is needed for `--isolated --headless` browser launches. Install via `npx puppeteer browsers install chrome` at build time, set `PUPPETEER_EXECUTABLE_PATH`. Alternatively, install `chromium` from the Debian repos (simpler, smaller). Use `chromium` package: `apt-get install -y chromium`. Set `OPERA_CLI_EXECUTABLE_PATH=/usr/bin/chromium`.
3. **Copy the built project**: `COPY build/ /app/build/`, `COPY package.json package-lock.json /app/`. Run `npm ci --omit=dev` to install runtime deps (puppeteer is a devDependency — need `npm ci` without `--omit=dev` since tests need it, or restructure). Actually: the test runner needs `node:test` (built-in) + `puppeteer` (devDependency) + the compiled `build/` output. Simplest: `npm ci` (installs everything), then `npm run build`, then run tests.
4. **Run as non-root**: Create a `stress` user (uid 1000) so process ownership is trackable and `/tmp` paths are predictable.
5. **Entry point**: `node --import ./build/tests/setup.js --test --test-force-exit --test-timeout=300000 build/tests/stress/**/*.test.js`

New file: `docker/stress-test/docker-compose.yml`

```yaml
stress-test:
  build: docker/stress-test
  working_dir: /app
  command: node --import ./build/tests/setup.js --test --test-force-exit --test-timeout=300000 build/tests/stress/runner.test.js
  environment:
    - OPERA_DEVTOOLS_NO_USAGE_STATISTICS=true
    - OPERA_DEVTOOLS_CRASH_ON_UNCAUGHT=true
    - OPERA_DEVTOOLS_NO_UPDATE_CHECKS=true
    - OPERA_CLI_EXECUTABLE_PATH=/usr/bin/chromium
    - HOME=/tmp/stress-home
    - XDG_RUNTIME_DIR=/tmp/stress-run
  tmpfs:
    - /tmp
  security_opt:
    - seccomp:unconfined # needed for Chrome sandbox disable in container
  cap_add:
    - SYS_PTRACE # needed for process.kill(pid, 0) liveness checks
```

New npm scripts in `package.json`:

```json
"test:stress": "npm run build && node --import ./build/tests/setup.js --test --test-force-exit --test-timeout=300000 build/tests/stress/runner.test.js",
"test:stress:docker": "docker compose -f docker/stress-test/docker-compose.yml up --build --abort-on-container-exit"
```

## Approach

### Step 0: Copy this plan to the canonical location

Copy `local://stress-test-system-plan.md` → `docs/specs/stress-test-system-plan.md`. This makes the plan discoverable alongside other specs in the repo.

### Step 1: Create `tests/stress/helpers.ts` — Process-Tree Utilities

This module provides the primitives every scenario test uses. No equivalent exists in the codebase — the existing `tests/utils.ts` helpers go through the CLI (pid-file-based liveness), but the stress test must assert directly against the OS process table to detect orphans.

**Functions to implement:**

```typescript
// Spawn the CLI with a given sessionId and args, return the ChildProcess
// (not awaited) so the test can interact with it mid-flight.
import {type ChildProcess, spawn} from 'node:child_process';
import {createCliEnv, CLI_PATH} from '../utils.js';
import {
  getDaemonPid,
  getPidFilePath,
  getSocketPath,
} from '../../src/daemon/utils.js';

// Get the daemon PID for a sessionId (reads the pid file, no process kill)
export function readDaemonPid(sessionId: string): number | null;

// Find all processes matching a pattern in the OS process table.
// Uses `ps -eo pid,ppid,command` + filtering (not pgrep, to stay portable).
// Returns array of {pid, ppid, command}.
export interface ProcInfo {
  pid: number;
  ppid: number;
  command: string;
}
export async function findProcesses(pattern: string): Promise<ProcInfo[]>;

// Assert that no orphaned daemon/MCP/browser processes exist for a sessionId.
// Scans ps output for: daemon.js, opera-devtools-mcp.js, chromium.
// Excludes the test runner process itself.
export async function assertNoOrphans(sessionId: string): Promise<void>;

// Kill a process by PID with a specific signal. Returns true if the process
// existed and was signaled.
export function killProcess(
  pid: number,
  signal: NodeJS.Signals = 'SIGKILL',
): boolean;

// Wait for a process to exit. Polls process.kill(pid, 0) every 50ms.
export async function waitForProcessExit(
  pid: number,
  timeoutMs = 5000,
): Promise<boolean>;

// Get all child PIDs of a parent PID (one level deep, via ps).
export async function getChildPids(parentPid: number): Promise<number[]>;

// Kill an entire process tree (parent + all descendants). Uses recursive
// getChildPids + SIGKILL. This is needed for browser helper cleanup (C2).
export async function killProcessTree(rootPid: number): Promise<void>;

// Start the daemon via the CLI, wait for it to be ready, return the daemon PID.
export async function startDaemonForTest(
  sessionId: string,
  args?: string[],
): Promise<number>;

// Stop the daemon via the CLI, wait for exit, assert no orphans.
export async function stopDaemonForTest(sessionId: string): Promise<void>;

// Send a raw message to the daemon socket (bypassing the CLI) — needed for D1.
// Connects to the Unix socket, sends raw bytes, reads response.
export async function sendRawSocketMessage(
  sessionId: string,
  rawBytes: Buffer,
): Promise<Buffer | null>;
```

**Key design decisions:**

- `ps` over `pgrep`/`pgrep` — `ps` is available in the `node:24-slim` base image. Pattern matching is done in JS, not in the shell, to avoid shell injection.
- `assertNoOrphans` filters by sessionId-specific paths where possible (socket path contains the sessionId), but falls back to scanning all `daemon.js` / `opera-devtools-mcp.js` / `chromium` processes in the container. Since the Docker container runs only the test, all matching processes are test subjects.
- Each test uses a unique `crypto.randomUUID()` sessionId so the daemon socket/pid paths are isolated (`/tmp/opera-devtools-mcp-<uid>-<sessionId>.sock`).

### Step 2: Scenario A1 — Stale PID File → Orphaned Daemon

**File**: `tests/stress/daemon-orphan.test.ts`

**Test**: `Stale pid file makes running daemon invisible`

1. Start the daemon with sessionId `S1` via `startDaemonForTest(S1)`. Record daemon PID `P1`.
2. Verify the daemon is running: `assertDaemonIsRunning(S1)`, and `readDaemonPid(S1) === P1`.
3. Delete the pid file: `fs.unlinkSync(getPidFilePath(S1))`.
4. Verify `isDaemonRunning(S1)` returns false (pid file gone → invisible).
5. Start a second daemon with the same sessionId: `startDaemonForTest(S1)`. This should trigger the stale-daemon hazard: the CLI deletes the pid file (already gone), spawns a new daemon that unlinks the socket and re-binds. Record new daemon PID `P2`.
6. **Orphan check**: `findProcesses('daemon.js')` should return processes with PIDs `P1` (orphan) and `P2` (new). Assert `P1` is still alive.
7. Cleanup: kill both `P1` and `P2` process trees. Assert `assertNoOrphans(S1)`.

**Stress loop**: Repeat 5 times with fresh sessionIds. After each iteration, assert zero orphans.

### Step 3: Scenario A2 — Concurrent CLI Start Race

**File**: `tests/stress/daemon-orphan.test.ts`

**Test**: `Two concurrent starts race on pid file`

1. Ensure no daemon running for sessionId `S2`.
2. Spawn two CLI `start` commands concurrently: `Promise.all([runCli(['start'], S2), runCli(['start'], S2)])`. Both check `isDaemonRunning` → false, both call `startDaemon`, both delete the pid file, both spawn.
3. One daemon wins the pid file (exits `isDaemonRunning` guard at daemon.ts:37-40 for the loser). But the loser may have deleted the winner's pid file first.
4. **Orphan check**: After both CLIs complete, scan for all `daemon.js` processes. There should be exactly one daemon. If the race produced an orphan (two daemons, one invisible), the test detects it.
5. If exactly one daemon: verify it's reachable via `status`. If two: the test logs the orphan and kills both.
6. Cleanup: stop + `assertNoOrphans`.

**Stress loop**: Repeat 10 times rapidly (no delay between iterations) to maximize race probability.

### Step 4: Scenario B1 — MCP Server Crash → Live-But-Useless Daemon

**File**: `tests/stress/mcp-server-crash.test.ts`

**Test**: `MCP server crash leaves daemon alive but useless`

1. Start daemon for sessionId `S3`: `startDaemonForTest(S3)`. Record daemon PID `P3`.
2. Find the MCP server child: `getChildPids(P3)` → should be exactly one child (the `opera-devtools-mcp.js` process). Record as `M3`.
3. Kill the MCP server: `killProcess(M3, 'SIGKILL')`. Wait for exit: `waitForProcessExit(M3)`.
4. **The daemon should detect this and restart the MCP server** (once restart logic is implemented). Currently: the daemon does NOT detect it. The test asserts:
   - Daemon PID `P3` is still alive (the daemon didn't crash — correct behavior).
   - A `status` command succeeds (daemon socket is still listening — correct).
   - A tool call (`list_pages`) fails with "Not connected" or similar error (MCP server is dead).
   - **After restart logic is implemented**: `getChildPids(P3)` should show a new MCP server process within a reasonable timeout (5s). The tool call should succeed.
5. **Orphan check**: The dead MCP server process should be fully gone. No zombie. `assertNoOrphans(S3)`.
6. Cleanup: `stopDaemonForTest(S3)`.

**Stress loop**: Repeat 5 times. Each iteration: start, kill MCP, (wait for restart), verify recovery, stop.

### Step 5: Scenario B2 — MCP Server `uncaughtException`

**File**: `tests/stress/mcp-server-crash.test.ts`

**Test**: `MCP server uncaught exception kills it without daemon detection`

1. Start daemon for sessionId `S4`. Record daemon PID `P4`, MCP server PID `M4`.
2. Send `SIGABRT` to `M4` (simulates a crash/abort, which Node treats similarly to `uncaughtException` — the process dies with a core dump on some systems, or just exits). Alternatively, send `SIGSEGV`. Use `SIGABRT` as it's cleaner — it triggers `abort()` which is an abnormal termination.
3. Wait for `M4` to exit.
4. Verify daemon `P4` is still alive (it should be — no `onclose` handler).
5. Verify `status` still succeeds (daemon socket is fine).
6. Verify `list_pages` fails (MCP server dead).
7. **After restart logic**: MCP server should be respawned. Verify with `getChildPids(P4)` + tool call.
8. **Orphan check**: `assertNoOrphans(S4)`.
9. Cleanup.

**Stress loop**: Repeat 5 times.

### Step 6: Scenario C1 — Browser Crash → Lazy Recovery

**File**: `tests/stress/browser-crash.test.ts`

**Test**: `Browser crash triggers lazy recovery on next tool call`

1. Start daemon for sessionId `S5`. Record daemon PID, MCP server PID `M5`.
2. Trigger a browser launch: `runCli(['navigate_page', '--url=https://example.com'], S5)`.
3. Find the browser process: `getChildPids(M5)` → the Chromium process. Record as `B5`.
4. Kill the browser: `killProcess(B5, 'SIGKILL')`. Wait for exit.
5. **The MCP server should detect the browser disconnect and the next tool call should relaunch it** (lazy recovery via `#getContext()` → `ensureBrowserLaunched()`). Currently this already works lazily — the test verifies:
   - MCP server `M5` is still alive.
   - Daemon is still alive.
   - Next `list_pages` call succeeds (triggers lazy relaunch). Use `waitExecutionFor` with a 10s timeout.
   - A new browser process exists under `M5`: `getChildPids(M5)` should show a new Chromium PID.
6. **Orphan check**: The old browser process `B5` should be gone. No orphaned helper processes. `assertNoOrphans(S5)`.
7. Cleanup.

**Stress loop**: Repeat 10 times (kill browser, verify recovery, repeat — stress the lazy relaunch path).

### Step 7: Scenario C2 — Browser SIGKILL → Orphaned Helper Processes

**File**: `tests/stress/browser-crash.test.ts`

**Test**: `Browser SIGKILL leaves orphaned helper processes`

1. Start daemon for sessionId `S6`. Navigate to a page (launches browser + helpers).
2. Find the browser process tree: `getChildPids(M6)` → browser PID `B6`. Then `getChildPids(B6)` → helper PIDs (GPU, renderer, etc.). Record all helper PIDs.
3. Kill ONLY the main browser process `B6` with `SIGKILL` (do NOT kill the process group). Wait for `B6` to exit.
4. **Check for orphaned helpers**: Some helper processes may survive because no process-group kill was sent. Scan for Chromium processes that were children of `B6` — they may be re-parented to pid 1 (the container's init). `findProcesses('chromium')` should show them.
5. Verify the MCP server detects the disconnect (next `list_pages` should relaunch). Use `waitExecutionFor`.
6. **After proper cleanup logic is implemented**: the old helpers should be killed when the new browser launches, or the daemon/MCP server should kill the process group. The test asserts no orphaned Chromium processes remain after recovery.
7. Cleanup: `killProcessTree(M6)` + `stopDaemonForTest(S6)`.

**Stress loop**: Repeat 5 times. After each iteration, assert no Chromium orphans.

### Step 8: Scenario D1 — Malformed Socket Message Kills Daemon

**File**: `tests/stress/malformed-message.test.ts`

**Test**: `Malformed socket message crashes the daemon via unhandled rejection`

1. Start daemon for sessionId `S7`. Record daemon PID `P7`.
2. Connect to the daemon's Unix socket directly and send malformed bytes: `sendRawSocketMessage(S7, Buffer.from('NOT JSON\x00'))`. The `JSON.parse(message)` at `daemon.ts:229-234` is outside try/catch → throws → unhandled rejection → `cleanup(1)` → daemon exits.
3. Wait for `P7` to exit: `waitForProcessExit(P7, 5000)`.
4. Verify the daemon is no longer running: `isDaemonRunning(S7)` returns false.
5. **Orphan check**: The MCP server child and browser child should have been cleaned up by the daemon's `cleanup()`. Assert `assertNoOrphans(S7)`.
6. **After fix (JSON.parse wrapped in try/catch)**: The daemon should survive. `status` should still work. The test sends the malformed message, then verifies `status` succeeds.
7. **After restart logic is implemented**: If the daemon crashes, a new daemon should be spawned (by a supervisor or by the next CLI invocation's auto-start). The test verifies the next CLI command auto-starts a fresh daemon.

**Stress loop**: Repeat 10 times. Each iteration: start, send malformed, (verify crash or survival), cleanup.

### Step 9: Scenario E2 — OOM Kill Simulation

**File**: `tests/stress/oom-kill.test.ts`

**Test**: `OOM kill of daemon leaves no orphans and system recovers`

1. Start daemon for sessionId `S8`. Record daemon PID `P8`, MCP server `M8`.
2. Simulate OOM kill: `killProcess(P8, 'SIGKILL')` (SIGKILL is what the OOM killer sends). Wait for exit.
3. **Orphan check**: The MCP server `M8` and browser `B8` may be orphaned (re-parented to pid 1) because the daemon was killed with SIGKILL, not SIGTERM — so `cleanup()` never ran. Scan for orphaned `opera-devtools-mcp.js` and `chromium` processes. This is the worst-case: no cleanup at all.
4. **After restart/supervision logic**: A new daemon should be spawned (by a supervisor). If no supervisor exists, the next CLI command should detect the dead daemon (stale pid file — `process.kill(P8, 0)` throws) and auto-start a new one. Verify: `runCli(['status'], S8)` should either show "not running" (and the next `start` creates a fresh daemon) or, with restart logic, show "running" with a new PID.
5. **The key assertion**: after the old daemon is SIGKILL'd, no orphaned MCP server or browser processes remain once the new daemon is started (the new daemon's start should clean up or the old processes should be detected and killed).
6. Cleanup: `stopDaemonForTest(S8)` + `assertNoOrphans(S8)`.

**Stress loop**: Repeat 5 times. Kill daemon, verify recovery (or orphan detection), verify clean state.

### Step 10: Create `tests/stress/runner.test.ts` — Orchestrated Loop

**File**: `tests/stress/runner.test.ts`

This is the main stress test that runs all scenarios in a loop, emulating sustained failure conditions:

1. Define an array of scenario functions: `[testA1, testA2, testB1, testB2, testC1, testC2, testD1, testE2]`.
2. **Loop**: Run `ITERATIONS` (default 20) rounds. Each round:
   - For each scenario: call the scenario function with a fresh sessionId.
   - After each scenario: `assertNoOrphans(sessionId)` — no orphans leaked.
   - Log timing + result for each scenario iteration.
3. **Final assertion**: After all iterations, scan the entire process table. Assert zero `daemon.js`, `opera-devtools-mcp.js`, or `chromium` processes remain (excluding the test runner).
4. **Metrics**: Track pass/fail per scenario per iteration. Report a summary at the end.

The runner uses `describe` + `it` from `node:test` with a single long-running test that loops internally. This avoids the per-test timeout being too short — the overall test timeout is 300s (set in the Docker entry point). Each individual scenario within the loop has its own internal timeout via `waitExecutionFor`.

### Step 11: Docker Container — `docker/stress-test/Dockerfile`

```dockerfile
FROM node:24-slim

# Install Chromium for headless browser testing
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Set Chrome path
ENV OPERA_CLI_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files and install deps
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json .prettierrc* .eslint* ./
COPY src/ ./src/
COPY tests/ ./tests/
COPY scripts/ ./scripts/
COPY third_party/ ./third_party/
COPY rollup.config.js puppeteer.config.js ./
RUN npm run build

# Create non-root user
RUN useradd -m -u 1000 stress
RUN mkdir -p /tmp/stress-home /tmp/stress-run && chown stress:stress /tmp/stress-home /tmp/stress-run
USER stress

# Run stress tests
CMD ["node", "--import", "./build/tests/setup.js", "--test", "--test-force-exit", "--test-timeout=300000", "build/tests/stress/runner.test.js"]
```

**Note on `third_party/`**: This directory contains the vendored DevTools frontend submodule. The Dockerfile copies it, but it's large. If the build fails without it (it's in `tsconfig.json` includes), it must be copied. If `npm run build` doesn't need it for the daemon/MCP tests, it can be skipped to reduce image size. The implementer should test both ways — try building without it first; if `tsc` fails, add it.

### Step 12: Add npm scripts to `package.json`

Add to the `"scripts"` section:

```json
"test:stress": "npm run build && node --import ./build/tests/setup.js --test --test-force-exit --test-timeout=300000 build/tests/stress/runner.test.js",
"test:stress:docker": "docker compose -f docker/stress-test/docker-compose.yml up --build --abort-on-container-exit"
```

### Step 13: Add `docker/stress-test/docker-compose.yml`

```yaml
services:
  stress-test:
    build:
      context: ..
      dockerfile: docker/stress-test/Dockerfile
    working_dir: /app
    environment:
      - OPERA_DEVTOOLS_NO_USAGE_STATISTICS=true
      - OPERA_DEVTOOLS_CRASH_ON_UNCAUGHT=true
      - OPERA_DEVTOOLS_NO_UPDATE_CHECKS=true
      - OPERA_CLI_EXECUTABLE_PATH=/usr/bin/chromium
      - HOME=/tmp/stress-home
      - XDG_RUNTIME_DIR=/tmp/stress-run
    tmpfs:
      - /tmp
    security_opt:
      - seccomp:unconfined
    cap_add:
      - SYS_PTRACE
```

## Critical Files & Anchors

1. **`tests/utils.ts:442-510`** — `createCliEnv()`, `runCli()`, `assertDaemonIsRunning()`, `CLI_PATH`. The stress test helpers import and reuse these. `createCliEnv` strips `OPERA_CLI_*` env vars and sets a throwaway `HOME` + `OPERA_CLI_EXECUTABLE_PATH` — essential for test isolation.

2. **`src/daemon/utils.ts:88-126`** — `getDaemonPid()`, `isDaemonRunning()`, `getPidFilePath()`, `getSocketPath()`. These are imported directly by the stress helpers to read daemon state without going through the CLI. `isDaemonRunning` is the pid-file-only liveness check that the stress test proves insufficient.

3. **`src/daemon/daemon.ts:129-150, 218-298, 312-319`** — `setupMCPClient()` (spawns MCP server, no `onclose` handler), `startSocketServer()` (unlinks socket unconditionally), `cleanup()` (unlinks socket+pid without ownership check), `unhandledRejection` handler (kills daemon on malformed message). These are the code anchors for scenarios B1, A1, A4, D1.

4. **`tests/shutdown.test.ts:1-80`** — Template for direct-spawn process tests: `spawnServer()`, `waitForExit()`, raw JSON-RPC over stdio. The stress test follows this pattern for spawning and killing processes directly.

5. **`src/bin/chrome-devtools-mcp-main.ts:38-81`** — MCP server signal handlers (`SIGTERM`/`SIGINT`/`SIGHUP` → `shutdown()` → `closeBrowser()` → `exit(0)`, 5s backstop), `unhandledRejection` handler (logs only, no crash unless `ENV_CRASH_ON_UNCAUGHT`). No `uncaughtException` handler. Anchor for scenarios B1, B2.

## Verification

> **Superseded** in two ways by what was actually built: the commands below are
> the plan's sketch (the image now ships the host-built `build/` rather than
> compiling, and the run wrapper is `scripts/stress-docker.js`), and the suite
> grew from 8 scenarios to 11. Use
> [docs/stress-testing.md](../stress-testing.md) for the commands that exist, and
> the [As-built reference](#as-built-reference) for the scenario inventory and
> the harness's actual assertions. The Expected Results table below still
> describes the defects the suite is meant to expose.

### End-to-End Proof

The stress test IS the verification. Run it:

```sh
# Build first
cd /Users/opera_user/work/opera-devtools-mcp
npm run build

# Run locally (requires Chrome/Chromium installed)
OPERA_CLI_EXECUTABLE_PATH=$(node -e "console.log(require('puppeteer').executablePath())") \
  node --import ./build/tests/setup.js --test --test-force-exit --test-timeout=300000 build/tests/stress/runner.test.js

# Run in Docker (isolated)
npm run test:stress:docker
```

### Expected Results (Current State — No Restart Logic)

The tests should **expose failures** because no restart/supervision logic exists:

| Scenario              | Expected Current Behavior                  | Expected Post-Fix Behavior                  |
| --------------------- | ------------------------------------------ | ------------------------------------------- |
| A1 (stale pid)        | Orphan detected — old daemon still alive   | Old daemon detected + killed, no orphan     |
| A2 (concurrent start) | Race may produce orphan                    | Lock prevents race, single daemon           |
| B1 (MCP crash)        | Daemon alive, tool calls fail, no restart  | MCP server respawned within 5s              |
| B2 (MCP abort)        | Same as B1                                 | Same as B1                                  |
| C1 (browser crash)    | Lazy recovery works (next call relaunches) | Same (already works)                        |
| C2 (browser SIGKILL)  | Orphaned helpers detected                  | Helpers killed on relaunch                  |
| D1 (malformed msg)    | Daemon crashes via unhandled rejection     | Daemon survives (JSON.parse wrapped)        |
| E2 (OOM kill)         | Daemon dead, MCP+browser orphaned          | Supervisor restarts daemon, orphans cleaned |

### Per-Scenario Smoke Checks

Each scenario test asserts:

1. **No orphans**: After the scenario, `assertNoOrphans(sessionId)` passes — zero `daemon.js`, `opera-devtools-mcp.js`, or `chromium` processes remain.
2. **Recovery** (post-fix): After killing a process, the system recovers within a timeout — new process spawned, tool calls succeed.
3. **Idempotency**: Running the scenario multiple times doesn't accumulate orphans.

The runner test asserts the final process table is clean after all iterations.

## Assumptions & Contingencies

- **Chromium in Docker**: The `node:24-slim` image doesn't include Chrome. Using the Debian `chromium` package is simpler than Puppeteer's browser installer. If `chromium` package isn't available or has sandbox issues in the container, fall back to `npx puppeteer browsers install chrome` and set `PUPPETEER_EXECUTABLE_PATH`. If Chrome can't run at all in Docker, the browser-crash scenarios (C1, C2) can be tested with a mock process that mimics the browser's parent-child relationship — but this is a last resort.

- **`third_party/` in Docker build**: The `tsconfig.json` includes `third_party/devtools-frontend/**` paths. If `npm run build` fails without the submodule, the Dockerfile must `COPY third_party/ ./third_party/` (and it must be initialized via `git submodule update --init`). If this makes the image too large, the implementer can try removing the `third_party` entries from `tsconfig.json` includes for the stress test build — but this risks breaking the build. Default: copy it.

- **Process table scanning inside Docker**: `ps -eo pid,ppid,command` must be available in the container. `node:24-slim` is Debian-based; `ps` is in `procps` which may not be installed by default. Add `procps` to the `apt-get install` line in the Dockerfile if `ps` is missing.

- **`SYS_PTRACE` capability**: Needed for `process.kill(pid, 0)` liveness checks to work on processes not owned by the test runner. In the Docker container, the test runs as user `stress` (uid 1000) and all spawned processes are children of that user, so `process.kill` should work without `SYS_PTRACE`. The capability is added as a safety net.

- **Test timeout**: The runner test loops 20 iterations × 8 scenarios. Each scenario takes 2-10 seconds (start daemon, kill process, verify). Total: ~5-25 minutes. The 300s (5 min) Docker CMD timeout may be too short. The implementer should set `--test-timeout=600000` (10 min) and `ITERATIONS=10` for the first run, then tune.

- **`OPERA_DEVTOOLS_CRASH_ON_UNCAUGHT=true`**: Set in the Docker env. This causes the MCP server to crash on `unhandledRejection` (the `ENV_CRASH_ON_UNCAUGHT` check at `chrome-devtools-mcp-main.ts:38`). This is intentional for the stress test — we WANT crashes to be visible, not silently swallowed. However, for scenario D1 (malformed message), the daemon's own `unhandledRejection` handler calls `cleanup(1)` regardless of this env var — it's hardcoded in `daemon.ts:316-319`.

- **Remaining scenarios for Phase 2**: A3 (pid recycling), A4 (cleanup unlinks wrong files), A5 (bind fail after pid write), B3 (MCP killed mid-call), B4 (MCP shutdown hangs), C3 (browser crash during AI relaunch), D2 (sendCommand timeout), D3 (socket ECONNRESET), E1 (/tmp cleanup), E3 (FD exhaustion), F1 (watchdog not a supervisor). These will be added as additional test files under `tests/stress/` in the next iteration.

## As-built reference

This section describes what exists in the repository today. Where it disagrees
with the step-by-step plan above, this wins.

### Scenario inventory

12 scenarios, all asserted as **robustness properties** (no orphan survives,
recovery happens) rather than as descriptions of today's behaviour, so a red run
is the bug report and the suite goes green when the system is fixed.

| ID  | File                         | Asserts                                                                                            | Expected today                                                                           |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A1  | `daemon-orphan.test.ts`      | a daemon hidden by a deleted pid file is reaped by the next `start`                                | **passing** since the daemon-supervision work (`STRESS_TEST_ROBUSTNESS_PLAN.md`)         |
| A2  | `daemon-orphan.test.ts`      | concurrent `start`s leave exactly one daemon, and the pid file names it                            | **passing** since the daemon-supervision work                                            |
| B1  | `mcp-server-crash.test.ts`   | a SIGKILLed MCP server is respawned within 5s and tools work again                                 | **passing** since the daemon-supervision work                                            |
| B2  | `mcp-server-crash.test.ts`   | same, for an aborted (SIGABRT) MCP server                                                          | **passing** since the daemon-supervision work                                            |
| C1  | `browser-crash.test.ts`      | a crashed browser is relaunched on the next tool call, on a new pid                                | **passing** (the relaunch always worked; it failed on an over-broad assertion)           |
| C2  | `browser-crash.test.ts`      | SIGKILLing the browser leaves no orphaned helper processes                                         | **passing** since the browser process-group kill                                         |
| D1  | `malformed-message.test.ts`  | malformed socket input does not take the daemon down                                               | **passing** since the socket-frame guard                                                 |
| E2  | `oom-kill.test.ts`           | a SIGKILLed daemon leaves no process of its session behind, and the session recovers               | **passing** since the stdin-EOF teardown chain                                           |
| G1  | `persistent-profile.test.ts` | a non-isolated browser is reused across commands, on the profile it was given                      | **passing**                                                                              |
| G2  | `persistent-profile.test.ts` | a crashed persistent-profile browser is relaunched on the same profile                             | **passing**                                                                              |
| G3  | `persistent-profile.test.ts` | a second session on one persistent profile fails without disturbing the first or leaking a browser | **passing**                                                                              |
| H1  | `browser-crash.test.ts`      | a browser left with no pages (the user closed them) is served by opening one, in the same browser  | **passing** since the page-recovery change; see `docs/specs/browser-session-recovery.md` |

Much of the value is in the failures: C1 passing while C2 fails is what
separates "the relaunch works" from "the dead browser's helpers are never
reaped".

E2's scope is deliberate. It asserts on **every** process of the session
(`assertNoOrphansWithin`), not on the daemon's two direct children: the MCP
server's stdio pipe to the daemon breaks with the daemon, so it can exit on its
own — the OS closing a pipe, not a supervision mechanism — and waiting on those
pids alone would then pass while the browser and its helpers were still running.
Session-wide is what makes a green E2 evidence of a reaper or a process-group
kill rather than of one lucky exit.

### Harness design (`tests/stress/helpers.ts`)

The plan assumed orphan detection could scan for `daemon.js`,
`opera-devtools-mcp.js` and `chromium` because "the container runs only the
test". That premise is unsafe outside a container (it would match the developer's
own Opera/Chrome, and the sweep could kill them) and environment variables are
invisible to `ps` on macOS, so identity is derived from the command line instead:

- **Session marker.** Every session's `start` carries
  `--chrome-arg=--stress-session-tag=<sessionId>`. The CLI serializes it into the
  daemon's argv, the daemon forwards it to the MCP server, and Puppeteer appends
  it to the browser's launch args, so all three roles — and their descendants —
  carry a token this run minted. `findSessionProcesses()` matches on it, plus any
  `--user-data-dir` a _browser_ of that session was seen using (a daemon's argv
  mentions the profile too, so daemon-side matching would make two sessions
  sharing a profile attribute each other's processes), **plus everything below a
  matched process**. The tree walk is not optional: the MCP server sets
  `process.title`, which rewrites its argv, so `ps` reports it as the bare
  product name with the marker gone — it is reachable only as a child of its
  daemon. Chrome's helpers have the mirror-image problem, never inheriting the
  launch switches.
- **Roles come from the command line, and two of them are easy to get wrong.**
  `opera-devtools-mcp` (the title form) has to be matched before the
  `Chrome|chromium|Opera` heuristic, which otherwise classifies the MCP server
  as a browser; `chrome_crashpad_handler` is the one Chromium child with no
  `--type=` switch and counts as a helper, or a persistent-profile scenario sees
  two browsers where there is one.
- **One composition point per launch.** `sessionStartArgs()` owns the verb, the
  marker and the `STRESS_CHROME_ARGS` switches; `persistentProfileArgs()` adds
  only the profile extras of the non-isolated launch. A helper that returned a
  complete argv for one call site and a partial one for another put the marker on
  the command line twice (yargs collects `--chrome-arg` into an array, so it was
  harmless, but it made the argv unreadable and duplicated any extra switch).
- **Ownership registry.** Processes discovered as session-owned are recorded with
  a command prefix, and re-validated before any signal, so a recycled pid can
  never be hit.
- **An orphan is a session process outside the live tree**, not "any session
  process at all". `assertNoOrphans`/`assertNoOrphansWithin` subtract the daemon
  the pid file names and its descendants, so a running session is not a leak;
  what remains is what outlived its place in that tree — the daemon a stale pid
  file hides (re-parented to init), the helpers of a browser that was killed, a
  second daemon from a lost start race. With no live daemon the live tree is
  empty and the assertion is as strict as before, which is what keeps it
  meaningful in `cleanupSession` and the round-level leak check. The alternative
  reading — "the session owns no processes" — counted the live daemon, its MCP
  server and its browser as orphans, so every scenario that asserted while its
  session was up reported a working product as broken. C1 was the first instance
  of this (its assertion was dropped); the remaining call sites are fixed here
  rather than dropped, because the live-tree form still catches the defect each
  of them exists to find.
- **Kill interlock.** `STRESS_ALLOW_PROCESS_KILLS=true` must be set _and_ the
  target must be session-owned; otherwise signalling throws. Without the env var
  every destructive scenario skips in milliseconds, which is why `npm test` is
  unaffected.
- **Quiet CLI runner** (`runCliQuiet`): same binary and isolated env as
  `tests/utils.ts`'s `runCli`, but output is captured rather than echoed — a run
  makes thousands of calls and the echo buried the report.
- **Run-level accounting**: round-level leak checks are collected instead of
  aborting the run (a failure there used to consume the report), and
  `ps` failures surface as `cannot read the process table (…)` because without
  `ps` no orphan assertion means anything.
- **Artifact cleanup is unconditional**: browser profiles the suite created are
  removed in a `finally`, since a failing sweep or assertion is the _normal_ case
  for a red run.

### Runner behaviour (`tests/stress/runner.test.ts`)

Runs all 12 scenarios for `STRESS_ITERATIONS` rounds (default 20). A scenario
that fails is **not repeated**: its defect is deterministic, so repeating it only
re-buys the same failure at the cost of its timeouts; passing scenarios are
repeated, which is what hunts flakiness. The report lists per-scenario passes,
failures and skipped runs, every failure message, and any run-level failures.

### Container (`tests/stress/docker/`)

- **The image does not compile.** `scripts/stress-docker.js` runs `npm run build`
  on the host and the Dockerfile copies `build/`, because a cold `tsc` over the
  vendored devtools-frontend tree exceeds the heap a container derives from its
  cgroup limits — it dies with `FATAL ERROR: Ineffective mark-compacts near heap
limit` at ~1 GB inside a default colima VM. `build/` is self-contained; the
  published package ships `build/src` alone.
- **`.dockerignore` is load-bearing**: without it every build shipped ~2.3 GB
  (`.git` 1.3 GB, root `node_modules` 320 MB, `third_party` 655 MB) before the
  first layer ran; with it the context is ~35 MB. `**/node_modules` must _not_ be
  used — `tsc` resolves `devtools-protocol`/`webdriver-bidi-protocol` types from
  the submodule's `node_modules` — and `front_end/panels` (200 MB) is excluded on
  evidence: `tsc --listFiles` compiles none of it.
- **`npm ci --ignore-scripts`** keeps the dependency layer keyed on the lockfile;
  `scripts/prepare.ts` (which patches a `.d.ts` `tsc` depends on) runs explicitly
  in the build step. The only install scripts in the tree are Puppeteer's Chrome
  download (already suppressed), eslint's native resolver, and four
  no-op/banner/warning scripts.
- **Chromium, both ways**: `OPERA_CLI_EXECUTABLE_PATH` for the daemon and
  `PUPPETEER_EXECUTABLE_PATH` for `createCliEnv()`, which otherwise prefers
  `puppeteer.executablePath()` and would point children at a browser the image
  never downloaded.
- **`USER node`** rather than a new `stress` user: the base image already has
  UID 1000, so `useradd --uid 1000` fails. `/app` stays root-owned and read-only
  to the suite.
- **The container's rounds belong to the caller**: compose resolves
  `STRESS_ITERATIONS` and `STRESS_CHROME_ARGS` from the shell
  (`${STRESS_ITERATIONS:-3}`, `${STRESS_CHROME_ARGS:-}`), and
  `scripts/stress-docker.js` forwards the same two names on its no-compose
  fallback. A hardcoded count on that fallback once tripled a run's duration, and
  neither path honoured the caller's value at all.
- `procps` for `ps`, `chromium`, `ca-certificates`; `--tmpfs /tmp` and
  `--security-opt seccomp=unconfined` in compose; `--test-timeout=1800000`
  because a red run spends 5-15s inside every failing scenario.
- **The container runs with an init** (`init: true`, `docker run --init`). The
  daemons under test are `detached: true`, and the CLI that starts them exits
  immediately, so they are re-parented to pid 1. Without a reaping pid 1 — the
  image's CMD `exec`s the node runner, which is not one — an exited daemon stays
  in the process table as a zombie, and `process.kill(pid, 0)`, the liveness
  check this suite and the product both use, calls a zombie alive. That turned
  A1's "the hidden daemon was reaped" and E2's "the daemon did not survive
  SIGKILL" into assertions about the container instead of the product, and
  inflated every cleanup by the length of its exit wait.

### Deviations from the plan, and why

| Plan                                                    | As built                                                                    | Why                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scan for `daemon.js`/`opera-devtools-mcp.js`/`chromium` | session-marker + ownership registry                                         | an unscoped scan matches the developer's real browsers, and env vars are invisible to `ps` on macOS                                                                                                                                     |
| Scenario bodies inside each `.test.ts`                  | bodies in `scenarios.ts`, registered by thin `.test.ts` wrappers            | the runner imports the scenarios; defining them in `.test.ts` files would register every wrapper twice                                                                                                                                  |
| A1/A2 assert the defect                                 | all scenarios assert the robustness property                                | one rule, and a red run reports the same evidence                                                                                                                                                                                       |
| C1 also asserts no orphans                              | C1 asserts recovery only                                                    | C1 was failing on a working relaunch because it tripped over C2's defect                                                                                                                                                                |
| "No orphans" = the session owns no processes            | "No orphans" = nothing outside the live daemon's tree                       | the strict form counted the live daemon, its MCP server and its browser as orphans, so A2/D1/C2/B1/B2 reported a working product as broken (the same class as the C1 fix, applied to the remaining call sites instead of deleting them) |
| Pids are found by the session marker                    | marker match **plus descendants of matches**                                | the MCP server's `process.title` erases its marker from `ps`, so B1/B2/C1/E2 could not find it at all and timed out looking                                                                                                             |
| Roles: daemon / mcp-server / browser / helper           | + the title form of the MCP server, + `chrome_crashpad_handler` as a helper | `opera-devtools-mcp` matched the `Opera` browser heuristic, and crashpad is the one Chromium child with no `--type=` switch                                                                                                             |
| Container: runner is pid 1                              | `init: true` (tini)                                                         | detached daemons re-parent to pid 1; a non-reaping pid 1 leaves them zombies that `kill(pid, 0)` calls alive                                                                                                                            |
| D1 reaches the browser                                  | D1 reaches it once, at the end                                              | the scenario's own subject is socket parsing (no browser needed for that), but it proves the daemon still serves a _tool_ call afterwards — which means a cold Chrome start, ~5s                                                        |
| Derived persistent profile                              | explicit `--userDataDir=<suite-owned dir>`                                  | immune to `--isolated` defaults and to `OPERA_CLI_*` promotion (which on a machine with Opera installed can point at the real profile)                                                                                                  |
| Container compiles the project                          | host builds, image copies `build/`                                          | `tsc` OOMs against a container's cgroup-derived heap                                                                                                                                                                                    |
| compose `build: docker/stress-test` + env in compose    | context `../../..`, `dockerfile:` set, build-time env in the Dockerfile     | the plan's two compose snippets contradicted each other and the context did not resolve                                                                                                                                                 |
| `--test-timeout=300000`, `ITERATIONS=10`                | `1800000`, `STRESS_ITERATIONS=3` (caller-overridable)                       | failing scenarios each burn a recovery timeout; the plan itself asked for these to be tuned                                                                                                                                             |
| Phases A3…F1                                            | not implemented                                                             | out of this iteration's scope; still listed above as Phase 2                                                                                                                                                                            |

### Verification status

Proven by execution during implementation: `tsc --noEmit`, `npm run build`,
`eslint`, `prettier`, `docker-compose config`, the compose-frontend resolver's
dispatch and exit-code propagation, that the persistent-profile argv parses,
that all 11 scenarios register and skip cleanly without the kill interlock
(9 files, 0 processes spawned), the runner's failure accounting and
skip-after-failure behaviour, and that session-owned profile directories are
removed even when cleanup fails.

Not yet proven, and requiring a container run: the scenarios' own assertions
against real processes. The suite has executed in the container and reported
failures for A1, A2, B1, B2, C2, D1 and E2 plus unexpected failures for C1,
which is what prompted the C1 scope fix, the trimmed timeouts and the
skip-after-failure change; G1-G3 have never run against a browser.

**First container run after the robustness mechanisms landed** (round 1 of 3,
G1-G3 passing in all three rounds, 8 failures) — what the failures actually
were, read off the assertion messages rather than the scenario names:

- **B1, B2, C1, E2 — `timed out waiting for a mcp-server process`.** The harness
  could not see the MCP server at all: `process.title` erases its marker from
  `ps`, and the role heuristic called it a browser. No scenario about the MCP
  server (or about a browser crash, which waits for the MCP server to survive)
  could assert anything. Fixed by the descendant walk and the role order above.
- **A2, C2, D1 — `orphaned processes` listing the _live_ session tree.** The
  dumps show the daemon (ppid 1, `state=Ssl`), its MCP server (`opera-devtools-mcp`,
  mis-labelled `[browser]`) and, in C2/D1, the live browser: a healthy session,
  reported as a leak. In C2 the eight helpers of the killed browser were _absent_
  from the dump — the group kill worked; the assertion was the broken part. Fixed
  by the live-tree scoping above.
- **A1 — `daemon 34 survived the restart`.** The one assertion in the run that
  is not explained by the harness: the probe-and-stop path exists for exactly
  this case and did not leave a live daemon, but the run took 10.9s, which is the
  probe plus a full 5s exit wait. A stopped daemon is re-parented to pid 1 when
  its CLI exits, and pid 1 here was the node runner, which does not reap what it
  did not spawn: the daemon exits, stays in the table as a zombie, and
  `process.kill(pid, 0)` calls it alive. Fixed in the container (an init that
  reaps), and hardened in the product (`ensureCleanStart` escalates to a
  process-group kill when a daemon it asked to stop is still there).

A1's underlying product behaviour is therefore still "assumed fixed, not proven";
the next container run is what settles it.

Re-verified after the review fixes (no container available in that environment,
and its sandbox denies `ps` outright, so the process table was served by a stub
for the harness-level checks): `docker-compose config` interpolation with and
without a caller-supplied `STRESS_ITERATIONS`/`STRESS_CHROME_ARGS`, the
no-compose fallback's `docker run` arguments in all three cases (set, unset,
empty), and, through a throwaway script driving the built helper, that a composed
persistent-profile launch carries the session marker exactly once, that
`profileDirOf` reads quoted and unquoted values, that a whitespace path is
refused before any profile directory is allocated (a `TMPDIR` or a scenario label
is where that whitespace could come from, since `mkdtempSync`'s own suffix is
alphanumeric), that `waitFor` returns a found `null` immediately, that the
ownership walk claims an unmarked browser helper and nothing unrelated, that
`cleanupSession` removes the profile directory it minted, and that E2's
session-wide assertion fails when the MCP server exits on its own but the browser
survives — the case the pid-based wait used to let through. The scenarios still
register and skip cleanly (12 skipped, 0 processes spawned).
