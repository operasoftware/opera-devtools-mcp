/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Daemon lifecycle supervision, owned by Opera.
 *
 * The upstream daemon is spawned `detached: true` and `unref()`ed, so the CLI
 * is not its parent and nothing recovers the process tree when it goes away
 * badly. Two holes follow from that, and this module closes both without
 * touching the daemon's own supervision of its children:
 *
 * 1. **Liveness is pid-file-only.** `isDaemonRunning` reads the pid file, so a
 *    daemon whose pid file was removed (or whose socket was unlinked by a
 *    racing starter) is invisible: the next `start` forks a second daemon and
 *    the first keeps running as an orphan holding the session's real socket.
 *    `ensureCleanStart` probes the socket itself — the one signal that survives
 *    a missing pid file — and stops any daemon it finds there.
 *
 * 2. **A dead daemon leaves its process group behind.** SIGKILL (what the OOM
 *    killer sends) runs no handler, so the MCP server and the browser stay up
 *    re-parented to init. `ensureCleanStart` kills the whole process group of a
 *    dead pid, which is what reaps them: the daemon is a session leader
 *    (`detached: true` calls `setsid()`), so every child it spawned shares its
 *    group id — including group members whose leader has already exited.
 *
 * Nothing here deletes the pid or socket files. File creation belongs to the
 * daemon's own `O_EXCL` claim (`daemon.ts`); a client that unlinked them would
 * reopen the race this module exists to close.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';
import {setTimeout as sleep} from 'node:timers/promises';

import type {DaemonResponse, DaemonStatusResult} from '../daemon/types.js';
import {
  getDaemonPid,
  getRuntimeHome,
  getSocketPath,
  IS_WINDOWS,
} from '../daemon/utils.js';
import {PipeTransport} from '../third_party/index.js';
import {logger, puppeteerLogger} from '../utils/logger.js';

/** How long a socket probe waits to connect before concluding nothing is there. */
const SOCKET_CONNECT_TIMEOUT_MS = 1_000;
/**
 * How long it then waits for the reply, once something accepted the connection.
 * Longer than the connect wait on purpose: a daemon that connected is alive, and
 * a busy one — a long tool call, a GC pause, a stalled disk — answers late rather
 * than never. Declaring it dead on a 1s reply window forks a second daemon whose
 * `O_EXCL` claim then fails, which reaches the user as a spurious startup error.
 */
const SOCKET_REPLY_TIMEOUT_MS = 5_000;
/** How long to wait for a daemon to exit after asking it to stop. */
const STOP_WAIT_TIMEOUT_MS = 5_000;
const STOP_WAIT_POLL_MS = 50;
/** Where a dying daemon explains itself to the next CLI invocation. */
const EXIT_REASON_FILE = 'daemon-error';

/**
 * `process.kill(pid, 0)` with the semantics the callers want: `EPERM` means the
 * pid exists but belongs to another user, which still counts as alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Get rid of a daemon that is known to be dead or unresponsive. POSIX: SIGKILL
 * its whole process group, which is what reaps the MCP server, the browser and
 * Chrome's helpers along with it (the daemon is a session leader, and the group
 * outlives its leader as long as one member is alive).
 *
 * `ESRCH` (the group is already gone) is the expected outcome once the daemon
 * exited cleanly, so it is not logged as a failure.
 */
function killStaleDaemon(pid: number): void {
  if (IS_WINDOWS) {
    // No process groups to signal, so the daemon itself is the only handle
    // available here. What it spawned is not reachable from this call.
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
    logger?.(`Killed the process group of daemon ${pid}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH') {
      logger?.(`Could not kill the process group of daemon ${pid}:`, error);
    }
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await sleep(STOP_WAIT_POLL_MS);
  }
  return !isProcessAlive(pid);
}

/** The pid out of a raw `status` reply, or null if the reply is not one. */
function readPidFromStatus(rawReply: string): number | null {
  try {
    const response = JSON.parse(rawReply) as Partial<DaemonResponse>;
    if (!response.success || typeof response.result !== 'string') {
      return null;
    }
    const status = JSON.parse(response.result) as Partial<DaemonStatusResult>;
    return typeof status.pid === 'number' ? status.pid : null;
  } catch {
    return null;
  }
}

/**
 * Open the session's socket and send one framed command, resolving with the
 * daemon's raw reply. `null` means the caller should act as if the session is
 * empty: the socket file is missing, nobody accepts the connection, or the
 * connection broke before a reply arrived.
 *
 * A connection that is accepted and then goes quiet is logged separately. It
 * means a daemon exists and is too busy (or too wedged) to answer, which is a
 * different thing to debug than no daemon at all — but the same thing to do
 * about, because nothing here can stop a daemon that will not talk.
 *
 * This bypasses `sendCommand`, whose pid-file guard is the very check that
 * cannot see the daemon we are looking for.
 */
async function probeSocket(
  sessionId: string,
  command: {method: string},
): Promise<string | null> {
  const socketPath = getSocketPath(sessionId);
  const {promise, resolve} = Promise.withResolvers<string | null>();
  const socket = net.createConnection({path: socketPath});
  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  const settle = (reply: string | null) => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    resolve(reply);
  };

  const armTimer = (timeoutMs: number, waitingFor: string) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      logger?.(
        `Daemon probe on ${socketPath} timed out after ${timeoutMs}ms ${waitingFor}`,
      );
      settle(null);
    }, timeoutMs);
  };

  armTimer(SOCKET_CONNECT_TIMEOUT_MS, 'waiting for a connection');
  socket.on('error', (error: NodeJS.ErrnoException) => {
    // ECONNREFUSED, ENOENT or a mid-reply reset: nothing to talk to.
    logger?.(
      `Daemon probe on ${socketPath} failed: ${error.code ?? error.message}`,
    );
    settle(null);
  });
  socket.on('connect', () => {
    armTimer(
      SOCKET_REPLY_TIMEOUT_MS,
      `waiting for a reply to ${command.method}`,
    );
    const transport = new PipeTransport(socket, socket, puppeteerLogger);
    transport.onmessage = (message: string) => settle(message);
    transport.send(JSON.stringify(command));
  });

  return await promise;
}

/**
 * Make the session safe to start a daemon in.
 *
 * Returns `true` when a live daemon already serves the session — the caller
 * should simply wait for it to become ready — and `false` when the caller
 * should fork one. Any daemon that the pid file does not mention, and any
 * process group left behind by a daemon that died without cleaning up, is gone
 * by the time this resolves.
 */
export async function ensureCleanStart(sessionId: string): Promise<boolean> {
  const pid = getDaemonPid(sessionId);
  if (pid !== null) {
    if (isProcessAlive(pid)) {
      return true;
    }
    // The pid file outlived its daemon. Everything the daemon spawned — MCP
    // server, browser, Chrome helpers — shares its process group, and the group
    // still exists as long as one member does, so this single kill reaps the
    // tree that a SIGKILLed daemon left behind.
    logger?.(
      `Pid file names the dead daemon ${pid}; reaping its process group`,
    );
    killStaleDaemon(pid);
  }

  const reply = await probeSocket(sessionId, {method: 'status'});
  const hiddenPid = reply === null ? null : readPidFromStatus(reply);
  if (hiddenPid !== null) {
    logger?.(
      `Found daemon ${hiddenPid}, which the pid file does not mention; stopping it`,
    );
    await probeSocket(sessionId, {method: 'stop'});
    if (!(await waitForProcessExit(hiddenPid, STOP_WAIT_TIMEOUT_MS))) {
      // It took the request and did not go. Leaving it is precisely the
      // invisible orphan this probe exists to remove - the caller is about to
      // fork a daemon that will unlink its socket - so stop asking.
      logger?.(`Daemon ${hiddenPid} ignored stop; killing its process group`);
      killStaleDaemon(hiddenPid);
      await waitForProcessExit(hiddenPid, STOP_WAIT_TIMEOUT_MS);
    }
  }

  // Nothing owns the session now. Drop a stale exit reason so a later failure
  // is not reported with a previous daemon's explanation. This is the only
  // place the reason is cleared: `readExitReason` deliberately leaves it in
  // place, because the CLI's readiness loop reads it on every retry and reports
  // its *last* error — a read that consumed the file would hand the user a
  // "Daemon is not running." with no explanation.
  try {
    fs.rmSync(exitReasonPath(sessionId), {force: true});
  } catch {
    // best-effort
  }
  return false;
}

/** The file a daemon leaves behind to explain its own exit. */
function exitReasonPath(sessionId: string): string {
  return path.join(getRuntimeHome(sessionId), EXIT_REASON_FILE);
}

/**
 * Record why a daemon is going away, for the next CLI invocation to surface.
 * Best-effort: the daemon is on its way out, and a reason file that cannot be
 * written must not be the thing that keeps it alive.
 */
export function writeExitReason(sessionId: string, message: string): void {
  try {
    fs.writeFileSync(exitReasonPath(sessionId), message);
  } catch {
    // best-effort
  }
}

/**
 * The daemon's exit reason, if it left one. Left in place on purpose: a readiness
 * loop reads this on every retry and reports its last error, so the file is only
 * cleared where the session is known clean — `ensureCleanStart`, before a new
 * daemon is forked. Any caller that reads the reason without that having run
 * will keep seeing it; that is the invariant, not a leak.
 */
export function readExitReason(sessionId: string): string | null {
  try {
    return fs.readFileSync(exitReasonPath(sessionId), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}
