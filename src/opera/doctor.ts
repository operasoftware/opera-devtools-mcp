/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * `doctor` — the five checks that translate onto the daemon model, and the two
 * repairs that need no decision from the user.
 *
 * Ported from opera-browser-cli's `src/cli.ts` `runDoctorChecks` /
 * `runDoctorFixes`, filtered: the source's `bridge` check is subsumed by the
 * daemon check here, its `mcp` check is about a binary this package *is*, and
 * its `hooks` check is dropped with the hooks themselves. What remains is the
 * configuration, the executable, the profile lock, the daemon, and the log.
 *
 * Nothing here ever fails the command: a failing check is a `fail` row, and the
 * process still exits 0. The point of `doctor` is to report, not to gate.
 */

import {existsSync, readFileSync, renameSync, statSync} from 'node:fs';

import {sendCommand} from '../daemon/client.js';
import type {DaemonStatusResult} from '../daemon/types.js';
import {isDaemonRunning} from '../daemon/utils.js';
import {VERSION} from '../version.js';

import {CLI_BIN_NAME} from './branding.js';
import {encode, renderHelp, renderOutput} from './cliOutput.js';
import {autoConfigure} from './config.js';
import {readExitReason} from './daemonLifecycle.js';
import {getDaemonLogPath, getPreviousDaemonLogPath} from './daemonLog.js';
import {
  findUnknownConfigKeys,
  getConfigFile,
  readConfigFile,
} from './envConfig.js';
import {
  inspectProfileLock,
  probeDevToolsEndpoint,
  readDevToolsPort,
} from './profile.js';

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  /**
   * The raw size behind a `detail` that would otherwise only carry it formatted
   * (`formatBytes`). `doctor --fix` decides log rotation on this, so the
   * threshold cannot be defeated by a change to the display format.
   */
  bytes?: number;
}

/** Logs above this are rotated by `doctor --fix`. */
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function fileContainsMarker(path: string, marker: string): boolean {
  if (!existsSync(path)) {
    return false;
  }
  try {
    return readFileSync(path, 'utf-8').includes(marker);
  } catch {
    return false;
  }
}

/** The config file: absent is a warning, unknown keys are a warning, else ok. */
function checkConfig(): DoctorCheck {
  const configFile = getConfigFile();
  if (!existsSync(configFile)) {
    return {
      name: 'config',
      status: 'warn',
      detail: `${configFile} not found — run \`${CLI_BIN_NAME} setup\``,
    };
  }
  const config = readConfigFile(configFile);
  const count = Object.keys(config).length;
  const unknown = findUnknownConfigKeys(config);
  if (unknown.length > 0) {
    // A typo'd key is silently ignored at load time and looks perfectly correct
    // in the file, so it has to be called out here or never.
    const described = unknown
      .map(u =>
        u.suggestion ? `${u.key} (did you mean ${u.suggestion}?)` : u.key,
      )
      .join(', ');
    return {
      name: 'config',
      status: 'warn',
      detail: `${configFile} — unrecognised key${unknown.length === 1 ? '' : 's'}: ${described}`,
    };
  }
  return {
    name: 'config',
    status: 'ok',
    detail: `${configFile} (${count} var${count === 1 ? '' : 's'} set)`,
  };
}

/** The Opera executable, unless an attach URL makes it unnecessary. */
function checkExecutable(): DoctorCheck {
  const execPath = process.env.OPERA_CLI_EXECUTABLE_PATH;
  const browserUrl = process.env.OPERA_CLI_BROWSER_URL;
  if (browserUrl) {
    return {
      name: 'executable',
      status: 'ok',
      detail: `OPERA_CLI_BROWSER_URL=${browserUrl} (skipping executable check)`,
    };
  }
  if (!execPath) {
    return {
      name: 'executable',
      status: 'warn',
      detail: 'OPERA_CLI_EXECUTABLE_PATH not set — Opera AI commands will fail',
    };
  }
  if (!existsSync(execPath)) {
    return {
      name: 'executable',
      status: 'fail',
      detail: `OPERA_CLI_EXECUTABLE_PATH=${execPath} does not exist`,
    };
  }
  return {name: 'executable', status: 'ok', detail: execPath};
}

/** The persistent profile: free, in use and attachable, or in use and locked. */
async function checkProfile(): Promise<DoctorCheck> {
  const profileDir = process.env.OPERA_CLI_USER_DATA_DIR;
  if (!profileDir) {
    return {
      name: 'profile',
      status: 'ok',
      detail: 'isolated (no persistent profile configured)',
    };
  }
  if (!existsSync(profileDir)) {
    return {
      name: 'profile',
      status: 'ok',
      detail: `${profileDir} (will be created on first launch)`,
    };
  }
  const lock = inspectProfileLock(profileDir);
  if (lock.state === 'free') {
    return {name: 'profile', status: 'ok', detail: `${profileDir} (free)`};
  }
  const port = readDevToolsPort(profileDir);
  const live = port !== null ? await probeDevToolsEndpoint(port) : null;
  if (live) {
    return {
      name: 'profile',
      status: 'ok',
      detail: `in use by ${live.browser}, attachable on port ${port}`,
    };
  }
  return {
    name: 'profile',
    status: 'warn',
    detail: `in use${lock.pid ? ` by pid ${lock.pid}` : ''} with no debugging port — a separate profile will be used`,
  };
}

/** The daemon: not running, running, or running a different version. */
async function checkDaemon(sessionId: string): Promise<DoctorCheck> {
  if (!isDaemonRunning(sessionId)) {
    const reason = readExitReason(sessionId);
    return {
      name: 'daemon',
      status: 'warn',
      detail: reason
        ? `not running (last exit: ${reason})`
        : 'not running (will auto-start on first command)',
    };
  }
  try {
    const response = await sendCommand({method: 'status'}, sessionId);
    if (!response.success) {
      return {
        name: 'daemon',
        status: 'fail',
        detail: `running but ${String(response.error)}`,
      };
    }
    const data: DaemonStatusResult = JSON.parse(response.result);
    if (data.version !== VERSION) {
      return {
        name: 'daemon',
        status: 'warn',
        detail: `running ${data.version}, but this CLI is ${VERSION} — restarts automatically on next command`,
      };
    }
    return {
      name: 'daemon',
      status: 'ok',
      detail: `running ${data.version}, pid ${data.pid}, socket ${data.socketPath}`,
    };
  } catch (error) {
    return {
      name: 'daemon',
      status: 'fail',
      detail: `running but not answering: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** The daemon log, which is where a daemon that died without a reason explains itself. */
function checkLogs(sessionId: string): DoctorCheck {
  const logFile = getDaemonLogPath(sessionId);
  if (!existsSync(logFile)) {
    return {
      name: 'logs',
      status: 'warn',
      detail: `${logFile} not yet created`,
    };
  }
  try {
    const size = statSync(logFile).size;
    return {
      name: 'logs',
      status: 'ok',
      detail: `${logFile} (${formatBytes(size)})`,
      bytes: size,
    };
  } catch {
    return {
      name: 'logs',
      status: 'warn',
      detail: `${logFile} exists but cannot stat`,
    };
  }
}

export async function runDoctorChecks(
  sessionId: string,
): Promise<DoctorCheck[]> {
  return [
    checkConfig(),
    checkExecutable(),
    await checkProfile(),
    await checkDaemon(sessionId),
    checkLogs(sessionId),
  ];
}

/**
 * Rotate the daemon log out of the way, one generation.
 *
 * The daemon does this itself on startup (`openDaemonLog`), but a session that
 * stays up for weeks never restarts, so `--fix` does it explicitly. Renaming a
 * file the daemon still holds open is safe on POSIX: the daemon keeps writing
 * to the renamed inode until its next open. On Windows the rename would fail
 * against a live handle, so there it is skipped and reported.
 */
function rotateDaemonLog(sessionId: string): boolean {
  const logFile = getDaemonLogPath(sessionId);
  if (process.platform === 'win32' && isDaemonRunning(sessionId)) {
    return false;
  }
  try {
    renameSync(logFile, getPreviousDaemonLogPath(sessionId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Repair what can be repaired mechanically. Anything needing a decision — an
 * install, a config edit — is reported, never done on the user's behalf.
 */
export async function runDoctorFixes(
  checks: DoctorCheck[],
  sessionId: string,
): Promise<string[]> {
  const done: string[] = [];

  const config = checks.find(check => check.name === 'config');
  if (config && config.detail.includes('not found')) {
    const result = autoConfigure();
    if (result.status === 'configured') {
      done.push(`wrote a config for ${result.browser.name}`);
    }
  }

  const logs = checks.find(check => check.name === 'logs');
  if (logs?.bytes !== undefined && logs.bytes >= LOG_ROTATE_BYTES) {
    done.push(
      rotateDaemonLog(sessionId)
        ? 'rotated the daemon log'
        : 'could not rotate the daemon log (it is held open)',
    );
  }

  return done;
}

function summarize(checks: DoctorCheck[]) {
  return {
    ok: checks.filter(check => check.status === 'ok').length,
    warn: checks.filter(check => check.status === 'warn').length,
    fail: checks.filter(check => check.status === 'fail').length,
  };
}

function renderChecks(checks: DoctorCheck[]): string {
  return `checks[${checks.length}]:\n${checks
    .map(check => `  ${check.name}: ${check.status} (${check.detail})`)
    .join('\n')}`;
}

export async function handleDoctor(
  args: string[],
  sessionId: string,
): Promise<string> {
  if (args.includes('--fix')) {
    const applied = await runDoctorFixes(
      await runDoctorChecks(sessionId),
      sessionId,
    );
    const after = await runDoctorChecks(sessionId);
    const summary = {fixed: applied.length, ...summarize(after)};
    return renderOutput([
      await encode({doctor: summary}),
      applied.length > 0
        ? `fixed[${applied.length}]:\n${applied.map(line => `  ${line}`).join('\n')}`
        : 'fixed: nothing needed repairing',
      renderChecks(after),
    ]);
  }

  const checks = await runDoctorChecks(sessionId);
  const help: string[] = [];
  if (checks.some(check => check.name === 'config' && check.status !== 'ok')) {
    help.push(`Run \`${CLI_BIN_NAME} setup\` to write a config file`);
  }
  if (
    checks.some(check => check.name === 'executable' && check.status !== 'ok')
  ) {
    help.push(
      `Run \`${CLI_BIN_NAME} setup\` to detect Opera, or set OPERA_CLI_EXECUTABLE_PATH`,
    );
  }
  if (
    checks.some(check => check.name === 'profile' && check.status === 'warn')
  ) {
    help.push(
      'A profile in use with no debugging port cannot be attached to — the CLI will use a separate one',
    );
  }
  if (
    checks.some(check => check.name === 'daemon' && check.status === 'fail')
  ) {
    help.push(
      `Run \`${CLI_BIN_NAME} logs\` to see why the daemon is unhealthy`,
    );
  }

  return renderOutput([
    await encode({doctor: summarize(checks)}),
    renderChecks(checks),
    help.length > 0 ? renderHelp(help) : '',
  ]);
}
