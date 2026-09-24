/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {
  applySettingsToEnv,
  autoConfigure,
  computeAutoConfig,
  shouldAutoConfigure,
  updateConfigFile,
  writeConfigFile,
} from '../../src/opera/config.js';
import {getConfigFile, readConfigFile} from '../../src/opera/envConfig.js';

const NEON = '/Applications/Opera Neon.app/Contents/MacOS/Opera';

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opera-config-'));
  tempDirs.push(dir);
  return dir;
}

function existsOnly(...paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return p => set.has(p);
}

function resetEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('OPERA_CLI_')) {
      delete process.env[key];
    }
  }
}

beforeEach(resetEnv);

afterEach(() => {
  resetEnv();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

describe('computeAutoConfig', () => {
  it('configures a fresh machine from a detected browser', () => {
    const home = tempHome();
    const result = computeAutoConfig({
      home,
      platform: 'darwin',
      exists: existsOnly(NEON),
    });

    assert.strictEqual(result.status, 'configured');
    if (result.status !== 'configured') {
      return;
    }
    assert.strictEqual(result.browser.isNeon, true);
    assert.strictEqual(result.settings.OPERA_CLI_EXECUTABLE_PATH, NEON);
    // Headed, because sign-in and every Opera AI feature need a window.
    assert.strictEqual(result.settings.OPERA_CLI_HEADED, '1');
    assert.ok(result.settings.OPERA_CLI_USER_DATA_DIR);
  });

  it("prefers the browser's real profile over a private one", () => {
    const home = tempHome();
    const realProfile = path.join(
      home,
      'Library',
      'Application Support',
      'com.operasoftware.OperaNeon',
    );
    fs.mkdirSync(realProfile, {recursive: true});

    const result = computeAutoConfig({
      home,
      platform: 'darwin',
      exists: p => p === NEON || fs.existsSync(p),
    });

    assert.strictEqual(result.status, 'configured');
    if (result.status !== 'configured') {
      return;
    }
    assert.strictEqual(result.settings.OPERA_CLI_USER_DATA_DIR, realProfile);
  });

  it('falls back to a CLI-owned profile when there is no real one', () => {
    const home = tempHome();
    const result = computeAutoConfig({
      home,
      platform: 'darwin',
      exists: existsOnly(NEON),
    });

    assert.strictEqual(result.status, 'configured');
    if (result.status !== 'configured') {
      return;
    }
    assert.ok(
      result.settings.OPERA_CLI_USER_DATA_DIR!.includes('.opera-browser-cli'),
    );
  });

  it('does nothing when a config file already exists', () => {
    const home = tempHome();
    writeConfigFile({OPERA_CLI_HEADED: '1'}, home);

    assert.deepStrictEqual(
      computeAutoConfig({home, platform: 'darwin', exists: () => true}),
      {status: 'already-configured'},
    );
  });

  it('does nothing when the environment already points at a browser', () => {
    process.env.OPERA_CLI_EXECUTABLE_PATH = NEON;

    assert.deepStrictEqual(
      computeAutoConfig({
        home: tempHome(),
        platform: 'darwin',
        exists: existsOnly(NEON),
      }),
      {status: 'already-configured'},
    );
  });

  it('honours the env seam without touching process.env', () => {
    assert.deepStrictEqual(
      computeAutoConfig({
        home: tempHome(),
        platform: 'darwin',
        exists: existsOnly(NEON),
        env: {OPERA_CLI_EXECUTABLE_PATH: NEON},
      }),
      {status: 'already-configured'},
    );
  });

  it('reports no-browser rather than writing a useless config', () => {
    assert.deepStrictEqual(
      computeAutoConfig({
        home: tempHome(),
        platform: 'darwin',
        exists: () => false,
      }),
      {status: 'no-browser'},
    );
  });
});

describe('autoConfigure', () => {
  it('writes the config and applies it to this process', () => {
    const home = tempHome();
    const result = autoConfigure({
      home,
      platform: 'darwin',
      exists: existsOnly(NEON),
    });

    assert.strictEqual(result.status, 'configured');
    assert.strictEqual(fs.existsSync(getConfigFile(home)), true);
    // Applied in-process too, so the very first command benefits.
    assert.strictEqual(process.env.OPERA_CLI_EXECUTABLE_PATH, NEON);
  });

  it('never overwrites a value already set in the environment', () => {
    process.env.OPERA_CLI_HEADED = '0';

    autoConfigure({
      home: tempHome(),
      platform: 'darwin',
      exists: existsOnly(NEON),
    });

    assert.strictEqual(process.env.OPERA_CLI_HEADED, '0');
  });

  it('writes the settings into the env seam, not the real environment', () => {
    // `env` is the seam computeAutoConfig reads; the write side must honour it
    // too, or a caller passing one still mutates the test runner's env.
    const seam: NodeJS.ProcessEnv = {};

    const result = autoConfigure({
      home: tempHome(),
      platform: 'darwin',
      exists: existsOnly(NEON),
      env: seam,
    });

    assert.strictEqual(result.status, 'configured');
    assert.strictEqual(seam.OPERA_CLI_EXECUTABLE_PATH, NEON);
    assert.strictEqual(process.env.OPERA_CLI_EXECUTABLE_PATH, undefined);
    assert.strictEqual(process.env.OPERA_CLI_HEADED, undefined);
  });

  it('still applies settings when the config file cannot be written', () => {
    const home = tempHome();
    fs.rmSync(home, {recursive: true, force: true});
    fs.writeFileSync(home, 'not a directory');

    const warnings: string[] = [];
    const original = console.error;
    console.error = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const result = autoConfigure({
        home,
        platform: 'darwin',
        exists: existsOnly(NEON),
      });

      assert.strictEqual(result.status, 'configured');
      assert.strictEqual(process.env.OPERA_CLI_EXECUTABLE_PATH, NEON);
    } finally {
      console.error = original;
    }
    // A broken state dir must leave a breadcrumb: `doctor` is a later phase.
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0]!, /could not save configuration/);
    assert.ok(warnings[0]!.includes(getConfigFile(home)));
  });
});

describe('applySettingsToEnv', () => {
  it('sets un-set keys and leaves already-set keys alone', () => {
    process.env.OPERA_CLI_HEADED = '0';

    applySettingsToEnv({
      OPERA_CLI_HEADED: '1',
      OPERA_CLI_EXECUTABLE_PATH: NEON,
    });

    assert.strictEqual(process.env.OPERA_CLI_HEADED, '0');
    assert.strictEqual(process.env.OPERA_CLI_EXECUTABLE_PATH, NEON);
  });
});

describe('config file round-trip', () => {
  it('preserves values containing quotes', () => {
    const home = tempHome();
    writeConfigFile({OPERA_CLI_CHROME_ARGS: '--flag="value"'}, home);

    assert.strictEqual(
      readConfigFile(getConfigFile(home)).OPERA_CLI_CHROME_ARGS,
      '--flag="value"',
    );
  });

  it('patches without disturbing other keys', () => {
    const home = tempHome();
    writeConfigFile(
      {OPERA_CLI_HEADED: '1', OPERA_CLI_BROWSER_URL: 'http://x'},
      home,
    );

    updateConfigFile(
      {OPERA_CLI_BROWSER_URL: null, OPERA_CLI_EXECUTABLE_PATH: NEON},
      home,
    );

    assert.deepStrictEqual(readConfigFile(getConfigFile(home)), {
      OPERA_CLI_HEADED: '1',
      OPERA_CLI_EXECUTABLE_PATH: NEON,
    });
  });

  it('refuses a value that would be truncated on read', () => {
    // The reader splits on `\n` and drops the tail, so writing one would
    // silently lose data — a loud failure is the only safe option.
    const home = tempHome();
    assert.throws(
      () => writeConfigFile({OPERA_CLI_CHROME_ARGS: '--foo=a\nb'}, home),
      /contains a newline/,
    );
    assert.throws(
      () => updateConfigFile({OPERA_CLI_CHROME_ARGS: 'a\nb'}, home),
      /contains a newline/,
    );
    assert.strictEqual(fs.existsSync(getConfigFile(home)), false);
  });

  it('tightens the file permissions on every write, not just creation', () => {
    const home = tempHome();
    const file = getConfigFile(home);
    writeConfigFile({OPERA_CLI_HEADED: '1'}, home);
    // A file that predates this tool (or was hand-written) may be world-readable.
    fs.chmodSync(file, 0o644);

    updateConfigFile({OPERA_CLI_BROWSER_URL: 'http://x'}, home);

    // Windows has no POSIX permission bits to assert on: `statSync().mode`
    // reports the read-only attribute rather than the mode a write asked for.
    if (process.platform !== 'win32') {
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    }
    assert.strictEqual(
      readConfigFile(file)['OPERA_CLI_BROWSER_URL'],
      'http://x',
    );
  });
});

describe('shouldAutoConfigure', () => {
  const suite = ['node', 'opera-browser-cli'];

  it('allows action commands', () => {
    assert.strictEqual(shouldAutoConfigure([...suite, 'new_page']), true);
    assert.strictEqual(shouldAutoConfigure([...suite, 'start']), true);
    assert.strictEqual(shouldAutoConfigure([...suite, 'doctor']), true);
    assert.strictEqual(shouldAutoConfigure(suite), true); // no command
  });

  it('skips the inspection commands', () => {
    assert.strictEqual(shouldAutoConfigure([...suite, 'logs']), false);
    assert.strictEqual(shouldAutoConfigure([...suite, 'setup']), false);
  });

  it('skips help/version flags anywhere in argv (regression: start --help)', () => {
    for (const flag of ['--help', '-h', '--version', '-v', '-V']) {
      assert.strictEqual(shouldAutoConfigure([...suite, flag]), false);
      assert.strictEqual(shouldAutoConfigure([...suite, 'start', flag]), false);
      assert.strictEqual(
        shouldAutoConfigure([...suite, 'new_page', flag]),
        false,
      );
    }
  });
});
