/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import sinon from 'sinon';

import type {ShutdownHandlers} from '../../src/opera/daemonShutdown.js';
import {
  installShutdownHandlers,
  recordShutdownReason,
} from '../../src/opera/daemonShutdown.js';
import {getRuntimeHome} from '../../src/daemon/utils.js';
import {readExitReason} from '../../src/opera/daemonLifecycle.js';

let runtimeDir: string;
let savedRuntimeDir: string | undefined;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'opera-daemon-shutdown-'));
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

describe('installShutdownHandlers', () => {
  const SIGNAL_REASONS: Record<string, string> = {
    SIGTERM: 'terminated by signal: SIGTERM',
    SIGINT: 'interrupted by signal: SIGINT',
    SIGHUP: 'hung up on signal: SIGHUP',
  };

  /** Capture what `installShutdownHandlers` registers, without touching the real
   * process: the listeners never fire outside a test that means them to. */
  function captureListeners(): {
    handlers: ShutdownHandlers;
    listeners: Map<string, (...args: unknown[]) => void>;
  } {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    sinon.stub(process, 'on').callsFake((event, fn) => {
      listeners.set(event as string, fn as (...args: unknown[]) => void);
      return process;
    });
    const handlers: ShutdownHandlers = {
      onSignal: sinon.stub().resolves(),
      onException: sinon.stub().resolves(),
    };
    installShutdownHandlers(handlers);
    return {handlers, listeners};
  }

  it('registers the three stop signals and both uncaught-error handlers', () => {
    const {listeners} = captureListeners();
    assert.deepStrictEqual([...listeners.keys()].sort(), [
      'SIGHUP',
      'SIGINT',
      'SIGTERM',
      'uncaughtException',
      'unhandledRejection',
    ]);
  });

  it('maps each signal to its exact shutdown reason', () => {
    const {handlers, listeners} = captureListeners();
    for (const [signal] of Object.entries(SIGNAL_REASONS)) {
      listeners.get(signal)!();
    }
    assert.deepStrictEqual(
      (handlers.onSignal as sinon.SinonStub)
        .getCalls()
        .map(call => call.args[0]),
      Object.values(SIGNAL_REASONS),
    );
  });

  it('reports an uncaught exception with its message', () => {
    const {handlers, listeners} = captureListeners();
    const consoleError = sinon.stub(console, 'error');

    listeners.get('uncaughtException')!(new Error('kaboom'));

    assert.strictEqual(consoleError.calledOnce, true);
    assert.ok(
      (handlers.onException as sinon.SinonStub).calledOnceWithExactly(
        'uncaught exception: kaboom',
      ),
    );
  });

  it('stringifies a non-Error uncaught throw', () => {
    const {handlers, listeners} = captureListeners();
    sinon.stub(console, 'error');

    listeners.get('uncaughtException')!('a bare string');

    assert.ok(
      (handlers.onException as sinon.SinonStub).calledOnceWithExactly(
        'uncaught exception: a bare string',
      ),
    );
  });

  it('reports an unhandled rejection with its message', () => {
    const {handlers, listeners} = captureListeners();
    sinon.stub(console, 'error');

    listeners.get('unhandledRejection')!(new Error('rejected'));

    assert.ok(
      (handlers.onException as sinon.SinonStub).calledOnceWithExactly(
        'unhandled rejection: rejected',
      ),
    );
  });
});

describe('recordShutdownReason', () => {
  it('records a truthy reason where the next CLI invocation reads it', () => {
    const sessionId = crypto.randomUUID();
    mkdirSync(getRuntimeHome(sessionId), {recursive: true});

    recordShutdownReason(sessionId, 'terminated by signal: SIGTERM');

    assert.strictEqual(
      readExitReason(sessionId),
      'terminated by signal: SIGTERM',
    );
  });

  it('writes nothing for a falsy or absent reason', () => {
    const sessionId = crypto.randomUUID();
    mkdirSync(getRuntimeHome(sessionId), {recursive: true});

    recordShutdownReason(sessionId, '');
    recordShutdownReason(sessionId, undefined);

    assert.strictEqual(readExitReason(sessionId), null);
  });
});
