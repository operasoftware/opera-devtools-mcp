/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

interface CDPSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (params: unknown) => void): void;
  off(event: string, listener: (params: unknown) => void): void;
}

const getCDPSession = (page: {_client(): CDPSession}): CDPSession =>
  page._client();

const MAX_SW_RETRIES = 5;
const SW_RETRY_DELAY_MS = 2500;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withServiceWorkerRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < MAX_SW_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e as Error;
      if (attempt < MAX_SW_RETRIES - 1) {
        await sleep(SW_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

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
  },
  handler: async (request, response) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = getCDPSession(request.page.pptrPage as any);
    try {
      const payload: Record<string, unknown> = {
        action: 'chat',
        prompt: request.params.prompt,
      };
      if (request.params.model !== undefined) {
        payload['model'] = request.params.model;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = getCDPSession(request.page.pptrPage as any);
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
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: false,
  },
  schema: {
    prompt: zod.string().describe('Description of what to create or generate.'),
  },
  handler: async (request, response) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = getCDPSession(request.page.pptrPage as any);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = getCDPSession(request.page.pptrPage as any);
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
    'List available AI models for Opera chat. Returns model IDs, display names, and which is the default.',
  blockedByDialog: false,
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: true,
  },
  schema: {},
  handler: async (request, response) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = getCDPSession(request.page.pptrPage as any);
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
