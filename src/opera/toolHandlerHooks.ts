/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import type fs from 'node:fs';

import type {parseArguments} from '../config/mcp-options.js';
import {ToolCategory} from '../tools/categories.js';
import type {DefinedPageTool, ToolDefinition} from '../tools/ToolDefinition.js';
import {logger} from '../utils/logger.js';

import {noteToolFinished, noteToolStarted} from './browserActivity.js';
import {ensureBrowserFlagsForTool} from './browserFlags.js';

type ServerArgs = ReturnType<typeof parseArguments>;
type AnyTool = ToolDefinition | DefinedPageTool;

/**
 * Structural subset of the MCP SDK's `RequestHandlerExtra` that Opera needs.
 * Declared with method syntax so the real (more specific) SDK type stays
 * assignable to it.
 */
export interface ToolInvocationExtra {
  signal?: AbortSignal;
  requestId?: string | number;
  /**
   * The request's `_meta`. The daemon puts its streaming token here: it is the
   * only per-request slot that survives the MCP round trip, so it is what lets
   * a chunk be routed back to the socket connection that asked for streaming.
   */
  _meta?: Record<string, unknown>;
  sendNotification?(notification: unknown): Promise<void>;
}

/**
 * The complete set of Opera-specific behaviour layered onto upstream's
 * `ToolHandler`. Keeping it behind one interface means `ToolHandler.ts` carries
 * three small hook calls instead of a forked copy of the invocation path.
 */
export interface OperaToolHooks {
  /**
   * Opera AI tools are long-running; they must not hold the global tool mutex.
   *
   * INVARIANT: a tool that bypasses the mutex must also tolerate `beforeInvoke`
   * running concurrently with other tools. It can no longer relaunch the browser
   * out from under one: the only relaunch left — acquiring the Opera automation
   * flags for a browser that does not have them yet — waits for every other
   * invocation to finish first (`opera/browserActivity.ts`), so what bypassing
   * the mutex costs is a wait, not a destroyed session. That wait is why
   * `afterInvoke` below has to run for every invocation, refusals included: a
   * claim left behind reads as a browser in use forever.
   */
  bypassMutex(tool: AnyTool): boolean;
  /** Runs before the context is resolved, so it may relaunch the browser. */
  beforeInvoke(tool: AnyTool): Promise<void>;
  /**
   * Runs after the invocation, whatever it did — including when `beforeInvoke`
   * itself refused it. Releases the browser-activity claim `beforeInvoke` took.
   */
  afterInvoke(tool: AnyTool): void;
  /** Streams partial output back to the client as it arrives. */
  makeLogCallback(
    extra: ToolInvocationExtra | undefined,
  ): ((message: string) => void) | undefined;
}

export function createOperaToolHooks(deps: {
  serverArgs: ServerArgs;
  logFile: fs.WriteStream | undefined;
  /** Drops the cached McpContext so the next call rebuilds it. */
  resetContext(): void;
}): OperaToolHooks {
  return {
    bypassMutex(tool) {
      return tool.annotations.category === ToolCategory.OPERA;
    },

    async beforeInvoke(tool) {
      // Claimed before the flags are ensured, so the relaunch this may perform
      // can see who else is using the browser — itself included.
      noteToolStarted(tool.name);
      await ensureBrowserFlagsForTool(
        tool.name,
        deps.serverArgs,
        deps.logFile,
        {resetContext: deps.resetContext},
      );
    },

    afterInvoke(tool) {
      noteToolFinished(tool.name);
    },

    makeLogCallback(extra) {
      const sendNotification = extra?.sendNotification;
      if (!sendNotification) {
        return undefined;
      }
      const streamToken = extra?._meta?.streamToken;
      return (message: string) => {
        // `logger` carries the MCP request ID so the opera-cli bridge can route
        // this chunk to the correct HTTP response (see bridge.ts requestLoggers).
        // `data` stays a plain string so non-bridge MCP hosts (Claude Desktop,
        // VS Code, etc.) continue to render it as readable text.
        sendNotification
          .call(extra, {
            method: 'notifications/message',
            params: {
              level: 'info',
              data: message,
              logger: String(extra?.requestId),
              // Echoed back so the daemon can route the chunk to the request
              // that asked for streaming — see `opera/daemonStreaming.ts`.
              ...(typeof streamToken === 'string'
                ? {_meta: {streamToken}}
                : {}),
            },
          })
          // Best-effort, and never a rejection: `sendNotification` rejects when
          // the transport has already closed, and an unhandled rejection lands in
          // the daemon's `unhandledRejection` handler, which tears the session
          // down — so one undeliverable chunk would cost the whole run, and the
          // supervisor respawning the MCP server would make a burst of them a
          // supervision loop. Losing the chunk costs the user that line only.
          .catch(error => {
            logger?.('Opera AI chunk not delivered:', error);
          });
      };
    },
  };
}
