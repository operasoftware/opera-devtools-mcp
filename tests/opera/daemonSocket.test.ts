/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import type {DaemonMessage} from '../../src/daemon/types.js';
import {answerSocketMessage} from '../../src/opera/daemonSocket.js';

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
