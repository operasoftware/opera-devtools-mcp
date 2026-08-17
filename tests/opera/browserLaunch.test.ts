/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import type {parseArguments} from '../../src/bin/chrome-devtools-mcp-cli-options.js';
import {buildLaunchOptions} from '../../src/opera/browserLaunch.js';

type ServerArgs = ReturnType<typeof parseArguments>;

/**
 * The launch options in `src/opera/browserLaunch.ts` are the single source of
 * truth for `ensureBrowserLaunched`, used by both the normal launch in
 * `src/index.ts` and the Opera browser relaunch in `browserFlags.ts`. These
 * tests lock down the parts that used to diverge: network-request filters
 * (blocklist/allowlist), proxy handling and extra Chromium args. If they
 * regress here, the relaunch path silently launches a browser with different
 * behaviour than the normal path.
 */
describe('buildLaunchOptions', () => {
  const args = (overrides: Partial<ServerArgs> = {}): ServerArgs =>
    ({
      headless: false,
      channel: 'stable',
      acceptInsecureCerts: false,
      viaCli: false,
      ...overrides,
    }) as unknown as ServerArgs;

  it('derives blocklist/allowlist from server args', () => {
    const options = buildLaunchOptions(
      args({
        blockedUrlPattern: ['*://example.com/*'],
        allowedUrlPattern: ['*://trusted.dev/*'],
      }),
    );
    assert.deepStrictEqual(options.blocklist, ['*://example.com/*']);
    assert.deepStrictEqual(options.allowlist, ['*://trusted.dev/*']);
  });

  it('an explicit blocklist/allowlist override wins over the server-arg default', () => {
    const options = buildLaunchOptions(
      args({blockedUrlPattern: ['*://a/*']}),
      undefined,
      {
        blocklist: ['*://override/*'],
      },
    );
    assert.deepStrictEqual(options.blocklist, ['*://override/*']);
  });

  it('prepends extra Chrome args and appends the proxy flag', () => {
    const options = buildLaunchOptions(
      args({
        chromeArg: ['--foo'],
        proxyServer: 'http://proxy:8080',
      }),
      undefined,
      {extraChromeArgs: ['--disable-blink-features=AutomationControlled']},
    );
    assert.deepStrictEqual(options.chromeArgs, [
      '--disable-blink-features=AutomationControlled',
      '--foo',
      '--proxy-server=http://proxy:8080',
    ]);
  });

  it('always returns the fields ensureBrowserLaunched requires, mapped from server args', () => {
    const options = buildLaunchOptions(
      args({
        headless: true,
        isolated: true,
        experimentalDevtools: true,
        categoryExtensions: true,
      }),
    );
    // Required fields of `McpLaunchOptions` must always be present so the
    // normal and relaunch paths behave identically.
    assert.equal(options.headless, true);
    assert.equal(options.isolated, true);
    assert.equal(options.devtools, true);
    assert.equal(options.enableExtensions, true);
    assert.deepStrictEqual(options.blocklist, undefined);
    assert.deepStrictEqual(options.allowlist, undefined);
  });

  it('an explicit devtools override wins over the server-arg default', () => {
    const options = buildLaunchOptions(
      args({experimentalDevtools: false}),
      undefined,
      {
        devtools: true,
      },
    );
    assert.equal(options.devtools, true);
  });
});
