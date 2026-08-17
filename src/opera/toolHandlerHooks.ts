/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import type fs from 'node:fs';

import type {parseArguments} from '../bin/chrome-devtools-mcp-cli-options.js';
import {ToolCategory} from '../tools/categories.js';
import type {DefinedPageTool, ToolDefinition} from '../tools/ToolDefinition.js';

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
   * running concurrently with other tools, because `beforeInvoke` can relaunch
   * (close and reopen) the shared, module-level browser for the Opera
   * automation flags. Opera tools relaunch the browser only when *this* tool
   * needs different flags, but by bypassing the mutex they lose the serialisation
   * that would otherwise keep them from disrupting an in-flight tool. Keep this
   * coupling in mind if `bypassMutex` is ever widened beyond the `OPERA`
   * category.
   */
  bypassMutex(tool: AnyTool): boolean;
  /** Runs before the context is resolved, so it may relaunch the browser. */
  beforeInvoke(tool: AnyTool): Promise<void>;
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
      await ensureBrowserFlagsForTool(
        tool.name,
        deps.serverArgs,
        deps.logFile,
        {resetContext: deps.resetContext},
      );
    },

    makeLogCallback(extra) {
      const sendNotification = extra?.sendNotification;
      if (!sendNotification) {
        return undefined;
      }
      return (message: string) => {
        // `logger` carries the MCP request ID so the opera-cli bridge can route
        // this chunk to the correct HTTP response (see bridge.ts requestLoggers).
        // `data` stays a plain string so non-bridge MCP hosts (Claude Desktop,
        // VS Code, etc.) continue to render it as readable text.
        void sendNotification.call(extra, {
          method: 'notifications/message',
          params: {
            level: 'info',
            data: message,
            logger: String(extra?.requestId),
          },
        });
      };
    },
  };
}
