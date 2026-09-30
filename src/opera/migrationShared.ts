/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Plumbing shared by the one-time two-package migration.
 *
 * `opera-browser-cli` used to ship as its own npm package; it now ships as a
 * second bin inside `opera-devtools-mcp`, reached through a launcher published
 * under the old name. The runtime migration guard (`legacyBridgeCleanup`) and
 * the notices it prints (`launcherNotice`) need the same four facts:
 *
 *   1. Whether the migration is still worth running at all — the guard must not
 *      outlive its reason for existing (see `MIGRATION_ACTIVE_UNTIL`).
 *   2. Which home directory to look in. The old bridge is rarely started under
 *      `sudo`, but the machine may be, and `os.homedir()` then answers for root
 *      (`/var/root`, `/root`) while the invoking user's
 *      `~/.opera-browser-cli/bridge.pid` is never found.
 *   3. Where a global install put the old package — without assuming npm, whose
 *      `npm_config_prefix` is not set by pnpm, yarn or bun.
 *   4. How to say something. The guard must never print to stdout, which carries
 *      the CLI's machine-readable result and the MCP server's transport.
 */

import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {setTimeout as sleep} from 'node:timers/promises';

import {PACKAGE_NAME} from './branding.js';

/**
 * The last day the migration guard does its work. Past it the guard returns
 * immediately, so a cleanup written for one transition cannot keep probing port
 * windows — or keep printing its notices — forever.
 */
export const MIGRATION_ACTIVE_UNTIL = new Date('2027-03-01T00:00:00Z');

/** Whether the migration guard should still do its work. */
export function isMigrationActive(now: Date = new Date()): boolean {
  return now.getTime() <= MIGRATION_ACTIVE_UNTIL.getTime();
}

/** Say something to the user without touching the CLI's stdout. */
export function warn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** How long a SIGTERMed process gets before the kill escalates. */
const STOP_GRACE_MS = 5_000;
const STOP_POLL_MS = 100;

/** `process.kill(pid, 0)`, treating `EPERM` (another user's live process) as alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * SIGTERM, wait, then SIGKILL — and true once the process is gone.
 *
 * `group: true` escalates to the whole process group, which is what a session
 * leader's teardown needs: the daemon and the legacy bridge are both spawned
 * `detached: true`, so the browser and the MCP server they spawned share their
 * group and survive a signal aimed at the leader alone. Windows has no process
 * groups, so the pid is all there is to signal.
 */
export async function terminateProcess(
  pid: number,
  options: {group?: boolean} = {},
): Promise<boolean> {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // `ESRCH` is the process we meant to stop being gone already. Anything else
    // — `EPERM` on a process owned by another user, the common case for a
    // bridge started with `sudo` — means the signal was not delivered, and
    // reporting success there would hide a bridge that is still running and let
    // its caller drop the PID file that records it.
    return !isProcessAlive(pid);
  }
  const deadline = Date.now() + STOP_GRACE_MS;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(STOP_POLL_MS);
  }
  try {
    if (options.group && process.platform !== 'win32') {
      process.kill(-pid, 'SIGKILL');
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    return !isProcessAlive(pid);
  }
  await sleep(200);
  return !isProcessAlive(pid);
}

/**
 * The home directory of the user who invoked the install.
 *
 * Under `sudo`, that is not `os.homedir()`: `SUDO_USER`/`SUDO_UID` name the
 * real user, and their home is what holds the legacy bridge's PID file. The
 * lookup goes through the login shell because `~user` expansion is the only
 * portable way to ask (Node exposes no uid→home call), and the username is
 * validated first so it cannot smuggle shell syntax into the command.
 *
 * Windows is skipped: it has no `sudo`, and the `sh` that happens to be on PATH
 * (Git Bash) answers `~user` with a POSIX path like `/c/Users/someone` — not the
 * `os.homedir()` every other caller of this function builds its paths with.
 */
export function getEffectiveHome(): string {
  const user = process.env.SUDO_USER;
  if (
    process.platform !== 'win32' &&
    user &&
    process.env.SUDO_UID &&
    /^[A-Za-z0-9._-]+$/.test(user)
  ) {
    try {
      const home = execFileSync('sh', ['-c', `echo ~${user}`], {
        encoding: 'utf8',
        timeout: 5_000,
      }).trim();
      if (home.startsWith('/')) {
        return home;
      }
    } catch {
      // Fall through to the process's own home.
    }
  }
  return os.homedir();
}

/**
 * The global install prefix, or null when it cannot be determined.
 *
 * Two sources, neither of which spawns a process: the environment npm and pnpm
 * set during a global install, and this file's own location —
 * `<prefix>/lib/node_modules/<pkg>/build/src/opera`. Asking npm was the old
 * fallback, but this runs on every start now, and a second npm costs ~1s of
 * process start and contends on the arborist lock npm 7+ holds during a global
 * install. A development checkout, whose path is not inside a global
 * `node_modules` tree, correctly reports nothing.
 */
export function resolveGlobalPrefix(): string | null {
  const fromEnv =
    process.env.npm_config_prefix ?? process.env.NPM_CONFIG_PREFIX ?? '';
  if (fromEnv) {
    return fromEnv;
  }
  // Symlinks are resolved by default, so a pnpm/bun-linked install reports the
  // store path and this finds no `lib/node_modules` — no prefix, no notice.
  const parts = path.resolve(import.meta.dirname).split(path.sep);
  const packageDir = parts.lastIndexOf(PACKAGE_NAME);
  if (packageDir < 2 || parts[packageDir - 1] !== 'node_modules') {
    return null;
  }
  const prefix = parts.slice(0, packageDir - 1);
  if (prefix[prefix.length - 1] === 'lib') {
    prefix.pop();
  }
  return prefix.join(path.sep) || path.sep;
}
