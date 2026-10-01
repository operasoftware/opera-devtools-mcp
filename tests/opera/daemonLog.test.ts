/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import type {ChildProcess} from 'node:child_process';

import {getRuntimeHome} from '../../src/daemon/utils.js';
import {
  readExitReason,
  writeExitReason,
} from '../../src/opera/daemonLifecycle.js';
import {
  daemonExitMessage,
  getDaemonLogPath,
  getPreviousDaemonLogPath,
  nameSpawnFailure,
  openDaemonLog,
} from '../../src/opera/daemonLog.js';

let runtimeDir: string;
let savedRuntimeDir: string | undefined;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'opera-daemon-log-'));
  savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
});

afterEach(() => {
  if (savedRuntimeDir === undefined) {
    delete process.env.XDG_RUNTIME_DIR;
  } else {
    process.env.XDG_RUNTIME_DIR = savedRuntimeDir;
  }
  rmSync(runtimeDir, {recursive: true, force: true});
});

describe('log paths', () => {
  it('derives the log and previous-log paths from the runtime home', () => {
    const sessionId = crypto.randomUUID();

    assert.strictEqual(
      getDaemonLogPath(sessionId),
      join(getRuntimeHome(sessionId), 'daemon.log'),
    );
    assert.strictEqual(
      getPreviousDaemonLogPath(sessionId),
      `${getDaemonLogPath(sessionId)}.prev`,
    );
  });
});

describe('openDaemonLog', () => {
  it('creates the runtime dir and opens a fresh 0o600 log in a 0o700 dir', () => {
    const sessionId = crypto.randomUUID();
    const fd = openDaemonLog(sessionId);

    assert.strictEqual(typeof fd, 'number');
    fs.closeSync(fd as number);
    const logPath = getDaemonLogPath(sessionId);
    assert.ok(fs.existsSync(logPath));
    if (process.platform !== 'win32') {
      assert.strictEqual(
        fs.statSync(getRuntimeHome(sessionId)).mode & 0o777,
        0o700,
      );
      assert.strictEqual(fs.statSync(logPath).mode & 0o777, 0o600);
    }
  });

  it('rotates a pre-existing log to .prev, preserving its content', () => {
    const sessionId = crypto.randomUUID();
    const logPath = getDaemonLogPath(sessionId);
    fs.mkdirSync(getRuntimeHome(sessionId), {recursive: true});
    fs.writeFileSync(logPath, 'previous daemon output\n');

    const fd = openDaemonLog(sessionId);
    fs.closeSync(fd as number);

    assert.strictEqual(
      fs.readFileSync(getPreviousDaemonLogPath(sessionId), 'utf-8'),
      'previous daemon output\n',
    );
    assert.strictEqual(fs.readFileSync(logPath, 'utf-8'), '');
  });

  it(
    'never writes through a symlink planted at the log path',
    {skip: process.platform === 'win32'},
    () => {
      const sessionId = crypto.randomUUID();
      const logPath = getDaemonLogPath(sessionId);
      fs.mkdirSync(getRuntimeHome(sessionId), {recursive: true});
      const target = join(runtimeDir, 'victim.txt');
      fs.writeFileSync(target, 'untouched');
      fs.symlinkSync(target, logPath);

      const fd = openDaemonLog(sessionId);
      assert.strictEqual(typeof fd, 'number');
      fs.closeSync(fd as number);

      assert.strictEqual(
        fs.readFileSync(target, 'utf-8'),
        'untouched',
        'the symlink target must never be written through',
      );
      // The one-generation rotation moves the planted symlink away rather than
      // following it; the freshly claimed log is a plain file.
      assert.ok(!fs.lstatSync(logPath).isSymbolicLink());
      assert.ok(
        fs.lstatSync(getPreviousDaemonLogPath(sessionId)).isSymbolicLink(),
      );
    },
  );

  it('degrades to a warning and ignore stdio when the runtime dir is blocked', () => {
    const sessionId = crypto.randomUUID();
    // A plain file standing where the runtime dir must be created.
    fs.writeFileSync(getRuntimeHome(sessionId), 'in the way');

    assert.strictEqual(openDaemonLog(sessionId), 'ignore');
  });
});

describe('daemonExitMessage', () => {
  it('names the reason a daemon left behind', () => {
    const sessionId = crypto.randomUUID();
    fs.mkdirSync(getRuntimeHome(sessionId), {recursive: true});
    writeExitReason(sessionId, 'terminated by signal: SIGKILL');

    assert.strictEqual(
      daemonExitMessage(sessionId),
      'Daemon exited while running the command: terminated by signal: SIGKILL',
    );
  });

  it('names both log paths when no reason was left', () => {
    const sessionId = crypto.randomUUID();
    const message = daemonExitMessage(sessionId);

    assert.match(message, /left no reason behind/);
    assert.ok(message.includes(getDaemonLogPath(sessionId)));
    assert.ok(message.includes(getPreviousDaemonLogPath(sessionId)));
    assert.strictEqual(
      readExitReason(sessionId),
      null,
      'no reason may be written',
    );
  });
});

describe('nameSpawnFailure', () => {
  it('rejects on the error event, naming the log path and carrying the cause', async () => {
    const sessionId = crypto.randomUUID();
    const child = new EventEmitter() as unknown as ChildProcess;
    const source = new Error('cannot exec node');

    const pending = nameSpawnFailure(child, sessionId);
    // A spawn that never fails never resolves this; it must not reject before
    // the `error` event actually fires.
    let rejectedEarly = false;
    void pending.catch(() => {
      rejectedEarly = true;
    });
    const tick = Promise.withResolvers<void>();
    setImmediate(tick.resolve);
    await tick.promise;
    assert.strictEqual(
      rejectedEarly,
      false,
      'must not reject before the error event',
    );

    child.emit('error', source);

    await assert.rejects(pending, (error: Error) => {
      assert.strictEqual(
        error.message,
        `Failed to start the daemon: cannot exec node. Its log is at ${getDaemonLogPath(sessionId)}.`,
      );
      assert.strictEqual(error.cause, source);
      return true;
    });
  });
});
