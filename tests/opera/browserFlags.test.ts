/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {parseArguments} from '../../src/config/mcp-options.js';
import {
  describeBrowserMode,
  isLaunchMode,
} from '../../src/opera/browserFlags.js';

describe('describeBrowserMode', () => {
  it('reports a launch when no attach option is on the command line', () => {
    assert.strictEqual(
      describeBrowserMode(['--headless', '--isolated']),
      'launched (owned by this daemon)',
    );
  });

  it('reads the attach target out of the camelCase form', () => {
    assert.strictEqual(
      describeBrowserMode(['--browserUrl=http://127.0.0.1:9222']),
      'attached to http://127.0.0.1:9222',
    );
  });

  it('reads the kebab-case form the CLI documents', () => {
    // `--help` lists `--browser-url` and `--auto-connect`, and the daemon stores
    // the argv verbatim: reporting either as "launched" would claim ownership of
    // a browser the daemon must never restart.
    assert.strictEqual(
      describeBrowserMode(['--browser-url=http://127.0.0.1:9222']),
      'attached to http://127.0.0.1:9222',
    );
    assert.strictEqual(
      describeBrowserMode(['--auto-connect']),
      'attached to an external browser',
    );
  });

  it('reads a value given as the next argument', () => {
    assert.strictEqual(
      describeBrowserMode(['--browserUrl', 'http://127.0.0.1:9222']),
      'attached to http://127.0.0.1:9222',
    );
    assert.strictEqual(
      describeBrowserMode([
        '--ws-endpoint',
        'ws://127.0.0.1:9222/devtools/browser/abc',
      ]),
      'attached to ws://127.0.0.1:9222/devtools/browser/abc',
    );
  });

  it('names no target for an attach flag that carries no value', () => {
    assert.strictEqual(
      describeBrowserMode(['--autoConnect']),
      'attached to an external browser',
    );
    assert.strictEqual(
      describeBrowserMode(['--ws-endpoint', '--headless']),
      'attached to an external browser',
    );
  });

  it('reads a negated attach flag as a launch, the way yargs parses it', () => {
    assert.strictEqual(
      describeBrowserMode(['--no-autoConnect']),
      'launched (owned by this daemon)',
    );
    assert.strictEqual(
      describeBrowserMode(['--autoConnect=false']),
      'launched (owned by this daemon)',
    );
  });

  it('agrees with the predicate the server itself applies', () => {
    const argv = (extra: string[]) =>
      parseArguments('1.0.0', ['node', 'script.js', ...extra], {
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
      });

    for (const extra of [
      ['--browser-url=http://127.0.0.1:9222'],
      ['--wsEndpoint', 'ws://127.0.0.1:9222/devtools/browser/abc'],
      ['--auto-connect'],
      ['--no-autoConnect'],
      ['--headless'],
    ]) {
      assert.strictEqual(
        describeBrowserMode(extra).startsWith('launched'),
        isLaunchMode(argv(extra)),
        `argv: ${extra.join(' ')}`,
      );
    }
  });
});
