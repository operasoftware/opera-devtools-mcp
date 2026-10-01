/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import os from 'node:os';
import {afterEach, beforeEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {
  getEffectiveHome,
  isMigrationActive,
  isProcessAlive,
  MIGRATION_ACTIVE_UNTIL,
  resolveGlobalPrefix,
  terminateProcess,
} from '../../src/opera/migrationShared.js';

/** Every variable these helpers read; each test starts from none of them set. */
const ENV_KEYS = [
  'npm_config_global',
  'INIT_CWD',
  'npm_config_prefix',
  'NPM_CONFIG_PREFIX',
  'SUDO_USER',
  'SUDO_UID',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  sinon.restore();
});

describe('isMigrationActive', () => {
  it('runs right up to the sunset instant, inclusive', () => {
    assert.strictEqual(isMigrationActive(MIGRATION_ACTIVE_UNTIL), true);
  });

  it('is closed one instant after the sunset date', () => {
    assert.strictEqual(
      isMigrationActive(new Date(MIGRATION_ACTIVE_UNTIL.getTime() + 1)),
      false,
    );
  });

  it('is active well before the sunset date', () => {
    assert.strictEqual(
      isMigrationActive(
        new Date(MIGRATION_ACTIVE_UNTIL.getTime() - 86_400_000),
      ),
      true,
    );
  });
});

describe('resolveGlobalPrefix', () => {
  it('prefers the prefix npm sets during a global install', () => {
    process.env.npm_config_prefix = '/npm/prefix';
    // Windows environment variables are case-insensitive, so these two
    // spellings are one variable there and cannot hold different values: the
    // precedence is a POSIX-only distinction.
    if (process.platform !== 'win32') {
      process.env.NPM_CONFIG_PREFIX = '/other/prefix';
    }
    assert.strictEqual(resolveGlobalPrefix(), '/npm/prefix');
  });

  it('accepts the prefix pnpm spells in upper case', () => {
    process.env.NPM_CONFIG_PREFIX = '/pnpm/prefix';
    assert.strictEqual(resolveGlobalPrefix(), '/pnpm/prefix');
  });

  it('reports nothing for a checkout that is not a global install', () => {
    // This suite runs out of a development checkout, so the copy asking the
    // question is not under any `node_modules`. The old fallback asked npm,
    // which answered with the *user's* global prefix — a prefix this copy has
    // nothing to do with, and the wrong thing to hang an install notice on.
    assert.strictEqual(resolveGlobalPrefix(), null);
  });
});

describe('getEffectiveHome', () => {
  it('answers for the process when neither sudo variable is set', () => {
    assert.strictEqual(getEffectiveHome(), os.homedir());
  });

  it('needs both sudo variables to look past the process', () => {
    process.env.SUDO_USER = 'someone-else';
    assert.strictEqual(getEffectiveHome(), os.homedir());
  });

  it('refuses a sudo user name that is not a plain login name', () => {
    // Nothing here may reach a shell: `~$(...)` would expand.
    process.env.SUDO_USER = 'root; touch /tmp/opera-should-not-exist';
    process.env.SUDO_UID = '0';
    assert.strictEqual(getEffectiveHome(), os.homedir());
  });

  it("answers for the invoking user's home under sudo", () => {
    const user = os.userInfo();
    process.env.SUDO_USER = user.username;
    process.env.SUDO_UID = String(user.uid);
    // The invoking user in this test *is* the process user, so the sudo path
    // and the fallback agree - what is asserted is that it resolves, not throws.
    // On Windows the sudo lookup is skipped outright, and this is the fallback.
    assert.strictEqual(getEffectiveHome(), os.homedir());
  });
});

describe('terminateProcess', () => {
  const started: number[] = [];

  afterEach(() => {
    for (const pid of started.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  /**
   * A process kept alive by a listening socket, not a timer, and one that says
   * when it is up — so the test waits on the real signal instead of guessing.
   */
  const spawnLongLived = async () => {
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
  };

  it('counts a live process as alive and a reaped pid as not', async () => {
    const child = await spawnLongLived();
    assert.strictEqual(isProcessAlive(child.pid!), true);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    assert.strictEqual(isProcessAlive(child.pid!), false);
  });

  it('stops a process that respects SIGTERM', async () => {
    const child = await spawnLongLived();
    // Attach before the kill: the event fires inside `terminateProcess`.
    const exited = once(child, 'exit');
    assert.strictEqual(await terminateProcess(child.pid!), true);
    await exited;
    assert.strictEqual(isProcessAlive(child.pid!), false);
  });
});
