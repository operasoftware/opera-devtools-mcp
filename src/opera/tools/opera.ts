/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import {zod} from '../../third_party/index.js';
import {ToolCategory} from '../../tools/categories.js';
import {definePageTool} from '../../tools/ToolDefinition.js';
import {withServiceWorkerRetry} from '../serviceWorkerRetry.js';

// NOTE: `createTools` in src/tools/tools.ts does `Object.values(...)` over this
// module, so every export here must be a tool definition. Put helpers elsewhere.

interface CDPSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: unknown) => void): void;
  off(event: string, listener: (params: unknown) => void): void;
}

const getCDPSession = (page: {_client(): CDPSession}): CDPSession =>
  page._client();

const dispatchAction = async (
  session: CDPSession,
  payload: Record<string, unknown>,
): Promise<string> => {
  const response = (await withServiceWorkerRetry(() =>
    session.send('Opera.dispatchAction', {payload}),
  )) as {result: string};
  return response.result;
};

const dispatchWithStreamedResponse = (
  session: CDPSession,
  payload: Record<string, unknown>,
  onChunkCallback?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<string> => {
  return withServiceWorkerRetry(() =>
    session.send('Opera.dispatchWithStreamedResponse', {payload}),
  ).then(raw => {
    const {correlationId} = raw as {correlationId: string};
    return new Promise<string>((resolve, reject) => {
      const onChunk = (params: unknown) => {
        const {correlationId: id, chunk} = params as {
          correlationId: string;
          chunk: string;
        };
        if (id === correlationId && onChunkCallback) {
          onChunkCallback(chunk);
        }
      };

      const onCompleted = (params: unknown) => {
        const {correlationId: id, result} = params as {
          correlationId: string;
          result: string;
        };
        if (id === correlationId) {
          cleanup();
          resolve(result);
        }
      };

      const onFailed = (params: unknown) => {
        const {correlationId: id, error} = params as {
          correlationId: string;
          error: string;
        };
        if (id === correlationId) {
          cleanup();
          reject(new Error(error));
        }
      };

      const cleanup = () => {
        session.off('Opera.actionChunk', onChunk);
        session.off('Opera.actionCompleted', onCompleted);
        session.off('Opera.actionFailed', onFailed);
      };

      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener(
        'abort',
        () => {
          cleanup();
          reject(signal.reason);
        },
        {once: true},
      );

      session.on('Opera.actionChunk', onChunk);
      session.on('Opera.actionCompleted', onCompleted);
      session.on('Opera.actionFailed', onFailed);
    });
  });
};

export const operaChat = definePageTool({
  name: 'opera_chat',
  description:
    "Send a chat prompt to Opera's built-in AI and return the response. Only available when connected to Opera Neon.",
  blockedByDialog: false,
  verifyFilesSchema: {},
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: false,
  },
  schema: {
    prompt: zod.string().describe('The prompt to send to Opera AI.'),
    model: zod
      .string()
      .optional()
      .describe(
        'Model ID to use for the chat. Omit to use the browser default. Use opera_list_models to discover available IDs.',
      ),
    conversationId: zod
      .string()
      .optional()
      .describe(
        'Conversation ID to continue an existing conversation. Omit to start a new conversation.',
      ),
  },
  handler: async (request, response) => {
    // puppeteer's _client() is internal; cast to the shape getCDPSession needs
    const session = getCDPSession(
      request.page.pptrPage as unknown as {_client(): CDPSession},
    );
    try {
      const payload: Record<string, unknown> = {
        action: 'chat',
        prompt: request.params.prompt,
      };
      if (request.params.model !== undefined) {
        payload['model'] = request.params.model;
      }
      if (request.params.conversationId !== undefined) {
        payload['conversationId'] = request.params.conversationId;
      }
      const result = await dispatchAction(session, payload);
      response.appendResponseLine(result);
    } catch (e) {
      response.appendResponseLine(
        `Opera.dispatchAction(chat) failed with error: ${(e as Error).message}`,
      );
    }
  },
});

export const operaDo = definePageTool({
  name: 'opera_do',
  description:
    "Instruct Opera's built-in AI to perform an action on the current page and return the result. Only available when connected to Opera Neon.",
  blockedByDialog: false,
  verifyFilesSchema: {},
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: false,
  },
  schema: {
    prompt: zod
      .string()
      .describe('The action to perform, described in natural language.'),
  },
  handler: async (request, response) => {
    // puppeteer's _client() is internal; cast to the shape getCDPSession needs
    const session = getCDPSession(
      request.page.pptrPage as unknown as {_client(): CDPSession},
    );
    try {
      const result = await dispatchWithStreamedResponse(
        session,
        {
          action: 'do',
          prompt: request.params.prompt,
        },
        chunk => response.sendLog(chunk),
        request.signal,
      );
      response.appendResponseLine(result);
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw e;
      }
      response.appendResponseLine(
        `Opera.dispatchWithStreamedResponse(do) failed with error: ${(e as Error).message}`,
      );
    }
  },
});

export const operaMake = definePageTool({
  name: 'opera_make',
  description:
    "Ask Opera's built-in AI to create or generate content and return the result. Only available when connected to Opera Neon.",
  blockedByDialog: false,
  verifyFilesSchema: {},
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: false,
  },
  schema: {
    prompt: zod.string().describe('Description of what to create or generate.'),
  },
  handler: async (request, response) => {
    // puppeteer's _client() is internal; cast to the shape getCDPSession needs
    const session = getCDPSession(
      request.page.pptrPage as unknown as {_client(): CDPSession},
    );
    try {
      const result = await dispatchAction(session, {
        action: 'make',
        prompt: request.params.prompt,
      });
      response.appendResponseLine(result);
    } catch (e) {
      response.appendResponseLine(
        `Opera.dispatchAction(make) failed with error: ${(e as Error).message}`,
      );
    }
  },
});

export const operaResearch = definePageTool({
  name: 'opera_research',
  description:
    "Ask Opera's built-in AI to research a topic and return a summary. Only available when connected to Opera Neon.",
  blockedByDialog: false,
  verifyFilesSchema: {},
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: false,
  },
  schema: {
    prompt: zod.string().describe('The topic or question to research.'),
    researchType: zod
      .enum(['local', 'one-minute', 'deep'])
      .optional()
      .describe(
        'Depth of research. "local" uses only on-page context, "one-minute" performs a quick web search, "deep" performs a thorough multi-source search.',
      ),
  },
  handler: async (request, response) => {
    // puppeteer's _client() is internal; cast to the shape getCDPSession needs
    const session = getCDPSession(
      request.page.pptrPage as unknown as {_client(): CDPSession},
    );
    const payload: Record<string, unknown> = {
      action: 'research',
      prompt: request.params.prompt,
    };
    if (request.params.researchType !== undefined) {
      payload['researchType'] = request.params.researchType;
    }
    try {
      const result = await dispatchWithStreamedResponse(
        session,
        payload,
        chunk => response.sendLog(chunk),
        request.signal,
      );
      response.appendResponseLine(result);
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw e;
      }
      response.appendResponseLine(
        `Opera.dispatchWithStreamedResponse(research) failed with error: ${(e as Error).message}`,
      );
    }
  },
});

export const operaListModels = definePageTool({
  name: 'opera_list_models',
  description:
    'List available AI models for Opera chat. Returns model IDs, display names, and which is the default. Only available when connected to Opera Neon.',
  blockedByDialog: false,
  verifyFilesSchema: {},
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (request, response) => {
    // puppeteer's _client() is internal; cast to the shape getCDPSession needs
    const session = getCDPSession(
      request.page.pptrPage as unknown as {_client(): CDPSession},
    );
    try {
      const result = await dispatchAction(session, {action: 'listModels'});
      response.appendResponseLine(result);
    } catch (e) {
      response.appendResponseLine(
        `Opera.dispatchAction(listModels) failed with error: ${(e as Error).message}`,
      );
    }
  },
});

export const operaListMcpServers = definePageTool({
  name: 'opera_list_mcp_servers',
  description:
    'List MCP servers registered in the browser, ' +
    'including their connection status. ' +
    'Only available when connected to Opera Neon.',
  blockedByDialog: false,
  verifyFilesSchema: {},
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (request, response) => {
    // puppeteer's _client() is internal; cast to the shape getCDPSession needs
    const session = getCDPSession(
      request.page.pptrPage as unknown as {_client(): CDPSession},
    );
    try {
      const result = await dispatchAction(session, {
        action: 'listMcpServers',
        type: 'LIST_SERVERS',
      });
      response.appendResponseLine(result);
    } catch (e) {
      response.appendResponseLine(
        `Opera.dispatchAction(listMcpServers) failed with error: ${(e as Error).message}`,
      );
    }
  },
});

export const operaListMcpTools = definePageTool({
  name: 'opera_list_mcp_tools',
  description:
    'List the tools exposed by a single MCP server. Prefer opera_list_mcp_servers ' +
    'when discovering everything at once; use this for a targeted refresh of one server. ' +
    'Only available when connected to Opera Neon.',
  blockedByDialog: false,
  verifyFilesSchema: {},
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: true,
  },
  schema: {
    server: zod
      .string()
      .min(1)
      .describe('The MCP server name (from opera_list_mcp_servers).'),
  },
  handler: async (request, response) => {
    // puppeteer's _client() is internal; cast to the shape getCDPSession needs
    const session = getCDPSession(
      request.page.pptrPage as unknown as {_client(): CDPSession},
    );
    try {
      const result = await dispatchAction(session, {
        action: 'listMcpTools',
        server: request.params.server,
        type: 'LIST_TOOLS',
      });
      response.appendResponseLine(result);
    } catch (e) {
      response.appendResponseLine(
        `Opera.dispatchAction(listMcpTools) failed with error: ${(e as Error).message}`,
      );
    }
  },
});

export const operaCallMcpTool = definePageTool({
  name: 'opera_call_mcp_tool',
  description:
    'Execute a tool on a specific MCP server registered in the browser. ' +
    'Use opera_list_mcp_servers to discover available ' +
    'servers and tools. ' +
    'Only available when connected to Opera Neon.',
  blockedByDialog: false,
  verifyFilesSchema: {},
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: false,
  },
  schema: {
    server: zod
      .string()
      .min(1)
      .describe('The MCP server name (from opera_list_mcp_servers).'),
    tool: zod
      .string()
      .min(1)
      .describe('The tool name to execute on the server.'),
    parameters: zod
      .record(zod.unknown())
      .optional()
      .describe('Parameters to pass to the tool. Omit if the tool takes none.'),
  },
  handler: async (request, response) => {
    // puppeteer's _client() is internal; cast to the shape getCDPSession needs
    const session = getCDPSession(
      request.page.pptrPage as unknown as {_client(): CDPSession},
    );
    try {
      const payload: Record<string, unknown> = {
        action: 'callMcpTool',
        server: request.params.server,
        toolName: request.params.tool,
        type: 'EXECUTE_TOOL',
      };
      if (request.params.parameters !== undefined) {
        payload['parameters'] = request.params.parameters;
      }
      const result = await dispatchWithStreamedResponse(
        session,
        payload,
        chunk => response.sendLog(chunk),
        request.signal,
      );
      response.appendResponseLine(result);
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw e;
      }
      response.appendResponseLine(
        `Opera.dispatchWithStreamedResponse(callMcpTool) failed with error: ${(e as Error).message}`,
      );
    }
  },
});

export const operaRegisterMcpServer = definePageTool({
  name: 'opera_register_mcp_server',
  description:
    'Register an MCP server in the browser. Does not connect or authenticate — ' +
    'follow with opera_connect_mcp_server. Only available when connected to Opera Neon.',
  blockedByDialog: false,
  verifyFilesSchema: {},
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: false,
  },
  schema: {
    server: zod.string().min(1).describe('The MCP server name to register.'),
    url: zod.string().min(1).describe('The HTTP URL of the MCP server.'),
  },
  handler: async (request, response) => {
    // puppeteer's _client() is internal; cast to the shape getCDPSession needs
    const session = getCDPSession(
      request.page.pptrPage as unknown as {_client(): CDPSession},
    );
    try {
      const result = await dispatchAction(session, {
        action: 'registerMcpServer',
        type: 'REGISTER_SERVER',
        server: request.params.server,
        transportInfo: {type: 'http', url: request.params.url},
      });
      response.appendResponseLine(result);
    } catch (e) {
      response.appendResponseLine(
        `Opera.dispatchAction(registerMcpServer) failed with error: ${(e as Error).message}`,
      );
    }
  },
});

export const operaConnectMcpServer = definePageTool({
  name: 'opera_connect_mcp_server',
  description:
    'Connect to a registered MCP server. If the server requires OAuth, ' +
    'the response includes requiresAuth: "needed" — follow with ' +
    'opera_authenticate_mcp_server. Only available when connected to Opera Neon.',
  blockedByDialog: false,
  verifyFilesSchema: {},
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: false,
  },
  schema: {
    server: zod.string().min(1).describe('The MCP server name to connect.'),
  },
  handler: async (request, response) => {
    const session = getCDPSession(
      request.page.pptrPage as unknown as {_client(): CDPSession},
    );
    try {
      const result = await dispatchAction(session, {
        action: 'connectMcpServer',
        type: 'CONNECT_SERVER',
        server: request.params.server,
      });
      response.appendResponseLine(result);
    } catch (e) {
      response.appendResponseLine(
        `Opera.dispatchAction(connectMcpServer) failed with error: ${(e as Error).message}`,
      );
    }
  },
});

export const operaAuthenticateMcpServer = definePageTool({
  name: 'opera_authenticate_mcp_server',
  description:
    'Complete OAuth sign-in for an MCP server that requires authentication. ' +
    'Opens a browser popup for the OAuth flow; requires a headed (visible) browser. ' +
    'Only available when connected to Opera Neon.',
  blockedByDialog: false,
  verifyFilesSchema: {},
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: false,
  },
  schema: {
    server: zod
      .string()
      .min(1)
      .describe('The MCP server name to authenticate.'),
  },
  handler: async (request, response) => {
    const session = getCDPSession(
      request.page.pptrPage as unknown as {_client(): CDPSession},
    );
    try {
      const result = await dispatchWithStreamedResponse(
        session,
        {
          action: 'authenticateMcpServer',
          type: 'AUTHENTICATE_SERVER',
          server: request.params.server,
        },
        chunk => response.sendLog(chunk),
        request.signal,
      );
      response.appendResponseLine(result);
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw e;
      }
      response.appendResponseLine(
        `Opera.dispatchWithStreamedResponse(authenticateMcpServer) failed with error: ${(e as Error).message}`,
      );
    }
  },
});

export const operaUnregisterMcpServer = definePageTool({
  name: 'opera_unregister_mcp_server',
  description:
    'Remove a registered MCP server and its stored auth tokens. ' +
    'Only available when connected to Opera Neon.',
  blockedByDialog: false,
  verifyFilesSchema: {},
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: false,
  },
  schema: {
    server: zod.string().min(1).describe('The MCP server name to unregister.'),
  },
  handler: async (request, response) => {
    const session = getCDPSession(
      request.page.pptrPage as unknown as {_client(): CDPSession},
    );
    try {
      const result = await dispatchAction(session, {
        action: 'unregisterMcpServer',
        type: 'UNREGISTER_SERVER',
        server: request.params.server,
      });
      response.appendResponseLine(result);
    } catch (e) {
      response.appendResponseLine(
        `Opera.dispatchAction(unregisterMcpServer) failed with error: ${(e as Error).message}`,
      );
    }
  },
});

export const operaEnableMcpServer = definePageTool({
  name: 'opera_enable_mcp_server',
  description:
    'Enable a disabled MCP server. Only available when connected to Opera Neon.',
  blockedByDialog: false,
  verifyFilesSchema: {},
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: false,
  },
  schema: {
    server: zod.string().min(1).describe('The MCP server name to enable.'),
  },
  handler: async (request, response) => {
    const session = getCDPSession(
      request.page.pptrPage as unknown as {_client(): CDPSession},
    );
    try {
      const result = await dispatchAction(session, {
        action: 'enableMcpServer',
        type: 'ENABLE_SERVER',
        server: request.params.server,
      });
      response.appendResponseLine(result);
    } catch (e) {
      response.appendResponseLine(
        `Opera.dispatchAction(enableMcpServer) failed with error: ${(e as Error).message}`,
      );
    }
  },
});

export const operaDisableMcpServer = definePageTool({
  name: 'opera_disable_mcp_server',
  description:
    'Disable an MCP server without unregistering it. ' +
    'Only available when connected to Opera Neon.',
  blockedByDialog: false,
  verifyFilesSchema: {},
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: false,
  },
  schema: {
    server: zod.string().min(1).describe('The MCP server name to disable.'),
  },
  handler: async (request, response) => {
    const session = getCDPSession(
      request.page.pptrPage as unknown as {_client(): CDPSession},
    );
    try {
      const result = await dispatchAction(session, {
        action: 'disableMcpServer',
        type: 'DISABLE_SERVER',
        server: request.params.server,
      });
      response.appendResponseLine(result);
    } catch (e) {
      response.appendResponseLine(
        `Opera.dispatchAction(disableMcpServer) failed with error: ${(e as Error).message}`,
      );
    }
  },
});
