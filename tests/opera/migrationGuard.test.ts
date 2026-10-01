/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * The migration guard runs from the entry points, not from an install hook.
 *
 * npm ≥12 blocks dependency install scripts unless the user opts into them, so
 * anything that has to happen on a machine upgrading from the two-package era
 * has to happen when one of our processes starts. That is two entry points, not
 * one: the CLI, and the MCP server an editor or agent starts on its own — with
 * no `opera-browser-cli` command anywhere in the picture. These cases hold both
 * to stopping an old HTTP bridge that is still holding port 9225 and a browser.
 *
 * The fixture is the real shape, not a convenient one: the bridge is spawned by
 * a launcher that exits at once, exactly as the legacy CLI spawns it, so nothing
 * in this process is its parent. A child of the test process would be a zombie
 * the moment it died, and `process.kill(pid, 0)` — the only liveness test the
 * guard has — would keep reporting it alive.
 */

import assert from 'node:assert';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';

import {getLegacyPidFilePath} from '../../src/opera/legacyBridgeCleanup.js';
import {createCliEnv} from '../utils.js';

const CLI_PATH = path.resolve('build/src/bin/opera-browser-cli.js');
const MCP_PATH = path.resolve('build/src/bin/opera-devtools-mcp.js');

/** A port window nothing else uses, so a sweep never touches a real bridge. */
const PORT_BASE = 9480;

const BRIDGE_STOPPED = /stopping legacy HTTP bridge \(pid \d+\)/;

/** The legacy bridge: `/health` with the old identity payload, and a browser. */
const BRIDGE_SOURCE = `
const http = require('node:http');
const fs = require('node:fs');
const [port, infoPath] = process.argv.slice(2);
const server = http.createServer((_req, res) => {
  res.writeHead(200, {'content-type': 'application/json'});
  res.end(JSON.stringify({
    status: 'ok', server: 'opera-browser-cli', version: '0.1.54',
    pid: process.pid, startedAt: Date.now(), bootMinute: 0,
    browser: {connected: true}, headed: false,
  }));
});
server.listen(Number(port), '127.0.0.1', () => {
  fs.writeFileSync(infoPath, JSON.stringify({pid: process.pid, port: Number(port)}));
});
`;

/** Spawn, then vanish: the bridge ends up reparented, as the real one does. */
const LAUNCHER_SOURCE = `
const {spawn} = require('node:child_process');
const [script, ...args] = process.argv.slice(1);
spawn(process.execPath, [script, ...args], {detached: true, stdio: 'ignore'}).unref();
`;

let prefix: string;
let runtime: string;
let root: string;
let env: Record<string, string>;
const started: number[] = [];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'opera-migration-guard-'));
  prefix = path.join(root, 'prefix');
  runtime = path.join(root, 'runtime');
  for (const dir of [path.join(prefix, 'bin'), runtime]) {
    fs.mkdirSync(dir, {recursive: true});
  }
  fs.writeFileSync(path.join(root, 'legacy-bridge.js'), BRIDGE_SOURCE);
  env = {
    ...(await createCliEnv()),
    // `createCliEnv` isolates HOME, but the guard's once-per-boot fence lives
    // under XDG_RUNTIME_DIR, which has to be this test's tree too.
    XDG_RUNTIME_DIR: runtime,
    OPERA_CLI_PORT: String(PORT_BASE),
    npm_config_prefix: prefix,
  };
});

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone, or never a group leader.
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  fs.rmSync(root, {recursive: true, force: true});
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Wait for `probe` to answer true, or give up.
 *
 * The condition is another process's startup, not this one's timers, so there
 * is nothing to advance deterministically: a real (short) interval polls the
 * observed condition and stops the moment it holds.
 */
async function waitFor(probe: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await probe()) {
      return;
    }
    await sleep(25);
  }
  throw new Error('fixture never became ready');
}

/** Start the legacy bridge fixture and wait until it answers `/health`. */
async function startLegacyBridge(port: number): Promise<number> {
  const infoPath = path.join(root, `bridge-${port}.json`);
  spawn(
    process.execPath,
    [
      '-e',
      LAUNCHER_SOURCE,
      path.join(root, 'legacy-bridge.js'),
      String(port),
      infoPath,
    ],
    {stdio: 'ignore'},
  ).unref();

  await waitFor(() => fs.existsSync(infoPath));
  const {pid} = JSON.parse(fs.readFileSync(infoPath, 'utf-8')) as {
    pid: number;
  };
  started.push(pid);
  await waitFor(async () => {
    const {promise, resolve} = Promise.withResolvers<boolean>();
    const req = http.get(
      {host: '127.0.0.1', port, path: '/health', timeout: 500},
      res => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    return await promise;
  });
  return pid;
}

/**
 * A PID file the bridge leaves behind, written into the home the *bin* will
 * read (`createCliEnv` repoints HOME for it). No boot stamp: this environment
 * denies `os.uptime()` — so a stamp cannot be forged — and a stamp is what a
 * bridge older than the identity fields never wrote anyway; the port window is
 * what recognises it.
 */
function writeLegacyPidFile(pid: number): void {
  const pidFile = getLegacyPidFilePath(env.HOME);
  fs.mkdirSync(path.dirname(pidFile), {recursive: true});
  fs.writeFileSync(
    pidFile,
    JSON.stringify({pid, port: PORT_BASE, version: '0.1.54'}),
  );
}

/** Run a bin the way the suite runs everything: through its own process. */
async function run(
  script: string,
  args: string[],
): Promise<{status: number | null; stdout: string; stderr: string}> {
  const child = spawn(process.execPath, [script, ...args], {env});
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => (stdout += chunk));
  child.stderr.on('data', chunk => (stderr += chunk));
  child.stdin.end('');
  const status = await new Promise<number | null>(resolve =>
    child.on('close', resolve),
  );
  return {status, stdout, stderr};
}

describe('the MCP server entry point', () => {
  it('stops a legacy bridge that left its PID file behind, and drops the file', async () => {
    const pid = await startLegacyBridge(PORT_BASE);
    writeLegacyPidFile(pid);

    const result = await run(MCP_PATH, ['--headless', '--isolated']);

    assert.match(result.stderr, BRIDGE_STOPPED, result.stderr);
    await waitFor(() => !alive(pid));
    assert.strictEqual(
      fs.existsSync(getLegacyPidFilePath(env.HOME)),
      false,
      'the PID file must not outlive the bridge',
    );
  });

  it('finds an orphaned bridge through the port window, with no PID file at all', async () => {
    const pid = await startLegacyBridge(PORT_BASE);

    const result = await run(MCP_PATH, ['--headless', '--isolated']);

    assert.match(result.stderr, BRIDGE_STOPPED, result.stderr);
    await waitFor(() => !alive(pid));
  });
});

describe('the CLI entry point', () => {
  it('stops the legacy bridge before the command runs', async () => {
    const pid = await startLegacyBridge(PORT_BASE);
    writeLegacyPidFile(pid);

    const result = await run(CLI_PATH, ['status']);

    assert.match(result.stderr, BRIDGE_STOPPED, result.stderr);
    await waitFor(() => !alive(pid));
  });
});
