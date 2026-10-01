/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import childProcess, {spawn} from 'node:child_process';
import fs from 'node:fs';
import {createServer, type Server} from 'node:http';
import {type AddressInfo} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {
  browserLaunchArgs,
  extractTakeoverFlag,
  launchAttachableBrowser,
  preflightBrowser,
  quitBrowser,
  resolveBrowserTarget,
  separateProfileDir,
  sessionIdFromArgv,
  settleBrowserConflict,
  type BrowserTarget,
  type PreflightDeps,
} from '../../src/opera/browserTarget.js';
import {CdpError} from '../../src/opera/cdpErrors.js';

const tempDirs: string[] = [];
const servers: Server[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opera-brtarget-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

/** A profile held by a live process, as the lock file records it. */
function writeLock(dir: string, pid: number): void {
  fs.symlinkSync(`${os.hostname()}-${pid}`, path.join(dir, 'SingletonLock'));
}

/** A DevTools endpoint that answers like a real browser, on a random port. */
async function serveVersion(browser = 'Opera/121.0.0.0'): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({Browser: browser}));
  });
  servers.push(server);
  const listening = Promise.withResolvers<void>();
  server.on('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  return (server.address() as AddressInfo).port;
}

describe('resolveBrowserTarget', () => {
  it('attaches to an explicitly configured browser URL', async () => {
    const target = await resolveBrowserTarget({
      browserUrl: 'http://127.0.0.1:9222',
      userDataDir: tempDir(),
    });
    assert.deepStrictEqual(target, {
      mode: 'attach',
      url: 'http://127.0.0.1:9222',
      note: 'OPERA_CLI_BROWSER_URL',
    });
  });

  it('manages an isolated browser when no profile is configured', async () => {
    assert.deepStrictEqual(await resolveBrowserTarget({}), {
      mode: 'managed',
      note: 'isolated profile',
    });
  });

  it('manages the profile when nothing holds it', async () => {
    assert.deepStrictEqual(
      await resolveBrowserTarget({userDataDir: tempDir()}),
      {mode: 'managed', note: 'profile is free'},
    );
  });

  it(
    'reports a conflict when a live process holds the profile without a debug port',
    {skip: process.platform === 'win32'},
    async () => {
      const dir = tempDir();
      writeLock(dir, process.pid);
      assert.deepStrictEqual(await resolveBrowserTarget({userDataDir: dir}), {
        mode: 'conflict',
        userDataDir: dir,
        lock: {state: 'locked', pid: process.pid, hostname: os.hostname()},
      });
    },
  );

  it(
    'attaches instead of conflicting once the profile advertises a live port',
    {skip: process.platform === 'win32'},
    async () => {
      const dir = tempDir();
      writeLock(dir, process.pid);
      const port = await serveVersion();
      fs.writeFileSync(
        path.join(dir, 'DevToolsActivePort'),
        `${port}\n/devtools/browser/abc\n`,
      );
      assert.deepStrictEqual(await resolveBrowserTarget({userDataDir: dir}), {
        mode: 'attach',
        url: `http://127.0.0.1:${port}`,
        note: 'running Opera/121.0.0.0',
      });
    },
  );
});

describe('browserLaunchArgs', () => {
  it('picks a port itself and keeps the profile it was given', () => {
    assert.deepStrictEqual(browserLaunchArgs('/tmp/profile'), [
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      '--user-data-dir=/tmp/profile',
    ]);
  });

  it('omits the profile when there is none', () => {
    assert.deepStrictEqual(browserLaunchArgs(undefined), [
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
    ]);
  });
});

describe('quitBrowser', () => {
  it('cannot signal a lock that names no process', async () => {
    assert.deepStrictEqual(
      await quitBrowser(
        {state: 'unknown', pid: null, hostname: null},
        tempDir(),
      ),
      {ok: false, reason: 'no-pid'},
    );
  });

  it(
    'waits for a signalled browser to release the profile',
    {skip: process.platform === 'win32'},
    async () => {
      // A real process is the point: the test is that SIGTERM reaches the pid
      // the lock names and the wait ends when it goes. Fake timers cannot
      // express a signal the OS delivers, so the child exists only to be alive
      // and to die — it is asked to do nothing but stay up.
      const dir = tempDir();
      const child = spawn(process.execPath, [
        '-e',
        'setTimeout(() => {}, 60_000)',
      ]);
      try {
        assert.ok(child.pid);
        writeLock(dir, child.pid);
        assert.deepStrictEqual(
          await quitBrowser(
            {state: 'locked', pid: child.pid, hostname: os.hostname()},
            dir,
            5000,
          ),
          {ok: true},
        );
      } finally {
        child.kill('SIGKILL');
      }
    },
  );

  it(
    'derives the machine’s host names once, not once per poll',
    {skip: process.platform !== 'darwin'},
    async () => {
      // The derivation is a `scutil` subprocess on macOS; run per poll it is
      // eighty of them over one wait, for an answer that cannot change while
      // the wait runs.
      const scutil = sinon
        .stub(childProcess, 'execFileSync')
        .callsFake(() => 'opera-users-MacBook-Pro-2\n');
      const dir = tempDir();
      // Ignores SIGTERM, and says so before the signal can arrive, so the wait
      // polls more than once instead of seeing a process that is already gone.
      const child = spawn(process.execPath, [
        '-e',
        "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setTimeout(() => {}, 60_000)",
      ]);
      const ready = Promise.withResolvers<void>();
      child.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) {
          ready.resolve();
        }
      });
      try {
        assert.ok(child.pid);
        await ready.promise;
        writeLock(dir, child.pid);
        assert.deepStrictEqual(
          await quitBrowser(
            {state: 'locked', pid: child.pid, hostname: os.hostname()},
            dir,
            700,
          ),
          {ok: false, reason: 'timeout'},
        );
        assert.strictEqual(
          scutil.callCount,
          1,
          'derived once for the whole wait',
        );
      } finally {
        sinon.restore();
        child.kill('SIGKILL');
      }
    },
  );
});

describe('launchAttachableBrowser', () => {
  it('refuses without an executable to launch', async () => {
    assert.deepStrictEqual(
      await launchAttachableBrowser(undefined, tempDir()),
      {ok: false, reason: 'no-executable'},
    );
    assert.deepStrictEqual(
      await launchAttachableBrowser(
        path.join(tempDir(), 'not-here'),
        tempDir(),
      ),
      {ok: false, reason: 'no-executable'},
    );
  });
});

interface FakeDeps {
  deps: PreflightDeps;
  env: NodeJS.ProcessEnv;
  out: string[];
  err: string[];
  asked: string[];
  calls: {quit: number; launch: number; resolve: number; stopDaemon: number};
}

function conflictTarget(userDataDir = '/configured/profile') {
  return {
    mode: 'conflict' as const,
    userDataDir,
    lock: {state: 'locked' as const, pid: 4242, hostname: 'Mac'},
  };
}

interface FakeOverrides extends Partial<PreflightDeps> {
  /** What the fake terminal answers when it is asked. */
  answer?: string;
  /** What the profile looks like to the preflight. */
  target?: BrowserTarget;
}

function makeDeps(
  overrides: FakeOverrides = {},
  env: NodeJS.ProcessEnv = {
    OPERA_CLI_USER_DATA_DIR: '/configured/profile',
    OPERA_CLI_EXECUTABLE_PATH: '/Applications/Opera.app/opera',
  },
): FakeDeps {
  const {answer = '', target, ...rest} = overrides;
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const calls = {quit: 0, launch: 0, resolve: 0, stopDaemon: 0};
  const deps: PreflightDeps = {
    interactive: false,
    ask: async question => {
      asked.push(question);
      return answer;
    },
    resolveTarget: async () => {
      calls.resolve++;
      return target ?? {mode: 'managed', note: 'test'};
    },
    daemonArgs: async () => null,
    quit: async () => {
      calls.quit++;
      return {ok: true};
    },
    launch: async () => {
      calls.launch++;
      return {ok: true, url: 'http://127.0.0.1:9333'};
    },
    stopDaemon: async () => {
      calls.stopDaemon++;
    },
    env,
    writeOut: text => out.push(text),
    write: text => err.push(text),
    ...rest,
  };
  return {deps, env, out, err, asked, calls};
}

describe('preflightBrowser', () => {
  it('leaves commands that never touch a browser alone', async () => {
    const {deps, calls} = makeDeps();
    for (const command of ['setup', 'doctor', 'logs', 'status', 'stop']) {
      await preflightBrowser([command], '', false, deps);
    }
    assert.strictEqual(calls.resolve, 0);
  });

  it('does not ask about the profile before printing help', async () => {
    const {deps, calls, asked} = makeDeps();
    await preflightBrowser(['new_page', '--help'], '', false, deps);
    assert.strictEqual(calls.resolve, 0);
    assert.deepStrictEqual(asked, []);
  });

  it('leaves a browser the user manages alone', async () => {
    const {deps, calls, env} = makeDeps();
    env.OPERA_CLI_BROWSER_URL = 'http://127.0.0.1:9222';
    await preflightBrowser(['new_page'], '', false, deps);
    assert.strictEqual(calls.resolve, 0);
    assert.strictEqual(env.OPERA_CLI_BROWSER_URL, 'http://127.0.0.1:9222');
  });

  it('does nothing without a persistent profile to contend over', async () => {
    const {deps, calls} = makeDeps({}, {});
    await preflightBrowser(['new_page'], '', false, deps);
    assert.strictEqual(calls.resolve, 0);
  });

  it('does not second-guess browser flags the command was given', async () => {
    const {deps, calls} = makeDeps();
    await preflightBrowser(
      ['start', '--browser-url=http://127.0.0.1:9222'],
      '',
      false,
      deps,
    );
    assert.strictEqual(calls.resolve, 0);
  });

  it('marks the configured profile as the attach URL when it advertises a port', async () => {
    const {deps, env} = makeDeps({
      target: {
        mode: 'attach',
        url: 'http://127.0.0.1:9444',
        note: 'running Opera/121.0.0.0',
      },
    });
    await preflightBrowser(['new_page'], '', false, deps);
    assert.strictEqual(env.OPERA_CLI_BROWSER_URL, 'http://127.0.0.1:9444');
  });

  it('changes nothing when the profile is free', async () => {
    const {deps, env, err} = makeDeps();
    await preflightBrowser(['new_page'], '', false, deps);
    assert.strictEqual(env.OPERA_CLI_BROWSER_URL, undefined);
    assert.strictEqual(env.OPERA_CLI_USER_DATA_DIR, '/configured/profile');
    assert.deepStrictEqual(err, []);
  });

  it('restarts the browser and attaches when the user picks 1', async () => {
    const {deps, env, out, err, calls, asked} = makeDeps({
      interactive: true,
      answer: '1',
      target: conflictTarget(),
    });
    await preflightBrowser(['new_page'], 's1', false, deps);

    assert.strictEqual(calls.quit, 1);
    assert.strictEqual(calls.launch, 1);
    assert.strictEqual(env.OPERA_CLI_BROWSER_URL, 'http://127.0.0.1:9333');
    assert.strictEqual(env.OPERA_CLI_USER_DATA_DIR, '/configured/profile');
    // The two ways out, the profile that is in the way, and that tabs come back.
    const prompt = out.join('');
    assert.match(prompt, /\/configured\/profile/);
    assert.match(prompt, /\[1\] Restart Opera now/);
    assert.match(prompt, /\[2\] Use a separate profile instead/);
    // The question is asked by readline, which prints it itself; putting it in
    // the explanation too would show it twice on a terminal.
    assert.deepStrictEqual(asked, ['Select [1/2] (default 2): ']);
    assert.doesNotMatch(prompt, /Select \[1\/2\]/);
    assert.strictEqual(calls.resolve, 1);
    assert.match(err.join(''), /restarted Opera and attached at/);
  });

  it('uses a separate profile for any answer that is not 1', async () => {
    const {deps, env, err, calls, asked} = makeDeps({
      interactive: true,
      answer: '2',
      target: conflictTarget(),
    });
    await preflightBrowser(['new_page'], '', false, deps);

    assert.strictEqual(calls.quit, 0);
    assert.strictEqual(calls.launch, 0);
    assert.strictEqual(env.OPERA_CLI_USER_DATA_DIR, separateProfileDir());
    assert.strictEqual(env.OPERA_CLI_BROWSER_URL, undefined);
    assert.match(err.join(''), /using .* for this run/);
    // The user was asked once, and answered something other than 1.
    assert.strictEqual(asked.length, 1);
    // The fallback has to name something the user can act on, not just the
    // profile it refused to touch.
    assert.match(err.join(''), /--remote-debugging-port=0/);
  });

  it('falls back to a separate profile when there is no terminal', async () => {
    const {deps, env, out, asked} = makeDeps({target: conflictTarget()});
    await preflightBrowser(['new_page'], '', false, deps);
    assert.deepStrictEqual(asked, []);
    assert.deepStrictEqual(out, []);
    assert.strictEqual(env.OPERA_CLI_USER_DATA_DIR, separateProfileDir());
  });

  it('takes the browser over without asking when told to', async () => {
    const {deps, env, asked, calls} = makeDeps({
      interactive: true,
      target: conflictTarget(),
    });
    await preflightBrowser(['new_page'], '', true, deps);
    assert.deepStrictEqual(asked, []);
    assert.strictEqual(calls.quit, 1);
    assert.strictEqual(calls.launch, 1);
    assert.strictEqual(env.OPERA_CLI_BROWSER_URL, 'http://127.0.0.1:9333');
  });

  it('re-selects and takes over when start ran on another browser', async () => {
    const {deps, env, calls} = makeDeps({
      interactive: true,
      answer: '1',
      daemonArgs: async () => ['--isolated'],
      target: conflictTarget(),
    });
    await preflightBrowser(['start'], 's1', false, deps);
    assert.strictEqual(calls.quit, 1);
    assert.strictEqual(calls.launch, 1);
    assert.strictEqual(env.OPERA_CLI_BROWSER_URL, 'http://127.0.0.1:9333');
  });

  it('reports a browser it could not stop as a browser failure', async () => {
    const {deps} = makeDeps({
      interactive: true,
      answer: '1',
      quit: async () => ({ok: false, reason: 'timeout'}),
      target: conflictTarget(),
    });
    await assert.rejects(
      preflightBrowser(['new_page'], '', false, deps),
      (error: unknown) => {
        assert.ok(error instanceof CdpError);
        assert.strictEqual(error.code, 'BROWSER_ERROR');
        assert.match(error.message, /did not shut down/);
        return true;
      },
    );
  });

  it('reports a browser that would not come back, naming the reason', async () => {
    const {deps} = makeDeps({
      interactive: true,
      answer: '1',
      launch: async () => ({ok: false, reason: 'no-executable'}),
      target: conflictTarget(),
    });
    await assert.rejects(
      preflightBrowser(['new_page'], '', false, deps),
      (error: unknown) => {
        assert.ok(error instanceof CdpError);
        assert.strictEqual(error.code, 'BROWSER_ERROR');
        assert.match(error.message, /no-executable/);
        return true;
      },
    );
  });

  it('leaves a tool command alone while a daemon is driving a browser', async () => {
    const {deps, calls, asked} = makeDeps({
      interactive: true,
      daemonArgs: async () => ['--isolated'],
      target: conflictTarget(),
    });
    await preflightBrowser(['new_page'], '', false, deps);
    assert.strictEqual(calls.resolve, 0);
    assert.deepStrictEqual(asked, []);
  });

  it('takes the daemon down with the browser it selected', async () => {
    const {deps, env, calls} = makeDeps({
      interactive: true,
      answer: '1',
      daemonArgs: async () => ['--isolated'],
      target: conflictTarget(),
    });
    await preflightBrowser(['start'], 's1', false, deps);
    // The daemon fixed its browser at startup, so a new selection only reaches
    // the next one it starts.
    assert.strictEqual(calls.stopDaemon, 1);
    assert.strictEqual(env.OPERA_CLI_BROWSER_URL, 'http://127.0.0.1:9333');
  });

  it('does not mistake the restart’s own browser for a conflict', async () => {
    const {deps, calls} = makeDeps({
      interactive: true,
      daemonArgs: async () => ['--userDataDir=/configured/profile'],
    });
    await preflightBrowser(['start'], '', false, deps);
    assert.strictEqual(calls.resolve, 0);
  });

  it('re-selects the browser on start when the daemon drove a different one', async () => {
    const {deps, env, calls} = makeDeps({
      interactive: true,
      ask: async () => '2',
      daemonArgs: async () => ['--userDataDir=/other/profile'],
      target: conflictTarget(),
    });
    await preflightBrowser(['start'], '', false, deps);
    assert.strictEqual(calls.resolve, 1);
    assert.strictEqual(env.OPERA_CLI_USER_DATA_DIR, separateProfileDir());
  });
});

describe('settleBrowserConflict', () => {
  it('reports no change when the profile is free', async () => {
    const {deps, env} = makeDeps();
    assert.strictEqual(
      await settleBrowserConflict('', {takeover: false}, deps),
      false,
    );
    assert.strictEqual(env.OPERA_CLI_BROWSER_URL, undefined);
  });

  it('reports the attach URL it found on the configured profile', async () => {
    const {deps, env} = makeDeps({
      target: {mode: 'attach', url: 'http://127.0.0.1:9444', note: 'running'},
    });
    assert.strictEqual(
      await settleBrowserConflict('', {takeover: false}, deps),
      true,
    );
    assert.strictEqual(env.OPERA_CLI_BROWSER_URL, 'http://127.0.0.1:9444');
  });

  it('reports no change when the attach URL is the one already in use', async () => {
    const {deps} = makeDeps({
      target: {mode: 'attach', url: 'http://127.0.0.1:9444', note: 'running'},
    });
    deps.env.OPERA_CLI_BROWSER_URL = 'http://127.0.0.1:9444';
    assert.strictEqual(
      await settleBrowserConflict('', {takeover: false}, deps),
      false,
    );
  });

  it('settles a conflict, and takes the old browser’s daemon down with it', async () => {
    const {deps, env, calls} = makeDeps({
      interactive: true,
      answer: '1',
      daemonArgs: async () => ['--userDataDir=/configured/profile'],
      target: conflictTarget(),
    });
    assert.strictEqual(
      await settleBrowserConflict('s1', {takeover: false}, deps),
      true,
    );
    assert.strictEqual(calls.quit, 1);
    assert.strictEqual(calls.launch, 1);
    assert.strictEqual(calls.stopDaemon, 1);
    assert.strictEqual(env.OPERA_CLI_BROWSER_URL, 'http://127.0.0.1:9333');
  });

  it('believes a failure over a lock file that reads free', async () => {
    // A lock that is missing or unattributable reads "free" while the browser
    // it belongs to is very much running, and the failing launch is the
    // evidence that matters, so the question is still asked.
    const {deps, env, out} = makeDeps({
      interactive: true,
      answer: '',
      target: {mode: 'managed', note: 'profile is free'},
    });
    assert.strictEqual(
      await settleBrowserConflict(
        '',
        {takeover: false, reason: 'profile-in-use'},
        deps,
      ),
      true,
    );
    assert.strictEqual(env.OPERA_CLI_USER_DATA_DIR, separateProfileDir());
    assert.match(out.join(''), /\[2\] Use a separate profile instead/);
  });

  it('cannot settle a failure that names no profile', async () => {
    const {deps} = makeDeps(
      {target: {mode: 'managed', note: 'profile is free'}},
      {OPERA_CLI_EXECUTABLE_PATH: '/x/opera'},
    );
    assert.strictEqual(
      await settleBrowserConflict(
        '',
        {takeover: false, reason: 'profile-in-use'},
        deps,
      ),
      false,
    );
  });

  it('leaves the daemon alone when the selection did not change', async () => {
    const {deps, calls} = makeDeps({
      daemonArgs: async () => ['--userDataDir=/configured/profile'],
    });
    assert.strictEqual(
      await settleBrowserConflict('', {takeover: false}, deps),
      false,
    );
    assert.strictEqual(calls.stopDaemon, 0);
  });

  it('retires a daemon that would keep launching instead of attaching', async () => {
    // The browser was started with a debug port after the daemon was already
    // running on the profile; the attach URL is new to it.
    const {deps, env, calls} = makeDeps({
      daemonArgs: async () => ['--userDataDir=/configured/profile'],
      target: {mode: 'attach', url: 'http://127.0.0.1:9444', note: 'running'},
    });
    assert.strictEqual(
      await settleBrowserConflict(
        's1',
        {takeover: false, reason: 'unreachable'},
        deps,
      ),
      true,
    );
    assert.strictEqual(calls.stopDaemon, 1);
    assert.strictEqual(env.OPERA_CLI_BROWSER_URL, 'http://127.0.0.1:9444');
  });

  it('retires a daemon left attached to a browser that is gone', async () => {
    // The CLI found the endpoint for that daemon (a takeover, or a
    // DevToolsActivePort it read), and the environment of this run names no
    // browser: the attach target is ours to re-derive, and an attached browser
    // is never restarted, so nothing else will.
    const {deps, calls} = makeDeps({
      daemonArgs: async () => ['--browserUrl=http://127.0.0.1:53943'],
      target: {mode: 'managed', note: 'profile is free'},
    });
    assert.strictEqual(
      await settleBrowserConflict(
        's1',
        {takeover: false, reason: 'unreachable'},
        deps,
      ),
      true,
    );
    assert.strictEqual(calls.stopDaemon, 1);
  });

  it('leaves a launched daemon alone when its browser is unreachable', async () => {
    // A daemon that launched its browser relaunches it when it dies; there is
    // nothing pinned to re-derive.
    const {deps, calls} = makeDeps({
      daemonArgs: async () => ['--userDataDir=/configured/profile'],
      target: {mode: 'managed', note: 'profile is free'},
    });
    assert.strictEqual(
      await settleBrowserConflict(
        '',
        {takeover: false, reason: 'unreachable'},
        deps,
      ),
      false,
    );
    assert.strictEqual(calls.stopDaemon, 0);
  });

  it('leaves an attach target the user chose alone', async () => {
    // `--autoConnect` (and `--wsEndpoint`) are typed by the user, whose browser
    // is theirs to start again — which is what the failure says.
    const {deps, calls} = makeDeps({
      daemonArgs: async () => ['--autoConnect'],
      target: {mode: 'managed', note: 'profile is free'},
    });
    assert.strictEqual(
      await settleBrowserConflict(
        '',
        {takeover: false, reason: 'unreachable'},
        deps,
      ),
      false,
    );
    assert.strictEqual(calls.stopDaemon, 0);
  });

  it('leaves an attach URL the environment names alone', async () => {
    const {deps, calls} = makeDeps(
      {
        daemonArgs: async () => ['--browserUrl=http://127.0.0.1:9222'],
        target: {
          mode: 'attach',
          url: 'http://127.0.0.1:9222',
          note: 'OPERA_CLI_BROWSER_URL',
        },
      },
      {
        OPERA_CLI_USER_DATA_DIR: '/configured/profile',
        OPERA_CLI_BROWSER_URL: 'http://127.0.0.1:9222',
      },
    );
    assert.strictEqual(
      await settleBrowserConflict(
        '',
        {takeover: false, reason: 'unreachable'},
        deps,
      ),
      false,
    );
    assert.strictEqual(calls.stopDaemon, 0);
  });

  it('does not retire anything for an unrelated reason', async () => {
    const {deps, calls} = makeDeps({
      daemonArgs: async () => ['--browserUrl=http://127.0.0.1:53943'],
      target: {mode: 'managed', note: 'profile is free'},
    });
    assert.strictEqual(
      await settleBrowserConflict('', {takeover: false}, deps),
      false,
    );
    assert.strictEqual(calls.stopDaemon, 0);
  });
});

describe('extractTakeoverFlag', () => {
  it('reports and removes the flag wherever it appears', () => {
    const argv = ['new_page', '--takeover', 'https://example.com'];
    assert.strictEqual(extractTakeoverFlag(argv), true);
    assert.deepStrictEqual(argv, ['new_page', 'https://example.com']);
  });

  it('leaves an argv without the flag untouched', () => {
    const argv = ['new_page', 'https://example.com'];
    assert.strictEqual(extractTakeoverFlag(argv), false);
    assert.deepStrictEqual(argv, ['new_page', 'https://example.com']);
  });
});

describe('sessionIdFromArgv', () => {
  it('reads the session out of either spelling, before or after the command', () => {
    assert.strictEqual(
      sessionIdFromArgv(['node', 'cli', 'new_page', '--sessionId', 'abc']),
      'abc',
    );
    assert.strictEqual(
      sessionIdFromArgv(['node', 'cli', '--session-id=abc', 'new_page']),
      'abc',
    );
  });

  it('falls back to the same default yargs applies', () => {
    assert.strictEqual(sessionIdFromArgv(['node', 'cli', 'new_page']), '');
    // A missing value is not a session id: only a following argument is.
    assert.strictEqual(sessionIdFromArgv(['node', 'cli', '--sessionId']), '');
  });
});
