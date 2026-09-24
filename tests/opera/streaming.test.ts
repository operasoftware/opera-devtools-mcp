/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import net from 'node:net';
import type {Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {sendCommand} from '../../src/daemon/client.js';
import type {DaemonLogFrame, DaemonResponse} from '../../src/daemon/types.js';
import {getPidFilePath} from '../../src/daemon/utils.js';
import {parseArguments} from '../../src/config/mcp-options.js';
import {resetBrowserActivity} from '../../src/opera/browserActivity.js';
import {
  CDP_RESULT_ERROR_KEYS,
  checkAiResultForCdpError,
  CdpError,
  EXIT_CODES,
} from '../../src/opera/cdpErrors.js';
import {
  attachLogForwarding,
  requestOverSocket,
  withLogSink,
} from '../../src/opera/daemonStreaming.js';
import {callDaemonTool} from '../../src/opera/daemonToolCall.js';
import {
  createOperaToolHooks,
  type OperaToolHooks,
} from '../../src/opera/toolHandlerHooks.js';
import {
  NON_REPLAYABLE_TOOLS,
  OPERA_AI_TIMEOUT_MS,
  OPERA_AI_TOOLS,
  isOperaAiTool,
  operaAiTimeoutMs,
} from '../../src/opera/streamingTools.js';
import {ToolCategory} from '../../src/tools/categories.js';
import type {Client} from '../../src/third_party/index.js';

type Frame = DaemonLogFrame | DaemonResponse;

/** Just enough of a `net.Socket` for `PipeTransport` and `sendCommand`. */
interface FakeSocket extends EventEmitter {
  write(chunk: string): boolean;
  destroy(): void;
}

interface FakeDaemon {
  /** Every `\0`-delimited frame the client sent, decoded. */
  requests: Array<Record<string, unknown>>;
  /** Push a frame from the daemon to the client. */
  send(frame: Frame): void;
  /** Drop the connection the way a killed daemon does. */
  close(): void;
}

/**
 * Replace the socket with an in-process duplex.
 *
 * The daemon's real socket cannot be bound in every environment (a restricted
 * sandbox denies `AF_UNIX` binds outright), and the behaviour under test is the
 * frame protocol, not the kernel's ability to carry it. Only the connection is
 * faked: the frames are the real `PipeTransport` `\0`-delimited ones.
 */
function fakeDaemon(): FakeDaemon {
  const requests: Array<Record<string, unknown>> = [];
  let pending = '';
  const socket = new EventEmitter() as FakeSocket;
  socket.write = (chunk: string) => {
    pending += chunk;
    let end = pending.indexOf('\0');
    while (end !== -1) {
      requests.push(
        JSON.parse(pending.slice(0, end)) as Record<string, unknown>,
      );
      pending = pending.slice(end + 1);
      end = pending.indexOf('\0');
    }
    return true;
  };
  socket.destroy = () => {
    socket.emit('close');
  };
  sinon
    .stub(net, 'createConnection')
    .callsFake(() => socket as unknown as net.Socket);

  return {
    requests,
    send: (frame: Frame) =>
      socket.emit('data', Buffer.from(JSON.stringify(frame) + '\0')),
    close: () => socket.emit('close'),
  };
}

/**
 * Everything `sendCommand` checks before it will connect: a live pid in the pid
 * file. This process's own is the only pid a test can rely on being alive.
 */
function claimSession(): string {
  const sessionId = crypto.randomUUID();
  const pidFile = getPidFilePath(sessionId);
  mkdirSync(dirname(pidFile), {recursive: true});
  writeFileSync(pidFile, String(process.pid));
  return sessionId;
}

let runtimeDir: string;
let savedRuntimeDir: string | undefined;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'opera-streaming-'));
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

describe('sendCommand streaming', () => {
  it('delivers chunks in order and settles on the final frame', async () => {
    const sessionId = claimSession();
    const daemon = fakeDaemon();

    const chunks: string[] = [];
    const settled = sendCommand(
      {method: 'invoke_tool', tool: 'opera_chat', args: {prompt: 'hi'}},
      sessionId,
      5000,
      chunk => chunks.push(chunk),
    );

    assert.strictEqual(daemon.requests.length, 1);
    assert.strictEqual(daemon.requests[0]!['stream'], true);
    assert.strictEqual(daemon.requests[0]!['tool'], 'opera_chat');

    daemon.send({log: 'thinking'});
    daemon.send({log: 'still thinking'});
    daemon.send({success: true, result: '{"content":[]}', error: null});

    const response = await settled;

    assert.deepStrictEqual(chunks, ['thinking', 'still thinking']);
    assert.strictEqual(response.success, true);
    assert.strictEqual(response.result, '{"content":[]}');
  });

  it('carries a chunk the tool emits through to the CLI sink', async () => {
    const sessionId = claimSession();
    const daemon = fakeDaemon();

    // The daemon's MCP-client side is the real notification handler; only the
    // socket and the browser are missing from this chain.
    const {client: sdkClient, notification} = captureClient();
    attachLogForwarding(sdkClient);

    const hooks = createOperaToolHooks({
      serverArgs: parseArguments('1.0.0', ['node', 'script.js'], {
        OPERA_DEVTOOLS_NO_USAGE_STATISTICS: 'true',
      }),
      logFile: undefined,
      resetContext: () => {
        // These tests never relaunch a browser.
      },
    });

    /** The MCP server, reduced to "take the call, emit one chunk through it". */
    const server = {
      callTool: (params: {
        name: string;
        arguments: Record<string, unknown>;
        _meta?: Record<string, unknown>;
      }) => {
        const log = hooks.makeLogCallback({
          requestId: 1,
          _meta: params._meta,
          sendNotification: sent => {
            notification(sent);
            return Promise.resolve();
          },
        });
        log?.(`${params.name} is thinking`);
        return Promise.resolve({content: []});
      },
    } as unknown as Client;

    const chunks: string[] = [];
    const settled = sendCommand(
      {method: 'invoke_tool', tool: 'opera_do', args: {prompt: 'go'}},
      sessionId,
      5000,
      chunk => chunks.push(chunk),
    );
    assert.strictEqual(daemon.requests[0]!['stream'], true);

    // The daemon's own wiring for a streaming request, token and frame sink
    // included: `withLogSink` around the call it makes through the MCP client.
    const streamToken = 'token-a';
    await withLogSink(
      streamToken,
      chunk => daemon.send({log: chunk}),
      () =>
        callDaemonTool(server, {
          tool: 'opera_do',
          args: {prompt: 'go'},
          streamToken,
        }),
    );
    daemon.send({success: true, result: '{"content":[]}', error: null});

    const response = await settled;

    assert.deepStrictEqual(chunks, ['opera_do is thinking']);
    assert.strictEqual(response.success, true);
  });

  it('leaves a request that asked for no chunks on the original protocol', async () => {
    const sessionId = claimSession();
    const daemon = fakeDaemon();

    const settled = sendCommand({method: 'status'}, sessionId, 5000);

    assert.strictEqual(daemon.requests.length, 1);
    assert.ok(
      !('stream' in daemon.requests[0]!),
      'a non-streaming request must not set `stream`',
    );

    daemon.send({success: true, result: '"one frame"', error: null});

    assert.strictEqual((await settled).result, '"one frame"');
  });

  it('settles on the first frame when no chunk sink was given', async () => {
    const sessionId = claimSession();
    const daemon = fakeDaemon();

    const settled = sendCommand({method: 'status'}, sessionId, 5000);
    // Without `onLog` there is no frame grammar to disambiguate: the first
    // frame is the answer, which is what a non-streaming client expects.
    daemon.send({log: 'not a response'});

    const response = await settled;

    assert.strictEqual(response.success, undefined);
    assert.strictEqual(response.result, undefined);
  });

  it('rejects a stream that closes before the final frame, without replaying it', async () => {
    const sessionId = claimSession();
    const daemon = fakeDaemon();

    const chunks: string[] = [];
    const settled = sendCommand(
      {method: 'invoke_tool', tool: 'opera_chat', args: {prompt: 'hi'}},
      sessionId,
      5000,
      chunk => chunks.push(chunk),
    );

    daemon.send({log: 'half an answer'});
    // `PipeTransport` hands frames over on a macrotask, so let that land before
    // the connection drops.
    await new Promise(resolve => setImmediate(resolve));
    daemon.close();

    await assert.rejects(settled, /Daemon exited while running the command/);

    assert.deepStrictEqual(chunks, ['half an answer']);
    // Single-shot by construction: a dropped Opera AI call is never re-sent,
    // because it may already have acted on the page or been billed.
    assert.strictEqual(daemon.requests.length, 1);
  });

  it('refuses to connect to a session with no daemon', async () => {
    fakeDaemon();

    await assert.rejects(
      sendCommand({method: 'status'}, crypto.randomUUID(), 5000),
      /Daemon is not running/,
    );
  });
});

/**
 * A `Client` whose notification handler the test can drive. Only the one
 * method `attachLogForwarding` calls is real, which is the point: the contract
 * under test is which notifications reach the sink.
 */
function captureClient(): {
  client: Client;
  notification(notification: unknown): void;
} {
  let handler: ((notification: never) => void) | undefined;
  // Unchecked cast: a hand-built stand-in for the SDK client, narrowed to the
  // single method `attachLogForwarding` calls.
  const stub = {
    setNotificationHandler(_schema: unknown, h: (n: never) => void) {
      handler = h;
    },
  };
  const client = stub as unknown as Client;
  return {
    client,
    notification: n => handler?.(n as never),
  };
}

describe('daemon log forwarding', () => {
  const TOKEN_A = 'token-a';
  const TOKEN_B = 'token-b';

  /** A chunk for one streaming request, as the server sends it. */
  const chunk = (data: string, streamToken?: string) => ({
    params: {
      level: 'info',
      data,
      ...(streamToken === undefined ? {} : {_meta: {streamToken}}),
    },
  });

  it('forwards message data to the sink of the request it names', async () => {
    const {client, notification} = captureClient();
    attachLogForwarding(client);

    const seen: string[] = [];
    await withLogSink(
      TOKEN_A,
      value => seen.push(value),
      async () => {
        notification(chunk('chunk one', TOKEN_A));
      },
    );

    assert.deepStrictEqual(seen, ['chunk one']);
  });

  it('keeps two streaming requests apart', async () => {
    const {client, notification} = captureClient();
    attachLogForwarding(client);

    const first: string[] = [];
    const second: string[] = [];
    const firstGate = Promise.withResolvers<void>();
    // The first request is still running when the second one starts, which is
    // the state the daemon is in when a user fires a second command mid-run.
    const firstRun = withLogSink(
      TOKEN_A,
      value => first.push(value),
      async () => {
        await firstGate.promise;
      },
    );
    const secondRun = withLogSink(
      TOKEN_B,
      value => second.push(value),
      async () => {
        notification(chunk('for the first terminal', TOKEN_A));
        notification(chunk('for the second terminal', TOKEN_B));
        firstGate.resolve();
        await firstRun;
      },
    );
    await secondRun;

    assert.deepStrictEqual(first, ['for the first terminal']);
    assert.deepStrictEqual(second, ['for the second terminal']);
  });

  it('keeps the other request streaming when one run finishes', async () => {
    const {client, notification} = captureClient();
    attachLogForwarding(client);

    const second: string[] = [];
    const firstGate = Promise.withResolvers<void>();
    const firstRun = withLogSink(
      TOKEN_A,
      () => {
        // The first request's chunks are not what this test is about.
      },
      async () => {
        await firstGate.promise;
      },
    );
    const secondRun = withLogSink(
      TOKEN_B,
      value => second.push(value),
      async () => {
        notification(chunk('before the first finished', TOKEN_B));
        // The first request ends here. A shared sink would be gone with it.
        firstGate.resolve();
        await firstRun;
        notification(chunk('after the first finished', TOKEN_B));
      },
    );
    await secondRun;

    assert.deepStrictEqual(second, [
      'before the first finished',
      'after the first finished',
    ]);
  });

  it('ignores notifications that carry no string data', async () => {
    const {client, notification} = captureClient();
    attachLogForwarding(client);

    const seen: string[] = [];
    await withLogSink(
      TOKEN_A,
      value => seen.push(value),
      async () => {
        notification({params: {level: 'info', _meta: {streamToken: TOKEN_A}}});
        notification({params: {data: {not: 'a string'}}});
      },
    );

    assert.deepStrictEqual(seen, []);
  });

  it('drops a chunk that arrives after the run that installed the sink', async () => {
    const {client, notification} = captureClient();
    attachLogForwarding(client);

    const seen: string[] = [];
    await withLogSink(
      TOKEN_A,
      value => seen.push(value),
      async () => {
        notification(chunk('during', TOKEN_A));
      },
    );
    notification(chunk('after', TOKEN_A));

    assert.deepStrictEqual(seen, ['during']);
  });

  it('drops a chunk from a request that never asked for streaming', async () => {
    const {client, notification} = captureClient();
    attachLogForwarding(client);

    const seen: string[] = [];
    await withLogSink(
      TOKEN_A,
      value => seen.push(value),
      async () => {
        notification(chunk('no token at all'));
        notification(chunk('unknown token', 'somebody-else'));
      },
    );

    assert.deepStrictEqual(seen, []);
  });

  it('drops notifications when no run has installed a sink', () => {
    const {client, notification} = captureClient();
    attachLogForwarding(client);

    assert.doesNotThrow(() => notification(chunk('nobody listening', TOKEN_A)));
  });
});

describe('Opera AI result errors', () => {
  it('turns each CDP error key into a coded failure', () => {
    const expected: Array<[string, string, number]> = [
      [CDP_RESULT_ERROR_KEYS.NOT_SIGNED_IN, 'AUTH_REQUIRED', 4],
      [CDP_RESULT_ERROR_KEYS.SUBSCRIPTION_REQUIRED, 'AUTH_REQUIRED', 4],
      [CDP_RESULT_ERROR_KEYS.CONSENT_REQUIRED, 'AUTH_REQUIRED', 4],
      [CDP_RESULT_ERROR_KEYS.NEON_ONLY, 'UNSUPPORTED_OPERATION', 2],
      [
        CDP_RESULT_ERROR_KEYS.CONVERSATION_NOT_FOUND,
        'CONVERSATION_NOT_FOUND',
        2,
      ],
    ];

    for (const [key, code, exitCode] of expected) {
      assert.throws(
        () => checkAiResultForCdpError('opera_chat', `prefix ${key} suffix`),
        (error: unknown) => {
          assert.ok(error instanceof CdpError, `not a CdpError for ${key}`);
          assert.strictEqual(error.code, code);
          assert.strictEqual(EXIT_CODES[error.code], exitCode);
          assert.ok(
            error.suggestions.length > 0,
            `${key} produced no suggestions`,
          );
          return true;
        },
      );
    }
  });

  it('accepts a plain-text AI result', () => {
    assert.doesNotThrow(() =>
      checkAiResultForCdpError('opera_chat', 'The capital of France is Paris.'),
    );
  });

  it('names the tool in a Neon-only failure', () => {
    assert.throws(
      () =>
        checkAiResultForCdpError(
          'opera_do',
          `x ${CDP_RESULT_ERROR_KEYS.NEON_ONLY} y`,
        ),
      (error: unknown) => {
        assert.ok(error instanceof CdpError);
        assert.match(error.message, /opera_do is only available on Opera Neon/);
        return true;
      },
    );
  });

  it('turns an unreadable AI store into a profile-level failure', () => {
    // Verbatim from a failing `opera_chat`: the tool reports it as an ordinary
    // result, so this is the only place that can name the cause and the remedy.
    const reported =
      'Opera.dispatchAction(chat) failed with error: Protocol error (Opera.dispatchAction): AbortError NotReadableError Data lost due to missing file. Affected record should be considered irrecoverable';

    assert.throws(
      () => checkAiResultForCdpError('opera_chat', reported),
      (error: unknown) => {
        assert.ok(error instanceof CdpError);
        assert.strictEqual(error.code, 'BROWSER_ERROR');
        assert.strictEqual(EXIT_CODES[error.code], 3);
        assert.match(error.message, /own storage rejected the action/);
        assert.ok(
          error.suggestions.some(s => s.includes('start --isolated')),
          'the fresh-profile remedy must be offered',
        );
        return true;
      },
    );
  });

  it('names a browser without Opera AI when the dispatch never reached it', () => {
    // The retry (`serviceWorkerRetry`) happens inside the tool, so a copy of
    // this wording that reaches the CLI is one the retries already spent: it is
    // the terminal diagnosis, not a warm-up. That is also the shape a non-Opera
    // browser takes — the tool appends it to a successful result rather than
    // throwing, so this check is the only thing that can exit non-zero for it.
    assert.throws(
      () =>
        checkAiResultForCdpError(
          'opera_chat',
          'Opera.dispatchWithStreamedResponse(chat) failed with error: dispatcher was not able to dispatch: no target',
        ),
      (error: unknown) => {
        assert.ok(error instanceof CdpError);
        assert.strictEqual(error.code, 'BROWSER_ERROR');
        assert.strictEqual(EXIT_CODES[error.code], 3);
        assert.match(error.message, /opera_chat requires an Opera browser/);
        assert.ok(
          error.suggestions.some(s => s.includes('opera.com')),
          'the alternative browser must be offered',
        );
        return true;
      },
    );
  });
});

describe('Opera AI chunk notifications', () => {
  function makeHooks(): OperaToolHooks {
    return createOperaToolHooks({
      serverArgs: parseArguments('1.0.0', ['node', 'script.js'], {
        OPERA_DEVTOOLS_NO_USAGE_STATISTICS: 'true',
      }),
      logFile: undefined,
      resetContext: () => {
        // These tests never relaunch a browser.
      },
    });
  }

  it('echoes the request streaming token on every chunk', () => {
    const sent: unknown[] = [];
    const log = makeHooks().makeLogCallback({
      requestId: 7,
      _meta: {streamToken: 'token-a'},
      sendNotification: notification => {
        sent.push(notification);
        return Promise.resolve();
      },
    });

    log?.('partial answer');

    assert.deepStrictEqual(sent, [
      {
        method: 'notifications/message',
        params: {
          level: 'info',
          data: 'partial answer',
          logger: '7',
          // The token the daemon put on the call, back again: without it the
          // chunk cannot be routed to the connection that asked for streaming.
          _meta: {streamToken: 'token-a'},
        },
      },
    ]);
  });

  it('sends the chunk without metadata when the request asked for none', () => {
    const sent: unknown[] = [];
    const log = makeHooks().makeLogCallback({
      requestId: 7,
      sendNotification: notification => {
        sent.push(notification);
        return Promise.resolve();
      },
    });

    log?.('partial answer');

    assert.deepStrictEqual(sent, [
      {
        method: 'notifications/message',
        params: {level: 'info', data: 'partial answer', logger: '7'},
      },
    ]);
  });

  it('has no callback when the invocation cannot send notifications', () => {
    assert.strictEqual(makeHooks().makeLogCallback({requestId: 1}), undefined);
  });

  it('leaves a rejected chunk send as a lost chunk, not an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const log = makeHooks().makeLogCallback({
        requestId: 7,
        // What a closed transport does: the notification cannot be delivered.
        sendNotification: () => Promise.reject(new Error('transport closed')),
      });

      log?.('partial answer');
      // The next event-loop turn, so a rejection nobody handled would have
      // reached the process by now (Node emits `unhandledRejection` once the
      // current turn's microtasks are done). It must not: the daemon answers
      // that event with `cleanup(1)`, so one undeliverable chunk would end the
      // session, and the respawn would make a burst of them a supervision loop.
      const {promise, resolve} = Promise.withResolvers<void>();
      setImmediate(resolve);
      await promise;
    } finally {
      process.off('unhandledRejection', onRejection);
    }

    assert.deepStrictEqual(rejections, []);
  });

  /**
   * The whole hop, with the socket and the browser replaced by the parts that
   * carry a chunk: the daemon puts a token on the call, the server's log
   * callback echoes it, and the notification lands in the sink of *that*
   * request and no other.
   */
  it('routes a chunk emitted by one call back to that call alone', async () => {
    const {client, notification} = captureClient();
    attachLogForwarding(client);

    /** The MCP server, reduced to "take the call, emit one chunk through it". */
    const server = {
      callTool: (params: {
        name: string;
        arguments: Record<string, unknown>;
        _meta?: Record<string, unknown>;
      }) => {
        const log = makeHooks().makeLogCallback({
          requestId: 1,
          _meta: params._meta,
          sendNotification: sent => {
            notification(sent);
            return Promise.resolve();
          },
        });
        log?.(`chunk for ${params.name}`);
        return Promise.resolve({content: []});
      },
    } as unknown as Client;

    const first: string[] = [];
    const second: string[] = [];
    const firstGate = Promise.withResolvers<void>();
    const firstRun = withLogSink(
      'token-a',
      value => first.push(value),
      async () => {
        await firstGate.promise;
      },
    );
    const secondRun = withLogSink(
      'token-b',
      value => second.push(value),
      async () => {
        await callDaemonTool(server, {
          tool: 'opera_do',
          args: {prompt: 'go'},
          streamToken: 'token-b',
        });
        // A request that never asked for streaming: its chunk, if the tool
        // emitted one, belongs to nobody and is dropped.
        await callDaemonTool(server, {tool: 'take_snapshot'});
        firstGate.resolve();
        await firstRun;
      },
    );
    await secondRun;

    // Nothing was emitted for the first request, and it was still running while
    // the second one streamed — the state that used to cross the two.
    assert.deepStrictEqual(first, []);
    assert.deepStrictEqual(second, ['chunk for opera_do']);
  });
});

describe('streaming tool set', () => {
  it('contains exactly the long-running Opera AI tools', () => {
    assert.deepStrictEqual(Object.keys(OPERA_AI_TOOLS).sort(), [
      'opera_authenticate_mcp_server',
      'opera_call_mcp_tool',
      'opera_chat',
      'opera_do',
      'opera_make',
      'opera_research',
    ]);
  });

  it('gives the AI tools the long timeout on both ends of the chain', () => {
    for (const tool of Object.keys(OPERA_AI_TOOLS)) {
      assert.strictEqual(isOperaAiTool(tool), true);
      // Both the CLI's socket wait and the daemon's MCP client ask this, and
      // the shorter of the two decides; a tool the daemon holds to its own
      // 60-second default is killed while the CLI is still waiting.
      assert.strictEqual(operaAiTimeoutMs(tool), OPERA_AI_TIMEOUT_MS);
    }
    assert.strictEqual(operaAiTimeoutMs('take_snapshot'), undefined);
    assert.strictEqual(isOperaAiTool('take_snapshot'), false);
  });
});

/**
 * A bare socket for `requestOverSocket`, whose only job is to carry frames.
 * `destroy` is a no-op so the timeout path above decides the outcome itself: a
 * real `net.Socket` emits `close` asynchronously, never before the timeout
 * callback's own `reject`, and a synchronous `close` here would swap the
 * timeout error for the "daemon exited" one. Callers simulate a dropped
 * connection explicitly through `close()`.
 */
function fakeSocket(): {
  socket: Socket;
  frames: string[];
  send(frame: Frame): void;
  close(): void;
  error(error: Error): void;
} {
  const socket = new EventEmitter() as FakeSocket;
  const frames: string[] = [];
  let pending = '';
  socket.write = (chunk: string) => {
    pending += chunk;
    let end = pending.indexOf('\0');
    while (end !== -1) {
      frames.push(pending.slice(0, end));
      pending = pending.slice(end + 1);
      end = pending.indexOf('\0');
    }
    return true;
  };
  socket.destroy = () => {
    // Intentionally nothing: see the note above.
  };
  return {
    socket: socket as unknown as Socket,
    frames,
    send: (frame: Frame) =>
      socket.emit('data', Buffer.from(JSON.stringify(frame) + '\0')),
    close: () => socket.emit('close'),
    error: error => socket.emit('error', error),
  };
}

describe('requestOverSocket', () => {
  it('rejects an accepted-but-silent connection with the daemon timeout', async () => {
    const {socket} = fakeSocket();

    const settled = requestOverSocket({
      socket,
      command: {
        method: 'invoke_tool',
        tool: 'opera_chat',
        args: {prompt: 'hi'},
      },
      timeout: 20,
      sessionId: 'session-a',
      onLog: () => {
        // Deliberately unused: this case asserts onLog is never consulted.
      },
    });

    await assert.rejects(settled, /Timeout waiting for daemon response/);
  });

  it('re-arms the timeout on every chunk', async () => {
    const {socket, send} = fakeSocket();
    const chunks: string[] = [];

    const settled = requestOverSocket({
      socket,
      command: {method: 'invoke_tool', tool: 'opera_do', args: {prompt: 'go'}},
      timeout: 60,
      sessionId: 'session-a',
      onLog: chunk => chunks.push(chunk),
    });

    // The deadline under test is the module's own `setTimeout`, and fake
    // timers break node:test's subtest scheduling (see the suite conventions),
    // so the clock is driven with real, brief waits. Each gap stays under the
    // 60 ms deadline but the three together exceed it: only a per-chunk re-arm
    // keeps the run alive across them.
    const wait = (ms: number) => {
      const {promise, resolve} = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    };
    await wait(40);
    send({log: 'one'});
    await wait(40);
    send({log: 'two'});
    await wait(40);
    send({success: true, result: '"done"', error: null});

    const response = await settled;
    assert.deepStrictEqual(chunks, ['one', 'two']);
    assert.strictEqual(response.success, true);
  });

  it('rejects with the socket error', async () => {
    const {socket, error} = fakeSocket();

    const settled = requestOverSocket({
      socket,
      command: {method: 'status'},
      timeout: 5000,
      sessionId: 'session-a',
    });

    error(new Error('connection reset by peer'));

    await assert.rejects(settled, /connection reset by peer/);
  });

  it('leaves a non-invoke_tool command on the original protocol even with onLog', async () => {
    const {socket, frames, send} = fakeSocket();

    const settled = requestOverSocket({
      socket,
      command: {method: 'status'},
      timeout: 5000,
      sessionId: 'session-a',
      onLog: () => {
        // Deliberately unused: this case asserts onLog is never consulted.
      },
    });

    assert.ok(
      !('stream' in (JSON.parse(frames[0]!) as Record<string, unknown>)),
      'a non-invoke_tool command must not be marked stream',
    );

    send({success: true, result: '"one frame"', error: null});
    assert.strictEqual((await settled).result, '"one frame"');
  });
});

describe('createOperaToolHooks real factory', () => {
  const makeTool = (name: string, category: ToolCategory) =>
    ({
      name,
      annotations: {category, readOnlyHint: false},
    }) as unknown as Parameters<OperaToolHooks['bypassMutex']>[0];

  const serverArgs = (extra: string[]) =>
    parseArguments('1.0.0', ['node', 'script.js', ...extra], {
      OPERA_DEVTOOLS_NO_USAGE_STATISTICS: 'true',
    });

  // These drive `beforeInvoke` directly, without the `ToolHandler` that pairs it
  // with `afterInvoke`, so the browser claim each one takes has to be handed
  // back here or the next case sees a browser in use.
  afterEach(() => resetBrowserActivity());

  it('bypasses the mutex only for Opera-category tools', () => {
    const hooks = createOperaToolHooks({
      serverArgs: serverArgs([]),
      logFile: undefined,
      resetContext: () => {
        // Not asserted in this case; the context cache is not under test here.
      },
    });

    assert.strictEqual(
      hooks.bypassMutex(makeTool('opera_do', ToolCategory.OPERA)),
      true,
    );
    assert.strictEqual(
      hooks.bypassMutex(makeTool('take_snapshot', ToolCategory.DEBUGGING)),
      false,
    );
  });

  it('is a no-op in attach mode', async () => {
    const resetContext = sinon.stub();
    const hooks = createOperaToolHooks({
      serverArgs: serverArgs(['--browser-url=http://127.0.0.1:9222']),
      logFile: undefined,
      resetContext,
    });

    await hooks.beforeInvoke(makeTool('opera_do', ToolCategory.OPERA));

    assert.strictEqual(resetContext.called, false);
  });

  it('does not relaunch for a tool that needs no Opera flags', async () => {
    const resetContext = sinon.stub();
    const hooks = createOperaToolHooks({
      serverArgs: serverArgs(['--headless', '--isolated']),
      logFile: undefined,
      resetContext,
    });

    await hooks.beforeInvoke(makeTool('opera_chat', ToolCategory.OPERA));

    assert.strictEqual(resetContext.called, false);
  });

  it('relaunches through resetContext for an Opera-flag tool in launch mode', async () => {
    const resetContext = sinon.stub();
    const hooks = createOperaToolHooks({
      serverArgs: serverArgs([
        '--headless',
        '--isolated',
        '--executable-path',
        '/definitely-not-a-real-opera-binary',
      ]),
      logFile: undefined,
      resetContext,
    });

    // The relaunch reaches resetContext first; the browser launch itself fails
    // on the nonexistent executable, which is fine: this pins the delegation,
    // not a real Chrome spawn.
    await assert.rejects(
      hooks.beforeInvoke(makeTool('opera_do', ToolCategory.OPERA)),
    );

    sinon.assert.calledOnce(resetContext);
  });
});

describe('streaming tool identity', () => {
  it('keeps NON_REPLAYABLE_TOOLS identical to OPERA_AI_TOOLS', () => {
    assert.strictEqual(NON_REPLAYABLE_TOOLS, OPERA_AI_TOOLS);
  });

  it('agrees on opera_call_mcp_tool membership and its timeout', () => {
    assert.strictEqual(isOperaAiTool('opera_call_mcp_tool'), true);
    assert.strictEqual(
      operaAiTimeoutMs('opera_call_mcp_tool'),
      OPERA_AI_TIMEOUT_MS,
    );
    assert.strictEqual(isOperaAiTool('take_snapshot'), false);
    assert.strictEqual(operaAiTimeoutMs('take_snapshot'), undefined);
  });
});
