/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, describe, it} from 'node:test';

import sinon from 'sinon';

import type {McpContext} from '../../src/McpContext.js';
import type {McpPage} from '../../src/McpPage.js';
import type {McpResponse} from '../../src/McpResponse.js';
import {serviceWorkerRetryPolicy} from '../../src/opera/serviceWorkerRetry.js';
import {operaAiStreamPolicy} from '../../src/opera/streamingTools.js';
import {
  operaAuthenticateMcpServer,
  operaCallMcpTool,
  operaChat,
  operaConnectMcpServer,
  operaDisableMcpServer,
  operaDo,
  operaEnableMcpServer,
  operaListMcpServers,
  operaListModels,
  operaListMcpTools,
  operaMake,
  operaRegisterMcpServer,
  operaResearch,
  operaUnregisterMcpServer,
} from '../../src/opera/tools/opera.js';
import {
  CDPSessionEvent,
  ConnectionClosedError,
  TargetCloseError,
} from '../../src/third_party/index.js';

/**
 * The Opera tools only touch `page.pptrPage._client()`, so they can be
 * exercised against a fake CDP session without launching a browser.
 */
class FakeCDPSession extends EventEmitter {
  readonly sent: Array<{method: string; params?: Record<string, unknown>}> = [];
  /** Queued outcomes for successive `send` calls. */
  #outcomes: Array<{ok: true; value: unknown} | {ok: false; error: Error}> = [];
  #defaultOutcome: {ok: true; value: unknown} | {ok: false; error: Error} = {
    ok: true,
    value: {result: 'ok'},
  };

  resolveWith(value: unknown): this {
    this.#defaultOutcome = {ok: true, value};
    return this;
  }

  rejectWith(error: Error): this {
    this.#defaultOutcome = {ok: false, error};
    return this;
  }

  /** Fail the next `times` calls, then fall through to the default outcome. */
  failTimes(times: number, error: Error): this {
    for (let i = 0; i < times; i++) {
      this.#outcomes.push({ok: false, error});
    }
    return this;
  }

  async send(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    this.sent.push({method, params});
    const outcome = this.#outcomes.shift() ?? this.#defaultOutcome;
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  }

  get sendCount(): number {
    return this.sent.length;
  }

  /** Payload of the Nth `Opera.*` dispatch, unwrapped. */
  payloadAt(index: number): Record<string, unknown> {
    return this.sent[index]?.params?.['payload'] as Record<string, unknown>;
  }

  listenerCountFor(event: string | symbol): number {
    return this.listenerCount(event);
  }
}

function makeRequest(
  session: FakeCDPSession,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) {
  return {
    params,
    signal,
    page: {
      pptrPage: {_client: () => session},
    } as unknown as McpPage,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeResponse() {
  const lines: string[] = [];
  const logs: string[] = [];
  const response = {
    appendResponseLine: (line: string) => lines.push(line),
    sendLog: (message: string) => logs.push(message),
  } as unknown as McpResponse;
  return {response, lines, logs};
}

const context = {} as McpContext;

/**
 * Resolves once the tool has registered its stream listeners on the session.
 * A fixed microtask hop is not enough: when the initial dispatch is retried,
 * listener registration happens several turns later.
 */
async function waitForStreamListeners(session: FakeCDPSession): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (session.listenerCountFor('Opera.actionCompleted') > 0) {
      return;
    }
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error('stream listeners were never registered');
}

describe('opera tools', () => {
  const defaultDelayMs = serviceWorkerRetryPolicy.delayMs;
  const defaultFirstEventTimeoutMs = operaAiStreamPolicy.firstEventTimeoutMs;

  beforeEach(() => {
    // Drive the retry loop without waiting on real backoff. Faking timers with
    // sinon is not an option here: it replaces the globals node:test uses to
    // schedule subtests, which silently drops whole suites from the run.
    serviceWorkerRetryPolicy.delayMs = 0;
  });

  afterEach(() => {
    serviceWorkerRetryPolicy.delayMs = defaultDelayMs;
    operaAiStreamPolicy.firstEventTimeoutMs = defaultFirstEventTimeoutMs;
    sinon.restore();
  });

  describe('opera_chat', () => {
    it('dispatches a chat action and returns the result', async () => {
      const session = new FakeCDPSession().resolveWith({result: 'hello there'});
      const {response, lines} = makeResponse();

      await operaChat.handler(
        makeRequest(session, {prompt: 'hi'}),
        response,
        context,
      );

      assert.strictEqual(session.sent[0]?.method, 'Opera.dispatchAction');
      assert.deepStrictEqual(session.payloadAt(0), {
        action: 'chat',
        prompt: 'hi',
      });
      assert.deepStrictEqual(lines, ['hello there']);
    });

    it('omits the model key when no model is given', async () => {
      const session = new FakeCDPSession();
      const {response} = makeResponse();

      await operaChat.handler(
        makeRequest(session, {prompt: 'hi'}),
        response,
        context,
      );

      assert.ok(!('model' in session.payloadAt(0)));
    });

    it('forwards the model when one is given', async () => {
      const session = new FakeCDPSession();
      const {response} = makeResponse();

      await operaChat.handler(
        makeRequest(session, {prompt: 'hi', model: 'aria-x'}),
        response,
        context,
      );

      assert.strictEqual(session.payloadAt(0)['model'], 'aria-x');
    });

    it('reports dispatch failures without throwing', async () => {
      const session = new FakeCDPSession().rejectWith(new Error('boom'));
      const {response, lines} = makeResponse();

      await operaChat.handler(
        makeRequest(session, {prompt: 'hi'}),
        response,
        context,
      );

      assert.match(lines[0]!, /Opera\.dispatchAction\(chat\) failed/);
      assert.match(lines[0]!, /boom/);
    });

    it('forwards the conversationId when one is given', async () => {
      const session = new FakeCDPSession();
      const {response} = makeResponse();

      await operaChat.handler(
        makeRequest(session, {
          prompt: 'hi',
          conversationId: 'conversation-123',
        }),
        response,
        context,
      );

      assert.strictEqual(
        session.payloadAt(0)['conversationId'],
        'conversation-123',
      );
    });

    it('omits the conversationId key when none is given', async () => {
      const session = new FakeCDPSession();
      const {response} = makeResponse();

      await operaChat.handler(
        makeRequest(session, {prompt: 'hi'}),
        response,
        context,
      );

      assert.ok(!('conversationId' in session.payloadAt(0)));
    });
    it('forwards openFullTabView when true', async () => {
      const session = new FakeCDPSession();
      const {response} = makeResponse();

      await operaChat.handler(
        makeRequest(session, {prompt: 'hi', openFullTabView: true}),
        response,
        context,
      );

      assert.strictEqual(session.payloadAt(0)['openFullTabView'], true);
    });

    it('omits openFullTabView when not set', async () => {
      const session = new FakeCDPSession();
      const {response} = makeResponse();

      await operaChat.handler(
        makeRequest(session, {prompt: 'hi'}),
        response,
        context,
      );

      assert.ok(!('openFullTabView' in session.payloadAt(0)));
    });

    it('omits openFullTabView when false', async () => {
      const session = new FakeCDPSession();
      const {response} = makeResponse();

      await operaChat.handler(
        makeRequest(session, {prompt: 'hi', openFullTabView: false}),
        response,
        context,
      );

      assert.ok(!('openFullTabView' in session.payloadAt(0)));
    });
  });

  describe('opera_make', () => {
    it('dispatches a make action', async () => {
      const session = new FakeCDPSession().resolveWith({result: 'made it'});
      const {response, lines} = makeResponse();

      await operaMake.handler(
        makeRequest(session, {prompt: 'a poem'}),
        response,
        context,
      );

      assert.deepStrictEqual(session.payloadAt(0), {
        action: 'make',
        prompt: 'a poem',
      });
      assert.deepStrictEqual(lines, ['made it']);
    });

    it('forwards the conversationId when one is given', async () => {
      const session = new FakeCDPSession().resolveWith({result: 'made it'});
      const {response} = makeResponse();

      await operaMake.handler(
        makeRequest(session, {
          prompt: 'a poem',
          conversationId: 'conversation-123',
        }),
        response,
        context,
      );

      assert.strictEqual(
        session.payloadAt(0)['conversationId'],
        'conversation-123',
      );
    });
    it('forwards openFullTabView when true', async () => {
      const session = new FakeCDPSession().resolveWith({result: 'made it'});
      const {response} = makeResponse();

      await operaMake.handler(
        makeRequest(session, {prompt: 'a poem', openFullTabView: true}),
        response,
        context,
      );

      assert.strictEqual(session.payloadAt(0)['openFullTabView'], true);
    });

    it('omits openFullTabView for opera_make when not set', async () => {
      const session = new FakeCDPSession().resolveWith({result: 'made it'});
      const {response} = makeResponse();

      await operaMake.handler(
        makeRequest(session, {prompt: 'a poem'}),
        response,
        context,
      );

      assert.ok(!('openFullTabView' in session.payloadAt(0)));
    });

    it('omits openFullTabView for opera_make when false', async () => {
      const session = new FakeCDPSession().resolveWith({result: 'made it'});
      const {response} = makeResponse();

      await operaMake.handler(
        makeRequest(session, {prompt: 'a poem', openFullTabView: false}),
        response,
        context,
      );

      assert.ok(!('openFullTabView' in session.payloadAt(0)));
    });
  });

  describe('opera_list_models', () => {
    it('dispatches a listModels action with no prompt', async () => {
      const session = new FakeCDPSession().resolveWith({result: '["a","b"]'});
      const {response, lines} = makeResponse();

      await operaListModels.handler(
        makeRequest(session, {}),
        response,
        context,
      );

      assert.deepStrictEqual(session.payloadAt(0), {action: 'listModels'});
      assert.deepStrictEqual(lines, ['["a","b"]']);
    });

    it('is marked read-only and in the OPERA category', () => {
      assert.strictEqual(operaListModels.annotations.readOnlyHint, true);
      assert.strictEqual(operaListModels.annotations.category, 'opera');
    });
  });

  describe('streaming (opera_do / opera_research)', () => {
    it('streams chunks to sendLog and resolves with the completed result', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response, lines, logs} = makeResponse();

      const pending = operaDo.handler(
        makeRequest(session, {prompt: 'click the button'}),
        response,
        context,
      );

      await waitForStreamListeners(session);

      session.emit('Opera.actionChunk', {correlationId: 'c1', chunk: 'step 1'});
      session.emit('Opera.actionChunk', {correlationId: 'c1', chunk: 'step 2'});
      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'done',
      });

      await pending;

      assert.strictEqual(
        session.sent[0]?.method,
        'Opera.dispatchWithStreamedResponse',
      );
      assert.deepStrictEqual(logs, ['step 1', 'step 2']);
      assert.deepStrictEqual(lines, ['done']);
    });

    it('resolves when the action finishes before the dispatch reply is processed', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response, lines, logs} = makeResponse();

      operaDo.handler(makeRequest(session, {prompt: 'go'}), response, context);

      // The browser answers in the same read as the dispatch reply, so these
      // arrive before the reply names the correlationId they belong to.
      session.emit('Opera.actionChunk', {correlationId: 'c1', chunk: 'step'});
      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'done',
      });

      // Turns, not a clock: the regression this guards is a call that never
      // settles, so there is no event to await and a real delay would only
      // blur "not yet" into "lost".
      for (let i = 0; i < 1000 && lines.length === 0; i++) {
        const {promise, resolve} = Promise.withResolvers<void>();
        setImmediate(resolve);
        await promise;
      }

      assert.deepStrictEqual(lines, ['done']);
      assert.deepStrictEqual(logs, ['step']);
    });

    it('ignores events for a different correlationId', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'mine'});
      const {response, lines, logs} = makeResponse();

      const pending = operaDo.handler(
        makeRequest(session, {prompt: 'go'}),
        response,
        context,
      );
      await waitForStreamListeners(session);

      session.emit('Opera.actionChunk', {
        correlationId: 'theirs',
        chunk: 'not mine',
      });
      session.emit('Opera.actionCompleted', {
        correlationId: 'theirs',
        result: 'not mine either',
      });
      session.emit('Opera.actionChunk', {correlationId: 'mine', chunk: 'mine'});
      session.emit('Opera.actionCompleted', {
        correlationId: 'mine',
        result: 'ok',
      });

      await pending;

      assert.deepStrictEqual(logs, ['mine']);
      assert.deepStrictEqual(lines, ['ok']);
    });

    it('removes its listeners once completed', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response} = makeResponse();

      const pending = operaDo.handler(
        makeRequest(session, {prompt: 'go'}),
        response,
        context,
      );
      await waitForStreamListeners(session);

      assert.strictEqual(session.listenerCountFor('Opera.actionChunk'), 1);

      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'ok',
      });
      await pending;

      assert.strictEqual(session.listenerCountFor('Opera.actionChunk'), 0);
      assert.strictEqual(session.listenerCountFor('Opera.actionCompleted'), 0);
      assert.strictEqual(session.listenerCountFor('Opera.actionFailed'), 0);
    });

    it('reports a disconnect and removes its listeners when the session dies', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response, lines} = makeResponse();

      const pending = operaDo.handler(
        makeRequest(session, {prompt: 'go'}),
        response,
        context,
      );
      await waitForStreamListeners(session);

      // Puppeteer emits this Symbol from `CdpSession.onClosed()` when the
      // browser dies. Without a listener the stream never settles, so the
      // tool hangs until the caller's timeout.
      session.emit(CDPSessionEvent.Disconnected);

      await pending;

      // A promise that settled without appending anything would otherwise fail
      // below as a TypeError on an empty array, not as a readable assertion.
      assert.ok(lines.length > 0, 'the failure must be reported to the caller');
      assert.match(
        lines[0]!,
        /Opera\.dispatchWithStreamedResponse\(do\) failed/,
      );
      assert.match(lines[0]!, /CDP session disconnected/);
      assert.strictEqual(session.listenerCountFor('Opera.actionChunk'), 0);
      assert.strictEqual(session.listenerCountFor('Opera.actionCompleted'), 0);
      assert.strictEqual(session.listenerCountFor('Opera.actionFailed'), 0);
      assert.strictEqual(
        session.listenerCountFor(CDPSessionEvent.Disconnected),
        0,
      );
    });

    it('reports a streamed failure without throwing', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response, lines} = makeResponse();

      const pending = operaDo.handler(
        makeRequest(session, {prompt: 'go'}),
        response,
        context,
      );
      await waitForStreamListeners(session);

      session.emit('Opera.actionFailed', {
        correlationId: 'c1',
        error: 'model unavailable',
      });
      await pending;

      assert.match(
        lines[0]!,
        /Opera\.dispatchWithStreamedResponse\(do\) failed/,
      );
      assert.match(lines[0]!, /model unavailable/);
    });

    it('rethrows when the request is aborted', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response} = makeResponse();
      const controller = new AbortController();

      const pending = operaDo.handler(
        makeRequest(session, {prompt: 'go'}, controller.signal),
        response,
        context,
      );
      await waitForStreamListeners(session);

      controller.abort();

      await assert.rejects(pending, {name: 'AbortError'});
    });

    it('forwards researchType when provided', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response} = makeResponse();

      const pending = operaResearch.handler(
        makeRequest(session, {prompt: 'quantum', researchType: 'deep'}),
        response,
        context,
      );
      await waitForStreamListeners(session);
      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'summary',
      });
      await pending;

      assert.deepStrictEqual(session.payloadAt(0), {
        action: 'research',
        prompt: 'quantum',
        researchType: 'deep',
      });
    });

    it('omits researchType when not provided', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response} = makeResponse();

      const pending = operaResearch.handler(
        makeRequest(session, {prompt: 'quantum'}),
        response,
        context,
      );
      await waitForStreamListeners(session);
      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'summary',
      });
      await pending;

      assert.ok(!('researchType' in session.payloadAt(0)));
    });
    it('forwards openFullTabView when true for opera_do', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response} = makeResponse();

      const pending = operaDo.handler(
        makeRequest(session, {prompt: 'go', openFullTabView: true}),
        response,
        context,
      );
      await waitForStreamListeners(session);
      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'done',
      });
      await pending;

      assert.strictEqual(session.payloadAt(0)['openFullTabView'], true);
    });

    it('omits openFullTabView for opera_do when not set', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response} = makeResponse();

      const pending = operaDo.handler(
        makeRequest(session, {prompt: 'go'}),
        response,
        context,
      );
      await waitForStreamListeners(session);
      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'done',
      });
      await pending;

      assert.ok(!('openFullTabView' in session.payloadAt(0)));
    });

    it('forwards openFullTabView when true for opera_research', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response} = makeResponse();

      const pending = operaResearch.handler(
        makeRequest(session, {prompt: 'quantum', openFullTabView: true}),
        response,
        context,
      );
      await waitForStreamListeners(session);
      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'summary',
      });
      await pending;

      assert.strictEqual(session.payloadAt(0)['openFullTabView'], true);
    });

    it('omits openFullTabView for opera_research when not set', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response} = makeResponse();

      const pending = operaResearch.handler(
        makeRequest(session, {prompt: 'quantum'}),
        response,
        context,
      );
      await waitForStreamListeners(session);
      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'summary',
      });
      await pending;

      assert.ok(!('openFullTabView' in session.payloadAt(0)));
    });

    it('omits openFullTabView for opera_research when false', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response} = makeResponse();

      const pending = operaResearch.handler(
        makeRequest(session, {prompt: 'quantum', openFullTabView: false}),
        response,
        context,
      );
      await waitForStreamListeners(session);
      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'summary',
      });
      await pending;

      assert.ok(!('openFullTabView' in session.payloadAt(0)));
    });
  });

  describe('opera_register_mcp_server', () => {
    it('dispatches a registerMcpServer action and returns the result', async () => {
      const session = new FakeCDPSession().resolveWith({result: 'registered'});
      const {response, lines} = makeResponse();

      await operaRegisterMcpServer.handler(
        makeRequest(session, {
          server: 'my-server',
          url: 'http://localhost:3000',
        }),
        response,
        context,
      );

      assert.strictEqual(session.sent[0]?.method, 'Opera.dispatchAction');
      assert.deepStrictEqual(session.payloadAt(0), {
        action: 'registerMcpServer',
        type: 'REGISTER_SERVER',
        server: 'my-server',
        transportInfo: {type: 'http', url: 'http://localhost:3000'},
      });
      assert.deepStrictEqual(lines, ['registered']);
    });

    it('reports dispatch failures without throwing', async () => {
      const session = new FakeCDPSession().rejectWith(new Error('boom'));
      const {response, lines} = makeResponse();

      await operaRegisterMcpServer.handler(
        makeRequest(session, {
          server: 'my-server',
          url: 'http://localhost:3000',
        }),
        response,
        context,
      );

      assert.match(
        lines[0]!,
        /Opera\.dispatchAction\(registerMcpServer\) failed/,
      );
      assert.match(lines[0]!, /boom/);
    });
  });

  describe('opera_connect_mcp_server', () => {
    it('dispatches a connectMcpServer action and returns the result', async () => {
      const session = new FakeCDPSession().resolveWith({result: 'connected'});
      const {response, lines} = makeResponse();

      await operaConnectMcpServer.handler(
        makeRequest(session, {server: 'my-server'}),
        response,
        context,
      );

      assert.strictEqual(session.sent[0]?.method, 'Opera.dispatchAction');
      assert.deepStrictEqual(session.payloadAt(0), {
        action: 'connectMcpServer',
        type: 'CONNECT_SERVER',
        server: 'my-server',
      });
      assert.deepStrictEqual(lines, ['connected']);
    });

    it('reports dispatch failures without throwing', async () => {
      const session = new FakeCDPSession().rejectWith(new Error('boom'));
      const {response, lines} = makeResponse();

      await operaConnectMcpServer.handler(
        makeRequest(session, {server: 'my-server'}),
        response,
        context,
      );

      assert.match(
        lines[0]!,
        /Opera\.dispatchAction\(connectMcpServer\) failed/,
      );
      assert.match(lines[0]!, /boom/);
    });
  });

  describe('opera_authenticate_mcp_server', () => {
    it('streams chunks to sendLog and resolves with the completed result', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response, lines, logs} = makeResponse();

      const pending = operaAuthenticateMcpServer.handler(
        makeRequest(session, {server: 'my-server'}),
        response,
        context,
      );

      await waitForStreamListeners(session);

      session.emit('Opera.actionChunk', {
        correlationId: 'c1',
        chunk: 'oauth step',
      });
      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'authenticated',
      });

      await pending;

      assert.strictEqual(
        session.sent[0]?.method,
        'Opera.dispatchWithStreamedResponse',
      );
      assert.deepStrictEqual(session.payloadAt(0), {
        action: 'authenticateMcpServer',
        type: 'AUTHENTICATE_SERVER',
        server: 'my-server',
      });
      assert.deepStrictEqual(logs, ['oauth step']);
      assert.deepStrictEqual(lines, ['authenticated']);
    });

    it('ignores events for a different correlationId', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'mine'});
      const {response, lines, logs} = makeResponse();

      const pending = operaAuthenticateMcpServer.handler(
        makeRequest(session, {server: 'my-server'}),
        response,
        context,
      );
      await waitForStreamListeners(session);

      session.emit('Opera.actionChunk', {
        correlationId: 'theirs',
        chunk: 'not mine',
      });
      session.emit('Opera.actionCompleted', {
        correlationId: 'theirs',
        result: 'not mine either',
      });
      session.emit('Opera.actionChunk', {
        correlationId: 'mine',
        chunk: 'mine',
      });
      session.emit('Opera.actionCompleted', {
        correlationId: 'mine',
        result: 'ok',
      });

      await pending;

      assert.deepStrictEqual(logs, ['mine']);
      assert.deepStrictEqual(lines, ['ok']);
    });

    it('removes its listeners once completed', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response} = makeResponse();

      const pending = operaAuthenticateMcpServer.handler(
        makeRequest(session, {server: 'my-server'}),
        response,
        context,
      );
      await waitForStreamListeners(session);

      assert.strictEqual(session.listenerCountFor('Opera.actionChunk'), 1);

      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'ok',
      });
      await pending;

      assert.strictEqual(session.listenerCountFor('Opera.actionChunk'), 0);
      assert.strictEqual(session.listenerCountFor('Opera.actionCompleted'), 0);
      assert.strictEqual(session.listenerCountFor('Opera.actionFailed'), 0);
    });

    it('reports a streamed failure without throwing', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response, lines} = makeResponse();

      const pending = operaAuthenticateMcpServer.handler(
        makeRequest(session, {server: 'my-server'}),
        response,
        context,
      );
      await waitForStreamListeners(session);

      session.emit('Opera.actionFailed', {
        correlationId: 'c1',
        error: 'auth denied',
      });
      await pending;

      assert.match(
        lines[0]!,
        /Opera\.dispatchWithStreamedResponse\(authenticateMcpServer\) failed/,
      );
      assert.match(lines[0]!, /auth denied/);
    });

    it('rethrows when the request is aborted', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response} = makeResponse();
      const controller = new AbortController();

      const pending = operaAuthenticateMcpServer.handler(
        makeRequest(session, {server: 'my-server'}, controller.signal),
        response,
        context,
      );
      await waitForStreamListeners(session);

      controller.abort();

      await assert.rejects(pending, {name: 'AbortError'});
    });
  });

  describe('opera_unregister_mcp_server', () => {
    it('dispatches an unregisterMcpServer action and returns the result', async () => {
      const session = new FakeCDPSession().resolveWith({
        result: 'unregistered',
      });
      const {response, lines} = makeResponse();

      await operaUnregisterMcpServer.handler(
        makeRequest(session, {server: 'my-server'}),
        response,
        context,
      );

      assert.strictEqual(session.sent[0]?.method, 'Opera.dispatchAction');
      assert.deepStrictEqual(session.payloadAt(0), {
        action: 'unregisterMcpServer',
        type: 'UNREGISTER_SERVER',
        server: 'my-server',
      });
      assert.deepStrictEqual(lines, ['unregistered']);
    });

    it('reports dispatch failures without throwing', async () => {
      const session = new FakeCDPSession().rejectWith(new Error('boom'));
      const {response, lines} = makeResponse();

      await operaUnregisterMcpServer.handler(
        makeRequest(session, {server: 'my-server'}),
        response,
        context,
      );

      assert.match(
        lines[0]!,
        /Opera\.dispatchAction\(unregisterMcpServer\) failed/,
      );
      assert.match(lines[0]!, /boom/);
    });
  });

  describe('opera_enable_mcp_server', () => {
    it('dispatches an enableMcpServer action and returns the result', async () => {
      const session = new FakeCDPSession().resolveWith({result: 'enabled'});
      const {response, lines} = makeResponse();

      await operaEnableMcpServer.handler(
        makeRequest(session, {server: 'my-server'}),
        response,
        context,
      );

      assert.strictEqual(session.sent[0]?.method, 'Opera.dispatchAction');
      assert.deepStrictEqual(session.payloadAt(0), {
        action: 'enableMcpServer',
        type: 'ENABLE_SERVER',
        server: 'my-server',
      });
      assert.deepStrictEqual(lines, ['enabled']);
    });

    it('reports dispatch failures without throwing', async () => {
      const session = new FakeCDPSession().rejectWith(new Error('boom'));
      const {response, lines} = makeResponse();

      await operaEnableMcpServer.handler(
        makeRequest(session, {server: 'my-server'}),
        response,
        context,
      );

      assert.match(
        lines[0]!,
        /Opera\.dispatchAction\(enableMcpServer\) failed/,
      );
      assert.match(lines[0]!, /boom/);
    });
  });

  describe('opera_disable_mcp_server', () => {
    it('dispatches a disableMcpServer action and returns the result', async () => {
      const session = new FakeCDPSession().resolveWith({result: 'disabled'});
      const {response, lines} = makeResponse();

      await operaDisableMcpServer.handler(
        makeRequest(session, {server: 'my-server'}),
        response,
        context,
      );

      assert.strictEqual(session.sent[0]?.method, 'Opera.dispatchAction');
      assert.deepStrictEqual(session.payloadAt(0), {
        action: 'disableMcpServer',
        type: 'DISABLE_SERVER',
        server: 'my-server',
      });
      assert.deepStrictEqual(lines, ['disabled']);
    });

    it('reports dispatch failures without throwing', async () => {
      const session = new FakeCDPSession().rejectWith(new Error('boom'));
      const {response, lines} = makeResponse();

      await operaDisableMcpServer.handler(
        makeRequest(session, {server: 'my-server'}),
        response,
        context,
      );

      assert.match(
        lines[0]!,
        /Opera\.dispatchAction\(disableMcpServer\) failed/,
      );
      assert.match(lines[0]!, /boom/);
    });
  });

  describe('streamed action that never starts', () => {
    /** A deadline short enough to observe, long enough not to be a race. */
    const stallAfterMs = 20;

    beforeEach(() => {
      operaAiStreamPolicy.firstEventTimeoutMs = stallAfterMs;
    });

    it('reports an action the browser never started', async () => {
      // Acked with a correlationId, then silence: what a research tab that
      // opens with no prompt in it looks like from here. Left alone the command
      // waits out the daemon's twenty-minute cap to say "Request timed out",
      // which names neither the action nor the browser.
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response, lines} = makeResponse();

      await operaResearch.handler(
        makeRequest(session, {prompt: 'latest hit'}),
        response,
        context,
      );

      assert.strictEqual(session.sendCount, 1);
      assert.match(lines[0]!, /did not start the research action/);
      assert.match(lines[0]!, /no progress was reported for/);
    });

    it('keeps waiting once the browser has reported anything', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response, lines} = makeResponse();

      const pending = operaDo.handler(
        makeRequest(session, {prompt: 'go'}),
        response,
        context,
      );
      await waitForStreamListeners(session);
      // The first event retires the deadline, however long the run then takes:
      // a research run may be quiet for minutes before and between chunks.
      session.emit('Opera.actionChunk', {correlationId: 'c1', chunk: 'step 1'});
      // A real wait, past the deadline, is the only way to see that it was
      // cleared: sinon's fake clock replaces the globals `node:test` schedules
      // subtests with, which silently drops whole suites from the run.
      await new Promise(resolve => setTimeout(resolve, stallAfterMs * 2));
      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'done',
      });
      await pending;

      assert.deepStrictEqual(lines, ['done']);
    });
  });

  describe('service worker retry', () => {
    /**
     * What Opera reports while its AI service worker is still coming up — the
     * one failure a replay is allowed after.
     */
    const NOT_DISPATCHED = 'The dispatcher was not able to dispatch: no target';

    /** What a failing browser-side action reports instead (see the log). */
    const STORAGE_UNREADABLE =
      'Protocol error (Opera.dispatchAction): AbortError NotReadableError Data lost due to missing file. Affected record should be considered irrecoverable';

    it('retries a failing dispatch and succeeds', async () => {
      const session = new FakeCDPSession()
        .failTimes(2, new Error(NOT_DISPATCHED))
        .resolveWith({result: 'eventually'});
      const {response, lines} = makeResponse();

      await operaChat.handler(
        makeRequest(session, {prompt: 'hi'}),
        response,
        context,
      );

      assert.strictEqual(session.sendCount, 3);
      assert.deepStrictEqual(lines, ['eventually']);
    });

    it('gives up after maxAttempts and reports the last error', async () => {
      const session = new FakeCDPSession().rejectWith(
        new Error(NOT_DISPATCHED),
      );
      const {response, lines} = makeResponse();

      await operaChat.handler(
        makeRequest(session, {prompt: 'hi'}),
        response,
        context,
      );

      assert.strictEqual(
        session.sendCount,
        serviceWorkerRetryPolicy.maxAttempts,
      );
      assert.match(lines[0]!, /dispatcher was not able to dispatch/);
    });

    it('does not replay a failure from the browser side of the dispatch', async () => {
      // One command, five attempts, five tabs: `chat` failing on unreadable AI
      // storage was re-sent for 10 seconds and left one tab per attempt. The
      // error is the browser's own, so nothing about it says the action never
      // started.
      const session = new FakeCDPSession().rejectWith(
        new Error(STORAGE_UNREADABLE),
      );
      const {response, lines} = makeResponse();

      await operaChat.handler(
        makeRequest(session, {prompt: 'hi'}),
        response,
        context,
      );

      assert.strictEqual(session.sendCount, 1);
      assert.match(lines[0]!, /NotReadableError/);
    });

    it('does not replay a failure from the browser side of a streamed action', async () => {
      const session = new FakeCDPSession().rejectWith(
        new Error(STORAGE_UNREADABLE),
      );
      const {response, lines} = makeResponse();

      await operaDo.handler(
        makeRequest(session, {prompt: 'go'}),
        response,
        context,
      );

      assert.strictEqual(session.sendCount, 1);
      assert.match(lines[0]!, /NotReadableError/);
    });

    it('does not retry a dead-browser dispatch error', async () => {
      // The real class, not a name-alike: the predicate matches by class, so a
      // string-only stand-in would pass here while Puppeteer's real error
      // retried five times.
      const closed = new TargetCloseError('Target closed');
      const session = new FakeCDPSession().rejectWith(closed);
      const {response, lines} = makeResponse();

      await operaChat.handler(
        makeRequest(session, {prompt: 'hi'}),
        response,
        context,
      );

      assert.strictEqual(session.sendCount, 1);
      assert.match(lines[0]!, /Target closed/);
    });

    it('does not retry a closed connection on a streamed dispatch', async () => {
      const closed = new ConnectionClosedError('Connection closed.');
      const session = new FakeCDPSession().rejectWith(closed);
      const {response, lines} = makeResponse();

      await operaDo.handler(
        makeRequest(session, {prompt: 'go'}),
        response,
        context,
      );

      assert.strictEqual(session.sendCount, 1);
      assert.match(lines[0]!, /Connection closed\./);
    });

    it('retries the initial dispatch of a streamed action too', async () => {
      const session = new FakeCDPSession()
        .failTimes(1, new Error(NOT_DISPATCHED))
        .resolveWith({correlationId: 'c1'});
      const {response, lines} = makeResponse();

      const pending = operaDo.handler(
        makeRequest(session, {prompt: 'go'}),
        response,
        context,
      );
      await waitForStreamListeners(session);
      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'ok',
      });
      await pending;

      assert.strictEqual(session.sendCount, 2);
      assert.deepStrictEqual(lines, ['ok']);
    });

    it('retries a failing registerMcpServer dispatch and succeeds', async () => {
      const session = new FakeCDPSession()
        .failTimes(2, new Error(NOT_DISPATCHED))
        .resolveWith({result: 'registered'});
      const {response, lines} = makeResponse();

      await operaRegisterMcpServer.handler(
        makeRequest(session, {
          server: 'my-server',
          url: 'http://localhost:3000',
        }),
        response,
        context,
      );

      assert.strictEqual(session.sendCount, 3);
      assert.deepStrictEqual(lines, ['registered']);
    });

    it('retries the initial dispatch of authenticateMcpServer too', async () => {
      const session = new FakeCDPSession()
        .failTimes(1, new Error(NOT_DISPATCHED))
        .resolveWith({correlationId: 'c1'});
      const {response, lines} = makeResponse();

      const pending = operaAuthenticateMcpServer.handler(
        makeRequest(session, {server: 'my-server'}),
        response,
        context,
      );
      await waitForStreamListeners(session);
      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'authenticated',
      });
      await pending;

      assert.strictEqual(session.sendCount, 2);
      assert.deepStrictEqual(lines, ['authenticated']);
    });
  });

  describe('opera_list_mcp_servers', () => {
    it('dispatches a LIST_SERVERS action and returns the result', async () => {
      const session = new FakeCDPSession().resolveWith({
        result: 'servers list',
      });
      const {response, lines} = makeResponse();

      await operaListMcpServers.handler(
        makeRequest(session, {}),
        response,
        context,
      );

      assert.strictEqual(session.sent[0]?.method, 'Opera.dispatchAction');
      assert.deepStrictEqual(session.payloadAt(0), {
        action: 'listMcpServers',
        type: 'LIST_SERVERS',
      });
      assert.deepStrictEqual(lines, ['servers list']);
    });
  });

  describe('opera_list_mcp_tools', () => {
    it('dispatches a LIST_TOOLS action naming the server', async () => {
      const session = new FakeCDPSession().resolveWith({result: 'tools list'});
      const {response, lines} = makeResponse();

      await operaListMcpTools.handler(
        makeRequest(session, {server: 'github'}),
        response,
        context,
      );

      assert.strictEqual(session.sent[0]?.method, 'Opera.dispatchAction');
      assert.deepStrictEqual(session.payloadAt(0), {
        action: 'listMcpTools',
        server: 'github',
        type: 'LIST_TOOLS',
      });
      assert.deepStrictEqual(lines, ['tools list']);
    });
  });

  describe('opera_call_mcp_tool', () => {
    it('streams an EXECUTE_TOOL action and pins the toolName key', async () => {
      const session = new FakeCDPSession().resolveWith({correlationId: 'c1'});
      const {response, lines, logs} = makeResponse();

      const pending = operaCallMcpTool.handler(
        makeRequest(session, {server: 'github', tool: 'list_issues'}),
        response,
        context,
      );

      await waitForStreamListeners(session);

      assert.strictEqual(
        session.sent[0]?.method,
        'Opera.dispatchWithStreamedResponse',
      );
      // The payload spells the executed tool `toolName`, not `tool` — the two
      // are easy to confuse, and a wrong key is only surfaced by the browser.
      assert.deepStrictEqual(session.payloadAt(0), {
        action: 'callMcpTool',
        server: 'github',
        toolName: 'list_issues',
        type: 'EXECUTE_TOOL',
      });

      session.emit('Opera.actionChunk', {
        correlationId: 'c1',
        chunk: 'found 3 issues',
      });
      session.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'done',
      });

      await pending;
      assert.deepStrictEqual(logs, ['found 3 issues']);
      assert.deepStrictEqual(lines, ['done']);
    });

    it('passes parameters through only when provided', async () => {
      const withParams = new FakeCDPSession().resolveWith({
        correlationId: 'c1',
      });
      const pendingWith = operaCallMcpTool.handler(
        makeRequest(withParams, {
          server: 'github',
          tool: 'create_issue',
          parameters: {title: 'a bug'},
        }),
        makeResponse().response,
        context,
      );
      await waitForStreamListeners(withParams);
      assert.deepStrictEqual(withParams.payloadAt(0), {
        action: 'callMcpTool',
        server: 'github',
        toolName: 'create_issue',
        type: 'EXECUTE_TOOL',
        parameters: {title: 'a bug'},
      });
      withParams.emit('Opera.actionCompleted', {
        correlationId: 'c1',
        result: 'done',
      });
      await pendingWith;

      const withoutParams = new FakeCDPSession().resolveWith({
        correlationId: 'c2',
      });
      const pendingWithout = operaCallMcpTool.handler(
        makeRequest(withoutParams, {server: 'github', tool: 'list_issues'}),
        makeResponse().response,
        context,
      );
      await waitForStreamListeners(withoutParams);
      assert.ok(!('parameters' in withoutParams.payloadAt(0)));
      withoutParams.emit('Opera.actionCompleted', {
        correlationId: 'c2',
        result: 'done',
      });
      await pendingWithout;
    });
  });
});
