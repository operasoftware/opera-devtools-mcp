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
  applyEnvToArgv,
  findUnknownConfigKeys,
  KNOWN_CONFIG_KEYS,
  loadOperaCliConfig,
  parseConfigValue,
  readConfigFile,
} from '../../src/opera/envConfig.js';

const tempDirs: string[] = [];

function tempConfigPath(content?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envconfig-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'config');
  if (content !== undefined) {
    fs.writeFileSync(file, content);
  }
  return file;
}

/** Run `fn` with console.error captured; returns what was written to it. */
function captureWarnings(fn: () => void): string[] {
  const warnings: string[] = [];
  const original = console.error;
  console.error = (msg: string) => {
    warnings.push(msg);
  };
  try {
    fn();
  } finally {
    console.error = original;
  }
  return warnings;
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

describe('parseConfigValue', () => {
  it('returns a bare value unchanged', () => {
    assert.strictEqual(
      parseConfigValue('/Applications/Opera.app'),
      '/Applications/Opera.app',
    );
  });

  it('strips a matching double-quote pair', () => {
    assert.strictEqual(parseConfigValue('"hello world"'), 'hello world');
  });

  it('strips a matching single-quote pair', () => {
    assert.strictEqual(parseConfigValue("'hello world'"), 'hello world');
  });

  it('unescapes internal escaped quotes', () => {
    assert.strictEqual(parseConfigValue('"a\\"b"'), 'a"b');
    assert.strictEqual(parseConfigValue("'a\\'b'"), "a'b");
  });
});

describe('readConfigFile', () => {
  it('returns {} for a missing file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envconfig-'));
    tempDirs.push(dir);
    assert.deepStrictEqual(readConfigFile(path.join(dir, 'nope')), {});
  });

  it('reads KEY=VALUE lines, skipping comments and blanks', () => {
    const file = tempConfigPath('# a comment\n\nOPERA_CLI_HEADED=1\n');
    assert.deepStrictEqual(readConfigFile(file), {OPERA_CLI_HEADED: '1'});
  });

  it('skips malformed lines with no `=`', () => {
    const file = tempConfigPath('no-equals-here\nOPERA_CLI_HEADED=1\n');
    assert.deepStrictEqual(readConfigFile(file), {OPERA_CLI_HEADED: '1'});
  });

  it('parses quoted values via parseConfigValue', () => {
    const file = tempConfigPath('OPERA_CLI_CHROME_ARGS="--enable-gpu"\n');
    assert.deepStrictEqual(readConfigFile(file), {
      OPERA_CLI_CHROME_ARGS: '--enable-gpu',
    });
  });

  it('treats an unreadable path as an empty config', () => {
    // A directory is deterministically unreadable by readFileSync on POSIX.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'envconfig-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'config');
    fs.mkdirSync(file);
    assert.deepStrictEqual(readConfigFile(file), {});
  });
});

describe('findUnknownConfigKeys', () => {
  it('ignores known keys', () => {
    assert.deepStrictEqual(findUnknownConfigKeys({OPERA_CLI_HEADED: '1'}), []);
  });

  it('suggests a known key for a near miss', () => {
    const result = findUnknownConfigKeys({OPERA_CLI_HAEDED: '1'});
    assert.deepStrictEqual(result, [
      {key: 'OPERA_CLI_HAEDED', suggestion: 'OPERA_CLI_HEADED'},
    ]);
  });

  it('gives no suggestion for an unrelated key', () => {
    const result = findUnknownConfigKeys({SOMETHING_ELSE: 'x'});
    assert.deepStrictEqual(result, [{key: 'SOMETHING_ELSE', suggestion: null}]);
  });

  it('only recognises the five Phase 1a keys', () => {
    assert.deepStrictEqual(KNOWN_CONFIG_KEYS, [
      'OPERA_CLI_EXECUTABLE_PATH',
      'OPERA_CLI_BROWSER_URL',
      'OPERA_CLI_USER_DATA_DIR',
      'OPERA_CLI_HEADED',
      'OPERA_CLI_CHROME_ARGS',
    ]);
  });
});

describe('loadOperaCliConfig', () => {
  it('promotes config entries that are not already set', () => {
    const file = tempConfigPath('OPERA_CLI_HEADED=1\n');
    loadOperaCliConfig(file);
    assert.strictEqual(process.env.OPERA_CLI_HEADED, '1');
  });

  it('does not overwrite an env var that is already set', () => {
    const file = tempConfigPath('OPERA_CLI_HEADED=1\n');
    process.env.OPERA_CLI_HEADED = '0';
    loadOperaCliConfig(file);
    assert.strictEqual(process.env.OPERA_CLI_HEADED, '0');
  });

  it('never promotes a key the fork does not read', () => {
    // The config file is user-writable data. Copying arbitrary keys out of it
    // would hand it the environment of the daemon the CLI spawns (a stray
    // `NODE_OPTIONS` would be honoured there). Unknown keys warn, nothing more.
    const file = tempConfigPath('OPERA_CLI_HAEDED=1\nSOMETHING_ELSE=2\n');

    const warnings = captureWarnings(() => {
      loadOperaCliConfig(file);
    });

    assert.strictEqual(process.env.OPERA_CLI_HAEDED, undefined);
    assert.strictEqual(process.env.SOMETHING_ELSE, undefined);
    assert.strictEqual(warnings.length, 2);
  });

  it('warns once per unknown key with the closest suggestion', () => {
    const file = tempConfigPath('OPERA_CLI_HAEDED=1\n');

    const warnings = captureWarnings(() => {
      loadOperaCliConfig(file);
    });

    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0]!, /OPERA_CLI_HEADED/);
    assert.match(warnings[0]!, /did you mean/);
  });
});

describe('applyEnvToArgv', () => {
  it('disables pageId routing only for CLI-spawned sessions', () => {
    const cli: string[] = ['--viaCli'];
    applyEnvToArgv(cli);
    assert.deepStrictEqual(cli, ['--viaCli', '--no-page-id-routing']);

    const direct: string[] = [];
    applyEnvToArgv(direct);
    assert.deepStrictEqual(direct, []);
  });
  it('maps OPERA_CLI_HEADED=1 to --headless=false', () => {
    process.env.OPERA_CLI_HEADED = '1';
    const argv: string[] = [];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, ['--headless=false']);
  });

  it('maps OPERA_CLI_HEADED=0 to --headless=true', () => {
    process.env.OPERA_CLI_HEADED = '0';
    const argv: string[] = [];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, ['--headless=true']);
  });

  it('keeps an explicit --headless flag over the env var', () => {
    process.env.OPERA_CLI_HEADED = '1';
    const argv: string[] = ['--headless=true'];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, ['--headless=true']);
  });

  it('accepts the true/false spellings of OPERA_CLI_HEADED', () => {
    process.env.OPERA_CLI_HEADED = 'true';
    const headed: string[] = [];
    applyEnvToArgv(headed);
    assert.deepStrictEqual(headed, ['--headless=false']);

    process.env.OPERA_CLI_HEADED = 'false';
    const headless: string[] = [];
    applyEnvToArgv(headless);
    assert.deepStrictEqual(headless, ['--headless=true']);
  });

  it('warns and injects nothing for an unusable OPERA_CLI_HEADED', () => {
    process.env.OPERA_CLI_HEADED = 'yes';
    const argv: string[] = [];

    const warnings = captureWarnings(() => {
      applyEnvToArgv(argv);
    });

    assert.deepStrictEqual(argv, []);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0]!, /OPERA_CLI_HEADED/);
  });

  it('treats a blank OPERA_CLI_HEADED as unset, without warning', () => {
    process.env.OPERA_CLI_HEADED = '   ';
    const argv: string[] = [];

    const warnings = captureWarnings(() => {
      applyEnvToArgv(argv);
    });

    assert.deepStrictEqual(argv, []);
    assert.deepStrictEqual(warnings, []);
  });

  it('maps OPERA_CLI_CHROME_ARGS, whitespace-split preserving order', () => {
    process.env.OPERA_CLI_CHROME_ARGS =
      '  --enable-gpu   --ignore-gpu-blocklist ';
    const argv: string[] = [];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, [
      '--chromeArg=--enable-gpu',
      '--chromeArg=--ignore-gpu-blocklist',
    ]);
  });

  it('emits no --chromeArg for a whitespace-only OPERA_CLI_CHROME_ARGS', () => {
    process.env.OPERA_CLI_CHROME_ARGS = '   ';
    const argv: string[] = [];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, []);
  });

  it('maps OPERA_CLI_BROWSER_URL', () => {
    process.env.OPERA_CLI_BROWSER_URL = 'http://127.0.0.1:9222';
    const argv: string[] = [];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, ['--browserUrl=http://127.0.0.1:9222']);
  });

  it('maps OPERA_CLI_USER_DATA_DIR to --userDataDir plus Opera profile flags', () => {
    process.env.OPERA_CLI_USER_DATA_DIR = '/tmp/opera-profile';
    const argv: string[] = [];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, [
      '--userDataDir=/tmp/opera-profile',
      '--ignoreDefaultChromeArg=--use-mock-keychain',
      '--ignoreDefaultChromeArg=--password-store=basic',
      '--ignoreDefaultChromeArg=--disable-extensions',
      '--ignoreDefaultChromeArg=--disable-component-extensions-with-background-pages',
      '--ignoreDefaultChromeArg=--disable-default-apps',
      '--ignoreDefaultChromeArg=--disable-background-networking',
      '--chromeArg=--show-component-extension-options',
    ]);
  });

  it('maps OPERA_CLI_EXECUTABLE_PATH', () => {
    process.env.OPERA_CLI_EXECUTABLE_PATH =
      '/Applications/Opera.app/Contents/MacOS/Opera';
    const argv: string[] = [];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, [
      '--executablePath=/Applications/Opera.app/Contents/MacOS/Opera',
    ]);
  });

  it('does not inject --userDataDir when a browser URL is already on argv', () => {
    process.env.OPERA_CLI_USER_DATA_DIR = '/tmp/env-profile';
    const argv: string[] = ['--browserUrl=http://127.0.0.1:9222'];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, ['--browserUrl=http://127.0.0.1:9222']);
  });

  it('does not inject --userDataDir when --isolated is on argv', () => {
    // yargs treats the two as mutually exclusive, so injecting the configured
    // dir alongside `--isolated` killed the MCP server during argument parsing
    // — the daemon reported "Connection closed" and the next command silently
    // ran on the persistent profile instead of a throwaway one.
    process.env.OPERA_CLI_USER_DATA_DIR = '/tmp/env-profile';
    const argv: string[] = ['--isolated'];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, ['--isolated']);
  });

  it('still injects the configured dir when isolation is only switched off', () => {
    process.env.OPERA_CLI_USER_DATA_DIR = '/tmp/env-profile';
    const argv: string[] = ['--no-isolated'];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, [
      '--no-isolated',
      '--userDataDir=/tmp/env-profile',
      '--ignoreDefaultChromeArg=--use-mock-keychain',
      '--ignoreDefaultChromeArg=--password-store=basic',
      '--ignoreDefaultChromeArg=--disable-extensions',
      '--ignoreDefaultChromeArg=--disable-component-extensions-with-background-pages',
      '--ignoreDefaultChromeArg=--disable-default-apps',
      '--ignoreDefaultChromeArg=--disable-background-networking',
      '--chromeArg=--show-component-extension-options',
    ]);
  });

  it('does not inject --executablePath when attaching by WS endpoint', () => {
    process.env.OPERA_CLI_EXECUTABLE_PATH = '/tmp/env-opera';
    const argv: string[] = [
      '--wsEndpoint=ws://127.0.0.1:9222/devtools/browser/abc',
    ];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, [
      '--wsEndpoint=ws://127.0.0.1:9222/devtools/browser/abc',
    ]);
  });

  it('does not inject --executablePath when --autoConnect is on argv', () => {
    process.env.OPERA_CLI_EXECUTABLE_PATH = '/tmp/env-opera';
    const argv: string[] = ['--autoConnect'];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, ['--autoConnect']);
  });

  it('keeps every explicit flag over its env var', () => {
    process.env.OPERA_CLI_HEADED = '1';
    process.env.OPERA_CLI_CHROME_ARGS = '--env-gpu';
    process.env.OPERA_CLI_BROWSER_URL = 'http://127.0.0.1:9222';
    process.env.OPERA_CLI_USER_DATA_DIR = '/tmp/env-profile';
    process.env.OPERA_CLI_EXECUTABLE_PATH = '/tmp/env-opera';
    const argv: string[] = [
      '--headless=true',
      '--chromeArg=--cli-arg',
      '--browserUrl=http://cli:9222',
      '--userDataDir=/tmp/cli-profile',
      '--executablePath=/tmp/cli-opera',
    ];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, [
      '--headless=true',
      '--chromeArg=--cli-arg',
      '--browserUrl=http://cli:9222',
      '--userDataDir=/tmp/cli-profile',
      '--executablePath=/tmp/cli-opera',
    ]);
  });

  it('ignores the deferred vars (hooks and takeover)', () => {
    process.env.OPERA_CLI_ENABLE_HOOKS = '1';
    process.env.OPERA_CLI_TAKEOVER = '1';
    const argv: string[] = [];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, []);
    // Deferred vars still surface as unknown keys until their owning phase lands.
    assert.deepStrictEqual(
      findUnknownConfigKeys({OPERA_CLI_ENABLE_HOOKS: '1'}),
      [{key: 'OPERA_CLI_ENABLE_HOOKS', suggestion: null}],
    );
    const takeover = findUnknownConfigKeys({OPERA_CLI_TAKEOVER: '1'});
    assert.deepStrictEqual(
      takeover.map(u => u.key),
      ['OPERA_CLI_TAKEOVER'],
    );
  });

  it('keeps the two-token --headless form over the env var', () => {
    process.env.OPERA_CLI_HEADED = '1';
    const argv: string[] = ['--headless', 'true'];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, ['--headless', 'true']);
  });

  it('honours every documented spelling of --browserUrl over OPERA_CLI_BROWSER_URL', () => {
    process.env.OPERA_CLI_BROWSER_URL = 'http://env:9222';
    for (const explicit of [
      '--browserUrl=http://cli:9222',
      '--browser-url=http://cli:9222',
      '-u=http://cli:9222',
      '--browser-url', // bare (two-token) form is just as explicit
    ]) {
      const argv: string[] = [explicit];
      applyEnvToArgv(argv);
      assert.deepStrictEqual(argv, [explicit]);
    }
  });

  it('honours the kebab-case --user-data-dir over OPERA_CLI_USER_DATA_DIR', () => {
    process.env.OPERA_CLI_USER_DATA_DIR = '/tmp/env-profile';
    for (const explicit of [
      '--userDataDir=/tmp/cli-profile',
      '--user-data-dir=/tmp/cli-profile',
    ]) {
      const argv: string[] = [explicit];
      applyEnvToArgv(argv);
      assert.deepStrictEqual(argv, [explicit]);
    }
  });

  it('honours every documented spelling of --wsEndpoint (no profile/executable injection)', () => {
    process.env.OPERA_CLI_USER_DATA_DIR = '/tmp/env-profile';
    process.env.OPERA_CLI_EXECUTABLE_PATH = '/tmp/env-opera';
    const endpoint = 'ws://127.0.0.1:9222/devtools/browser/abc';
    for (const explicit of [
      `--wsEndpoint=${endpoint}`,
      `--ws-endpoint=${endpoint}`,
      `-w=${endpoint}`,
    ]) {
      const argv: string[] = [explicit];
      applyEnvToArgv(argv);
      assert.deepStrictEqual(argv, [explicit]);
    }
  });

  it('honours every documented spelling of --executablePath over OPERA_CLI_EXECUTABLE_PATH', () => {
    process.env.OPERA_CLI_EXECUTABLE_PATH = '/tmp/env-opera';
    for (const explicit of [
      '--executablePath=/tmp/cli-opera',
      '--executable-path=/tmp/cli-opera',
      '-e=/tmp/cli-opera',
    ]) {
      const argv: string[] = [explicit];
      applyEnvToArgv(argv);
      assert.deepStrictEqual(argv, [explicit]);
    }
  });

  it('keeps --no-headless over OPERA_CLI_HEADED', () => {
    process.env.OPERA_CLI_HEADED = '1';
    const argv: string[] = ['--no-headless'];
    applyEnvToArgv(argv);
    assert.deepStrictEqual(argv, ['--no-headless']);
  });
});
