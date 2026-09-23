/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {spawn} from 'node:child_process';
import {EventEmitter, once} from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {mkdtempSync, rmSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {getPidFilePath, getRuntimeHome} from '../../src/daemon/utils.js';
import {
  ensureCleanStart,
  readExitReason,
  writeExitReason,
} from '../../src/opera/daemonLifecycle.js';

let runtimeDir: string;
let savedRuntimeDir: string | undefined;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'opera-daemon-lifecycle-'));
  savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
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

/** Write the session's pid file contents, creating the runtime dir as needed. */
function writePidFile(sessionId: string, contents: string): void {
  const pidFile = getPidFilePath(sessionId);
  fs.mkdirSync(dirname(pidFile), {recursive: true});
  fs.writeFileSync(pidFile, contents);
}

/** Just enough of a `net.Socket` for `probeSocket`'s `PipeTransport`. */
interface FakeSocket extends EventEmitter {
  write(chunk: string): boolean;
  destroy(): void;
}

/**
 * Replace the socket with an in-process fake that acts as a live daemon the pid
 * file does not mention: the `status` probe is answered with a reply naming
 * `hiddenPid`, and the follow-up `stop` probe is sent but never answered (a
 * wedged daemon that will not go). Both probes connect, so the `stop` is really
 * put on the wire before its reply times out.
 */
function fakeHiddenDaemon(hiddenPid: number): {requests: string[]} {
  const requests: string[] = [];
  sinon.stub(net, 'createConnection').callsFake(() => {
    const socket = new EventEmitter() as FakeSocket;
    let pending = '';
    socket.write = (chunk: string) => {
      pending += chunk;
      let end = pending.indexOf('\0');
      while (end !== -1) {
        const request = JSON.parse(pending.slice(0, end)) as {method: string};
        requests.push(request.method);
        pending = pending.slice(end + 1);
        end = pending.indexOf('\0');
        if (request.method === 'status') {
          const frame = JSON.stringify({
            success: true,
            result: JSON.stringify({pid: hiddenPid}),
            error: null,
          });
          queueMicrotask(() => socket.emit('data', Buffer.from(frame + '\0')));
        }
        // `stop` is deliberately never answered, so its reply times out.
      }
      return true;
    };
    socket.destroy = () => socket.emit('close');
    // `probeSocket` attaches its handlers after `createConnection` returns, so
    // connect on the next turn.
    setImmediate(() => socket.emit('connect'));
    return socket as unknown as net.Socket;
  });
  return {requests};
}

describe('ensureCleanStart', () => {
  it('tells the caller to fork when no pid file exists', async () => {
    const sessionId = crypto.randomUUID();

    assert.strictEqual(await ensureCleanStart(sessionId), false);
  });

  it('reaps a dead daemon, reports a fork is needed and leaves the pid file', async () => {
    const child = spawn(process.execPath, ['--version'], {stdio: 'ignore'});
    await once(child, 'exit');
    assert.ok(child.pid);
    const sessionId = crypto.randomUUID();
    writePidFile(sessionId, `${child.pid}\n`);

    assert.strictEqual(await ensureCleanStart(sessionId), false);
    assert.ok(
      fs.existsSync(getPidFilePath(sessionId)),
      "file cleanup is the daemon's own O_EXCL claim, not the probe",
    );
  });

  it('treats an unparseable pid file like a missing daemon', async () => {
    const sessionId = crypto.randomUUID();
    writePidFile(sessionId, 'garbage');

    assert.strictEqual(await ensureCleanStart(sessionId), false);
  });

  it(
    'returns immediately for a live daemon pid without probing a dead socket',
    {skip: process.platform === 'win32'},
    async () => {
      // A live, unrelated process (not this test runner): the pid file names it,
      // and `isProcessAlive` short-circuits before any socket probe could hang.
      // The `setTimeout` runs inside the spawned child only to keep it alive for
      // the duration of this test — it does not pace the test, which awaits the
      // `ensureCleanStart` promise and then kills the child.
      const child = spawn(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 30000)'],
        {
          stdio: 'ignore',
        },
      );
      const sessionId = crypto.randomUUID();
      writePidFile(sessionId, String(child.pid));

      const started = Date.now();
      assert.strictEqual(await ensureCleanStart(sessionId), true);
      assert.ok(
        Date.now() - started < 3_000,
        'a live pid must short-circuit, not wait out the socket probe',
      );

      child.kill('SIGKILL');
      await once(child, 'exit');
    },
  );

  it(
    'stops a hidden daemon found through the socket, killing its group when it ignores stop',
    {skip: process.platform === 'win32', timeout: 30_000},
    async () => {
      const sessionId = crypto.randomUUID();
      // A live process in its own session/group (`detached`) that `ensureCleanStart`
      // cannot see through the pid file: the socket probe is the only way to find
      // it, and the `SIGKILL`-to-group is the only way to reap it once it ignores
      // the `stop` — which is exactly why a real (detached) child is used here.
      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        {
          stdio: 'ignore',
          detached: true,
        },
      );
      child.unref();
      assert.ok(child.pid, 'the detached child must have a pid');
      const exited = once(child, 'exit');
      const {requests} = fakeHiddenDaemon(child.pid);

      try {
        const started = Date.now();
        const result = await ensureCleanStart(sessionId);
        const elapsed = Date.now() - started;

        assert.deepStrictEqual(requests, ['status', 'stop']);
        assert.strictEqual(result, false);
        // The ignored stop had to be answered with a group kill: the hidden
        // daemon is observably gone.
        await exited;
        assert.ok(elapsed < 25_000, 'ensureCleanStart must settle, not hang');
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      }
    },
  );
});

describe('exit reason', () => {
  it('round-trips a written reason', () => {
    const sessionId = crypto.randomUUID();
    fs.mkdirSync(getRuntimeHome(sessionId), {recursive: true});

    writeExitReason(sessionId, 'terminated by signal: SIGTERM');

    assert.strictEqual(
      readExitReason(sessionId),
      'terminated by signal: SIGTERM',
    );
  });

  it('reads null when no reason was ever written', () => {
    const sessionId = crypto.randomUUID();

    assert.strictEqual(readExitReason(sessionId), null);
  });

  it('is cleared by a clean start', async () => {
    const sessionId = crypto.randomUUID();
    fs.mkdirSync(getRuntimeHome(sessionId), {recursive: true});
    writeExitReason(sessionId, 'a previous daemon fell over');

    await ensureCleanStart(sessionId);

    assert.strictEqual(
      readExitReason(sessionId),
      null,
      'a clean start is the only place the reason is dropped',
    );
  });
});
