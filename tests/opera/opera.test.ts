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
import {
  operaChat,
  operaDo,
  operaListModels,
  operaMake,
  operaResearch,
} from '../../src/opera/tools/opera.js';

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

  listenerCountFor(event: string): number {
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

  beforeEach(() => {
    // Drive the retry loop without waiting on real backoff. Faking timers with
    // sinon is not an option here: it replaces the globals node:test uses to
    // schedule subtests, which silently drops whole suites from the run.
    serviceWorkerRetryPolicy.delayMs = 0;
  });

  afterEach(() => {
    serviceWorkerRetryPolicy.delayMs = defaultDelayMs;
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
  });

  describe('service worker retry', () => {
    it('retries a failing dispatch and succeeds', async () => {
      const session = new FakeCDPSession()
        .failTimes(2, new Error('service worker not ready'))
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
      const session = new FakeCDPSession().rejectWith(new Error('still down'));
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
      assert.match(lines[0]!, /still down/);
    });

    it('retries the initial dispatch of a streamed action too', async () => {
      const session = new FakeCDPSession()
        .failTimes(1, new Error('service worker not ready'))
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
  });
});
