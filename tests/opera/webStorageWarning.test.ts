/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Every entry point loads `third_party/index.ts`, whose bundled `debug` reads
 * the `localStorage` global. Under Node that read is a lazy accessor, so without
 * `--localstorage-file` it printed
 *
 *   ExperimentalWarning: localStorage is not available because
 *   --localstorage-file was not provided.
 *
 * on stderr ahead of the command's own output, which made every run look like it
 * had a problem. `opera/webStorageWarning.ts` takes the read away, in the
 * process itself and — through the `NODE_OPTIONS` preload the CLI propagates —
 * in the daemon and in the update check it spawns. These cases hold that in
 * place.
 */

import assert from 'node:assert';
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

import sinon from 'sinon';

import {preloadWebStorageWarningGuardInChildren} from '../../src/opera/webStorageWarning.js';
import {createCliEnv} from '../utils.js';

const CLI_PATH = path.resolve('build/src/bin/opera-browser-cli.js');
const MCP_PATH = path.resolve('build/src/bin/opera-devtools-mcp.js');
const GUARD_PATH = fileURLToPath(
  new URL('../../src/opera/webStorageWarning.js', import.meta.url),
);
const THIRD_PARTY_URL = pathToFileURL(
  path.resolve('build/src/third_party/index.js'),
).href;

const WARNING = 'ExperimentalWarning';

/**
 * Run a Node command the way the suite runs everything else, minus the
 * environment variable that would decide the answer for us: a `NODE_OPTIONS`
 * carrying the suite's own `--no-warnings` (execArgv is not inherited) would
 * silence the warning this file asserts on.
 *
 * `OPERA_DEVTOOLS_NO_UPDATE_CHECKS` is deliberately left alone. The CLI only
 * reads the global once its update check gets as far as spawning, and that
 * check is detached with `stdio: 'ignore'`, so leaving it running costs the
 * child nothing and keeps this file's CLI case honest.
 */
async function run(
  args: string[],
  options: {input?: string; env?: NodeJS.ProcessEnv} = {},
): Promise<{status: number | null; stdout: string; stderr: string}> {
  const env = options.env ?? {...(await createCliEnv())};
  if (options.env === undefined) {
    delete env.NODE_OPTIONS;
  }

  const child = spawn(process.execPath, args, {env});
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => (stdout += chunk));
  child.stderr.on('data', chunk => (stderr += chunk));
  child.stdin.end(options.input ?? '');
  const status = await new Promise<number | null>(resolve => {
    child.on('close', resolve);
  });
  return {status, stdout, stderr};
}

/** The warning needs Node's lazy `localStorage` global to exist at all. */
const webStorageIsWired = await (async () => {
  const probe = await run([
    '-e',
    'console.log(typeof Object.getOwnPropertyDescriptor(globalThis, "localStorage")?.get);',
  ]);
  return probe.stdout.trim() === 'function';
})();

describe('Node Web Storage warning', () => {
  it('stays off a CLI command', async () => {
    const result = await run([
      CLI_PATH,
      'status',
      '--sessionId',
      crypto.randomUUID(),
    ]);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(!result.stderr.includes(WARNING), result.stderr);
  });

  it('stays off the MCP server', async () => {
    const result = await run([MCP_PATH, '--headless', '--isolated']);
    assert.ok(!result.stderr.includes(WARNING), result.stderr);
  });

  it('stays off a Node child that inherits the CLI guard preload', async () => {
    const saved = process.env.NODE_OPTIONS;
    try {
      delete process.env.NODE_OPTIONS;
      preloadWebStorageWarningGuardInChildren();
      // The daemon's shape: a process that loads `third_party` and reads the
      // global, with nothing of ours able to run before its own imports.
      const result = await run(
        [
          '--input-type=module',
          '-e',
          `import ${JSON.stringify(THIRD_PARTY_URL)}; console.log('loaded');`,
        ],
        {env: process.env},
      );
      assert.ok(!result.stderr.includes(WARNING), result.stderr);
    } finally {
      if (saved === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = saved;
      }
    }
  });

  it('leaves a configured Web Storage alone', async t => {
    if (!webStorageIsWired) {
      t.skip('no localStorage global on this Node');
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webstorage-warning-'));
    try {
      const result = await run([
        `--localstorage-file=${path.join(dir, 'storage')}`,
        // The file URL, not the path: the ESM loader takes a file path on
        // POSIX but rejects a Windows path as an unsupported scheme, which
        // would kill the child before it printed anything. The preload
        // `preloadWebStorageWarningGuardInChildren` hands out is a URL for the
        // same reason.
        `--import=${pathToFileURL(GUARD_PATH).href}`,
        '-e',
        'console.log(typeof globalThis.localStorage);',
      ]);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(result.stdout.trim(), 'object');
      assert.ok(!result.stderr.includes(WARNING), result.stderr);
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});

describe('preloadWebStorageWarningGuardInChildren', () => {
  const option = `--import=${pathToFileURL(GUARD_PATH).href}`;

  let savedNodeOptions: string | undefined;

  beforeEach(() => {
    savedNodeOptions = process.env.NODE_OPTIONS;
  });

  afterEach(() => {
    sinon.restore();
    if (savedNodeOptions === undefined) {
      delete process.env.NODE_OPTIONS;
    } else {
      process.env.NODE_OPTIONS = savedNodeOptions;
    }
  });

  it('sets the preload option when NODE_OPTIONS is unset', () => {
    delete process.env.NODE_OPTIONS;

    preloadWebStorageWarningGuardInChildren();

    assert.strictEqual(process.env.NODE_OPTIONS, option);
  });

  it('appends the option to an existing NODE_OPTIONS, preserving it', () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';

    preloadWebStorageWarningGuardInChildren();

    // The user's flags stay intact; the preload is added after them, never
    // replacing them.
    assert.strictEqual(
      process.env.NODE_OPTIONS,
      `--max-old-space-size=4096 ${option}`,
    );
  });

  it('is idempotent: calling again does not duplicate the option', () => {
    delete process.env.NODE_OPTIONS;

    preloadWebStorageWarningGuardInChildren();
    preloadWebStorageWarningGuardInChildren();

    assert.strictEqual(
      process.env.NODE_OPTIONS!.split(/\s+/).filter(token => token === option)
        .length,
      1,
    );
  });
});
