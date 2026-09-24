/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {
  CdpError,
  EXIT_CODES,
  classifyToolError,
  describeToolFailure,
  exitCodeFor,
  wrapAiToolError,
} from '../../src/opera/cdpErrors.js';

describe('wrapAiToolError', () => {
  const NO_TARGET = 'dispatcher was not able to dispatch: no target';

  it('returns a non-dispatch error unchanged (identity)', () => {
    const original = new Error('the page closed mid-run');

    assert.strictEqual(wrapAiToolError('opera_do', original), original);
  });

  it('returns a non-dispatch non-Error unchanged (identity)', () => {
    assert.strictEqual(wrapAiToolError('opera_chat', 42), 42);
  });

  it('wraps a dispatch failure on a non-chat tool as an Opera Neon error', () => {
    const wrapped = wrapAiToolError('opera_do', new Error(NO_TARGET));

    assert.ok(wrapped instanceof CdpError);
    assert.strictEqual(wrapped.code, 'BROWSER_ERROR');
    assert.match(wrapped.message, /opera_do requires Opera Neon/);
    assert.match(wrapped.message, /does not support Opera AI/);
    assert.ok(wrapped.suggestions.some(s => s.includes('operaneon.com')));
  });

  it('wraps a dispatch failure on opera_chat as a plain Opera error', () => {
    const wrapped = wrapAiToolError(
      'opera_chat',
      new Error('no target to dispatch to'),
    );

    assert.ok(wrapped instanceof CdpError);
    assert.strictEqual(wrapped.code, 'BROWSER_ERROR');
    assert.match(wrapped.message, /opera_chat requires an Opera browser/);
    assert.doesNotMatch(wrapped.message, /requires Opera Neon/);
  });

  it('handles a non-Error dispatch failure via String(error)', () => {
    const wrapped = wrapAiToolError('opera_do', NO_TARGET);

    assert.ok(wrapped instanceof CdpError, 'a non-Error must still be wrapped');
    assert.strictEqual(wrapped.code, 'BROWSER_ERROR');
  });

  it('wraps a missing AI extension as EXTENSION_NOT_FOUND, not as a dispatch gap', () => {
    const wrapped = wrapAiToolError(
      'opera_chat',
      new Error(
        'Protocol error: Opera extension not available for this profile',
      ),
    );

    assert.ok(wrapped instanceof CdpError);
    assert.strictEqual(wrapped.code, 'EXTENSION_NOT_FOUND');
    assert.strictEqual(EXIT_CODES[wrapped.code], 3);
    assert.match(wrapped.message, /not available for this profile/);
  });
});

describe('classifyToolError', () => {
  it('maps the sign-in/subscription/consent group to AUTH_REQUIRED', () => {
    for (const message of [
      'Opera: user is not signed in',
      'Opera: an active subscription is required',
      'Opera: user consent has not been accepted',
      'result contained [OPERA_CDP_ERR:NOT_SIGNED_IN]',
    ]) {
      assert.strictEqual(classifyToolError(message), 'AUTH_REQUIRED', message);
    }
  });

  it('maps the dropped-connection group to SERVER_DISCONNECTED', () => {
    for (const message of [
      'connect ECONNREFUSED 127.0.0.1:9222',
      'read ECONNRESET',
      'write EPIPE',
      'socket hang up',
    ]) {
      assert.strictEqual(
        classifyToolError(message),
        'SERVER_DISCONNECTED',
        message,
      );
    }
  });

  it('classifies an unmatched message as UNKNOWN', () => {
    assert.strictEqual(
      classifyToolError('a failure the contract does not name'),
      'UNKNOWN',
    );
  });
});

describe('describeToolFailure', () => {
  it('rewrites an exhausted dispatch failure into the browser diagnosis', () => {
    const failure = describeToolFailure(
      'opera_do',
      'Opera.dispatchWithStreamedResponse(do) failed with error: Protocol error (Opera.dispatchWithStreamedResponse): The dispatcher was not able to dispatch: no target',
    );

    assert.strictEqual(failure.code, 'BROWSER_ERROR');
    assert.match(failure.message, /opera_do requires Opera Neon/);
    assert.ok(failure.suggestions.length > 0, 'the remedy must travel with it');
  });

  it('keeps a tool error message no descriptor knows, and codes it', () => {
    const message = 'Element uid "999_999" not found on page 1.';
    const failure = describeToolFailure('click', message);

    assert.strictEqual(failure.message, message);
    assert.strictEqual(failure.code, 'REF_NOT_FOUND');
    assert.strictEqual(EXIT_CODES[failure.code], 6);
    assert.ok(
      failure.suggestions.some(s => s.includes('take_snapshot')),
      'exit 6 names the page state as the thing that moved',
    );
  });

  it('prefers the descriptor when an error result carries a CDP key', () => {
    const failure = describeToolFailure(
      'opera_chat',
      'dispatch failed: [OPERA_CDP_ERR:NOT_SIGNED_IN]',
    );

    assert.strictEqual(failure.code, 'AUTH_REQUIRED');
    assert.strictEqual(failure.message, 'Opera: user is not signed in');
    assert.ok(failure.suggestions.some(s => s.includes('login')));
  });

  it('names a missing AI extension in the profile as EXTENSION_NOT_FOUND', () => {
    // Verbatim from `opera_do` on an Opera build without the AI extension: the
    // tool appends it to a successful result, so it used to exit 0.
    const failure = describeToolFailure(
      'opera_do',
      'Opera.dispatchWithStreamedResponse(do) failed with error: Protocol error (Opera.dispatchWithStreamedResponse): Opera extension not available for this profile',
    );

    assert.strictEqual(failure.code, 'EXTENSION_NOT_FOUND');
    assert.strictEqual(EXIT_CODES[failure.code], 3);
    assert.match(
      failure.message,
      /AI extension is not available for this profile/,
    );
    assert.ok(
      failure.suggestions.some(s => s.includes('operaneon.com')),
      'a Neon-only command must be told where Neon is',
    );
  });

  it('does not call a missing profile extension a Neon problem for chat', () => {
    const failure = describeToolFailure(
      'opera_chat',
      'Opera extension not available for this profile',
    );

    assert.strictEqual(failure.code, 'EXTENSION_NOT_FOUND');
    assert.doesNotMatch(failure.message, /Opera Neon/);
    assert.ok(!failure.suggestions.some(s => s.includes('operaneon.com')));
    assert.ok(failure.suggestions.some(s => s.includes('profile')));
  });

  it('leaves text nothing recognises as UNKNOWN with no invented remedy', () => {
    const failure = describeToolFailure('click', 'a failure it does not name');

    assert.strictEqual(failure.code, 'UNKNOWN');
    assert.deepStrictEqual(failure.suggestions, []);
  });
});

describe('exitCodeFor', () => {
  it('maps a CdpError code to its exit code', () => {
    assert.strictEqual(
      exitCodeFor(new CdpError('x', 'AUTH_REQUIRED')),
      EXIT_CODES.AUTH_REQUIRED,
    );
    assert.strictEqual(
      exitCodeFor(new CdpError('x', 'SERVER_DISCONNECTED')),
      EXIT_CODES.SERVER_DISCONNECTED,
    );
    assert.strictEqual(exitCodeFor(new CdpError('x', 'UNKNOWN')), 1);
  });

  it('returns the UNKNOWN exit code for a non-CdpError', () => {
    assert.strictEqual(exitCodeFor(new Error('plain failure')), 1);
    assert.strictEqual(exitCodeFor('just a string'), 1);
    assert.strictEqual(exitCodeFor(undefined), 1);
  });
});
