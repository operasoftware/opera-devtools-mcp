/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {parseArguments} from '../src/bin/chrome-devtools-mcp-cli-options.js';
import {McpContext} from '../src/McpContext.js';
import {McpPage} from '../src/McpPage.js';
import {McpResponse} from '../src/McpResponse.js';
import {Mutex} from '../src/Mutex.js';
import type {OperaToolHooks} from '../src/opera/toolHandlerHooks.js';
import {ToolHandler} from '../src/ToolHandler.js';
import {ToolCategory} from '../src/tools/categories.js';
import type {
  DefinedPageTool,
  ToolDefinition,
} from '../src/tools/ToolDefinition.js';

describe('ToolHandler', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('calls page getter for page scoped tools', async () => {
    let handlerCalled = false;
    const tool: DefinedPageTool = {
      name: 'page_tool',
      description: 'A page scoped tool',
      annotations: {
        category: ToolCategory.INPUT,
        readOnlyHint: false,
      },
      schema: {},
      blockedByDialog: false,
      pageScoped: true,
      handler: async () => {
        handlerCalled = true;
      },
    };

    const mockContext = sinon.createStubInstance(McpContext);
    const mockPage = sinon.createStubInstance(McpPage);
    mockContext.getSelectedMcpPage.returns(mockPage);
    mockContext.detectOpenDevToolsWindows.resolves();

    const toolMutex = new Mutex();
    const serverArgs = parseArguments('1.0.0', ['node', 'script.js'], {
      OPERA_DEVTOOLS_NO_USAGE_STATISTICS: 'true',
    });

    const toolHandler = new ToolHandler(
      tool,
      serverArgs,
      async () => mockContext,
      toolMutex,
    );

    assert.strictEqual(toolHandler.shouldRegister, true);
    await toolHandler.handle({});

    assert.strictEqual(mockContext.getSelectedMcpPage.calledOnce, true);
    assert.strictEqual(handlerCalled, true);
  });

  it('does not call page getter for non-page scoped tools', async () => {
    let handlerCalled = false;
    const tool: ToolDefinition = {
      name: 'global_tool',
      description: 'A global tool',
      annotations: {
        category: ToolCategory.NAVIGATION,
        readOnlyHint: true,
      },
      schema: {},
      blockedByDialog: false,
      handler: async () => {
        handlerCalled = true;
      },
    };

    const mockContext = sinon.createStubInstance(McpContext);
    mockContext.detectOpenDevToolsWindows.resolves();

    const toolMutex = new Mutex();
    const serverArgs = parseArguments('1.0.0', ['node', 'script.js'], {
      OPERA_DEVTOOLS_NO_USAGE_STATISTICS: 'true',
    });

    const toolHandler = new ToolHandler(
      tool,
      serverArgs,
      async () => mockContext,
      toolMutex,
    );

    assert.strictEqual(toolHandler.shouldRegister, true);
    const result = await toolHandler.handle({});

    assert.strictEqual(mockContext.getSelectedMcpPage.called, false);
    assert.strictEqual(mockContext.getPageById.called, false);
    assert.strictEqual(handlerCalled, true);
    assert.strictEqual(result.isError, undefined);
  });

  it('sets shouldRegister to false and returns disabled reason when category is disabled', async () => {
    let handlerCalled = false;
    const tool: ToolDefinition = {
      name: 'disabled_tool',
      description: 'A disabled tool',
      annotations: {
        category: ToolCategory.EMULATION,
        readOnlyHint: true,
      },
      schema: {},
      blockedByDialog: false,
      handler: async () => {
        handlerCalled = true;
      },
    };

    const mockContext = sinon.createStubInstance(McpContext);
    const toolMutex = new Mutex();
    const serverArgs = parseArguments(
      '1.0.0',
      ['node', 'script.js', '--categoryEmulation=false'],
      {OPERA_DEVTOOLS_NO_USAGE_STATISTICS: 'true'},
    );

    const toolHandler = new ToolHandler(
      tool,
      serverArgs,
      async () => mockContext,
      toolMutex,
    );

    assert.strictEqual(toolHandler.shouldRegister, false);

    const result = await toolHandler.handle({});
    assert.strictEqual(result.isError, true);
    assert.match(
      result.content[0].type === 'text' ? result.content[0].text : '',
      /is currently disabled/,
    );
    assert.strictEqual(handlerCalled, false);
  });

  it('applies the redactNetworkHeaders flag to the response', async () => {
    const tool: ToolDefinition = {
      name: 'global_tool',
      description: 'A global tool',
      annotations: {category: ToolCategory.NAVIGATION, readOnlyHint: true},
      schema: {},
      blockedByDialog: false,
      handler: async () => {
        // Intentionally does nothing.
      },
    };

    const mockContext = sinon.createStubInstance(McpContext);
    mockContext.detectOpenDevToolsWindows.resolves();
    const setRedact = sinon.spy(
      McpResponse.prototype,
      'setRedactNetworkHeaders',
    );

    const serverArgs = parseArguments(
      '1.0.0',
      ['node', 'script.js', '--redactNetworkHeaders=false'],
      {OPERA_DEVTOOLS_NO_USAGE_STATISTICS: 'true'},
    );

    await new ToolHandler(
      tool,
      serverArgs,
      async () => mockContext,
      new Mutex(),
    ).handle({});

    assert.strictEqual(setRedact.calledOnceWithExactly(false), true);
  });

  describe('opera hooks', () => {
    function makeTool(name: string, category: ToolCategory): ToolDefinition {
      return {
        name,
        description: name,
        annotations: {category, readOnlyHint: true},
        schema: {},
        blockedByDialog: false,
        handler: async () => {
          // Intentionally does nothing.
        },
      };
    }

    function makeArgs() {
      return parseArguments('1.0.0', ['node', 'script.js'], {
        OPERA_DEVTOOLS_NO_USAGE_STATISTICS: 'true',
      });
    }

    function makeContext() {
      const mockContext = sinon.createStubInstance(McpContext);
      mockContext.detectOpenDevToolsWindows.resolves();
      return mockContext;
    }

    function hooks(overrides: Partial<OperaToolHooks> = {}): OperaToolHooks {
      return {
        bypassMutex: () => false,
        beforeInvoke: async () => {
          // Intentionally does nothing.
        },
        makeLogCallback: () => undefined,
        ...overrides,
      };
    }

    it('does not hold the tool mutex when bypassMutex is true', async () => {
      const mutex = new Mutex();
      // Hold the mutex for the whole test: a bypassing tool must still finish.
      const held = await mutex.acquire();

      const result = await new ToolHandler(
        makeTool('opera_chat', ToolCategory.OPERA),
        makeArgs(),
        async () => makeContext(),
        mutex,
        hooks({bypassMutex: tool => tool.name === 'opera_chat'}),
      ).handle({});

      assert.strictEqual(result.isError, undefined);
      held.dispose();
    });

    it('serializes on the mutex when bypassMutex is false', async () => {
      const mutex = new Mutex();
      const held = await mutex.acquire();

      let settled = false;
      const pending = new ToolHandler(
        makeTool('navigate_page', ToolCategory.NAVIGATION),
        makeArgs(),
        async () => makeContext(),
        mutex,
        hooks(),
      )
        .handle({})
        .then(r => {
          settled = true;
          return r;
        });

      await new Promise(resolve => setImmediate(resolve));
      assert.strictEqual(settled, false, 'should be blocked on the mutex');

      held.dispose();
      await pending;
      assert.strictEqual(settled, true);
    });

    it('runs beforeInvoke before resolving the context', async () => {
      const order: string[] = [];
      const mockContext = makeContext();

      await new ToolHandler(
        makeTool('opera_do', ToolCategory.OPERA),
        makeArgs(),
        async () => {
          order.push('getContext');
          return mockContext;
        },
        new Mutex(),
        hooks({
          beforeInvoke: async () => {
            order.push('beforeInvoke');
          },
        }),
      ).handle({});

      assert.deepStrictEqual(order, ['beforeInvoke', 'getContext']);
    });

    it('wires the log callback into the response', async () => {
      const logged: string[] = [];
      const tool: ToolDefinition = {
        name: 'opera_research',
        description: 'streams',
        annotations: {category: ToolCategory.OPERA, readOnlyHint: true},
        schema: {},
        blockedByDialog: false,
        handler: async (_request, response) => {
          response.sendLog('chunk');
        },
      };

      await new ToolHandler(
        tool,
        makeArgs(),
        async () => makeContext(),
        new Mutex(),
        hooks({makeLogCallback: () => msg => logged.push(msg)}),
      ).handle({});

      assert.deepStrictEqual(logged, ['chunk']);
    });

    it('forwards the abort signal to the tool handler', async () => {
      const controller = new AbortController();
      let seen: AbortSignal | undefined;
      const tool: ToolDefinition = {
        name: 'global_tool',
        description: 'reads the signal',
        annotations: {category: ToolCategory.NAVIGATION, readOnlyHint: true},
        schema: {},
        blockedByDialog: false,
        handler: async request => {
          seen = request.signal;
        },
      };

      await new ToolHandler(
        tool,
        makeArgs(),
        async () => makeContext(),
        new Mutex(),
        hooks(),
      ).handle({}, {signal: controller.signal});

      assert.strictEqual(seen, controller.signal);
    });
  });
});
