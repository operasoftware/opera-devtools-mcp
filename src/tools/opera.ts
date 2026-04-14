/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

type CDPSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

const getCDPSession = (page: {_client(): CDPSession}): CDPSession =>
  page._client();

const operaCommand = async (
  session: CDPSession,
  method: string,
  params: Record<string, unknown>,
): Promise<string> => {
  const response = (await session.send(method, params)) as {result: string};
  return response.result;
};

export const operaChat = definePageTool({
  name: 'opera_chat',
  description:
    "Send a chat prompt to Opera's built-in AI and return the response. Only available when connected to Opera Neon.",
  annotations: {
    category: ToolCategory.OPERA,
    readOnlyHint: false,
  },
  schema: {
    prompt: zod.string().describe('The prompt to send to Opera AI.'),
  },
  handler: async (request, response) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const session = getCDPSession(request.page.pptrPage as any);
    try {
      const result = await operaCommand(session, 'Opera.chat', {
        prompt: request.params.prompt,
      });
      response.appendResponseLine(result);
    } catch (e) {
      response.appendResponseLine(
        `Opera.chat is not supported by this browser: ${(e as Error).message}`,
      );
    }
  },
});

export const operaDo = definePageTool({
  name: 'opera_do',
  description:
    "Instruct Opera's built-in AI to perform an action on the current page and return the result. Only available when connected to Opera Neon.",
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
      const result = await operaCommand(session, 'Opera.invokeDo', {
        prompt: request.params.prompt,
      });
      response.appendResponseLine(result);
    } catch (e) {
      response.appendResponseLine(
        `Opera.invokeDo is not supported by this browser: ${(e as Error).message}`,
      );
    }
  },
});

export const operaMake = definePageTool({
  name: 'opera_make',
  description:
    "Ask Opera's built-in AI to create or generate content and return the result. Only available when connected to Opera Neon.",
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
      const result = await operaCommand(session, 'Opera.make', {
        prompt: request.params.prompt,
      });
      response.appendResponseLine(result);
    } catch (e) {
      response.appendResponseLine(
        `Opera.make is not supported by this browser: ${(e as Error).message}`,
      );
    }
  },
});

export const operaResearch = definePageTool({
  name: 'opera_research',
  description:
    "Ask Opera's built-in AI to research a topic and return a summary. Only available when connected to Opera Neon.",
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
    const params: Record<string, unknown> = {prompt: request.params.prompt};
    if (request.params.researchType !== undefined) {
      params['researchType'] = request.params.researchType;
    }
    try {
      const result = await operaCommand(session, 'Opera.research', params);
      response.appendResponseLine(result);
    } catch (e) {
      response.appendResponseLine(
        `Opera.research is not supported by this browser: ${(e as Error).message}`,
      );
    }
  },
});
