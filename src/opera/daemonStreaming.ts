/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Streaming, both sides of the daemon socket: the daemon is the bridge between
 * the browser's `notifications/message` chunks and the CLI's stderr.
 *
 * The MCP server already streams — `opera/toolHandlerHooks.ts`'s
 * `makeLogCallback` sends each partial chunk as a logging notification carrying
 * the MCP request ID in `logger` — but the daemon's socket protocol is
 * one-message-one-response, so the chunks had nowhere to go. This module owns
 * the gap: the daemon-side handler that catches the notifications and the sinks
 * a streaming request installs, plus the client-side reader that pulls chunks
 * off a connection until the final response frame arrives.
 *
 * Why the sink is keyed by a token rather than "the one active request": a
 * daemon serves many socket connections, and more than one of them can be
 * inside a long Opera AI call at the same time — a second terminal, or the same
 * user starting another command while the first is still running. With a single
 * shared sink, the newer request took it over and *the older request finishing
 * cleared it for everyone*, so the run that was still streaming lost its output
 * from that moment on. The daemon therefore mints a token per streaming request
 * and puts it in the `tools/call` request's `_meta` (see `daemon.ts`); the
 * server echoes it on every notification it emits for that request
 * (`toolHandlerHooks.ts`), which is what lets a chunk be routed to the
 * connection whose request produced it — and only that one.
 */

import type {Socket} from 'node:net';

import type {
  DaemonLogFrame,
  DaemonMessage,
  DaemonResponse,
} from '../daemon/types.js';
import type {Client} from '../third_party/index.js';
import {
  LoggingMessageNotificationSchema,
  PipeTransport,
} from '../third_party/index.js';
import {logger, puppeteerLogger} from '../utils/logger.js';

import {daemonExitMessage} from './daemonLog.js';

/** A streamed chunk frame, distinguished from the final response frame. */
function isLogFrame(value: unknown): value is DaemonLogFrame {
  if (typeof value !== 'object' || value === null || !('log' in value)) {
    return false;
  }
  return typeof value.log === 'string';
}

/** The live chunk sinks, keyed by the streaming token of their request. */
const sinks = new Map<string, (chunk: string) => void>();

/**
 * The streaming token a notification carries, if any.
 *
 * `_meta` is the protocol's own slot for per-request metadata of this kind
 * (`RequestMetaSchema` is a loose object, so an extra key is legal on both the
 * request and the notification), and a notification without one belongs to a
 * caller that did not ask for streaming.
 */
function streamTokenOf(params: object): string | undefined {
  const meta = (params as {_meta?: unknown})._meta;
  if (typeof meta !== 'object' || meta === null) {
    return undefined;
  }
  const token = (meta as {streamToken?: unknown}).streamToken;
  return typeof token === 'string' ? token : undefined;
}

/**
 * Forward `notifications/message` chunks to the sink of the request they
 * belong to.
 *
 * `data` is a plain string (see `makeLogCallback`); anything else is some other
 * logger's notification and is ignored rather than stringified into the user's
 * terminal.
 */
export function attachLogForwarding(client: Client): void {
  client.setNotificationHandler(
    LoggingMessageNotificationSchema,
    notification => {
      const params: unknown = notification.params;
      if (
        typeof params !== 'object' ||
        params === null ||
        !('data' in params) ||
        typeof params.data !== 'string'
      ) {
        return;
      }
      const token = streamTokenOf(params);
      if (token === undefined) {
        return;
      }
      sinks.get(token)?.(params.data);
    },
  );
}

/**
 * Run `work` with the sink for `token` installed, and always remove it again —
 * a sink left behind would push chunks from a *later* request onto a closed
 * socket. Only this token's entry is removed, so a request that finishes never
 * takes another request's streaming down with it.
 */
export async function withLogSink<T>(
  token: string,
  sink: (chunk: string) => void,
  work: () => Promise<T>,
): Promise<T> {
  sinks.set(token, sink);
  try {
    return await work();
  } finally {
    sinks.delete(token);
  }
}

export interface SocketRequest {
  /** The connecting (or connected) daemon socket. */
  socket: Socket;
  /** The command to send; `stream: true` is added when `onLog` is given. */
  command: DaemonMessage;
  /** Milliseconds of quiet before the request is abandoned. */
  timeout: number;
  /** Names the daemon in the error a dropped connection produces. */
  sessionId: string;
  /** Receives each chunk of a streaming request as it arrives. */
  onLog?: (chunk: string) => void;
}

/**
 * Read one response off one socket connection, streaming-aware: client side.
 *
 * With `onLog`, the request is marked `stream` and the connection stays open
 * for the whole run: each `{log}` frame is handed to `onLog` as it arrives, and
 * the promise settles on the final `DaemonResponse`. The timeout is re-armed by
 * every chunk, so a long call that is actively producing output is never killed
 * for being slow — only for going quiet.
 *
 * Without `onLog`, the original one-message-one-response protocol applies and
 * the first frame is the answer, byte for byte as upstream's client reads it.
 */
export function requestOverSocket(
  options: SocketRequest,
): Promise<DaemonResponse> {
  const {socket, command, timeout, sessionId, onLog} = options;

  // Only a tool call can produce chunks, so a `stop` or `status` that is
  // handed a sink anyway is still sent on the original protocol.
  const message: DaemonMessage =
    onLog !== undefined && command.method === 'invoke_tool'
      ? {...command, stream: true}
      : command;

  const {promise, resolve, reject} = Promise.withResolvers<DaemonResponse>();

  let timer: NodeJS.Timeout;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timeout waiting for daemon response'));
    }, timeout);
  };
  arm();

  const transport = new PipeTransport(socket, socket, puppeteerLogger);
  transport.onmessage = (frame: string) => {
    logger?.('onmessage', frame);
    const parsed: unknown = JSON.parse(frame);
    // A chunk frame is not the answer: hand it over and keep waiting.
    if (onLog !== undefined && isLogFrame(parsed)) {
      arm();
      onLog(parsed.log);
      return;
    }
    clearTimeout(timer);
    resolve(parsed as DaemonResponse);
  };
  socket.on('error', error => {
    clearTimeout(timer);
    logger?.('Socket error:', error);
    reject(error);
  });
  socket.on('close', () => {
    clearTimeout(timer);
    logger?.('Socket closed:');
    reject(new Error(daemonExitMessage(sessionId)));
  });
  logger?.('Sending message', message);
  transport.send(JSON.stringify(message));

  return promise;
}
