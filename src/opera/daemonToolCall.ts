/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * The daemon's policy around `tools/call`: how long the tool may run, and which
 * streaming token identifies its chunks.
 *
 * Both decisions have to agree with the CLI's — the shorter timeout of the two
 * wins, and a chunk with no token can never be routed — so they live in one
 * function with one test rather than inline in `daemon.ts`, which is injections
 * only. Nothing here needs a daemon, a socket or a browser to be exercised.
 */

import type {Client} from '../third_party/index.js';
import {operaAiTimeoutMs} from './streamingTools.js';

export interface ToolCallRequest {
  tool: string;
  args?: Record<string, unknown>;
  /**
   * The streaming token of the socket request that asked for chunks. Absent for
   * a request that did not, which keeps the call identical to the original
   * one-request-one-response protocol.
   */
  streamToken?: string;
}

/**
 * Run one tool through the daemon's MCP client.
 *
 * `_meta` is the only per-request slot the MCP round trip preserves, which is
 * what makes it the streaming token's carrier: the server echoes it on every
 * `notifications/message` the tool emits, so a chunk can be routed back to the
 * connection whose request produced it (`opera/daemonStreaming.ts`).
 */
export async function callDaemonTool(
  client: Client,
  request: ToolCallRequest,
): Promise<unknown> {
  const timeout = operaAiTimeoutMs(request.tool);
  return await client.callTool(
    {
      name: request.tool,
      arguments: request.args ?? {},
      ...(request.streamToken === undefined
        ? {}
        : {_meta: {streamToken: request.streamToken}}),
    },
    undefined,
    timeout === undefined ? undefined : {timeout},
  );
}
