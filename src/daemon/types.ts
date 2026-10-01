/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export type DaemonMessage =
  | {
      method: 'stop';
    }
  | {
      method: 'status';
    }
  | {
      method: 'invoke_tool';
      tool: string;
      args?: Record<string, unknown>;
      /**
       * The client wants partial chunks as they arrive. Opt-in, so a client
       * that does not set it keeps the original one-message-one-response
       * protocol byte for byte.
       *
       * The chunks themselves are addressed by a token the daemon mints for
       * this request — the client asks for streaming, the daemon identifies it
       * (see `opera/daemonStreaming.ts`).
       */
      stream?: true;
    };

export interface DaemonResponse {
  success: boolean;
  // Stringified CallToolResult.
  result: string;
  error: unknown;
}

/**
 * A streamed chunk, sent before the final `DaemonResponse` while a streaming
 * tool runs. Chunks are raw text for the user's terminal, not JSON to parse.
 */
export interface DaemonLogFrame {
  log: string;
}

export interface DaemonStatusResult {
  pid: number | null;
  socketPath: string;
  startDate: string;
  version: string;
  args: string[];
}
