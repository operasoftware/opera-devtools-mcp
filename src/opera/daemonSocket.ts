/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * The daemon's socket edges: the frame it is answering (`dispatchSocketMessage`,
 * which routes a streaming request through `answerSocketMessage`), and the
 * failure it reports when it cannot start listening at all.
 *
 * Both exist because the daemon's own error handling is a trapdoor. A frame that
 * is not JSON rejects the transport callback, and the daemon's
 * `unhandledRejection` handler runs `cleanup(1)`: one malformed byte from
 * anything that can open the socket takes the whole session down. And a startup
 * failure that runs `cleanup()` unlinks the socket file — which, when the
 * failure is a lost bind race, belongs to the daemon that won. The winner is
 * left alive and deaf, which is the orphan this whole area exists to prevent.
 */

import {randomUUID} from 'node:crypto';
import process from 'node:process';

import type {DaemonLogFrame, DaemonMessage} from '../daemon/types.js';
import type {PipeTransport} from '../third_party/index.js';

import {writeExitReason} from './daemonLifecycle.js';
import {withLogSink} from './daemonStreaming.js';

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

/**
 * Answer one framed socket message, streaming requests included.
 *
 * A streaming request is the `invoke_tool` variant that opted in, and it gets a
 * token of its own: the chunks it produces are written to this connection as
 * they arrive, and the same final response frame follows. Two connections may
 * stream at once, so the token is what keeps their chunks apart — see
 * `opera/daemonStreaming.ts`. Every other message goes straight to `handle`.
 */
export async function dispatchSocketMessage(
  raw: string,
  transport: PipeTransport,
  handle: (message: DaemonMessage, streamToken?: string) => Promise<object>,
): Promise<object> {
  return answerSocketMessage(raw, message => {
    if (message.method === 'invoke_tool' && message.stream === true) {
      const streamToken = randomUUID();
      return withLogSink(
        streamToken,
        chunk => {
          transport.send(JSON.stringify({log: chunk} satisfies DaemonLogFrame));
        },
        () => handle(message, streamToken),
      );
    }
    return handle(message);
  });
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
