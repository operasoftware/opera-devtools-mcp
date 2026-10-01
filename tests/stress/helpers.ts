/**
 * @license
 * Copyright 2026 Opera Software AS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Process-table harness shared by every stress scenario.
 *
 * The existing `tests/utils.ts` helpers assert liveness through the CLI, which
 * itself relies on the pid file. The stress suite needs to observe the OS
 * process table directly, because every scenario it exercises is about
 * processes that the pid file does *not* account for (orphans, ghosts,
 * never-reaped children).
 *
 * Session identity comes from the command line: the daemon is started with
 * `--chrome-arg=--stress-session-tag=<sessionId>`, which the CLI serializes
 * into the daemon's argv, the MCP server's argv (the daemon forwards the same
 * mcpArgs) and the browser's argv (puppeteer appends `chromeArg` to the launch
 * args). Every process that belongs to a session therefore carries a marker
 * this run minted, and nothing is ever matched, let alone signalled, without
 * one. That is what makes the orphan assertions safe to run on a developer
 * machine instead of only inside a disposable container.
 *
 * Signalling is double-gated:
 *  - `STRESS_ALLOW_PROCESS_KILLS=true` must be set (the stress runner sets it;
 *    the container sets it; a plain `npm test` never does), and
 *  - the target pid must have been discovered as session-owned beforehand.
 */

import assert from 'node:assert';
import {execFile, spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {describe, it} from 'node:test';
import {promisify} from 'node:util';

import {
  getDaemonPid,
  getPidFilePath,
  getSocketPath,
  IS_WINDOWS,
} from '../../src/daemon/utils.js';
import {PERSISTENT_PROFILE_IGNORE_DEFAULT_ARGS} from '../../src/opera/envConfig.js';
import {CLI_PATH, createCliEnv} from '../utils.js';

const execFileAsync = promisify(execFile);

/**
 * `tests/utils.ts`'s `runCli` echoes every child's stdout/stderr into the test
 * process, which is right for a handful of CLI assertions and wrong for a
 * stress loop: a run makes thousands of calls, and the echo buries the report
 * in `list_pages` listings. Same binary, same isolated env, captured output.
 */
export async function runCliQuiet(
  args: string[],
  sessionId: string,
): Promise<{status: number | null; stdout: string; stderr: string}> {
  const env = await createCliEnv();
  const {promise, resolve, reject} = Promise.withResolvers<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>();
  const child = spawn('node', [CLI_PATH, ...args, '--sessionId', sessionId], {
    env,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => (stdout += chunk));
  child.stderr.on('data', chunk => (stderr += chunk));
  child.on('close', status => resolve({status, stdout, stderr}));
  child.on('error', reject);
  return promise;
}

/** Stress scenarios kill and scan processes; neither works without `ps`. */
export const STRESS_SUPPORTED = !IS_WINDOWS;

export const ENV_ALLOW_KILLS = 'STRESS_ALLOW_PROCESS_KILLS';
export const ENV_ITERATIONS = 'STRESS_ITERATIONS';

/**
 * Extra Chrome switches for a session's browser, space separated, e.g.
 * `STRESS_CHROME_ARGS=--no-sandbox` for a container whose Chrome refuses to
 * start under the default sandbox. `OPERA_CLI_CHROME_ARGS` cannot be used:
 * `createCliEnv()` strips every `OPERA_CLI_*` variable from child processes.
 */
export const ENV_CHROME_ARGS = 'STRESS_CHROME_ARGS';

/** Rounds the runner executes when `STRESS_ITERATIONS` is unset. */
export const DEFAULT_ITERATIONS = 20;

/** Marker switch carried by every process of a stress session. */
export const SESSION_TAG_FLAG = '--stress-session-tag';

const PS_ARGS = ['-ww', '-eo', 'pid,ppid,stat,command'];
const POLL_INTERVAL_MS = 100;

export interface ProcInfo {
  pid: number;
  ppid: number;
  /** `ps` state column; `Z` marks a zombie that nobody reaped. */
  state: string;
  command: string;
}

export type ProcRole =
  'daemon' | 'mcp-server' | 'browser' | 'browser-helper' | 'cli' | 'unknown';

export interface SessionProcess extends ProcInfo {
  role: ProcRole;
}

/**
 * A `ps` row that may already carry its role. `SessionProcess` is this with
 * `role` required, so `describeProcs` accepts classified and raw snapshots
 * alike without a cast.
 */
export type DescribedProc = ProcInfo & {role?: ProcRole};

interface OwnedProc {
  pid: number;
  /** Command prefix, re-checked before signalling so a recycled pid is never hit. */
  token: string;
}

const ownedProcs = new Map<string, Map<number, OwnedProc>>();
const ownedUserDataDirs = new Map<string, Set<string>>();
/** Profile dirs this suite created; removed when the session is cleaned up. */
const ownedProfileDirs = new Map<string, Set<string>>();
/** Every session this run touched, for the run-level leak assertion. */
const touchedSessions = new Set<string>();

export function processKillsAllowed(): boolean {
  return process.env[ENV_ALLOW_KILLS] === 'true';
}

export function getIterations(): number {
  const raw = process.env[ENV_ITERATIONS];
  if (!raw) {
    return DEFAULT_ITERATIONS;
  }
  const parsed = Number.parseInt(raw, 10);
  assert.ok(
    Number.isFinite(parsed) && parsed > 0,
    `${ENV_ITERATIONS} must be a positive integer, got ${raw}`,
  );
  return parsed;
}

export function sessionTag(sessionId: string): string {
  assertValidSession(sessionId);
  return `${SESSION_TAG_FLAG}=${sessionId}`;
}

/**
 * The `start` invocation every scenario uses: the session marker plus any
 * switches `STRESS_CHROME_ARGS` asks for.
 */
export function sessionStartArgs(sessionId: string): string[] {
  const extra = (process.env[ENV_CHROME_ARGS] ?? '')
    .split(/\s+/)
    .filter(Boolean);
  return [
    'start',
    ...extra.map(arg => `--chrome-arg=${arg}`),
    `--chrome-arg=${sessionTag(sessionId)}`,
  ];
}

/**
 * The switches of the non-isolated launch, i.e. the one the product actually
 * exists for: the browser runs against a persistent profile instead of a
 * throwaway one. Extras only - `startDaemonForTest` adds the verb, the session
 * marker and any `STRESS_CHROME_ARGS` switches itself, so this composes with it
 * instead of duplicating its flags.
 *
 * The profile directory is passed explicitly rather than left to be derived,
 * for two reasons: `--userDataDir` beats both the CLI's `--isolated` default
 * and anything `applyEnvToArgv` would promote from `OPERA_CLI_*` (it skips a
 * flag that is already present), and the scenarios can then assert that the
 * relaunched browser really is reusing the profile they handed it.
 *
 * The reverted Puppeteer defaults are not cosmetic: a mocked keychain and
 * `--password-store=basic` make a real profile launch logged out, and the
 * component-extension blockers stop the Opera AI extension from loading at all
 * (see `PERSISTENT_PROFILE_IGNORE_DEFAULT_ARGS`).
 */
export function persistentProfileArgs(profileDir: string): string[] {
  return [
    `--userDataDir=${profileDir}`,
    ...PERSISTENT_PROFILE_IGNORE_DEFAULT_ARGS.map(
      arg => `--ignore-default-chrome-arg=${arg}`,
    ),
    '--chrome-arg=--show-component-extension-options',
  ];
}

/**
 * A profile directory the suite owns, registered for removal when the session
 * is cleaned up. Two sessions can be pointed at the *same* directory to
 * reproduce profile-lock contention, which is why this is not per-process.
 */
export function createProfileDir(sessionId: string, label: string): string {
  // The directory is read back out of a command line by `profileDirOf`, and
  // `ps` prints argv joined by spaces with no quoting, so a path containing
  // whitespace would be read back truncated and the ownership net would
  // silently stop covering the browser. Checked on the prefix, *before*
  // `mkdtempSync` allocates: a guard that fires must not leak the directory it
  // just created. `mkdtempSync`'s own suffix is alphanumeric, so the prefix is
  // where whitespace could come from - `os.tmpdir()` or a scenario's label.
  const prefix = path.join(os.tmpdir(), `opera-stress-${label}-`);
  assert.ok(
    !/\s/.test(prefix),
    `profile directories must not contain whitespace: ${prefix}`,
  );
  const dir = fs.mkdtempSync(prefix);
  const dirs = ownedProfileDirs.get(sessionId) ?? new Set<string>();
  dirs.add(dir);
  ownedProfileDirs.set(sessionId, dirs);
  return dir;
}

/** The `--user-data-dir=` a process was launched with, if any. */
export function profileDirOf(command: string): string | null {
  // Alternation, not `\S+`: a launcher that quotes the value (some wrappers
  // do) must yield the directory rather than the token including its quotes.
  const match = /--user-data-dir=(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

/**
 * A failure scenario. `run` performs one iteration against one fresh session
 * and asserts the robustness property - no orphans, automatic recovery - so a
 * defect surfaces as a failing assertion naming the processes it found.
 */
export interface Scenario {
  id: string;
  title: string;
  /** Iterations when the scenario runs through its own `.test.ts` wrapper. */
  iterations: number;
  run: (sessionId: string) => Promise<void>;
}

/** Why a stress test is not running, or `false` when it can. */
export function stressSkipReason(): string | false {
  if (!STRESS_SUPPORTED) {
    return 'stress scenarios need `ps` (POSIX only)';
  }
  if (!processKillsAllowed()) {
    return `${ENV_ALLOW_KILLS} is not 'true' (see docs/specs/stress-test-system-plan.md)`;
  }
  return false;
}

/**
 * Run one scenario iteration, then always clean the session up. The scenario's
 * own failure wins over a cleanup failure, so the defect that broke the
 * scenario is never masked by the reap that follows it.
 */
export async function runScenarioIteration(
  scenario: Scenario,
  sessionId: string,
  context: string,
): Promise<void> {
  let failure: unknown;
  try {
    await scenario.run(sessionId);
  } catch (error) {
    failure = error;
  }
  try {
    await cleanupSession(sessionId);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    const message =
      failure instanceof Error ? failure.message : String(failure);
    throw new Error(`${scenario.id} ${context}: ${message}`, {cause: failure});
  }
}

/** Register a scenario as its own `node:test` case, iterating in-file. */
export function describeScenario(scenario: Scenario): void {
  // `describe`/`it` return promises that a test file never awaits; this module
  // is not a `.test.ts` file, so it cannot lean on the lint exemption the
  // eslint config grants test files (see `eslint.config.js`).
  void describe(`${scenario.id}: ${scenario.title}`, () => {
    void it(
      `survives ${scenario.iterations} iterations`,
      {skip: stressSkipReason()},
      async () => {
        for (let iteration = 1; iteration <= scenario.iterations; iteration++) {
          await runScenarioIteration(
            scenario,
            crypto.randomUUID(),
            `iteration ${iteration}/${scenario.iterations}`,
          );
        }
        await assertNoRunLeftovers();
      },
    );
  });
}

function assertValidSession(sessionId: string): void {
  assert.ok(
    /^[a-fA-F0-9-]+$/.test(sessionId),
    `stress sessions need a real sessionId, got "${sessionId}"`,
  );
}

/**
 * Start a CLI-runnable session and remember it, so the run-level leak check
 * covers scenarios that fail half way through.
 */
export function touchSession(sessionId: string): void {
  touchedSessions.add(sessionId);
}

// ---------- pid/process primitives ----------

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but is owned by someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function getSessionPaths(sessionId: string): {
  socketPath: string;
  pidFilePath: string;
} {
  return {
    socketPath: getSocketPath(sessionId),
    pidFilePath: getPidFilePath(sessionId),
  };
}

/** One `ps` snapshot of the whole table, minus this test process. */
export async function listProcesses(): Promise<ProcInfo[]> {
  let stdout: string;
  try {
    ({stdout} = await execFileAsync('ps', PS_ARGS, {
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (error) {
    // Without `ps` there is no orphan detection at all, so say so plainly
    // instead of failing later with a bare `spawn EPERM`.
    throw new Error(
      `cannot read the process table (\`ps ${PS_ARGS.join(' ')}\` failed): ${
        (error as Error).message
      }`,
      {cause: error},
    );
  }
  const procs: ProcInfo[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    if (pid === process.pid) {
      continue;
    }
    procs.push({
      pid,
      ppid: Number(match[2]),
      state: match[3],
      command: match[4],
    });
  }
  return procs;
}

export async function findProcesses(
  pattern: RegExp | string,
): Promise<ProcInfo[]> {
  const matcher =
    typeof pattern === 'string'
      ? (command: string) => command.includes(pattern)
      : (command: string) => pattern.test(command);
  return (await listProcesses()).filter(proc => matcher(proc.command));
}

export function classifyProcess(command: string): ProcRole {
  if (/[/\\]daemon\.js(\s|$)/.test(command)) {
    return 'daemon';
  }
  if (/[/\\]opera-devtools-mcp\.js(\s|$)/.test(command)) {
    return 'mcp-server';
  }
  if (/[/\\]opera-browser-cli\.js(\s|$)/.test(command)) {
    return 'cli';
  }
  // `process.title` rewrites argv, so `ps` shows the MCP server as the bare
  // product name and the script path above is gone. It has to be matched
  // exactly - a substring test would also catch it inside a longer command line
  // - and before the browser heuristic below, which matches the "opera" in it.
  if (/^opera-devtools-mcp(\s|$)/.test(command)) {
    return 'mcp-server';
  }
  if (/--type=[a-z-]+/.test(command)) {
    return 'browser-helper';
  }
  // Chromium's crash reporter is the one child that carries no `--type=`
  // switch but is still a child, not the browser itself.
  if (/[/\\]chrome_crashpad_handler(\s|$)/.test(command)) {
    return 'browser-helper';
  }
  if (/(Chrome|chromium|Opera)/i.test(command)) {
    return 'browser';
  }
  return 'unknown';
}

/** `ppid -> child pids` over one `ps` snapshot, so tree walks index it once. */
function childIndex(snapshot: readonly ProcInfo[]): Map<number, number[]> {
  const childrenOf = new Map<number, number[]>();
  for (const proc of snapshot) {
    const children = childrenOf.get(proc.ppid);
    if (children) {
      children.push(proc.pid);
    } else {
      childrenOf.set(proc.ppid, [proc.pid]);
    }
  }
  return childrenOf;
}

function ownedToken(command: string): string {
  return command.slice(0, 120);
}

/**
 * Every process that belongs to a session: those that carry its marker, those
 * that run out of a profile directory its browser created, and everything below
 * either.
 *
 * The descendant walk is what makes the MCP server reachable at all. It sets
 * `process.title`, so `ps` reports it as the bare product name: the marker it
 * was started with is gone from its command line, and it can only be found as a
 * child of the daemon. Chrome's helpers are the same problem from the other
 * end - they never inherit the launch switches.
 */
export async function findSessionProcesses(
  sessionId: string,
): Promise<SessionProcess[]> {
  const tag = sessionTag(sessionId);
  const profileDirs = ownedUserDataDirs.get(sessionId) ?? new Set<string>();
  const procs = await listProcesses();
  const matched = procs.filter(proc => {
    if (proc.command.includes(tag)) {
      return true;
    }
    const dir = profileDirOf(proc.command);
    return dir !== null && profileDirs.has(dir);
  });

  const childrenOf = childIndex(procs);
  const byPid = new Map(procs.map(proc => [proc.pid, proc] as const));
  const session = new Map<number, ProcInfo>(
    matched.map(proc => [proc.pid, proc]),
  );
  let frontier = matched.map(proc => proc.pid);
  while (frontier.length) {
    const next: number[] = [];
    for (const pid of frontier) {
      for (const child of childrenOf.get(pid) ?? []) {
        const proc = byPid.get(child);
        if (!proc || session.has(child)) {
          continue;
        }
        session.set(child, proc);
        next.push(child);
      }
    }
    frontier = next;
  }

  return [...session.values()].map(proc => ({
    ...proc,
    role: classifyProcess(proc.command),
  }));
}

/**
 * Record a session's processes (and their whole descendant trees) as owned.
 *
 * Descendants matter because Chrome's helpers do not necessarily inherit the
 * launch switch, but they do stay in the parent-child tree of the browser
 * process until something kills the parent.
 */
export async function registerSessionProcesses(
  sessionId: string,
): Promise<SessionProcess[]> {
  touchSession(sessionId);
  const found = await findSessionProcesses(sessionId);
  const all = new Map<number, ProcInfo>(found.map(proc => [proc.pid, proc]));

  for (const proc of found) {
    const dir = proc.role === 'browser' ? profileDirOf(proc.command) : null;
    if (dir) {
      const dirs = ownedUserDataDirs.get(sessionId) ?? new Set<string>();
      dirs.add(dir);
      ownedUserDataDirs.set(sessionId, dirs);
    }
  }

  // Tree walk from a snapshot, so a dying parent cannot hide its children.
  const snapshot = await listProcesses();
  const childrenOf = childIndex(snapshot);
  const byPid = new Map(snapshot.map(proc => [proc.pid, proc] as const));
  const walked = new Set(found.map(proc => proc.pid));
  let frontier = found.map(proc => proc.pid);
  while (frontier.length) {
    const next: number[] = [];
    for (const pid of frontier) {
      for (const child of childrenOf.get(pid) ?? []) {
        if (walked.has(child)) {
          continue;
        }
        walked.add(child);
        next.push(child);
        const proc = byPid.get(child);
        if (proc && !all.has(child)) {
          all.set(child, proc);
        }
      }
    }
    frontier = next;
  }

  const registry = ownedProcs.get(sessionId) ?? new Map<number, OwnedProc>();
  for (const proc of all.values()) {
    registry.set(proc.pid, {pid: proc.pid, token: ownedToken(proc.command)});
  }
  ownedProcs.set(sessionId, registry);
  return found;
}

/** A registered pid that is alive *and* still running the command we recorded. */
async function liveOwnedProcs(sessionId: string): Promise<ProcInfo[]> {
  const registry = ownedProcs.get(sessionId);
  if (!registry?.size) {
    return [];
  }
  const byPid = new Map(
    (await listProcesses()).map(proc => [proc.pid, proc] as const),
  );
  const live: ProcInfo[] = [];
  for (const [pid, owned] of registry) {
    const proc = byPid.get(pid);
    if (proc && proc.command.startsWith(owned.token)) {
      live.push(proc);
    } else if (!proc && isPidAlive(pid)) {
      // `ps` hides some processes (e.g. short-lived re-exec); trust kill(0).
      live.push({pid, ppid: -1, state: '?', command: owned.token});
    }
  }
  return live;
}

/**
 * Everything that still belongs to a session: marker-carrying processes plus
 * registered processes that outlived their parent.
 */
export async function findSessionLeftovers(
  sessionId: string,
): Promise<SessionProcess[]> {
  const marked = await findSessionProcesses(sessionId);
  const seen = new Set(marked.map(proc => proc.pid));
  const leftovers: SessionProcess[] = [...marked];
  for (const proc of await liveOwnedProcs(sessionId)) {
    if (seen.has(proc.pid)) {
      continue;
    }
    leftovers.push({...proc, role: classifyProcess(proc.command)});
  }
  return leftovers;
}

export function describeProcs(procs: readonly DescribedProc[]): string {
  if (!procs.length) {
    return '(none)';
  }
  return procs
    .map(proc => {
      // An unclassified row (a raw `ps` snapshot) is classified here.
      const role = proc.role ?? classifyProcess(proc.command);
      const zombie = proc.state.startsWith('Z') ? ' ZOMBIE' : '';
      return `  [${role}] pid=${proc.pid} ppid=${proc.ppid} state=${proc.state}${zombie} ${proc.command.slice(0, 160)}`;
    })
    .join('\n');
}

export async function getChildPids(parentPid: number): Promise<number[]> {
  return (await listProcesses())
    .filter(proc => proc.ppid === parentPid)
    .map(proc => proc.pid);
}

export async function getDescendantPids(rootPid: number): Promise<number[]> {
  const childrenOf = childIndex(await listProcesses());
  const seen = new Set<number>([rootPid]);
  const descendants: number[] = [];
  // Breadth-first over that index: one pass to build it, then one visit per
  // descendant, instead of a table scan and a linear `includes` per level.
  let frontier = childrenOf.get(rootPid) ?? [];
  while (frontier.length) {
    const next: number[] = [];
    for (const pid of frontier) {
      if (seen.has(pid)) {
        continue;
      }
      seen.add(pid);
      descendants.push(pid);
      next.push(...(childrenOf.get(pid) ?? []));
    }
    frontier = next;
  }
  return descendants;
}

// ---------- signalling (gated) ----------

function requireKillsAllowed(operation: string): void {
  assert.ok(
    processKillsAllowed(),
    `${operation} needs ${ENV_ALLOW_KILLS}=true (see docs/specs/stress-test-system-plan.md)`,
  );
}

async function assertSessionOwns(
  sessionId: string,
  pid: number,
): Promise<void> {
  const registry = ownedProcs.get(sessionId);
  const owned = registry?.get(pid);
  if (owned) {
    const current = (await listProcesses()).find(proc => proc.pid === pid);
    assert.ok(
      !current || current.command.startsWith(owned.token),
      `refusing to signal pid ${pid}: it is no longer the process this session registered`,
    );
    return;
  }
  const marked = await findProcesses(sessionTag(sessionId));
  assert.ok(
    marked.some(proc => proc.pid === pid),
    `refusing to signal pid ${pid}: it does not carry this session's marker`,
  );
}

export async function killProcess(
  pid: number,
  sessionId: string,
  signal: NodeJS.Signals = 'SIGKILL',
): Promise<boolean> {
  requireKillsAllowed(`killProcess(${pid}, ${signal})`);
  await assertSessionOwns(sessionId, pid);
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

/** Kill a process and everything below it, children first. */
export async function killProcessTree(
  rootPid: number,
  sessionId: string,
): Promise<void> {
  requireKillsAllowed(`killProcessTree(${rootPid})`);
  const descendants = await getDescendantPids(rootPid);
  for (const pid of descendants.reverse()) {
    try {
      await killProcess(pid, sessionId);
    } catch {
      // A descendant that died on its own (or was never ours) is fine here.
    }
  }
  await killProcess(rootPid, sessionId);
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) {
      return true;
    }
    await delay(POLL_INTERVAL_MS);
  }
  return !isPidAlive(pid);
}

// ---------- session lifecycle ----------

/**
 * Start the daemon for a session through the real CLI, tagged so every process
 * it spawns is identifiable.
 */
export async function startDaemonForTest(
  sessionId: string,
  extraArgs: string[] = [],
): Promise<number> {
  touchSession(sessionId);
  const result = await runCliQuiet(
    [...sessionStartArgs(sessionId), ...extraArgs],
    sessionId,
  );
  assert.strictEqual(
    result.status,
    0,
    `start failed for session ${sessionId}: ${result.stderr}`,
  );
  const pid = getDaemonPid(sessionId);
  assert.ok(pid !== null, `no pid file written for session ${sessionId}`);
  await registerSessionProcesses(sessionId);
  return pid;
}

/**
 * Stop the daemon through the CLI and wait for the process to go away.
 *
 * The timeout is a parameter because the two callers want opposite things: a
 * scenario proving graceful shutdown deserves the full budget, while the
 * cleanup sweep only needs to know whether it must start killing - and a dead
 * MCP server can make the daemon's own teardown hang, so waiting the long
 * budget there just burns seconds on every failure.
 */
export async function stopDaemonForTest(
  sessionId: string,
  timeoutMs = 10_000,
): Promise<void> {
  const pid = getDaemonPid(sessionId);
  await runCliQuiet(['stop'], sessionId);
  if (pid !== null) {
    await waitForProcessExit(pid, timeoutMs);
  }
}

/**
 * Stop a session and reap whatever it left behind, then assert the process
 * table holds nothing for it. Every scenario ends here, which is what makes
 * "Idempotency: running the scenario multiple times does not accumulate
 * orphans" testable.
 */
export async function cleanupSession(sessionId: string): Promise<void> {
  try {
    try {
      await stopDaemonForTest(sessionId, 3_000);
    } catch {
      // The daemon may already be gone or unreachable; the kill sweep below is
      // the fallback.
    }
    if (processKillsAllowed()) {
      try {
        for (const proc of await findSessionLeftovers(sessionId)) {
          await killProcessTree(proc.pid, sessionId);
        }
      } catch {
        // Unreadable process table, or a process that died mid-sweep. Whatever
        // is left is `assertNoOrphans`'s to report below.
      }
    }
  } finally {
    // On disk, not in the process table: the browser profiles this suite
    // created must go even when the sweep or the assertion fails, which is the
    // normal case for a red run.
    for (const dir of ownedProfileDirs.get(sessionId) ?? []) {
      fs.rmSync(dir, {recursive: true, force: true});
    }
    ownedProfileDirs.delete(sessionId);
  }
  await assertNoOrphans(sessionId);
  ownedProcs.delete(sessionId);
  ownedUserDataDirs.delete(sessionId);
}

/**
 * The processes a session is *supposed* to be running right now: the daemon its
 * pid file names, and everything below it.
 *
 * Empty when the pid file is gone or names something that is not alive — which
 * is what makes the orphan assertions strict again after `stop`: with no live
 * daemon there is no live tree, and every session process is a leftover.
 */
async function liveSessionPids(sessionId: string): Promise<Set<number>> {
  const pid = getDaemonPid(sessionId);
  if (pid === null || !isPidAlive(pid)) {
    return new Set<number>();
  }
  return new Set<number>([pid, ...(await getDescendantPids(pid))]);
}

/**
 * A session's processes that are *not* part of its live daemon's tree.
 *
 * A running session is not a leak, and the earlier shape of these assertions —
 * "the session owns no processes at all" — counted the daemon, its MCP server
 * and its browser as orphans, so every scenario that asserted while the session
 * was up failed on a working product. What an orphan actually is here is
 * everything that outlived its place in that tree: the daemon a stale pid file
 * hides (its parent is init, not the live daemon), the helpers of a browser
 * that was killed (re-parented to init), a second daemon from a lost start
 * race, a leaked respawn.
 */
async function orphansOutsideLiveTree(
  sessionId: string,
): Promise<SessionProcess[]> {
  const allowed = await liveSessionPids(sessionId);
  return (await findSessionLeftovers(sessionId)).filter(
    proc => !allowed.has(proc.pid),
  );
}

export async function assertNoOrphans(sessionId: string): Promise<void> {
  const leftovers = await orphansOutsideLiveTree(sessionId);
  assert.strictEqual(
    leftovers.length,
    0,
    `orphaned processes for session ${sessionId}:\n${describeProcs(leftovers)}`,
  );
}

/**
 * Wait for a session's processes outside its live tree to drain, then assert
 * none are left. Chrome's helpers take a moment to notice a dead browser, so a
 * bare snapshot would be a race; the wait budget is the assertion's real bound.
 */
export async function assertNoOrphansWithin(
  sessionId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let leftovers = await orphansOutsideLiveTree(sessionId);
  while (leftovers.length && Date.now() < deadline) {
    await delay(POLL_INTERVAL_MS);
    leftovers = await orphansOutsideLiveTree(sessionId);
  }
  assert.strictEqual(
    leftovers.length,
    0,
    `orphaned processes for session ${sessionId} after ${timeoutMs}ms:\n${describeProcs(leftovers)}`,
  );
}

/** Run-level leak check: every session this run touched must be clean. */
export async function assertNoRunLeftovers(): Promise<void> {
  const dirty: string[] = [];
  for (const sessionId of touchedSessions) {
    const leftovers = await findSessionLeftovers(sessionId);
    if (leftovers.length) {
      dirty.push(`session ${sessionId}:\n${describeProcs(leftovers)}`);
    }
  }
  assert.strictEqual(
    dirty.length,
    0,
    `processes leaked by this stress run:\n${dirty.join('\n')}`,
  );
}

export function resetRunRegistry(): void {
  touchedSessions.clear();
  ownedProcs.clear();
  ownedUserDataDirs.clear();
  // Normally emptied by `cleanupSession`'s `finally`, but a test that crashes
  // between `createProfileDir` and its cleanup would otherwise leak the paths
  // into the next runner invocation in this process - and the directories
  // themselves are removed from that map alone.
  ownedProfileDirs.clear();
}

// ---------- sockets ----------

/**
 * Talk to the daemon socket directly, bypassing the CLI. Used to feed the
 * daemon raw bytes (frames are `\0`-terminated, JSON payloads).
 */
export async function sendRawSocketMessage(
  sessionId: string,
  rawBytes: Buffer,
  timeoutMs = 5000,
): Promise<Buffer | null> {
  const {socketPath} = getSessionPaths(sessionId);
  const {promise, resolve} = Promise.withResolvers<Buffer | null>();
  let response = Buffer.alloc(0);
  let settled = false;
  const socket = net.createConnection({path: socketPath});
  const finish = () => {
    if (settled) {
      return;
    }
    settled = true;
    socket.destroy();
    resolve(response.length ? response : null);
  };
  socket.setTimeout(timeoutMs, finish);
  socket.on('connect', () => socket.write(rawBytes));
  socket.on('data', (chunk: Buffer) => {
    response = Buffer.concat([response, chunk]);
  });
  socket.on('close', finish);
  socket.on('error', finish);
  return promise;
}

// ---------- waiting ----------

export function delay(ms: number): Promise<void> {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Poll `probe` until it reports success, or fail with `what` in the message.
 * Scenarios use this for every recovery expectation, so a hung system reports
 * the expectation it broke rather than a bare timeout.
 *
 * The probe returns `{value}` rather than a bare value-or-null because a `T`
 * that includes `null` (or any falsy type) would otherwise have no way to say
 * "found it": the probe would succeed and the wait would still poll to its
 * deadline, then report a timeout for something that already happened.
 */
export async function waitFor<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<{value: T} | null>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const found = await probe();
      if (found !== null) {
        return found.value;
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${what}`,
    lastError === undefined ? undefined : {cause: lastError},
  );
}

export async function waitForSessionProcessRole(
  sessionId: string,
  role: ProcRole,
  timeoutMs: number,
  exclude?: number,
): Promise<SessionProcess> {
  return waitFor(
    `a ${role} process in session ${sessionId}`,
    timeoutMs,
    async () => {
      const procs = await findSessionProcesses(sessionId);
      const match = procs.find(
        proc => proc.role === role && proc.pid !== exclude,
      );
      return match ? {value: match} : null;
    },
  );
}

/** Report, without failing, what a session's daemon state looks like. */
export function describeSessionState(
  sessionId: string,
  daemonPid: number | null,
): string {
  const {socketPath, pidFilePath} = getSessionPaths(sessionId);
  return [
    `session=${sessionId}`,
    `daemonPid=${daemonPid ?? 'none'}`,
    `daemonAlive=${daemonPid !== null && isPidAlive(daemonPid)}`,
    `pidFile=${fs.existsSync(pidFilePath) ? 'present' : 'missing'}`,
    `socket=${fs.existsSync(socketPath) ? 'present' : 'missing'}`,
  ].join(' ');
}
