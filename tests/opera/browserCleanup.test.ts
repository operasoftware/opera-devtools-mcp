/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {EventEmitter} from 'node:events';
import {describe, it} from 'node:test';

import {
  disarmBrowserOrphanCleanup,
  killBrowserProcessGroup,
  watchBrowserForOrphans,
} from '../../src/opera/browserCleanup.js';

type WatchedBrowser = Parameters<typeof watchBrowserForOrphans>[0];

/** A browser double with only the two things `watchBrowserForOrphans` touches. */
function fakeBrowser(pid: number) {
  const events = new EventEmitter();
  const browser = {
    process: () => ({pid}),
    once: events.once.bind(events),
  } as unknown as WatchedBrowser;
  return {events, browser};
}

/**
 * The group kill exists to reap the helpers of a browser that died on its own.
 * `disconnected` is not that: Puppeteer's `close()` ends with `disconnect()`, so
 * a deliberate shutdown fires it too — and answering it with a SIGKILL kills a
 * browser that is still flushing its profile, which is how an Opera AI profile
 * ends up with IndexedDB records whose files never landed.
 */
describe('browser orphan cleanup', {skip: process.platform === 'win32'}, () => {
  it('kills the process group when the browser disconnects on its own', t => {
    const kill = t.mock.method(process, 'kill', () => true);
    const {events, browser} = fakeBrowser(4242);
    watchBrowserForOrphans(browser);
    events.emit('disconnected');
    assert.deepStrictEqual(
      kill.mock.calls.map(call => call.arguments),
      [[-4242, 'SIGKILL']],
    );
  });

  it('leaves the browser alone when the close was ours', t => {
    const kill = t.mock.method(process, 'kill', () => true);
    const {events, browser} = fakeBrowser(4242);
    watchBrowserForOrphans(browser);
    disarmBrowserOrphanCleanup();
    events.emit('disconnected');
    assert.strictEqual(kill.mock.callCount(), 0);
  });

  it('re-arms for a browser launched after a deliberate close', t => {
    const kill = t.mock.method(process, 'kill', () => true);
    const first = fakeBrowser(111);
    watchBrowserForOrphans(first.browser);
    disarmBrowserOrphanCleanup();
    first.events.emit('disconnected');

    const second = fakeBrowser(222);
    watchBrowserForOrphans(second.browser);
    second.events.emit('disconnected');

    assert.deepStrictEqual(
      kill.mock.calls.map(call => call.arguments),
      [[-222, 'SIGKILL']],
    );
  });

  it('keeps the previous close’s disarm when the next browser is armed', t => {
    const kill = t.mock.method(process, 'kill', () => true);
    const first = fakeBrowser(111);
    watchBrowserForOrphans(first.browser);
    // We announced a deliberate close of the first browser, and its
    // `disconnected` has not arrived yet when the next launch arms its watcher.
    // That order is real: Puppeteer emits the event from its own close path, not
    // synchronously with ours. The late event is still answered by the first
    // watcher's own flag, so the close we asked for is not turned into a group
    // kill — which would reach the helpers still flushing that profile.
    disarmBrowserOrphanCleanup();
    const second = fakeBrowser(222);
    watchBrowserForOrphans(second.browser);

    first.events.emit('disconnected');
    assert.strictEqual(
      kill.mock.callCount(),
      0,
      'the deliberately closed browser’s group was killed anyway',
    );

    // And the new browser's teardown still fires when it dies on its own.
    second.events.emit('disconnected');
    assert.deepStrictEqual(
      kill.mock.calls.map(call => call.arguments),
      [[-222, 'SIGKILL']],
    );
  });
});

describe(
  'killBrowserProcessGroup',
  {skip: process.platform === 'win32'},
  () => {
    it('does nothing when the pid is missing or zero', t => {
      const kill = t.mock.method(process, 'kill', () => true);

      killBrowserProcessGroup(undefined);
      killBrowserProcessGroup(0);

      assert.strictEqual(kill.mock.callCount(), 0);
    });

    it('SIGKILLs the process group once for a real pid', t => {
      const kill = t.mock.method(process, 'kill', () => true);

      killBrowserProcessGroup(1234);

      assert.deepStrictEqual(
        kill.mock.calls.map(call => call.arguments),
        [[-1234, 'SIGKILL']],
      );
    });

    it('swallows ESRCH and EPERM from process.kill', t => {
      for (const errorCode of ['ESRCH', 'EPERM']) {
        const kill = t.mock.method(process, 'kill', () => {
          const error = new Error(errorCode) as NodeJS.ErrnoException;
          error.code = errorCode;
          throw error;
        });

        assert.doesNotThrow(() => killBrowserProcessGroup(1234));
        assert.strictEqual(kill.mock.callCount(), 1);
      }
    });
  },
);

describe('killBrowserProcessGroup on win32', () => {
  it('is a no-op without touching process.kill', t => {
    const kill = t.mock.method(process, 'kill', () => true);
    const beforePlatform = process.platform;

    withProcessPlatform('win32', () => {
      killBrowserProcessGroup(1234);
    });

    assert.strictEqual(kill.mock.callCount(), 0);
    assert.strictEqual(process.platform, beforePlatform);
  });
});

function withProcessPlatform(platform: NodeJS.Platform, fn: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  assert.ok(descriptor, 'process.platform is not configurable');
  Object.defineProperty(process, 'platform', {
    value: platform,
    writable: false,
    enumerable: true,
    configurable: true,
  });
  try {
    fn();
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
}
