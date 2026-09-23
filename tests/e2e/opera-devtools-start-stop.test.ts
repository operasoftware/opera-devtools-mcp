/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, it, afterEach, beforeEach} from 'node:test';

import {
  assertDaemonIsNotRunning,
  assertDaemonIsRunning,
  runCli,
} from '../utils.js';
import {CLI_BIN_NAME} from '../../src/opera/branding.js';

describe(CLI_BIN_NAME, () => {
  let sessionId: string;

  beforeEach(async () => {
    sessionId = crypto.randomUUID();
    await runCli(['stop'], sessionId);
    await assertDaemonIsNotRunning(sessionId);
  });

  afterEach(async () => {
    await runCli(['stop'], sessionId);
    await assertDaemonIsNotRunning(sessionId);
  });

  it('can start and stop the daemon', async () => {
    await assertDaemonIsNotRunning(sessionId);

    const startResult = await runCli(['start'], sessionId);
    assert.strictEqual(
      startResult.status,
      0,
      `start command failed: ${startResult.stderr}`,
    );

    await assertDaemonIsRunning(sessionId);

    const stopResult = await runCli(['stop'], sessionId);
    assert.strictEqual(
      stopResult.status,
      0,
      `stop command failed: ${stopResult.stderr}`,
    );

    await assertDaemonIsNotRunning(sessionId);
  });

  it('can start the daemon with userDataDir', async () => {
    const userDataDir = path.join(
      os.tmpdir(),
      `opera-devtools-test-${crypto.randomUUID()}`,
    );
    fs.mkdirSync(userDataDir, {recursive: true});

    const startResult = await runCli(
      ['start', '--userDataDir', userDataDir],
      sessionId,
    );
    assert.strictEqual(
      startResult.status,
      0,
      `start command failed: ${startResult.stderr}`,
    );
    assert.ok(
      !startResult.stderr.includes(
        'Arguments userDataDir and isolated are mutually exclusive',
      ),
      `unexpected conflict error: ${startResult.stderr}`,
    );

    await assertDaemonIsRunning(sessionId);
  });

  it('can start the daemon with a workspace', async () => {
    const workspace = fs.mkdtempSync(
      path.join(os.tmpdir(), 'chrome-devtools-workspace-'),
    );

    try {
      const startResult = await runCli(
        ['start', '--workspace', workspace],
        sessionId,
      );
      assert.strictEqual(
        startResult.status,
        0,
        `start command failed: ${startResult.stderr}`,
      );

      const statusResult = await runCli(['status'], sessionId);
      assert.strictEqual(statusResult.status, 0);
      assert.ok(
        statusResult.stdout.includes('--filesystem-root=') &&
          statusResult.stdout.includes(path.basename(workspace)),
        `workspace was not forwarded: ${statusResult.stdout}`,
      );
    } finally {
      fs.rmSync(workspace, {recursive: true, force: true});
    }
  });

  it('lets configured OPERA_CLI_* browser options beat the start defaults', async () => {
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'opera-devtools-config-profile-'),
    );
    const configured = {
      OPERA_CLI_HEADED: '1',
      OPERA_CLI_USER_DATA_DIR: userDataDir,
    };

    try {
      const startResult = await runCli(['start'], sessionId, configured);
      assert.strictEqual(
        startResult.status,
        0,
        `start command failed: ${startResult.stderr}`,
      );

      const statusResult = await runCli(['status'], sessionId, configured);
      assert.strictEqual(statusResult.status, 0);
      // These are the args the daemon hands the MCP server, which turns the
      // missing headless flag into `--headless=false` from the same config. A
      // serialized `--headless`/`--isolated` here is the CLI's own start
      // default overriding the config before the MCP server can read it.
      assert.ok(
        statusResult.stdout.includes(`--user-data-dir=${userDataDir}`) &&
          !statusResult.stdout.includes('--isolated') &&
          !statusResult.stdout.includes('--headless'),
        `configured browser options were not honoured: ${statusResult.stdout}`,
      );

      // The other direction: an explicit "no window" config still reaches it.
      await runCli(['stop'], sessionId);
      const headlessEnv = {OPERA_CLI_HEADED: '0'};
      const headlessStart = await runCli(['start'], sessionId, headlessEnv);
      assert.strictEqual(
        headlessStart.status,
        0,
        `start command failed: ${headlessStart.stderr}`,
      );
      const headlessStatus = await runCli(['status'], sessionId, headlessEnv);
      assert.ok(
        headlessStatus.stdout.includes('--headless'),
        `OPERA_CLI_HEADED=0 was not honoured: ${headlessStatus.stdout}`,
      );
    } finally {
      fs.rmSync(userDataDir, {recursive: true, force: true});
    }
  });
});
