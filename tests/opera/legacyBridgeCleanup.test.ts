/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {
  getLegacyPidFilePath,
  legacyCandidatePorts,
  probeAndStopLegacyBridges,
  runLegacyMigrationGuard,
  stopLegacyBridge,
} from '../../src/opera/legacyBridgeCleanup.js';
import {isProcessAlive} from '../../src/opera/migrationShared.js';

/** A fixed boot, so the boot-stamp comparison is not a function of wall time. */
const FAKE_UPTIME_SECONDS = 3_600;
const bootMinuteNow = () =>
  Math.floor((Date.now() - FAKE_UPTIME_SECONDS * 1000) / 60_000);

/** A port window nothing else uses, so a sweep never touches a real bridge. */
const GUARD_PORT_BASE = 9460;

let home: string;
let uptime: sinon.SinonStub;
const started: number[] = [];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'opera-legacy-bridge-'));
  uptime = sinon.stub(os, 'uptime').returns(FAKE_UPTIME_SECONDS);
});

afterEach(() => {
  sinon.restore();
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  fs.rmSync(home, {recursive: true, force: true});
});

/** Set an environment variable for the duration of one test. */
function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) {
    savedEnv[key] = process.env[key];
  }
  process.env[key] = value;
}

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
    delete savedEnv[key];
  }
});

/** A process kept alive by a listening socket; the test awaits its readiness. */
async function spawnIdleProcess(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      "require('node:net').createServer().listen(0, '127.0.0.1', () => console.log('up'))",
    ],
    {stdio: ['ignore', 'pipe', 'ignore']},
  );
  started.push(child.pid!);
  await once(child.stdout!, 'data');
  return child;
}

/**
 * A stand-in for the legacy bridge: answers `/health` with the old package's
 * identity payload, on `port` (0 = let the OS choose) and reports the port it
 * bound on stdout.
 *
 * `stubborn` installs the SIGTERM handler the real bridge does not need — it
 * forces the killer past its grace period and into the SIGKILL branch — and
 * spawns a child, which stands in for the browser and the stdio MCP child the
 * real bridge holds. Both share the bridge's process group, because that is how
 * the real one is spawned (`detached: true`).
 */
async function spawnHealthBridge(
  port = 0,
  options: {stubborn?: boolean} = {},
): Promise<{child: ChildProcess; port: number; grandchild?: number}> {
  const child = spawn(
    process.execPath,
    [
      '-e',
      [
        "const {spawn} = require('node:child_process');",
        "const http = require('node:http');",
        options.stubborn
          ? 'const grandchild = spawn(process.execPath, ["-e", "require(\'node:net\').createServer().listen(0)"], {stdio: \'ignore\'});'
          : 'const grandchild = null;',
        options.stubborn ? "process.on('SIGTERM', () => {});" : '',
        'const server = http.createServer((_req, res) => {',
        "  res.writeHead(200, {'content-type': 'application/json'});",
        '  res.end(JSON.stringify({',
        "    status: 'ok', server: 'opera-browser-cli', version: '0.1.53',",
        '    pid: process.pid, startedAt: Date.now(), bootMinute: 0,',
        '    browser: {connected: true}, headed: false,',
        '  }));',
        '});',
        `server.listen(${port}, '127.0.0.1', () =>`,
        '  console.log(JSON.stringify({',
        '    port: server.address().port,',
        '    grandchild: grandchild && grandchild.pid,',
        '  })));',
      ].join('\n'),
    ],
    {stdio: ['ignore', 'pipe', 'ignore'], detached: true},
  );
  started.push(child.pid!);
  const [chunk] = await once(child.stdout!, 'data');
  const bound = JSON.parse(String(chunk)) as {
    port: number;
    grandchild?: number;
  };
  if (bound.grandchild !== undefined) {
    started.push(bound.grandchild);
  }
  // Deliberately not `unref()`d. Every caller waits on `once(child, 'exit')`,
  // and an unref'd process handle does not keep the loop alive until that event
  // is delivered: once the child's stdout pipe has closed with the child, the
  // loop is empty, `beforeExit` fires, and node:test cancels the test with
  // "Promise resolution is still pending but the event loop has already
  // resolved" — observed on Windows, where the exit notification does not
  // arrive before the pipe does. The `afterEach` above SIGKILLs every pid this
  // file spawns, so a ref'd handle cannot outlive the test that made it.
  return {...bound, child};
}

function writeLegacyPidFile(info: Record<string, unknown>): void {
  const pidFile = getLegacyPidFilePath(home);
  fs.mkdirSync(join(home, '.opera-browser-cli'), {recursive: true});
  fs.writeFileSync(pidFile, JSON.stringify(info));
}

const pidFileExists = () => fs.existsSync(getLegacyPidFilePath(home));

describe('getLegacyPidFilePath', () => {
  it('names the PID file the old package wrote', () => {
    assert.strictEqual(
      getLegacyPidFilePath('/home/someone'),
      join('/home/someone', '.opera-browser-cli', 'bridge.pid'),
    );
  });
});

describe('legacyCandidatePorts', () => {
  const savedPort = process.env.OPERA_CLI_PORT;

  afterEach(() => {
    if (savedPort === undefined) {
      delete process.env.OPERA_CLI_PORT;
    } else {
      process.env.OPERA_CLI_PORT = savedPort;
    }
  });

  it('scans the ten ports the old bridge could have taken', () => {
    delete process.env.OPERA_CLI_PORT;
    assert.deepStrictEqual(
      legacyCandidatePorts(),
      Array.from({length: 10}, (_, i) => 9225 + i),
    );
  });

  it("honours the old bridge's port override", () => {
    process.env.OPERA_CLI_PORT = '9400';
    assert.deepStrictEqual(
      legacyCandidatePorts(),
      Array.from({length: 10}, (_, i) => 9400 + i),
    );
  });
});

describe('stopLegacyBridge', () => {
  it('does nothing without a PID file', async () => {
    assert.strictEqual(await stopLegacyBridge({home}), false);
  });

  it('stops a bridge recorded against this boot and clears its PID file', async () => {
    const child = await spawnIdleProcess();
    writeLegacyPidFile({
      pid: child.pid,
      port: 9225,
      token: 't',
      version: '0.1.53',
      bootMinute: bootMinuteNow(),
    });

    // Attach before the stop: the event fires inside it.
    const exited = once(child, 'exit');
    assert.strictEqual(await stopLegacyBridge({home}), true);
    await exited;
    assert.strictEqual(isProcessAlive(child.pid!), false);
    assert.strictEqual(pidFileExists(), false);
  });

  it('refuses a PID recorded against a different boot', async () => {
    // After a reboot the recorded PID may belong to a stranger; the port probe
    // is the only safe way to identify that bridge.
    const child = await spawnIdleProcess();
    writeLegacyPidFile({pid: child.pid, port: 9225, bootMinute: 1});

    assert.strictEqual(await stopLegacyBridge({home}), false);
    assert.strictEqual(isProcessAlive(child.pid!), true);
    assert.strictEqual(pidFileExists(), true);
  });

  it('refuses a PID file with no boot stamp at all', async () => {
    // Written by a bridge older than the identity fields, so it cannot prove
    // the PID is ours.
    const child = await spawnIdleProcess();
    writeLegacyPidFile({pid: child.pid, port: 9225});

    assert.strictEqual(await stopLegacyBridge({home}), false);
    assert.strictEqual(isProcessAlive(child.pid!), true);
    assert.strictEqual(pidFileExists(), true);
  });

  it('clears a PID file whose process is already gone', async () => {
    const child = await spawnIdleProcess();
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    writeLegacyPidFile({
      pid: child.pid,
      port: 9225,
      bootMinute: bootMinuteNow(),
    });

    assert.strictEqual(await stopLegacyBridge({home}), false);
    assert.strictEqual(pidFileExists(), false);
  });

  it('survives an unreadable PID file', async () => {
    fs.mkdirSync(join(home, '.opera-browser-cli'), {recursive: true});
    fs.writeFileSync(getLegacyPidFilePath(home), 'not json');
    assert.strictEqual(await stopLegacyBridge({home}), false);
  });

  it('refuses to signal anything when the boot time cannot be read', async () => {
    // `os.uptime()` is denied in some sandboxes; an unanswerable boot check must
    // read as "cannot verify", never as a crash.
    const child = await spawnIdleProcess();
    writeLegacyPidFile({
      pid: child.pid,
      port: 9225,
      bootMinute: bootMinuteNow(),
    });
    sinon.restore();
    sinon.stub(os, 'uptime').throws(new Error('EPERM'));

    assert.strictEqual(await stopLegacyBridge({home}), false);
    assert.strictEqual(isProcessAlive(child.pid!), true);
  });
});

describe('probeAndStopLegacyBridges', () => {
  it('leaves a foreign server alone', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({server: 'not-ours'}));
    });
    await new Promise<void>(resolve =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const port = (server.address() as {port: number}).port;
    try {
      assert.strictEqual(await probeAndStopLegacyBridges([port]), false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('stops the bridge that answers /health', async () => {
    const {child, port} = await spawnHealthBridge();

    // Attach before the probe: the event fires inside it.
    const exited = once(child, 'exit');
    assert.strictEqual(await probeAndStopLegacyBridges([port]), true);
    await exited;
    assert.strictEqual(isProcessAlive(child.pid!), false);
  });

  it(
    "reaps the bridge's process group when the bridge ignores SIGTERM",
    {skip: process.platform === 'win32'},
    async () => {
      // The real bridge group-kills its browser and stdio child from its own exit
      // handler, which a SIGKILL never runs — so the killer has to signal the
      // group, or the browser outlives the bridge it belonged to. Windows has no
      // process groups, and no catchable SIGTERM to hold a bridge past the grace
      // period in the first place: both halves of this fixture are POSIX-only.
      const {child, port, grandchild} = await spawnHealthBridge(0, {
        stubborn: true,
      });
      assert.ok(grandchild, 'fixture must have a child to leave behind');

      const exited = once(child, 'exit');
      assert.strictEqual(await probeAndStopLegacyBridges([port]), true);
      await exited;
      assert.strictEqual(isProcessAlive(child.pid!), false);
      assert.strictEqual(isProcessAlive(grandchild!), false);
    },
  );
});

describe('runLegacyMigrationGuard', () => {
  let xdg: string;

  beforeEach(() => {
    xdg = fs.mkdtempSync(join(os.tmpdir(), 'opera-migration-guard-'));
    // The guard reads the invoking user's home and the runtime dir the fence
    // lives in; both are pointed at this test's throwaway tree.
    sinon.stub(os, 'homedir').returns(home);
    setEnv('XDG_RUNTIME_DIR', xdg);
    setEnv('OPERA_CLI_PORT', String(GUARD_PORT_BASE));
    setEnv('npm_config_prefix', join(home, 'prefix'));
  });

  afterEach(() => {
    fs.rmSync(xdg, {recursive: true, force: true});
  });

  it('stops the bridge its PID file names, with no CLI command involved', async () => {
    const child = await spawnIdleProcess();
    writeLegacyPidFile({
      pid: child.pid,
      port: GUARD_PORT_BASE,
      bootMinute: bootMinuteNow(),
    });

    const exited = once(child, 'exit');
    await runLegacyMigrationGuard();
    await exited;

    assert.strictEqual(isProcessAlive(child.pid!), false);
    assert.strictEqual(pidFileExists(), false);
  });

  it('sweeps the port window for an orphan, then leaves it alone for this boot', async () => {
    // The PID file is gone, which is the state only the port probe can see.
    const orphan = await spawnHealthBridge(GUARD_PORT_BASE);
    const orphanExited = once(orphan.child, 'exit');
    await runLegacyMigrationGuard();
    await orphanExited;
    assert.strictEqual(isProcessAlive(orphan.child.pid!), false);

    // Same boot: the sweep already ran, so a second orphan is left for the
    // next boot rather than probed on every command and every server start.
    const second = await spawnHealthBridge(GUARD_PORT_BASE);
    await runLegacyMigrationGuard();
    assert.strictEqual(isProcessAlive(second.child.pid!), true);

    // A reboot is a different boot stamp, which claims the pass again.
    uptime.returns(FAKE_UPTIME_SECONDS + 3_600);
    const secondExited = once(second.child, 'exit');
    await runLegacyMigrationGuard();
    await secondExited;
    assert.strictEqual(isProcessAlive(second.child.pid!), false);
  });

  it('points at the launcher install when the pre-launcher package is still there', async () => {
    const prefix = join(home, 'prefix');
    const dir = join(prefix, 'lib', 'node_modules', 'opera-browser-cli');
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({name: 'opera-browser-cli', version: '0.1.54'}),
    );

    const notices: string[] = [];
    const stderr = sinon
      .stub(process.stderr, 'write')
      .callsFake((chunk: string | Uint8Array) => {
        notices.push(String(chunk));
        return true;
      });
    try {
      await runLegacyMigrationGuard();
    } finally {
      stderr.restore();
    }
    assert.ok(
      notices.some(line =>
        /legacy opera-browser-cli detected at .*run: npm i -g opera-browser-cli@latest to migrate\./.test(
          line,
        ),
      ),
      notices.join(''),
    );
  });

  it('stays quiet when the package at that path is the launcher itself', async () => {
    const dir = join(
      home,
      'prefix',
      'lib',
      'node_modules',
      'opera-browser-cli',
    );
    fs.mkdirSync(join(dir, 'bin'), {recursive: true});
    fs.writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({name: 'opera-browser-cli', version: '0.1.55'}),
    );
    fs.writeFileSync(join(dir, 'bin', 'cli.js'), '#!/usr/bin/env node\n');

    const notices: string[] = [];
    const stderr = sinon
      .stub(process.stderr, 'write')
      .callsFake((chunk: string | Uint8Array) => {
        notices.push(String(chunk));
        return true;
      });
    try {
      await runLegacyMigrationGuard();
    } finally {
      stderr.restore();
    }
    assert.deepStrictEqual(notices, []);
  });
});
