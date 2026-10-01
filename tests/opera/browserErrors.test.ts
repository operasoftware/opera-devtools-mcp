/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {
  attachFailed,
  classifyBrowserFailure,
  isProfileInUseMessage,
  noDevToolsEndpoint,
  profileInUse,
} from '../../src/opera/browserErrors.js';

const DIR = '/tmp/opera-profile-123';

describe('profileInUse', () => {
  it('names the profile and both routes out of the conflict', () => {
    const message = profileInUse(DIR);

    assert.ok(message.includes(DIR), message);
    assert.ok(message.includes('--remote-debugging-port'), message);
    assert.ok(message.includes('--browser-url'), message);
    assert.ok(message.includes('--autoConnect'), message);
    assert.ok(message.includes('--isolated'), message);
  });
});

describe('isProfileInUseMessage', () => {
  it('recognises the launch failure, wrapped the way tools deliver it', () => {
    // `ToolHandler` appends the cause, so the match has to survive that.
    assert.strictEqual(
      isProfileInUseMessage(
        `${profileInUse(DIR)}\nCause: The browser is already running for ${DIR}.`,
      ),
      true,
    );
  });

  it('does not claim another failure', () => {
    assert.strictEqual(isProfileInUseMessage('Element uid not found'), false);
    assert.strictEqual(isProfileInUseMessage(noDevToolsEndpoint(DIR)), false);
    assert.strictEqual(isProfileInUseMessage(attachFailed({}, false)), false);
  });
});

describe('classifyBrowserFailure', () => {
  it('names the two failures the daemon cannot get out of by itself', () => {
    // `ToolHandler` appends the cause, so the match has to survive that.
    assert.strictEqual(
      classifyBrowserFailure(
        `${profileInUse(DIR)}\nCause: The browser is already running for ${DIR}.`,
      ),
      'profile-in-use',
    );
    assert.strictEqual(
      classifyBrowserFailure(attachFailed({browserURL: 'http://b'}, false)),
      'unreachable',
    );
    assert.strictEqual(
      classifyBrowserFailure(noDevToolsEndpoint(DIR)),
      'unreachable',
    );
  });

  it('claims no other failure', () => {
    assert.strictEqual(
      classifyBrowserFailure('Element uid not found'),
      undefined,
    );
    assert.strictEqual(classifyBrowserFailure(''), undefined);
  });
});

describe('noDevToolsEndpoint', () => {
  it('names the profile and points at remote debugging', () => {
    const message = noDevToolsEndpoint(DIR);

    assert.ok(message.includes(DIR), message);
    assert.ok(message.includes('no DevTools endpoint was found'), message);
    assert.ok(message.includes('chrome://inspect/#remote-debugging'), message);
  });
});

describe('attachFailed', () => {
  it('reports the first of browserURL, wsEndpoint, userDataDir', () => {
    assert.ok(
      attachFailed(
        {browserURL: 'http://b', wsEndpoint: 'ws://w', userDataDir: '/u'},
        false,
      ).includes('at http://b'),
    );
    assert.ok(
      attachFailed({wsEndpoint: 'ws://w', userDataDir: '/u'}, false).includes(
        'at ws://w',
      ),
    );
    assert.ok(attachFailed({userDataDir: '/u'}, false).includes('at /u'));
  });

  it('omits the target clause when there is no target at all', () => {
    const message = attachFailed({}, false);
    assert.ok(!message.includes(' at '), message);
    assert.ok(message.includes('Could not attach to the browser'), message);
  });

  it('adds the autoConnect hint only when autoConnect is set', () => {
    const withHint = attachFailed({browserURL: 'http://b'}, true);
    assert.ok(
      withHint.includes('(chrome://inspect/#remote-debugging)'),
      withHint,
    );

    const withoutHint = attachFailed({browserURL: 'http://b'}, false);
    assert.ok(
      !withoutHint.includes('(chrome://inspect/#remote-debugging)'),
      withoutHint,
    );
  });

  it('always tells the user the browser is not restarted for them', () => {
    assert.ok(
      attachFailed({browserURL: 'http://b'}, false).includes(
        'not restarted for you',
      ),
    );
  });
});
