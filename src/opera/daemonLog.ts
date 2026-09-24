/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Where the daemon's output goes, and what the CLI says about a daemon that is
 * gone.
 *
 * The daemon is spawned detached with no terminal, so without a file its
 * diagnostics go nowhere: a daemon that is killed outright leaves a dead pid
 * file, a stale socket and no way to tell what it was doing. Everything the
 * daemon prints — including the reason it records on its way out — lands here,
 * and the CLI points at this file when it has nothing better to report.
 *
 * Opera-owned for the same reason `claimPidFile` is: the upstream client names
 * an entry point (open the log for the spawn, say why the daemon died), and this
 * module owns the behaviour — a one-generation rotation, a refusal to follow a
 * symlink, and a fallback that keeps a diagnostic from stopping the daemon from
 * starting at all.
 */

import type {ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {getRuntimeHome} from '../daemon/utils.js';
import {logger} from '../utils/logger.js';

import {readExitReason} from './daemonLifecycle.js';

/**
 * The daemon's own stdout/stderr capture point, inside the session's runtime
 * home.
 */
export function getDaemonLogPath(sessionId: string): string {
  return path.join(getRuntimeHome(sessionId), 'daemon.log');
}

/**
 * The log of the daemon before the current one. The log is rotated rather than
 * truncated — the CLI points at it when a daemon was killed — so this is where a
 * killed daemon's output lives once the session has started a new one.
 */
export function getPreviousDaemonLogPath(sessionId: string): string {
  return `${getDaemonLogPath(sessionId)}.prev`;
}

/**
 * Open the daemon's log for the spawn, creating the runtime directory the daemon
 * would otherwise create itself.
 *
 * The directory is chmod-ed after creation rather than relying on `mkdirSync`'s
 * mode, which is masked by the umask and does nothing at all to a directory that
 * already exists. The daemon refuses to run on a group/world-writable runtime
 * directory, so the mode has to hold whether the CLI or the daemon created it.
 *
 * Nothing here is allowed to stop the daemon from starting: a log is a
 * diagnostic, and a runtime dir this process cannot write (another user's, a
 * read-only mount) degrades to `'ignore'` stdio with a warning instead of
 * killing the spawn. `O_NOFOLLOW` so a planted symlink is never written
 * through — the pid file gets the same guarantee.
 */
export function openDaemonLog(sessionId: string): number | 'ignore' {
  try {
    const logPath = getDaemonLogPath(sessionId);
    const dir = path.dirname(logPath);
    fs.mkdirSync(dir, {recursive: true, mode: 0o700});
    if (process.platform !== 'win32') {
      fs.chmodSync(dir, 0o700);
    }
    // Rotate instead of truncating: this file is where a killed daemon's output
    // lives, and the CLI points at it when a daemon left no reason behind.
    // Keeping one previous generation bounds the growth without throwing away
    // the only evidence of the previous failure.
    try {
      fs.renameSync(logPath, getPreviousDaemonLogPath(sessionId));
    } catch {
      // No previous log — the common case.
    }
    return fs.openSync(
      logPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_APPEND |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    logger?.(
      'Could not open the daemon log; the daemon will run without one:',
      error,
    );
    return 'ignore';
  }
}

/**
 * Why the daemon is gone, for a command that was already in flight.
 *
 * A daemon that ran its own teardown leaves a reason; one that was killed
 * cannot, and that difference is the whole point of the message. `readExitReason`
 * leaves the file in place, so this can be called on every attempt.
 */
export function daemonExitMessage(sessionId: string): string {
  const reason = readExitReason(sessionId);
  if (reason) {
    return `Daemon exited while running the command: ${reason}`;
  }
  return (
    'Daemon exited while running the command and left no reason behind, ' +
    'which means it was killed rather than shut down (SIGKILL, the OOM killer). ' +
    `Its output is at ${getDaemonLogPath(sessionId)}` +
    `, or at ${getPreviousDaemonLogPath(sessionId)} if a daemon has started since.`
  );
}

/**
 * The rejection a spawn failure deserves, for `Promise.race` against the
 * pid-file wait.
 *
 * A spawn that fails outright — a missing script, an unusable execPath — emits
 * `'error'` and never creates the pid file, which would otherwise surface as an
 * unexplained ready-timeout. The log names the reason; this names the log.
 */
export function nameSpawnFailure(
  child: ChildProcess,
  sessionId: string,
): Promise<never> {
  return new Promise((_, reject) => {
    child.on('error', error => {
      reject(
        new Error(
          `Failed to start the daemon: ${error.message}. Its log is at ${getDaemonLogPath(sessionId)}.`,
          {cause: error},
        ),
      );
    });
  });
}
