/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {CLI_BIN_NAME} from '../../src/opera/branding.js';
import {runCli} from '../utils.js';

/**
 * The CLI has to settle a profile that is already open before it starts the
 * daemon, because the daemon is detached with no terminal to ask in — and the
 * answer it gives a caller without a terminal (which is how agents run it) has
 * to be visible in the output, not silent.
 */
describe(`${CLI_BIN_NAME} against an already-open profile`, () => {
  let sessionId: string;
  let profileDir: string;

  beforeEach(() => {
    sessionId = crypto.randomUUID();
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opera-cli-locked-'));
  });

  afterEach(async () => {
    await runCli(['stop'], sessionId);
    fs.rmSync(profileDir, {recursive: true, force: true});
  });

  it(
    'falls back to a separate profile, and says which one',
    {skip: process.platform === 'win32'},
    async () => {
      // A lock naming this test process: alive, on this machine, and not a
      // browser the CLI may signal. `runCli` gives the child no terminal, so
      // the fallback is the answer under test.
      fs.symlinkSync(
        `${os.hostname()}-${process.pid}`,
        path.join(profileDir, 'SingletonLock'),
      );

      const result = await runCli(
        ['new_page', 'https://example.com'],
        sessionId,
        {OPERA_CLI_USER_DATA_DIR: profileDir},
      );

      assert.match(
        result.stderr,
        /note: Opera is running on the configured profile; using .*\.opera-browser-cli[/\\]profile for this run\./,
      );
      // The user has to be told why they are not signed in, and what to do
      // about it, without having to read the source.
      assert.match(
        result.stderr,
        /with a debugging port \(--remote-debugging-port=0\)/,
      );
    },
  );

  it(
    'leaves a profile that nothing holds alone',
    {skip: process.platform === 'win32'},
    async () => {
      const result = await runCli(
        ['new_page', 'https://example.com'],
        sessionId,
        {OPERA_CLI_USER_DATA_DIR: profileDir},
      );

      assert.doesNotMatch(result.stderr, /using .* for this run/);
    },
  );
});
