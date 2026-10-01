/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Which browser a command should drive, and what to do when the configured
 * profile is already held by a browser that cannot be driven.
 *
 * Ported from opera-browser-cli's `src/browser-target.ts` and the
 * `preflightBrowser` / `resolveBrowserConflict` half of its `src/cli.ts`. The
 * split is kept: the mechanics (resolve a target, ask a running browser to
 * quit, start one that can be attached to) live here, and the CLI only calls
 * the preflight.
 *
 * The constraint that shapes all of this: `--remote-debugging-port` is a
 * startup-only flag. A browser the user opened normally cannot be attached to,
 * ever. So there is no way to "connect to the Opera that is already open" —
 * only ways to arrange that the open Opera was started with a port in the first
 * place, and a way to detect it when it was.
 *
 * That gives three states for a configured profile:
 *
 *   free                        → let the daemon launch it, as before.
 *   locked, debug port live     → attach. No prompt, no restart, nothing to do.
 *   locked, no debug port       → a conflict only the user can resolve, by
 *                                 letting us restart their browser.
 *
 * The second case is the one that makes this feel automatic: once a browser has
 * been started with a port — by us, or by the user following the flags in
 * `docs/troubleshooting.md` — every later command finds it on its own via
 * DevToolsActivePort.
 *
 * The third case is what the user sees as the `A browser is already running
 * with the profile …` error. Resolving it restarts somebody's browser, so it
 * happens only on an explicit yes: a terminal prompt, or `--takeover` for
 * scripted callers. Everything else falls back to a separate profile, which
 * always works and costs only a sign-in.
 */

import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync, unlinkSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {createInterface} from 'node:readline';

import {sendCommand, stopDaemon} from '../daemon/client.js';
import type {DaemonStatusResult} from '../daemon/types.js';
import {isDaemonRunning} from '../daemon/utils.js';

import {CLI_BIN_NAME} from './branding.js';
import {launchedUserDataDir, storedBrowserUrl} from './browserFlags.js';
import {CdpError} from './cdpErrors.js';
import {getStateDir} from './envConfig.js';
import {
  findAttachableEndpoint,
  inspectProfileLock,
  isProcessAlive,
  localHostNames,
  probeDevToolsEndpoint,
  readDevToolsPort,
  type ProfileLock,
} from './profile.js';

export interface BrowserTargetContext {
  browserUrl?: string | undefined;
  userDataDir?: string | undefined;
  executablePath?: string | undefined;
}

export type BrowserTarget =
  /** A browser is running and reachable: drive it. */
  | {mode: 'attach'; url: string; note: string}
  /** Nothing holds the profile (or it is isolated): launch one. */
  | {mode: 'managed'; note: string}
  /** A browser holds the profile and cannot be driven. */
  | {mode: 'conflict'; userDataDir: string; lock: ProfileLock};

/** Decide what the daemon should talk to, before it starts. */
export async function resolveBrowserTarget(
  ctx: BrowserTargetContext,
): Promise<BrowserTarget> {
  // An explicit browser URL is the user telling us they manage the browser.
  if (ctx.browserUrl) {
    return {mode: 'attach', url: ctx.browserUrl, note: 'OPERA_CLI_BROWSER_URL'};
  }
  // No persistent profile means an isolated one, which nothing else can hold.
  if (!ctx.userDataDir) {
    return {mode: 'managed', note: 'isolated profile'};
  }
  // A live debug port wins outright: the browser is running and reachable, so
  // there is no conflict to resolve regardless of what the lock says.
  const attachable = await findAttachableEndpoint(ctx.userDataDir);
  if (attachable !== null) {
    return {
      mode: 'attach',
      url: attachable.url,
      note: `running ${attachable.identity.browser}`,
    };
  }
  const lock = inspectProfileLock(ctx.userDataDir);
  if (lock.state === 'free') {
    return {mode: 'managed', note: 'profile is free'};
  }
  return {mode: 'conflict', userDataDir: ctx.userDataDir, lock};
}

// ---------------------------------------------------------------------------
// Takeover
// ---------------------------------------------------------------------------

export type QuitResult = {ok: true} | {ok: false; reason: 'no-pid' | 'timeout'};

function sleep(ms: number): Promise<void> {
  const {promise, resolve: resolveSleep} = Promise.withResolvers<void>();
  setTimeout(resolveSleep, ms);
  return promise;
}

/**
 * Ask a running browser to quit, and wait for it to let go of the profile.
 *
 * SIGTERM only. Chromium treats it as a clean shutdown — session saved, profile
 * flushed — whereas SIGKILL risks a corrupted profile and loses the user's
 * tabs. If it will not go, we say so rather than escalating: this is somebody's
 * browser, and forcing it is not ours to decide.
 *
 * Two signals mean the profile is free, and the wait takes either: Chromium
 * removes `SingletonLock` as it goes, and a browser that died without removing
 * it leaves the lock naming a process that is gone. The names that make a lock
 * this machine's are derived once, before the loop: on macOS that derivation is
 * a `scutil` subprocess, and a 20-second wait would otherwise run it eighty
 * times for an answer that cannot change while we wait.
 */
export async function quitBrowser(
  lock: ProfileLock,
  userDataDir: string,
  timeoutMs = 20_000,
): Promise<QuitResult> {
  if (lock.pid === null) {
    return {ok: false, reason: 'no-pid'};
  }
  try {
    process.kill(lock.pid, 'SIGTERM');
  } catch {
    // Already gone between inspection and now — that is a success.
    return {ok: true};
  }
  const localNames = localHostNames();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(250);
    if (
      inspectProfileLock(
        userDataDir,
        isProcessAlive,
        process.platform,
        localNames,
      ).state === 'free'
    ) {
      return {ok: true};
    }
  }
  return {ok: false, reason: 'timeout'};
}

export type LaunchResult =
  {ok: true; url: string} | {ok: false; reason: string; detail?: string};

/**
 * Start a browser we can attach to, and that outlives us.
 *
 * `--remote-debugging-port=0` has Chromium pick a free port itself and record
 * it in `DevToolsActivePort`. That satisfies two requirements at once: we never
 * squat a predictable port like 9222, and the port is discoverable by every
 * later command without being written to any config.
 *
 * The browser is detached deliberately. Having just restarted the user's
 * browser, closing it again when the daemon stops would be a poor trade.
 */
export async function launchAttachableBrowser(
  executablePath: string | undefined,
  userDataDir: string,
  extraArgs: string[] = [],
  timeoutMs = 30_000,
): Promise<LaunchResult> {
  if (!executablePath || !existsSync(executablePath)) {
    return {ok: false, reason: 'no-executable'};
  }
  // Chromium rewrites this on startup, but clearing it first means a stale port
  // from a previous run can never be mistaken for the new browser's.
  const portFile = join(userDataDir, 'DevToolsActivePort');
  try {
    unlinkSync(portFile);
  } catch {
    // Absent already — fine.
  }
  const args = [
    ...browserLaunchArgs(userDataDir),
    // We just took their browser away; give the tabs back.
    '--restore-last-session',
    ...extraArgs,
  ];
  let child: ChildProcess;
  try {
    child = spawn(executablePath, args, {stdio: 'ignore', detached: true});
  } catch (error) {
    return {
      ok: false,
      reason: 'spawn-failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  child.unref();
  let spawnError: string | null = null;
  child.on('error', error => {
    spawnError = error.message;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError !== null) {
      return {ok: false, reason: 'spawn-failed', detail: spawnError};
    }
    const port = readDevToolsPort(userDataDir);
    if (port !== null && (await probeDevToolsEndpoint(port)) !== null) {
      return {ok: true, url: `http://127.0.0.1:${port}`};
    }
    await sleep(250);
  }
  return {ok: false, reason: 'timeout'};
}

/**
 * The flags a user needs to start Opera themselves so the CLI can attach.
 *
 * Deliberately not `--remote-allow-origins=*`: Chromium's default rejection of
 * CDP WebSocket upgrades that carry an Origin header is what stops a web page
 * from driving the browser, and this profile is logged into everything.
 */
export function browserLaunchArgs(userDataDir: string | undefined): string[] {
  const args = [
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
  ];
  if (userDataDir) {
    args.push(`--user-data-dir=${userDataDir}`);
  }
  return args;
}

/** The throwaway profile the fallback uses when the configured one is taken. */
export function separateProfileDir(): string {
  return join(getStateDir(), 'profile');
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** Commands that never touch a browser, so never need a browser chosen. */
const BROWSER_SKIP_COMMANDS: Record<string, true> = {
  setup: true,
  doctor: true,
  logs: true,
  status: true,
  stop: true,
};

/**
 * Flags that pick the browser explicitly. A command carrying one of these is
 * the user deciding, and a decision is not something to second-guess — the same
 * rule `applyEnvToArgv` follows, where an explicit flag beats the environment.
 */
function picksBrowserOnArgv(argv: readonly string[]): boolean {
  const flags = [
    '--browserUrl',
    '--browser-url',
    '-u',
    '--wsEndpoint',
    '--ws-endpoint',
    '-w',
    '--autoConnect',
    '--auto-connect',
    '--isolated',
    '--userDataDir',
    '--user-data-dir',
  ];
  return argv.some(arg =>
    flags.some(flag => arg === flag || arg.startsWith(`${flag}=`)),
  );
}

/** True when the running daemon launched its browser on this very profile. */
function daemonOwnsProfile(
  daemonArgs: readonly string[],
  userDataDir: string,
): boolean {
  const launched = launchedUserDataDir(daemonArgs);
  return launched !== undefined && resolve(launched) === resolve(userDataDir);
}

const CONFLICT_EXPLANATION = (userDataDir: string): string =>
  `\nOpera is already running on the profile ${CLI_BIN_NAME} is configured to use:\n` +
  `  ${userDataDir}\n\n` +
  'A browser can only be automated if it was started with a debugging port,\n' +
  'and that flag cannot be added to a browser that is already open.\n\n' +
  '  [1] Restart Opera now so the CLI can drive it (tabs are restored)\n' +
  '  [2] Use a separate profile instead (you will need to sign in there)\n\n' +
  'Restarting opens a local debugging port for as long as that browser runs.\n';

/**
 * The question, without the explanation: readline prints whatever it is given,
 * so the explanation is written separately and this is the only part that would
 * otherwise appear twice on a terminal.
 */
const CONFLICT_QUESTION = 'Select [1/2] (default 2): ';

/** The seams the preflight needs; injected so tests need no terminal or daemon. */
export interface PreflightDeps {
  /** Whether there is a terminal to ask in. No terminal is a reason to fall back, not to fail. */
  interactive: boolean;
  /** The user's answer to the conflict question. */
  ask(question: string): Promise<string>;
  resolveTarget(ctx: BrowserTargetContext): Promise<BrowserTarget>;
  /** The argv a running daemon was started with, or null when none serves the session. */
  daemonArgs(sessionId: string): Promise<string[] | null>;
  quit(lock: ProfileLock, userDataDir: string): Promise<QuitResult>;
  launch(
    executablePath: string | undefined,
    userDataDir: string,
  ): Promise<LaunchResult>;
  /** Takes a daemon down so the next command starts one on the new browser. */
  stopDaemon(sessionId: string): Promise<void>;
  env: NodeJS.ProcessEnv;
  /** The prompt, which belongs on stdout with the rest of the output. */
  writeOut(text: string): void;
  /** Notes about what was decided, which belong on stderr. */
  write(text: string): void;
}

async function askOnTerminal(question: string): Promise<string> {
  const rl = createInterface({input: process.stdin, output: process.stdout});
  const {promise, resolve: resolveAnswer} = Promise.withResolvers<string>();
  rl.question(question, resolveAnswer);
  // Ctrl-D ends the question without an answer. The fallback is the wrong
  // answer to hang on, and an empty answer selects it.
  rl.once('close', () => resolveAnswer(''));
  try {
    return await promise;
  } finally {
    rl.close();
  }
}

/** Long enough for a busy daemon to answer, short enough not to stall a command. */
const DAEMON_STATUS_TIMEOUT_MS = 5_000;

async function defaultDaemonArgs(sessionId: string): Promise<string[] | null> {
  if (!isDaemonRunning(sessionId)) {
    return null;
  }
  try {
    const response = await sendCommand(
      {method: 'status'},
      sessionId,
      DAEMON_STATUS_TIMEOUT_MS,
    );
    if (!response.success) {
      return [];
    }
    const status = JSON.parse(response.result) as DaemonStatusResult;
    return status.args;
  } catch {
    // A daemon that cannot answer owns nothing we can compare against, so the
    // profile it holds is treated as somebody else's — and a command that is
    // about to use that daemon must not be failed by a probe about it.
    return [];
  }
}

const defaultPreflightDeps: PreflightDeps = {
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask: askOnTerminal,
  resolveTarget: resolveBrowserTarget,
  daemonArgs: defaultDaemonArgs,
  quit: quitBrowser,
  launch: launchAttachableBrowser,
  stopDaemon,
  env: process.env,
  writeOut: text => process.stdout.write(text),
  write: text => process.stderr.write(text),
};

/**
 * Settle the conflict the prompt is about.
 *
 * `separate` is the answer that always works and needs nobody's browser to be
 * touched, so it is the default for every caller that cannot ask: no terminal,
 * or an answer that is not 1.
 */
async function resolveConflict(
  target: Extract<BrowserTarget, {mode: 'conflict'}>,
  options: {takeover: boolean; deps: PreflightDeps},
): Promise<void> {
  const {deps} = options;
  let choice: 'separate' | 'takeover' = options.takeover
    ? 'takeover'
    : 'separate';

  if (!options.takeover && deps.interactive) {
    deps.writeOut(CONFLICT_EXPLANATION(target.userDataDir));
    const answer = (await deps.ask(CONFLICT_QUESTION)).trim().toLowerCase();
    if (answer === '1' || answer === 'y') {
      choice = 'takeover';
    }
  }

  if (choice === 'separate') {
    const dir = separateProfileDir();
    deps.env.OPERA_CLI_USER_DATA_DIR = dir;
    deps.write(
      `note: Opera is running on the configured profile; using ${dir} for this run.\n` +
        '      Start Opera with a debugging port (--remote-debugging-port=0) so the CLI can attach to it instead.\n',
    );
  } else {
    const quit = await deps.quit(target.lock, target.userDataDir);
    if (!quit.ok) {
      throw new CdpError(
        quit.reason === 'no-pid'
          ? 'Could not identify the process holding the profile, so it was not signalled.'
          : 'Opera did not shut down within 20s.',
        'BROWSER_ERROR',
        [
          'Quit Opera yourself, then re-run the command',
          'Or restart it with a debugging port (--remote-debugging-port=0) so the CLI can attach instead',
        ],
      );
    }
    const launched = await deps.launch(
      deps.env.OPERA_CLI_EXECUTABLE_PATH,
      target.userDataDir,
    );
    if (!launched.ok) {
      throw new CdpError(
        `Opera was stopped but could not be restarted (${launched.reason}${
          launched.detail ? `: ${launched.detail}` : ''
        }).`,
        'BROWSER_ERROR',
        [
          'Start Opera yourself, then re-run the command',
          'Or restart it with a debugging port (--remote-debugging-port=0) so the CLI can attach instead',
        ],
      );
    }
    deps.env.OPERA_CLI_BROWSER_URL = launched.url;
    deps.write(`note: restarted Opera and attached at ${launched.url}\n`);
  }
}

/**
 * Take down a daemon that would keep driving the browser it was started with.
 *
 * A daemon fixes its browser at startup — the attach URL, the profile, the
 * flags — so a new selection only reaches the next one. Nothing here restarts
 * it; the caller starts a daemon on the selection it now holds.
 */
async function retireDaemonForNewSelection(
  sessionId: string,
  deps: PreflightDeps,
): Promise<void> {
  if ((await deps.daemonArgs(sessionId)) === null) {
    return;
  }
  deps.write('note: browser selection changed; restarting the daemon.\n');
  await deps.stopDaemon(sessionId);
}

export interface SettleOptions {
  /** `--takeover` was given for this run. */
  takeover: boolean;
  /**
   * Why the caller is settling, when it is settling because something failed.
   *
   * `profile-in-use` means a launch was refused, and the lock file is then not
   * the authority on whether a browser holds the profile: a lock that is
   * missing or unattributable answers "free" while the browser it belongs to is
   * very much running. `unreachable` means the browser the daemon was driving
   * is gone, which a daemon pinned to an attach URL cannot recover from — an
   * attached browser is never restarted, so it stays pointing at nothing.
   */
  reason?: 'profile-in-use' | 'unreachable';
}

/**
 * Settle whichever browser the environment points at, and report whether that
 * changed it — so a caller that already tried something can try again.
 *
 * Two callers need this. The preflight runs it before a command starts a daemon
 * (`preflightBrowser`), and the tool commands run it when a daemon reports the
 * one failure this can fix (`cliCommands.ts`): a launch that never happened
 * because a browser was already holding the profile, or an attach to a browser
 * that is no longer there. The second exists because the first cannot see
 * everything — a daemon started before that browser was opened, or by an older
 * CLI, is pinned to the profile it was given, and no amount of looking at the
 * environment reveals that its browser is missing.
 */
export async function settleBrowserConflict(
  sessionId: string,
  options: SettleOptions,
  deps: PreflightDeps = defaultPreflightDeps,
): Promise<boolean> {
  const env = deps.env;
  const userDataDir = env.OPERA_CLI_USER_DATA_DIR;
  const target = await deps.resolveTarget({
    browserUrl: env.OPERA_CLI_BROWSER_URL,
    userDataDir,
    executablePath: env.OPERA_CLI_EXECUTABLE_PATH,
  });

  let changed = false;
  if (target.mode === 'attach') {
    if (env.OPERA_CLI_BROWSER_URL !== target.url) {
      // A live debug port on the configured profile. Set the attach URL so the
      // daemon the caller is about to start attaches to it rather than
      // launching — and so the tools' page ownership follows the browser in
      // use.
      env.OPERA_CLI_BROWSER_URL = target.url;
      changed = true;
    }
  } else if (
    target.mode === 'conflict' ||
    options.reason === 'profile-in-use'
  ) {
    // An isolated profile cannot be held by anybody else, so a failure that
    // says otherwise is not one this can settle.
    if (!userDataDir) {
      return false;
    }
    await resolveConflict(
      target.mode === 'conflict'
        ? target
        : {
            mode: 'conflict',
            userDataDir,
            lock: {state: 'unknown', pid: null, hostname: null},
          },
      {takeover: options.takeover, deps},
    );
    changed = true;
  } else if (options.reason !== 'unreachable') {
    return false;
  }

  if (!changed && !(await daemonPinnedToDiscoveredAttach(sessionId, deps))) {
    return false;
  }
  await retireDaemonForNewSelection(sessionId, deps);
  return true;
}

/**
 * Whether a daemon is attached to a URL the CLI discovered for it, and which
 * the environment no longer names.
 *
 * That daemon cannot recover by itself: an attached browser is never restarted,
 * so it keeps trying a port nothing answers. Retiring it lets the caller's
 * restart re-derive the browser — attach to a live endpoint, launch when the
 * profile is free, or ask when it is held. A URL the user configured, or a
 * `--wsEndpoint` / `--autoConnect` they typed, is left alone: their browser is
 * theirs to start again, which is what the failure says.
 */
async function daemonPinnedToDiscoveredAttach(
  sessionId: string,
  deps: PreflightDeps,
): Promise<boolean> {
  if (deps.env.OPERA_CLI_BROWSER_URL !== undefined) {
    return false;
  }
  const daemonArgs = await deps.daemonArgs(sessionId);
  return daemonArgs !== null && storedBrowserUrl(daemonArgs) !== undefined;
}

/**
 * Work out which browser the command about to run should drive.
 *
 * Runs in the CLI rather than the daemon because settling a conflict may need
 * to ask the user something, and the daemon is detached with no terminal —
 * which is also why the decision has to be written into the environment before
 * the command starts the daemon: both processes inherit it from here.
 *
 * The browser is only re-selected when a daemon is not already driving one: a
 * daemon fixes its browser at startup, so the question is settled for as long
 * as it lives. `start` is the exception — its handler stops the daemon and
 * picks fresh browser options — and even then the lock a restart can see
 * belongs to the browser it is about to release, so it is not a conflict to
 * resolve. A daemon whose browser never started is the other exception, and it
 * is settled where its failure is reported instead.
 */
export async function preflightBrowser(
  argv: readonly string[],
  sessionId: string,
  takeover: boolean,
  deps: PreflightDeps = defaultPreflightDeps,
): Promise<void> {
  const command = argv[0];
  if (command === undefined || BROWSER_SKIP_COMMANDS[command] === true) {
    return;
  }
  // `--help` on any command is a question about the command, not a job for the
  // browser; asking about a profile conflict before printing help would be rude.
  if (
    argv.some(
      arg =>
        arg === '--help' ||
        arg === '-h' ||
        arg === '--version' ||
        arg === '-v' ||
        arg === '-V',
    )
  ) {
    return;
  }
  const env = deps.env;
  // An explicit browser URL, or no persistent profile, means no conflict is
  // possible.
  if (env.OPERA_CLI_BROWSER_URL || !env.OPERA_CLI_USER_DATA_DIR) {
    return;
  }
  if (picksBrowserOnArgv(argv)) {
    return;
  }
  const userDataDir = env.OPERA_CLI_USER_DATA_DIR;
  const daemonArgs = await deps.daemonArgs(sessionId);
  if (
    daemonArgs !== null &&
    (command !== 'start' || daemonOwnsProfile(daemonArgs, userDataDir))
  ) {
    return;
  }
  await settleBrowserConflict(sessionId, {takeover}, deps);
}

/**
 * Remove `--takeover` wherever it appears and report whether it was given. It
 * belongs to the preflight, not to any command, and every command parser is
 * strict — so the flag is consumed here rather than declared on each of them.
 */
export function extractTakeoverFlag(argv: string[]): boolean {
  let takeover = false;
  for (let index = argv.length - 1; index >= 0; index--) {
    if (argv[index] === '--takeover') {
      takeover = true;
      argv.splice(index, 1);
    }
  }
  return takeover;
}

/**
 * The `--sessionId` a command will be scoped to, read before yargs has parsed
 * it: the daemon the preflight asks about has to be the session's own. `''` is
 * the default yargs applies to a command that passes none — the two must agree,
 * or the preflight would inspect an empty session nobody is using.
 */
export function sessionIdFromArgv(argv: readonly string[]): string {
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    for (const name of ['--sessionId', '--session-id']) {
      if (arg === name && index + 1 < argv.length) {
        return argv[index + 1]!;
      }
      if (arg.startsWith(`${name}=`)) {
        return arg.slice(name.length + 1);
      }
    }
  }
  return '';
}
