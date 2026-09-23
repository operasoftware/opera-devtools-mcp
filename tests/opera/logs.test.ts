/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';

import sinon from 'sinon';

import {getRuntimeHome} from '../../src/daemon/utils.js';
import {getDaemonLogPath} from '../../src/opera/daemonLog.js';
import {
  filterLogLines,
  handleLogs,
  parseLogsArgs,
} from '../../src/opera/logs.js';

describe('parseLogsArgs', () => {
  it('defaults to the last 50 lines, not following', () => {
    assert.deepStrictEqual(parseLogsArgs([]), {
      lines: 50,
      follow: false,
      errorsOnly: false,
    });
  });

  it('accepts both spellings of the line count', () => {
    assert.strictEqual(parseLogsArgs(['-n', '10']).lines, 10);
    assert.strictEqual(parseLogsArgs(['--lines', '10']).lines, 10);
  });

  it('accepts both spellings of follow and the errors filter', () => {
    assert.strictEqual(parseLogsArgs(['-f']).follow, true);
    assert.strictEqual(parseLogsArgs(['--follow']).follow, true);
    assert.strictEqual(parseLogsArgs(['--errors']).errorsOnly, true);
  });

  it('ignores a non-numeric or non-positive line count', () => {
    assert.strictEqual(parseLogsArgs(['--lines', 'lots']).lines, 50);
    assert.strictEqual(parseLogsArgs(['--lines', '0']).lines, 50);
    assert.strictEqual(parseLogsArgs(['--lines']).lines, 50);
  });
});

describe('filterLogLines', () => {
  const lines = [
    'Daemon server listening on /tmp/socket',
    'failed to launch the browser',
    'Socket error: ECONNREFUSED',
    'not a problem',
  ];

  it('passes everything through by default', () => {
    assert.deepStrictEqual(filterLogLines(lines, false), lines);
  });

  it('keeps only the lines worth looking at in errors mode', () => {
    assert.deepStrictEqual(filterLogLines(lines, true), [
      'failed to launch the browser',
      'Socket error: ECONNREFUSED',
    ]);
  });
});

describe('handleLogs', () => {
  let runtimeDir: string;
  let sessionId: string;
  let logFile: string;
  let savedRuntimeDir: string | undefined;

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'opera-logs-'));
    savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    sessionId = crypto.randomUUID();
    logFile = getDaemonLogPath(sessionId);
  });

  afterEach(() => {
    if (savedRuntimeDir === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = savedRuntimeDir;
    }
    rmSync(runtimeDir, {recursive: true, force: true});
  });

  function writeLog(contents: string): void {
    mkdirSync(getRuntimeHome(sessionId), {recursive: true});
    writeFileSync(logFile, contents);
  }

  it('says so when no log exists yet, and how to make one', async () => {
    const output = await handleLogs([], sessionId);

    assert.ok(output.includes('no log file yet'), output);
    assert.ok(output.includes(logFile), output);
    assert.ok(output.includes('opera-browser-cli start'), output);
  });

  it('takes the last lines of the log by default', async () => {
    writeLog('one\ntwo\nthree\n');

    const output = await handleLogs([], sessionId);

    assert.match(output, /^lines: 3$/m);
    assert.match(output, /^total: 3$/m);
    assert.ok(output.includes('one\ntwo\nthree'), output);
  });

  it('honours --lines without dropping the total', async () => {
    writeLog('one\ntwo\nthree\nfour\n');

    const output = await handleLogs(['--lines', '2'], sessionId);

    assert.match(output, /^lines: 2$/m);
    assert.match(output, /^total: 4$/m);
    assert.ok(output.includes('three\nfour'), output);
    assert.ok(!output.includes('one'), output);
  });

  it('filters to failure lines with --errors and reports both counts', async () => {
    writeLog('started\nfailed to launch\nlistening\n');

    const output = await handleLogs(['--errors'], sessionId);

    assert.match(output, /^lines: 1$/m);
    assert.match(output, /^total: 3$/m);
    assert.match(output, /^matched: 1$/m);
    assert.ok(output.includes('failed to launch'), output);
    assert.ok(!output.includes('started'), output);
  });

  it('suggests the flags that show more', async () => {
    writeLog('one\n');

    const output = await handleLogs([], sessionId);

    assert.ok(output.includes('opera-browser-cli logs --lines'), output);
    assert.ok(output.includes('opera-browser-cli logs --errors'), output);
    assert.ok(output.includes('opera-browser-cli logs --follow'), output);
  });
});

describe('handleLogs --follow', () => {
  let runtimeDir: string;
  let sessionId: string;
  let logFile: string;
  let savedRuntimeDir: string | undefined;

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'opera-logs-follow-'));
    savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    sessionId = crypto.randomUUID();
    logFile = getDaemonLogPath(sessionId);
  });

  afterEach(() => {
    sinon.restore();
    if (savedRuntimeDir === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = savedRuntimeDir;
    }
    rmSync(runtimeDir, {recursive: true, force: true});
  });

  // `followLog` polls the real platform clock on a fixed 500ms loop, and
  // sinon fake timers break `node:test`'s subtest scheduling, so the follower
  // is driven with generous real waits (bounded by the timeout) instead.
  async function waitFor(
    predicate: () => boolean,
    timeoutMs = 8000,
  ): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('timed out waiting for the followed log');
      }
      await delay(50);
    }
  }

  function seedLog(contents: string): void {
    mkdirSync(getRuntimeHome(sessionId), {recursive: true});
    writeFileSync(logFile, contents);
  }

  it('streams only appended lines, never the pre-existing content again', async () => {
    seedLog('first line\n');
    const writes: string[] = [];
    sinon.stub(process.stdout, 'write').callsFake((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const sigintBefore = process.listenerCount('SIGINT');

    const following = handleLogs(['-f'], sessionId);

    // The header dump carries the pre-existing line exactly once.
    await waitFor(() => writes.join('').includes('first line'));

    appendFileSync(logFile, 'second line\n');
    await waitFor(() => writes.join('').includes('second line'));

    process.emit('SIGINT');
    await following;

    // The follower's own write is only the appended line.
    assert.ok(
      writes.some(w => w === 'second line\n'),
      writes.join('|'),
    );
    assert.strictEqual(
      writes.join('').split('first line').length - 1,
      1,
      'pre-existing line must not be re-emitted by the follower',
    );
    assert.strictEqual(
      process.listenerCount('SIGINT'),
      sigintBefore,
      'the follower removed its SIGINT listener',
    );
  });

  it('re-reads a rotated (shrunk) file from the top', async () => {
    seedLog('this is a long first line that will be replaced\n');
    const writes: string[] = [];
    sinon.stub(process.stdout, 'write').callsFake((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    const following = handleLogs(['-f'], sessionId);
    await waitFor(() => writes.join('').includes('long first line'));

    // Rotation: the daemon replaces the file with smaller content.
    writeFileSync(logFile, 'small\n');
    await waitFor(() => writes.join('').includes('small\n'));

    process.emit('SIGINT');
    await following;

    assert.ok(
      writes.some(w => w === 'small\n'),
      `rotated content re-read from the top:\n${writes.join('|')}`,
    );
  });

  it('filters appended lines when following with --errors', async () => {
    seedLog('daemon started\n');
    const writes: string[] = [];
    sinon.stub(process.stdout, 'write').callsFake((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    const following = handleLogs(['-f', '--errors'], sessionId);
    // The header dump is one write; wait for it before appending.
    await waitFor(() => writes.length >= 1);

    appendFileSync(logFile, 'failed to connect\nall good\n');
    await waitFor(() => writes.join('').includes('failed to connect'));

    process.emit('SIGINT');
    await following;

    assert.ok(
      writes.some(w => w === 'failed to connect\n'),
      writes.join('|'),
    );
    assert.ok(
      !writes.join('').includes('all good'),
      `non-error appended line must be filtered:\n${writes.join('|')}`,
    );
  });
});
