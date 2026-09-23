/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {getPidFilePath} from '../../src/daemon/utils.js';
import {claimPidFile} from '../../src/opera/daemonPidFile.js';

let runtimeDir: string;
let savedRuntimeDir: string | undefined;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'opera-daemon-pidfile-'));
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

/** Write the session's pid file contents, creating the runtime dir as needed. */
function writePidFile(sessionId: string, contents: string): void {
  const pidFile = getPidFilePath(sessionId);
  fs.mkdirSync(dirname(pidFile), {recursive: true});
  fs.writeFileSync(pidFile, contents);
}

describe('claimPidFile', () => {
  it('creates a fresh 0o600 file and returns its descriptor', () => {
    const sessionId = crypto.randomUUID();
    fs.mkdirSync(dirname(getPidFilePath(sessionId)), {recursive: true});
    const fd = claimPidFile(sessionId);

    assert.strictEqual(typeof fd, 'number');
    const pidPath = getPidFilePath(sessionId);
    assert.ok(fs.existsSync(pidPath));
    if (process.platform !== 'win32') {
      assert.strictEqual(
        fs.statSync(pidPath).mode & 0o777,
        0o600,
        'the pid file must be owner-only',
      );
    }
    fs.closeSync(fd);
  });

  it('throws EEXIST when a live pid already owns the file', () => {
    const sessionId = crypto.randomUUID();
    writePidFile(sessionId, String(process.pid));

    assert.throws(
      () => claimPidFile(sessionId),
      (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
    );
  });

  it('reclaims a pid file left by a dead daemon', async () => {
    // A short-lived child whose pid is reliably dead once it has exited.
    const child = spawn(process.execPath, ['--version'], {stdio: 'ignore'});
    await once(child, 'exit');
    assert.ok(child.pid);
    const sessionId = crypto.randomUUID();
    writePidFile(sessionId, `${child.pid}\n`);

    const fd = claimPidFile(sessionId);

    assert.strictEqual(typeof fd, 'number');
    const pidPath = getPidFilePath(sessionId);
    assert.ok(fs.existsSync(pidPath));
    assert.notStrictEqual(
      fs.readFileSync(pidPath, 'utf-8'),
      `${child.pid}\n`,
      'the stale pid must not survive the reclaim',
    );
    fs.closeSync(fd);
  });

  it('throws EEXIST rather than reclaiming an unparseable pid file', () => {
    const sessionId = crypto.randomUUID();
    writePidFile(sessionId, 'not a pid');

    assert.throws(
      () => claimPidFile(sessionId),
      (error: NodeJS.ErrnoException) => error.code === 'EEXIST',
    );
  });

  it(
    'refuses to follow a symlink planted at the pid path',
    {skip: process.platform === 'win32'},
    () => {
      const sessionId = crypto.randomUUID();
      const pidPath = getPidFilePath(sessionId);
      fs.mkdirSync(dirname(pidPath), {recursive: true});
      const target = join(runtimeDir, 'victim.txt');
      fs.writeFileSync(target, 'untouched');
      fs.symlinkSync(target, pidPath);

      // `O_NOFOLLOW` refuses to open through the link; with `O_CREAT|O_EXCL` the
      // kernel reports the existing path as EEXIST (ELOOP on some platforms), so
      // the claim fails instead of silently taking ownership of a planted link.
      assert.throws(
        () => claimPidFile(sessionId),
        (error: NodeJS.ErrnoException) =>
          error.code === 'EEXIST' || error.code === 'ELOOP',
      );

      assert.strictEqual(
        fs.readFileSync(target, 'utf-8'),
        'untouched',
        'the symlink target must never be written through',
      );
      assert.ok(
        fs.lstatSync(pidPath).isSymbolicLink(),
        'the symlink itself must be left in place',
      );
    },
  );
});
