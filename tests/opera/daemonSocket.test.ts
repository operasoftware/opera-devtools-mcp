/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import sinon from 'sinon';

import type {DaemonMessage} from '../../src/daemon/types.js';
import {getRuntimeHome} from '../../src/daemon/utils.js';
import {readExitReason} from '../../src/opera/daemonLifecycle.js';
import {
  answerSocketMessage,
  dispatchSocketMessage,
  reportStartupFailure,
} from '../../src/opera/daemonSocket.js';
import {attachLogForwarding} from '../../src/opera/daemonStreaming.js';
import type {Client, PipeTransport} from '../../src/third_party/index.js';

let runtimeDir: string;
let savedRuntimeDir: string | undefined;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'opera-daemon-socket-'));
  savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
});

afterEach(() => {
  sinon.restore();
  if (savedRuntimeDir === undefined) {
    delete process.env.XDG_RUNTIME_DIR;
  } else {
    process.env.XDG_RUNTIME_DIR = savedRuntimeDir;
  }
  rmSync(runtimeDir, {recursive: true, force: true});
});

describe('answerSocketMessage', () => {
  it('answers a frame that is not JSON instead of letting it reject', async () => {
    let handled = false;
    const reply = await answerSocketMessage('not json at all', async () => {
      handled = true;
      return {success: true};
    });

    assert.strictEqual(handled, false);
    assert.deepStrictEqual(reply, {success: false, error: 'malformed message'});
  });

  it('passes a parsed frame to the handler and returns its reply', async () => {
    let seen: DaemonMessage | undefined;
    const reply = await answerSocketMessage(
      '{"method":"status"}',
      async message => {
        seen = message;
        return {success: true, result: 'ok'};
      },
    );

    assert.deepStrictEqual(seen, {method: 'status'});
    assert.deepStrictEqual(reply, {success: true, result: 'ok'});
  });

  it('turns a throwing handler into an error reply', async () => {
    // The daemon's own `handleRequest` catches internally, but nothing on this
    // path may reject: a rejection reaches `unhandledRejection`, whose handler
    // tears the whole session down.
    const reply = await answerSocketMessage(
      '{"method":"invoke_tool"}',
      async () => {
        throw new Error('boom');
      },
    );

    assert.deepStrictEqual(reply, {success: false, error: 'boom'});
  });
});

describe('dispatchSocketMessage', () => {
  /** A transport stand-in that records every frame `send` is asked to carry. */
  function captureTransport(): {frames: string[]; transport: PipeTransport} {
    const frames: string[] = [];
    const transport = {
      send: (frame: string) => {
        frames.push(frame);
      },
    } as unknown as PipeTransport;
    return {frames, transport};
  }

  /** A client stand-in narrowed to `setNotificationHandler`, the one method
   * `attachLogForwarding` calls. */
  function captureClient(): {
    client: Client;
    notification(notification: unknown): void;
  } {
    let handler: ((notification: never) => void) | undefined;
    const stub = {
      setNotificationHandler(_schema: unknown, h: (n: never) => void) {
        handler = h;
      },
    };
    return {
      client: stub as unknown as Client,
      notification: n => handler?.(n as never),
    };
  }

  /** A chunk notification as the MCP server sends it, carrying its stream token. */
  const logChunk = (data: string, streamToken: string) => ({
    params: {level: 'info', data, _meta: {streamToken}},
  });

  it('passes a non-streaming message through with no token and no send', async () => {
    const {frames, transport} = captureTransport();
    let calls = 0;
    let seenToken: string | undefined = 'sentinel';
    const reply = await dispatchSocketMessage(
      '{"method":"status"}',
      transport,
      async (message, token) => {
        calls++;
        seenToken = token;
        return {success: true, result: 'alive'};
      },
    );

    assert.strictEqual(calls, 1);
    assert.strictEqual(seenToken, undefined);
    assert.deepStrictEqual(reply, {success: true, result: 'alive'});
    assert.deepStrictEqual(frames, []);
  });

  it('answers malformed JSON as an error reply without calling the handler', async () => {
    const {frames, transport} = captureTransport();
    let handled = false;
    const reply = await dispatchSocketMessage(
      'not json',
      transport,
      async () => {
        handled = true;
        return {success: true};
      },
    );

    assert.strictEqual(handled, false);
    assert.deepStrictEqual(reply, {success: false, error: 'malformed message'});
    assert.deepStrictEqual(frames, []);
  });

  it('turns a throwing handler into an error reply', async () => {
    const {transport} = captureTransport();
    const reply = await dispatchSocketMessage(
      '{"method":"invoke_tool"}',
      transport,
      async () => {
        throw new Error('boom');
      },
    );

    assert.deepStrictEqual(reply, {success: false, error: 'boom'});
  });

  it('mints a token and routes a chunk to the transport while it streams', async () => {
    const {frames, transport} = captureTransport();
    const {client, notification} = captureClient();
    attachLogForwarding(client);

    let seenToken: string | undefined;
    const reply = await dispatchSocketMessage(
      '{"method":"invoke_tool","stream":true}',
      transport,
      async (message, token) => {
        assert.strictEqual(message.method, 'invoke_tool');
        assert.strictEqual(message.stream, true);
        seenToken = token;
        notification(logChunk('hello chunk', token!));
        return {success: true, result: 'done'};
      },
    );

    assert.strictEqual(typeof seenToken, 'string');
    assert.ok((seenToken as string).length > 0, 'the token must be non-empty');
    assert.deepStrictEqual(frames, [JSON.stringify({log: 'hello chunk'})]);
    assert.deepStrictEqual(reply, {success: true, result: 'done'});
  });

  it('keeps two concurrent streams on their own transports', async () => {
    const {frames: aFrames, transport: transportA} = captureTransport();
    const {frames: bFrames, transport: transportB} = captureTransport();
    const {client, notification} = captureClient();
    attachLogForwarding(client);

    const gateA = Promise.withResolvers<void>();
    const gateB = Promise.withResolvers<void>();
    let tokenA: string | undefined;
    let tokenB: string | undefined;

    const runA = dispatchSocketMessage(
      '{"method":"invoke_tool","stream":true,"tool":"opera_chat"}',
      transportA,
      async (_message, token) => {
        tokenA = token;
        await gateA.promise;
        return {success: true, result: 'a'};
      },
    );
    const runB = dispatchSocketMessage(
      '{"method":"invoke_tool","stream":true,"tool":"opera_do"}',
      transportB,
      async (_message, token) => {
        tokenB = token;
        await gateB.promise;
        return {success: true, result: 'b'};
      },
    );

    // Both handlers ran synchronously within their dispatch calls and minted
    // distinct tokens, which is the only thing keeping their chunks apart.
    assert.strictEqual(typeof tokenA, 'string');
    assert.strictEqual(typeof tokenB, 'string');
    assert.notStrictEqual(tokenA, tokenB);

    notification(logChunk('for a', tokenA!));
    notification(logChunk('for b', tokenB!));

    gateA.resolve();
    gateB.resolve();
    await Promise.all([runA, runB]);

    assert.deepStrictEqual(aFrames, [JSON.stringify({log: 'for a'})]);
    assert.deepStrictEqual(bFrames, [JSON.stringify({log: 'for b'})]);
  });
});

describe('reportStartupFailure', () => {
  it('tears down once and stays running when the socket was bound', async () => {
    const sessionId = crypto.randomUUID();
    mkdirSync(getRuntimeHome(sessionId), {recursive: true});
    const teardown = sinon.stub().resolves();
    const exit = sinon.stub(process, 'exit');

    await reportStartupFailure(new Error('lost the bind race'), {
      socketBound: true,
      sessionId,
      teardown,
    });

    assert.ok(
      teardown.calledOnceWithExactly('startup failed: lost the bind race'),
    );
    assert.strictEqual(exit.called, false);
    assert.strictEqual(readExitReason(sessionId), null);
  });

  it('records the bind failure and exits once, without teardown, when not bound', async () => {
    const sessionId = crypto.randomUUID();
    mkdirSync(getRuntimeHome(sessionId), {recursive: true});
    const teardown = sinon.stub().resolves();
    const exit = sinon.stub(process, 'exit');

    await reportStartupFailure(new Error('address in use'), {
      socketBound: false,
      sessionId,
      teardown,
    });

    assert.strictEqual(teardown.called, false);
    assert.strictEqual(exit.calledOnceWithExactly(1), true);
    assert.strictEqual(
      readExitReason(sessionId),
      'socket bind failed: address in use',
    );
  });

  it('stringifies a non-Error failure detail', async () => {
    const sessionId = crypto.randomUUID();
    mkdirSync(getRuntimeHome(sessionId), {recursive: true});
    const teardown = sinon.stub().resolves();
    sinon.stub(process, 'exit');

    await reportStartupFailure('weird failure', {
      socketBound: true,
      sessionId,
      teardown,
    });

    assert.ok(teardown.calledOnceWithExactly('startup failed: weird failure'));
  });
});
