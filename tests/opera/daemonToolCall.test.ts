/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * The daemon's `tools/call` policy: the timeout it grants a tool, and the
 * streaming token it puts on the request. Both are contracts with the other end
 * of the chain — a tool the daemon holds to a shorter timeout than the CLI is
 * killed while the CLI is still waiting, and a chunk whose token the daemon
 * never sent can never be routed to the socket that asked for it.
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {callDaemonTool} from '../../src/opera/daemonToolCall.js';
import {OPERA_AI_TIMEOUT_MS} from '../../src/opera/streamingTools.js';
import type {Client} from '../../src/third_party/index.js';

interface CapturedCall {
  params: {name: string; arguments: Record<string, unknown>};
  options: {timeout?: number} | undefined;
}

/** A `Client` that records the call the daemon makes through it. */
function capturingClient(result: unknown = {content: []}): {
  client: Client;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const stub = {
    callTool(
      params: CapturedCall['params'],
      _schema: unknown,
      options: unknown,
    ) {
      calls.push({
        params,
        options: options as CapturedCall['options'],
      });
      return Promise.resolve(result);
    },
  };
  return {client: stub as unknown as Client, calls};
}

describe('callDaemonTool', () => {
  it('gives an Opera AI tool the long timeout and carries its token', async () => {
    const result = {content: [{type: 'text', text: 'done'}]};
    const {client, calls} = capturingClient(result);

    assert.strictEqual(
      await callDaemonTool(client, {
        tool: 'opera_research',
        args: {prompt: 'latest hit'},
        streamToken: 'token-a',
      }),
      result,
    );

    assert.deepStrictEqual(calls, [
      {
        params: {
          name: 'opera_research',
          arguments: {prompt: 'latest hit'},
          _meta: {streamToken: 'token-a'},
        },
        options: {timeout: OPERA_AI_TIMEOUT_MS},
      },
    ]);
  });

  it('leaves any other tool on the SDK timeout, without metadata', async () => {
    const {client, calls} = capturingClient();

    await callDaemonTool(client, {tool: 'take_snapshot'});

    // No `_meta` key at all and no options: a request that neither streams nor
    // runs long is exactly the request the original protocol would have sent.
    assert.deepStrictEqual(calls, [
      {params: {name: 'take_snapshot', arguments: {}}, options: undefined},
    ]);
  });

  it('surfaces a failed tool call to the daemon', async () => {
    const failure = new Error('MCP error -32001: Request timed out');
    const {client} = capturingClient();
    client.callTool = () => Promise.reject(failure);

    await assert.rejects(
      callDaemonTool(client, {tool: 'opera_do', args: {prompt: 'go'}}),
      failure,
    );
  });
});
