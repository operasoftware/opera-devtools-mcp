/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Opera Software AS.
 */

import type fs from 'node:fs';

import type {parseArguments} from './bin/opera-devtools-mcp-cli-options.js';
import type {Channel} from './browser.js';
import {
  closeBrowser,
  ensureBrowserConnected,
  ensureBrowserLaunched,
  getCurrentBrowser,
} from './browser.js';
import {loadIssueDescriptions} from './issue-descriptions.js';
import {logger} from './logger.js';
import {McpContext} from './McpContext.js';
import {McpResponse} from './McpResponse.js';
import {Mutex} from './Mutex.js';
import {SlimMcpResponse} from './SlimMcpResponse.js';
import type {ClearcutLogger} from './telemetry/ClearcutLogger.js';
import {bucketizeLatency} from './telemetry/metricUtils.js';
import {
  McpServer,
  type CallToolResult,
  SetLevelRequestSchema,
  ListRootsResultSchema,
  RootsListChangedNotificationSchema,
} from './third_party/index.js';
import {ToolCategory} from './tools/categories.js';
import type {DefinedPageTool, ToolDefinition} from './tools/ToolDefinition.js';
import {pageIdSchema} from './tools/ToolDefinition.js';
import {createTools} from './tools/tools.js';
import {VERSION} from './version.js';

export {buildFlag} from './ToolHandler.js';

export async function createMcpServer(
  serverArgs: ReturnType<typeof parseArguments>,
  options: {
    logFile?: fs.WriteStream;
  },
) {
  let clearcutLogger: ClearcutLogger | undefined;

  const server = new McpServer(
    {
      name: 'chrome_devtools',
      title: 'Chrome DevTools MCP server',
      version: VERSION,
    },
    {capabilities: {logging: {}}},
  );
  server.server.setRequestHandler(SetLevelRequestSchema, () => {
    return {};
  });

  const updateRoots = async () => {
    if (!server.server.getClientCapabilities()?.roots) {
      return;
    }
    try {
      const roots = await server.server.request(
        {method: 'roots/list'},
        ListRootsResultSchema,
      );
      context?.setRoots(roots.roots);
    } catch (e) {
      logger('Failed to list roots', e);
    }
  };

  server.server.oninitialized = () => {
    const clientName = server.server.getClientVersion()?.name;
    if (clientName) {
      clearcutLogger?.setClientName(clientName);
    }
    if (server.server.getClientCapabilities()?.roots) {
      void updateRoots();
      server.server.setNotificationHandler(
        RootsListChangedNotificationSchema,
        () => {
          void updateRoots();
        },
      );
    }
  };

  let context: McpContext | undefined;
  let browserHasOperaFlags = false;
  async function getContext(): Promise<McpContext> {
    const chromeArgs: string[] = (serverArgs.chromeArg ?? []).map(String);
    const ignoreDefaultChromeArgs: string[] = (
      serverArgs.ignoreDefaultChromeArg ?? []
    ).map(String);
    if (serverArgs.proxyServer) {
      chromeArgs.push(`--proxy-server=${serverArgs.proxyServer}`);
    }
    const devtools = serverArgs.experimentalDevtools ?? false;
    const browser =
      serverArgs.browserUrl || serverArgs.wsEndpoint || serverArgs.autoConnect
        ? await ensureBrowserConnected({
            browserURL: serverArgs.browserUrl,
            wsEndpoint: serverArgs.wsEndpoint,
            wsHeaders: serverArgs.wsHeaders,
            // Important: only pass channel, if autoConnect is true.
            channel: serverArgs.autoConnect
              ? (serverArgs.channel as Channel)
              : undefined,
            userDataDir: serverArgs.userDataDir,
            devtools,
          })
        : await ensureBrowserLaunched({
            headless: serverArgs.headless,
            executablePath: serverArgs.executablePath,
            channel: serverArgs.channel as Channel,
            isolated: serverArgs.isolated ?? false,
            userDataDir: serverArgs.userDataDir,
            logFile: options.logFile,
            viewport: serverArgs.viewport,
            chromeArgs,
            ignoreDefaultChromeArgs,
            acceptInsecureCerts: serverArgs.acceptInsecureCerts,
            devtools,
            enableExtensions: serverArgs.categoryExtensions,
            viaCli: serverArgs.viaCli,
          });

    if (context?.browser !== browser) {
      context = await McpContext.from(browser, logger, {
        experimentalDevToolsDebugging: devtools,
        experimentalIncludeAllPages: serverArgs.experimentalIncludeAllPages,
        performanceCrux: serverArgs.performanceCrux,
      });
      await updateRoots();
    }
    return context;
  }

  async function restartBrowserWithoutOperaFlags(): Promise<void> {
    context?.dispose();
    context = undefined;
    browserHasOperaFlags = false;
    await closeBrowser();
  }

  async function restartBrowserForOpera(): Promise<void> {
    context?.dispose();
    context = undefined;
    browserHasOperaFlags = false;
    await closeBrowser();
    const chromeArgs: string[] = [
      '--disable-blink-features=AutomationControlled',
      ...(serverArgs.chromeArg ?? []).map(String),
    ];
    if (serverArgs.proxyServer) {
      chromeArgs.push(`--proxy-server=${serverArgs.proxyServer}`);
    }
    await ensureBrowserLaunched({
      headless: serverArgs.headless,
      executablePath: serverArgs.executablePath,
      channel: serverArgs.channel as Channel,
      isolated: serverArgs.isolated ?? false,
      userDataDir: serverArgs.userDataDir,
      logFile: options.logFile,
      viewport: serverArgs.viewport,
      chromeArgs,
      ignoreDefaultChromeArgs: (serverArgs.ignoreDefaultChromeArg ?? []).map(
        String,
      ),
      acceptInsecureCerts: serverArgs.acceptInsecureCerts,
      devtools: serverArgs.experimentalDevtools ?? false,
      enableExtensions: serverArgs.categoryExtensions,
      viaCli: serverArgs.viaCli,
    });
    browserHasOperaFlags = true;
  }

  const toolMutex = new Mutex();

  function registerTool(tool: ToolDefinition | DefinedPageTool): void {
    if (
      tool.annotations.category === ToolCategory.EMULATION &&
      serverArgs.categoryEmulation === false
    ) {
      return;
    }
    if (
      tool.annotations.category === ToolCategory.PERFORMANCE &&
      serverArgs.categoryPerformance === false
    ) {
      return;
    }
    if (
      tool.annotations.category === ToolCategory.NETWORK &&
      serverArgs.categoryNetwork === false
    ) {
      return;
    }
    if (
      tool.annotations.category === ToolCategory.EXTENSIONS &&
      !serverArgs.categoryExtensions
    ) {
      return;
    }
    if (
      tool.annotations.category === ToolCategory.WEBMCP &&
      !serverArgs.categoryExperimentalWebmcp
    ) {
      return;
    }
    if (
      tool.annotations.category === ToolCategory.THIRD_PARTY &&
      !serverArgs.categoryExperimentalThirdParty
    ) {
      return;
    }
    if (
      tool.annotations.conditions?.includes('experimentalVision') &&
      !serverArgs.experimentalVision
    ) {
      return;
    }
    if (
      tool.annotations.conditions?.includes('experimentalInteropTools') &&
      !serverArgs.experimentalInteropTools
    ) {
      return;
    }
    if (
      tool.annotations.conditions?.includes('experimentalScreencast') &&
      !serverArgs.experimentalScreencast
    ) {
      return;
    }
    if (
      tool.annotations.conditions?.includes('experimentalMemory') &&
      !serverArgs.experimentalMemory
    ) {
      return;
    }
    const schema =
      'pageScoped' in tool &&
      tool.pageScoped &&
      serverArgs.experimentalPageIdRouting &&
      !serverArgs.slim
        ? {...tool.schema, ...pageIdSchema}
        : tool.schema;

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: schema,
        annotations: tool.annotations,
      },
      async (params, extra): Promise<CallToolResult> => {
        const guard =
          tool.annotations.category === ToolCategory.OPERA
            ? null
            : await toolMutex.acquire();
        const startTime = Date.now();
        let success = false;
        try {
          const isLaunchMode =
            !serverArgs.browserUrl &&
            !serverArgs.wsEndpoint &&
            !serverArgs.autoConnect;
          const needsOperaFlags =
            tool.name === 'opera_do' || tool.name === 'opera_research';
          const browserConnected = getCurrentBrowser()?.connected ?? false;
          if (isLaunchMode) {
            if (
              needsOperaFlags &&
              !(browserHasOperaFlags && browserConnected)
            ) {
              await restartBrowserForOpera();
            } else if (
              !needsOperaFlags &&
              browserHasOperaFlags &&
              browserConnected
            ) {
              await restartBrowserWithoutOperaFlags();
            }
          }
          logger(`${tool.name} request: ${JSON.stringify(params, null, '  ')}`);
          const context = await getContext();
          logger(`${tool.name} context: resolved`);
          await context.detectOpenDevToolsWindows();
          const logCallback = (message: string) => {
            // `logger` carries the MCP request ID so the opera-cli bridge can route
            // this chunk to the correct HTTP response (see bridge.ts requestLoggers).
            // `data` stays a plain string so non-bridge MCP hosts (Claude Desktop,
            // VS Code, etc.) continue to render it as readable text.
            void extra.sendNotification({
              method: 'notifications/message',
              params: {
                level: 'info',
                data: message,
                logger: String(extra.requestId),
              },
            });
          };
          const response = serverArgs.slim
            ? new SlimMcpResponse(serverArgs, logCallback)
            : new McpResponse(serverArgs, logCallback);
          try {
            if ('pageScoped' in tool && tool.pageScoped) {
              const page =
                serverArgs.experimentalPageIdRouting &&
                params.pageId &&
                !serverArgs.slim
                  ? context.getPageById(params.pageId)
                  : context.getSelectedMcpPage();
              response.setPage(page);
              if (tool.blockedByDialog) {
                page.throwIfDialogOpen();
              }
              await tool.handler(
                {
                  params,
                  page,
                  signal: extra.signal,
                },
                response,
                context,
              );
            } else {
              await tool.handler(
                // @ts-expect-error types do not match.
                {
                  params,
                  signal: extra.signal,
                },
                response,
                context,
              );
            }
          } catch (err) {
            response.setError(err);
          }
          const {content, structuredContent} = await response.handle(
            tool.name,
            context,
          );
          const result: CallToolResult & {
            structuredContent?: Record<string, unknown>;
          } = {
            content,
          };
          if (response.error) {
            result.isError = true;
          }
          success = true;
          if (serverArgs.experimentalStructuredContent) {
            result.structuredContent = structuredContent as Record<
              string,
              unknown
            >;
          }
          return result;
        } catch (err) {
          logger(`${tool.name} error:`, err, err?.stack);
          let errorText = err && 'message' in err ? err.message : String(err);
          if ('cause' in err && err.cause) {
            errorText += `\nCause: ${err.cause.message}`;
          }
          return {
            content: [
              {
                type: 'text',
                text: errorText,
              },
            ],
            isError: true,
          };
        } finally {
          void clearcutLogger?.logToolInvocation({
            toolName: tool.name,
            params: params as Record<string, unknown>,
            schema: tool.schema,
            success,
            latencyMs: bucketizeLatency(Date.now() - startTime),
          });
          guard?.dispose();
        }
      },
    );
  }

  const tools = createTools(serverArgs);
  for (const tool of tools) {
    registerTool(tool);
  }

  await loadIssueDescriptions();

  return {server, clearcutLogger};
}

export const logDisclaimers = (args: ReturnType<typeof parseArguments>) => {
  console.error(
    `opera-devtools-mcp exposes content of the browser instance to the MCP clients allowing them to inspect,
debug, and modify any data in the browser or DevTools.
Avoid sharing sensitive or personal information that you do not want to share with MCP clients.`,
  );

  if (!args.slim && args.performanceCrux) {
    console.error(
      `Performance tools may send trace URLs to the Google CrUX API to fetch real-user experience data. To disable, run with --no-performance-crux.`,
    );
  }
};
