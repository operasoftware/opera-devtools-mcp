/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * How the daemon goes away, and what it says about it.
 *
 * Two problems, both about the daemon's last words. Every shutdown path has to
 * record *why* it is leaving — the CLI reads that reason when a command was in
 * flight, and a shutdown that records nothing is reported there as a kill — and
 * the handlers that do it have to exist before anything can go wrong, which is
 * why the daemon installs them next to its other startup work rather than deep
 * in its teardown.
 *
 * A shutdown on request is not a kill: `SIGTERM` from a supervisor, `SIGINT`
 * from a terminal and `SIGHUP` from a closed shell each name themselves, so
 * "left no reason behind" is left to mean what it says — a `SIGKILL` or the OOM
 * killer, neither of which can run a handler at all.
 */

import process from 'node:process';

import {writeExitReason} from './daemonLifecycle.js';

/** Every signal the daemon treats as "stop", and the words it reports them with. */
const SHUTDOWN_SIGNALS = [
  ['SIGTERM', 'terminated by signal: SIGTERM'],
  ['SIGINT', 'interrupted by signal: SIGINT'],
  ['SIGHUP', 'hung up on signal: SIGHUP'],
] as const;

export interface ShutdownHandlers {
  /** The daemon was asked to stop, and says why. Runs with exit code 0. */
  onSignal(reason: string): Promise<void>;
  /** The daemon fell over, and says why. Runs with exit code 1. */
  onException(reason: string): Promise<void>;
}

function describeError(kind: string, error: unknown): string {
  return `${kind}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Install the daemon's signal and uncaught-error handlers.
 *
 * The stack goes to stderr rather than `logger` because stderr *is* the daemon
 * log (stdio is redirected to it at spawn), and a `logger` stream would be
 * dropped by the `process.exit` the teardown ends in.
 */
export function installShutdownHandlers(handlers: ShutdownHandlers): void {
  for (const [signal, reason] of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      void handlers.onSignal(reason);
    });
  }
  process.on('uncaughtException', error => {
    console.error('[MCP Daemon] Uncaught exception:', error);
    void handlers.onException(describeError('uncaught exception', error));
  });
  process.on('unhandledRejection', error => {
    console.error('[MCP Daemon] Unhandled rejection:', error);
    void handlers.onException(describeError('unhandled rejection', error));
  });
}

/**
 * Record why a daemon is going away, for the next CLI invocation to surface.
 * Best-effort: the daemon is on its way out, and a reason file that cannot be
 * written must not be the thing that keeps it alive. A shutdown with no reason
 * to give writes nothing.
 */
export function recordShutdownReason(sessionId: string, reason?: string): void {
  if (reason) {
    writeExitReason(sessionId, reason);
  }
}
