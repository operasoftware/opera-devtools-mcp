/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import {createServer, type Server} from 'node:http';
import net, {type AddressInfo} from 'node:net';
import {hostname, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {getPidFilePath, getRuntimeHome} from '../../src/daemon/utils.js';
import {
  getDaemonLogPath,
  getPreviousDaemonLogPath,
} from '../../src/opera/daemonLog.js';
import {writeExitReason} from '../../src/opera/daemonLifecycle.js';
import {
  formatBytes,
  handleDoctor,
  runDoctorChecks,
  runDoctorFixes,
  type DoctorCheck,
} from '../../src/opera/doctor.js';
import {writeConfigFile} from '../../src/opera/config.js';
import {getConfigFile, getStateDir} from '../../src/opera/envConfig.js';
import {VERSION} from '../../src/version.js';
import {pinHome, restoreHome} from '../fake-home.js';

const OPERA_ENV_KEYS = [
  'OPERA_CLI_EXECUTABLE_PATH',
  'OPERA_CLI_BROWSER_URL',
  'OPERA_CLI_USER_DATA_DIR',
  'OPERA_CLI_HEADED',
];

/**
 * Where Windows detection and profile lookup look: `LOCALAPPDATA`/`PROGRAMFILES`
 * hold the install roots, `APPDATA` the per-user profile. A runner's real ones
 * name the real user's folders, so a test that plants a browser under its own
 * temp home has to redirect them there.
 */
const WINDOWS_ENV_KEYS = ['LOCALAPPDATA', 'PROGRAMFILES', 'APPDATA'];

describe('formatBytes', () => {
  it('scales to the largest unit that fits', () => {
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(2048), '2.0 KB');
    assert.strictEqual(formatBytes(6 * 1024 * 1024), '6.0 MB');
  });
});

describe('doctor', () => {
  let home: string;
  let runtimeDir: string;
  let sessionId: string;
  let savedHome: Record<string, string | undefined>;
  let savedRuntimeDir: string | undefined;
  let savedOperaEnv: Record<string, string | undefined>;
  let savedWindowsEnv: Record<string, string | undefined>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'opera-doctor-home-'));
    runtimeDir = mkdtempSync(join(tmpdir(), 'opera-doctor-run-'));
    sessionId = crypto.randomUUID();
    savedOperaEnv = Object.fromEntries(
      OPERA_ENV_KEYS.map(key => [key, process.env[key]]),
    );
    savedWindowsEnv = Object.fromEntries(
      WINDOWS_ENV_KEYS.map(key => [key, process.env[key]]),
    );
    savedHome = pinHome(home);
    savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    // A real machine's config must not decide what `doctor` reports here.
    for (const key of OPERA_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    restoreHome(savedHome);
    if (savedRuntimeDir === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = savedRuntimeDir;
    }
    restoreEnv(savedOperaEnv);
    restoreEnv(savedWindowsEnv);
    rmSync(home, {recursive: true, force: true});
    rmSync(runtimeDir, {recursive: true, force: true});
  });

  /** Put back the variables a test replaced, dropping the ones it unset. */
  function restoreEnv(saved: Record<string, string | undefined>): void {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  function check(name: string, checks: DoctorCheck[]): DoctorCheck {
    const found = checks.find(candidate => candidate.name === name);
    assert.ok(found, `no ${name} check in ${JSON.stringify(checks)}`);
    return found;
  }

  describe('config check', () => {
    it('warns when no config file exists', async () => {
      const config = check('config', await runDoctorChecks(sessionId));

      assert.strictEqual(config.status, 'warn');
      assert.ok(config.detail.includes('not found'), config.detail);
    });

    it('reports the number of settings once one exists', async () => {
      writeConfigFile({OPERA_CLI_HEADED: '1'}, home);

      const config = check('config', await runDoctorChecks(sessionId));

      assert.strictEqual(config.status, 'ok');
      assert.ok(config.detail.includes('1 var set'), config.detail);
    });

    it('flags an unrecognised key with its likely intended spelling', async () => {
      writeConfigFile({OPERA_CLI_EXECUTABLE_PATHS: '/opt/opera'}, home);

      const config = check('config', await runDoctorChecks(sessionId));

      assert.strictEqual(config.status, 'warn');
      assert.ok(config.detail.includes('unrecognised key'), config.detail);
      assert.ok(
        config.detail.includes('did you mean OPERA_CLI_EXECUTABLE_PATH'),
        config.detail,
      );
    });
  });

  describe('executable check', () => {
    it('skips the executable when a browser URL is configured', async () => {
      process.env.OPERA_CLI_BROWSER_URL = 'http://127.0.0.1:9222';

      const executable = check('executable', await runDoctorChecks(sessionId));

      assert.strictEqual(executable.status, 'ok');
      assert.ok(executable.detail.includes('skipping'), executable.detail);
    });

    it('warns when nothing is configured', async () => {
      const executable = check('executable', await runDoctorChecks(sessionId));

      assert.strictEqual(executable.status, 'warn');
      assert.ok(executable.detail.includes('not set'), executable.detail);
    });

    it('fails when the configured path is gone', async () => {
      process.env.OPERA_CLI_EXECUTABLE_PATH = join(home, 'no-such-opera');

      const executable = check('executable', await runDoctorChecks(sessionId));

      assert.strictEqual(executable.status, 'fail');
      assert.ok(
        executable.detail.includes('does not exist'),
        executable.detail,
      );
    });

    it('accepts an existing path', async () => {
      const binary = join(home, 'opera');
      writeFileSync(binary, '');
      process.env.OPERA_CLI_EXECUTABLE_PATH = binary;

      const executable = check('executable', await runDoctorChecks(sessionId));

      assert.deepStrictEqual(executable, {
        name: 'executable',
        status: 'ok',
        detail: binary,
      });
    });
  });

  describe('profile check', () => {
    it('reports an isolated session as ok', async () => {
      const profile = check('profile', await runDoctorChecks(sessionId));

      assert.strictEqual(profile.status, 'ok');
      assert.ok(profile.detail.includes('isolated'), profile.detail);
    });

    it('reports a profile that has not been created yet as ok', async () => {
      process.env.OPERA_CLI_USER_DATA_DIR = join(home, 'future-profile');

      const profile = check('profile', await runDoctorChecks(sessionId));

      assert.strictEqual(profile.status, 'ok');
      assert.ok(profile.detail.includes('will be created'), profile.detail);
    });

    it('reports a profile with no lock as free', async () => {
      const dir = join(home, 'profile');
      mkdirSync(dir, {recursive: true});
      process.env.OPERA_CLI_USER_DATA_DIR = dir;

      const profile = check('profile', await runDoctorChecks(sessionId));

      assert.strictEqual(profile.status, 'ok');
      assert.ok(profile.detail.includes('(free)'), profile.detail);
    });

    it(
      'warns when a live browser holds the profile without a debug port',
      {skip: process.platform === 'win32'},
      async () => {
        const dir = join(home, 'locked-profile');
        mkdirSync(dir, {recursive: true});
        // This process's own pid: a lock we can prove is live.
        symlinkSync(`${hostname()}-${process.pid}`, join(dir, 'SingletonLock'));
        process.env.OPERA_CLI_USER_DATA_DIR = dir;

        const profile = check('profile', await runDoctorChecks(sessionId));

        assert.strictEqual(profile.status, 'warn');
        assert.ok(
          profile.detail.includes(`by pid ${process.pid}`),
          profile.detail,
        );
        assert.ok(profile.detail.includes('no debugging port'), profile.detail);
      },
    );
  });

  describe('daemon and log checks', () => {
    it('warns that the daemon is not running, with the reason it last left', async () => {
      const daemon = check('daemon', await runDoctorChecks(sessionId));

      assert.strictEqual(daemon.status, 'warn');
      assert.ok(daemon.detail.includes('not running'), daemon.detail);

      // The daemon creates its runtime home; the test has to stand in for it.
      mkdirSync(getRuntimeHome(sessionId), {recursive: true});
      writeExitReason(sessionId, 'killed while idle');
      const withReason = check('daemon', await runDoctorChecks(sessionId));
      assert.ok(
        withReason.detail.includes('last exit: killed while idle'),
        withReason.detail,
      );
    });

    it('warns when the log has not been created yet', async () => {
      const logs = check('logs', await runDoctorChecks(sessionId));

      assert.strictEqual(logs.status, 'warn');
      assert.ok(logs.detail.includes('not yet created'), logs.detail);
    });

    it('reports the log size once there is one', async () => {
      const logFile = getDaemonLogPath(sessionId);
      mkdirSync(dirname(logFile), {recursive: true});
      writeFileSync(logFile, 'some daemon output\n');

      const logs = check('logs', await runDoctorChecks(sessionId));

      assert.strictEqual(logs.status, 'ok');
      assert.ok(logs.detail.includes(`(${formatBytes(19)})`), logs.detail);
    });
  });

  describe('handleDoctor', () => {
    it('renders a summary and one row per check', async () => {
      const output = await handleDoctor([], sessionId);

      assert.match(output, /^doctor:/m);
      assert.match(output, /^ {2}ok: 1$/m);
      assert.match(output, /^ {2}warn: 4$/m);
      assert.match(output, /^checks\[5\]:$/m);
      assert.match(output, /^ {2}config: warn /m);
    });

    it('suggests setup when the config is missing', async () => {
      const output = await handleDoctor([], sessionId);

      assert.ok(output.includes('opera-browser-cli setup'), output);
    });

    it('reports that nothing needed repairing when nothing does', async () => {
      // A config and a small log: neither repair has anything to do.
      writeConfigFile({OPERA_CLI_EXECUTABLE_PATH: '/opt/opera'}, home);
      const logFile = getDaemonLogPath(sessionId);
      mkdirSync(dirname(logFile), {recursive: true});
      writeFileSync(logFile, 'small\n');

      const output = await handleDoctor(['--fix'], sessionId);

      assert.ok(output.includes('fixed: nothing needed repairing'), output);
    });

    it('rotates an oversized log and reports it', async () => {
      writeConfigFile({OPERA_CLI_EXECUTABLE_PATH: '/opt/opera'}, home);
      const logFile = getDaemonLogPath(sessionId);
      mkdirSync(dirname(logFile), {recursive: true});
      writeFileSync(logFile, Buffer.alloc(6 * 1024 * 1024));

      const output = await handleDoctor(['--fix'], sessionId);

      assert.ok(output.includes('rotated the daemon log'), output);
      assert.ok(output.includes('fixed[1]:'), output);
      assert.ok(
        existsSync(getPreviousDaemonLogPath(sessionId)),
        'the previous generation was not kept',
      );
    });

    it('leaves a log under the rotation ceiling alone', async () => {
      const logFile = getDaemonLogPath(sessionId);
      mkdirSync(dirname(logFile), {recursive: true});
      writeFileSync(logFile, 'small\n');

      await runDoctorFixes(await runDoctorChecks(sessionId), sessionId);

      assert.ok(
        existsSync(logFile),
        'the log was rotated when it should not be',
      );
    });

    it('rotates on the byte count, not on how the size renders', async () => {
      const logFile = getDaemonLogPath(sessionId);
      mkdirSync(dirname(logFile), {recursive: true});
      writeFileSync(logFile, Buffer.alloc(6 * 1024 * 1024));
      const size = 6 * 1024 * 1024;

      // The detail is written the way a formatter with different units would
      // write it. A rotation decided by re-parsing that string would not fire;
      // the threshold is the raw byte count the check carries.
      const applied = await runDoctorFixes(
        [
          {
            name: 'logs',
            status: 'ok',
            detail: `${logFile} (${size} B)`,
            bytes: size,
          },
        ],
        sessionId,
      );

      assert.deepStrictEqual(applied, ['rotated the daemon log']);
    });

    it(
      'writes a config for a machine that has a browser but none configured',
      {skip: process.platform === 'linux'},
      async () => {
        // A browser where detection looks, which is the only way this repair
        // fires: a machine that has already been configured takes the other path.
        // Windows detection composes its candidates from these environment
        // roots, so a planted browser is only findable once they name this
        // test's home rather than the runner's own folders.
        process.env.LOCALAPPDATA = join(home, 'AppData', 'Local');
        process.env.PROGRAMFILES = join(home, 'Program Files');
        process.env.APPDATA = join(home, 'AppData', 'Roaming');
        const relative =
          process.platform === 'darwin'
            ? join(
                home,
                'Applications',
                'Opera Neon.app',
                'Contents',
                'MacOS',
                'Opera',
              )
            : join(
                process.env.LOCALAPPDATA,
                'Programs',
                'Opera Neon',
                'opera.exe',
              );
        mkdirSync(dirname(relative), {recursive: true});
        writeFileSync(relative, '');

        const output = await handleDoctor(['--fix'], sessionId);

        assert.ok(output.includes('wrote a config for Opera Neon'), output);
        assert.ok(
          existsSync(getConfigFile(home)),
          `no config written to ${getStateDir(home)}`,
        );
      },
    );
  });

  describe('daemon check — running', () => {
    it('fails when the running daemon reports an error', async () => {
      claimDaemonPidFile(sessionId);
      fakeDaemon(() => ({success: false, result: '', error: 'boom'}));

      const daemon = check('daemon', await runDoctorChecks(sessionId));

      assert.strictEqual(daemon.status, 'fail');
      assert.ok(daemon.detail.includes('running but boom'), daemon.detail);
    });

    it('warns when the daemon runs a different version', async () => {
      claimDaemonPidFile(sessionId);
      fakeDaemon(() => ({
        success: true,
        result: JSON.stringify({
          pid: process.pid,
          socketPath: '',
          startDate: '',
          version: '0.0.0',
          args: [],
        }),
        error: null,
      }));

      const daemon = check('daemon', await runDoctorChecks(sessionId));

      assert.strictEqual(daemon.status, 'warn');
      assert.ok(
        daemon.detail.includes('restarts automatically'),
        daemon.detail,
      );
      assert.ok(daemon.detail.includes('0.0.0'), daemon.detail);
    });

    it('reports ok for a healthy daemon at this version', async () => {
      claimDaemonPidFile(sessionId);
      fakeDaemon(() => ({
        success: true,
        result: JSON.stringify({
          pid: process.pid,
          socketPath: '/tmp/fake.sock',
          startDate: '',
          version: VERSION,
          args: [],
        }),
        error: null,
      }));

      const daemon = check('daemon', await runDoctorChecks(sessionId));

      assert.strictEqual(daemon.status, 'ok');
      assert.ok(daemon.detail.includes(`running ${VERSION}`), daemon.detail);
      assert.ok(daemon.detail.includes(String(process.pid)), daemon.detail);
    });

    it('fails when the running daemon does not answer', async () => {
      claimDaemonPidFile(sessionId);
      sinon.stub(net, 'createConnection').callsFake(() => {
        const socket = new EventEmitter() as EventEmitter & {
          write(): boolean;
          destroy(): void;
        };
        socket.write = () => {
          queueMicrotask(() => socket.emit('error', new Error('ECONNRESET')));
          return true;
        };
        socket.destroy = () => socket.emit('close');
        return socket as unknown as net.Socket;
      });

      const daemon = check('daemon', await runDoctorChecks(sessionId));

      assert.strictEqual(daemon.status, 'fail');
      assert.ok(daemon.detail.includes('not answering'), daemon.detail);
    });
  });

  describe('profile check — attachable', () => {
    it(
      'reports an in-use profile that answers as Opera, with its port',
      {skip: process.platform === 'win32'},
      async () => {
        const dir = join(home, 'attachable-profile');
        mkdirSync(dir, {recursive: true});
        const port = await serveJson('{"Browser":"Opera/110.0.0.0"}');
        writeFileSync(
          join(dir, 'DevToolsActivePort'),
          `${port}\n/devtools/browser/x\n`,
        );
        symlinkSync(`${hostname()}-${process.pid}`, join(dir, 'SingletonLock'));
        process.env.OPERA_CLI_USER_DATA_DIR = dir;

        const profile = check('profile', await runDoctorChecks(sessionId));

        assert.strictEqual(profile.status, 'ok');
        assert.ok(
          profile.detail.includes('in use by Opera/110.0.0.0'),
          profile.detail,
        );
        assert.ok(
          profile.detail.includes(`attachable on port ${port}`),
          profile.detail,
        );
      },
    );

    it(
      'warns when the lock is live but the advertised port does not answer',
      {skip: process.platform === 'win32'},
      async () => {
        const dir = join(home, 'locked-dead-port-profile');
        mkdirSync(dir, {recursive: true});
        const port = await closedPort();
        writeFileSync(
          join(dir, 'DevToolsActivePort'),
          `${port}\n/devtools/browser/x\n`,
        );
        symlinkSync(`${hostname()}-${process.pid}`, join(dir, 'SingletonLock'));
        process.env.OPERA_CLI_USER_DATA_DIR = dir;

        const profile = check('profile', await runDoctorChecks(sessionId));

        assert.strictEqual(profile.status, 'warn');
        assert.ok(
          profile.detail.includes(`by pid ${process.pid}`),
          profile.detail,
        );
        assert.ok(profile.detail.includes('no debugging port'), profile.detail);
      },
    );
  });
});

// --- running-daemon and attachable-profile helpers ---

const servers: Server[] = [];

type Frame = Record<string, unknown>;

function claimDaemonPidFile(sessionId: string): void {
  const pidFile = getPidFilePath(sessionId);
  mkdirSync(dirname(pidFile), {recursive: true});
  writeFileSync(pidFile, String(process.pid));
}

function fakeDaemon(respond: (request: Frame) => Frame): void {
  sinon.stub(net, 'createConnection').callsFake(() => {
    const socket = new EventEmitter() as EventEmitter & {
      write(chunk: string): boolean;
      destroy(): void;
    };
    let pending = '';
    socket.write = (chunk: string) => {
      pending += chunk;
      let end = pending.indexOf('\0');
      while (end !== -1) {
        const request = JSON.parse(pending.slice(0, end)) as Frame;
        pending = pending.slice(end + 1);
        end = pending.indexOf('\0');
        queueMicrotask(() =>
          socket.emit(
            'data',
            Buffer.from(JSON.stringify(respond(request)) + '\0'),
          ),
        );
      }
      return true;
    };
    socket.destroy = () => socket.emit('close');
    return socket as unknown as net.Socket;
  });
}

async function serveJson(body: string): Promise<number> {
  const {promise, resolve, reject} = Promise.withResolvers<number>();
  const server = createServer((req, res) => {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(body);
  });
  servers.push(server);
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as AddressInfo).port);
  });
  return promise;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.on('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const port = (server.address() as AddressInfo).port;
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  return port;
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
  sinon.restore();
});
