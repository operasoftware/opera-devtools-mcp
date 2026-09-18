/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * The daemon's socket edges: the frame it is answering, and the failure it
 * reports when it cannot start listening at all.
 *
 * Both exist because the daemon's own error handling is a trapdoor. A frame that
 * is not JSON rejects the transport callback, and the daemon's
 * `unhandledRejection` handler runs `cleanup(1)`: one malformed byte from
 * anything that can open the socket takes the whole session down. And a startup
 * failure that runs `cleanup()` unlinks the socket file — which, when the
 * failure is a lost bind race, belongs to the daemon that won. The winner is
 * left alive and deaf, which is the orphan this whole area exists to prevent.
 */

import process from 'node:process';

import type {DaemonMessage} from '../daemon/types.js';

import {writeExitReason} from './daemonLifecycle.js';

/**
 * Parse one framed socket message and hand it to `handle`, answering with an
 * error reply when it is not JSON — or when `handle` itself throws. The reply is
 * a reply, not an exception: the caller sends it and closes the connection, and
 * nothing on this path is allowed to reach the daemon's `unhandledRejection`
 * handler, whose answer to any stray rejection is to tear the session down.
 */
export async function answerSocketMessage(
  raw: string,
  handle: (message: DaemonMessage) => Promise<object>,
): Promise<object> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {success: false, error: 'malformed message'};
  }
  try {
    return await handle(parsed as DaemonMessage);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface StartupFailureOptions {
  /** True once `listen` succeeded, i.e. this daemon owns the socket. */
  socketBound: boolean;
  sessionId: string;
  /** Tear this daemon down, recording why for the next CLI invocation. */
  teardown(reason: string): Promise<void>;
}

/**
 * Report why the daemon could not start, and get out of the way.
 *
 * A daemon that lost the bind race must not run the caller's `teardown`: it
 * would unlink the socket file the winner is listening on and leave a live,
 * unreachable daemon behind. It exits bare instead, leaving a reason for the
 * next CLI invocation to surface. A failure after a successful bind is ours to
 * clean up, socket and all — and it records why, like every other shutdown.
 */
export async function reportStartupFailure(
  error: unknown,
  options: StartupFailureOptions,
): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  if (options.socketBound) {
    await options.teardown(`startup failed: ${detail}`);
    return;
  }
  writeExitReason(options.sessionId, `socket bind failed: ${detail}`);
  process.exit(1);
}
