/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * The daemon's pid file, behind an `O_EXCL` claim.
 *
 * Upstream opens the file with `O_TRUNC`, which makes the pid file a last-writer
 * -wins slot rather than a lock: two clients that both observe "not running"
 * both spawn a daemon, the second one truncates the first one's file and then
 * unlinks its socket, and the session is left with one visible daemon and one
 * deaf one. `O_EXCL` makes exactly one of them the owner; the loser gets
 * `EEXIST` and exits before it can touch anything.
 *
 * A file left by a daemon that died is still reclaimable, but only after
 * re-reading it to confirm it names that same dead pid: a third daemon may have
 * claimed it in between. The re-read *narrows* the window to the gap between
 * that comparison and the unlink — microseconds, and the loser of any race here
 * retries `O_EXCL` and exits, so it does not close it outright.
 */

import fs from 'node:fs';
import {constants, openSync} from 'node:fs';
import process from 'node:process';

import {getDaemonPid, getPidFilePath} from '../daemon/utils.js';

const PID_FILE_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;

/**
 * Remove the pid file of a daemon that is no longer alive. False when the file
 * belongs to a live daemon, or to one that is mid-write and has not written its
 * pid yet — unlinking either would hide a daemon that is starting up.
 */
function reclaimStalePidFile(sessionId: string): boolean {
  const pidFilePath = getPidFilePath(sessionId);
  const existingPid = getDaemonPid(sessionId);
  if (existingPid === null) {
    return false;
  }
  try {
    process.kill(existingPid, 0);
    return false;
  } catch {
    // Dead pid: the file is ours to reclaim.
  }
  try {
    if (
      fs.readFileSync(pidFilePath, 'utf-8').trim() !== existingPid.toString()
    ) {
      return false;
    }
    fs.unlinkSync(pidFilePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Open the session's pid file and return the descriptor to write this process's
 * pid into. Throws — the daemon is expected to report and exit — if another
 * daemon owns it.
 *
 * `O_NOFOLLOW` means a symlink is never followed, and the returned descriptor
 * is created `0o600`: readable and writable by its owner alone.
 */
export function claimPidFile(sessionId: string): number {
  const pidFilePath = getPidFilePath(sessionId);
  try {
    return openSync(pidFilePath, PID_FILE_FLAGS, 0o600);
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code !== 'EEXIST' ||
      !reclaimStalePidFile(sessionId)
    ) {
      throw err;
    }
  }
  // One retry: the window between the unlink and this open is nanoseconds, so a
  // second `EEXIST` means another daemon genuinely won the race.
  return openSync(pidFilePath, PID_FILE_FLAGS, 0o600);
}
