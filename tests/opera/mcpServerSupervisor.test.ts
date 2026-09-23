/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {describe, it} from 'node:test';
import {setTimeout as sleep} from 'node:timers/promises';

import {getRuntimeHome} from '../../src/daemon/utils.js';
import {readExitReason} from '../../src/opera/daemonLifecycle.js';
import {superviseMcpServer} from '../../src/opera/mcpServerSupervisor.js';
import type {
  Client,
  StdioClientTransport,
} from '../../src/third_party/index.js';

const RESPAWN_ATTEMPTS = 3;

interface FakeHandles {
  client: Client | null;
  transport: StdioClientTransport | null;
}

/** Wait for something the supervisor reaches asynchronously, or fail loudly. */
async function waitFor(what: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check() && Date.now() < deadline) {
    await sleep(10);
  }
  assert.ok(check(), `timed out waiting for ${what}`);
}

/**
 * A transport stand-in. The supervisor only ever identifies it and closes it, and
 * the close reports itself back exactly as the SDK's `onclose` does at runtime,
 * which is what makes the "did I cause this close?" logic observable here.
 */
function fakeTransport(
  onClose: (transport: StdioClientTransport) => void,
): StdioClientTransport {
  const transport = {
    close: async () => onClose(transport),
  } as unknown as StdioClientTransport;
  return transport;
}

/**
 * The daemon's wiring, minus the SDK: `connect` publishes a new transport into
 * `handles`, and `dyingDuringConnect` decides which attempt starts a server that
 * dies before `connect` returns.
 *
 * `report` is filled in after the supervisor exists — the two reference each
 * other, exactly as the daemon's `setupMCPClient` and its supervisor do.
 */
function harness(
  dyingDuringConnect: (attempt: number) => boolean = () => false,
) {
  const sessionId = crypto.randomUUID();
  // The daemon always runs with its runtime home created (it holds the pid
  // file); the exit-reason file lives there too.
  mkdirSync(getRuntimeHome(sessionId), {recursive: true, mode: 0o700});
  const handles: FakeHandles = {client: null, transport: null};
  const report: {close: (transport: StdioClientTransport) => void} = {
    close: _transport => undefined,
  };
  let connects = 0;
  let gaveUp = false;

  const connect = async () => {
    connects++;
    const transport = fakeTransport(candidate => report.close(candidate));
    handles.transport = transport;
    if (dyingDuringConnect(connects)) {
      // The server dies inside the same `connect`, before the supervisor has any
      // way to see it as "the current server".
      report.close(transport);
    }
  };

  const supervisor = superviseMcpServer({
    sessionId,
    connect,
    handles: () => handles,
    giveUp: async () => {
      gaveUp = true;
    },
  });
  report.close = transport => supervisor.onTransportClosed(transport);

  return {
    sessionId,
    supervisor,
    handles,
    connect,
    connects: () => connects,
    gaveUp: () => gaveUp,
  };
}

describe('superviseMcpServer', () => {
  it('brings up a replacement when the transport closes', async () => {
    const test = harness();
    await test.connect();
    const first = test.handles.transport!;

    test.supervisor.onTransportClosed(first);

    await waitFor('the replacement to connect', () => test.connects() === 2);
    // Releasing the dead transport closes it, and that close lands in the same
    // callback. It must not be read as the replacement dying too.
    assert.strictEqual(test.connects(), 2);
    assert.strictEqual(test.gaveUp(), false);
  });

  it('retries a replacement that dies while connect is still running', async () => {
    const test = harness(attempt => attempt === 2);
    await test.connect();

    test.supervisor.onTransportClosed(test.handles.transport!);

    await waitFor('a live replacement', () => test.connects() === 3);
    // Attempt 2's `connect` resolved with a server that was already dead. A
    // supervisor that trusted the resolution would sit believing the session is
    // healthy, and every later tool call would fail with nothing to recover it.
    assert.strictEqual(test.connects(), 3);
    assert.strictEqual(test.gaveUp(), false);
  });

  it('gives up and records why when no replacement survives its own startup', async () => {
    const test = harness(attempt => attempt > 1);
    await test.connect();

    test.supervisor.onTransportClosed(test.handles.transport!);

    await waitFor('the give-up', () => test.gaveUp());
    assert.strictEqual(test.connects(), 1 + RESPAWN_ATTEMPTS);
    assert.match(
      readExitReason(test.sessionId) ?? '',
      /MCP server respawn failed after 3 attempts/,
    );
  });

  it('does not respawn after stop, even though stopping closes the transport', async () => {
    const test = harness();
    await test.connect();

    test.supervisor.stop();
    test.supervisor.onTransportClosed(test.handles.transport!);

    await sleep(50);
    assert.strictEqual(test.connects(), 1);
  });

  it('gives up and records why when connect rejects outright', async () => {
    const sessionId = crypto.randomUUID();
    mkdirSync(getRuntimeHome(sessionId), {recursive: true, mode: 0o700});
    const handles: FakeHandles = {client: null, transport: null};
    const report: {close: (transport: StdioClientTransport) => void} = {
      close: _transport => undefined,
    };
    let connects = 0;
    let gaveUp = false;

    const connect = async () => {
      connects++;
      if (connects === 1) {
        handles.transport = fakeTransport(candidate => report.close(candidate));
        return;
      }
      // Every respawn attempt rejects before it can publish a server.
      throw new Error('spawn failed');
    };

    const supervisor = superviseMcpServer({
      sessionId,
      connect,
      handles: () => handles,
      giveUp: async () => {
        gaveUp = true;
      },
    });
    report.close = transport => supervisor.onTransportClosed(transport);

    await connect();
    supervisor.onTransportClosed(handles.transport!);

    await waitFor('the give-up', () => gaveUp);
    assert.strictEqual(connects, 1 + RESPAWN_ATTEMPTS);
    assert.match(
      readExitReason(sessionId) ?? '',
      /MCP server respawn failed after 3 attempts: spawn failed/,
    );
  });

  it('does not start a parallel respawn when a close arrives mid-respawn', async () => {
    const sessionId = crypto.randomUUID();
    mkdirSync(getRuntimeHome(sessionId), {recursive: true, mode: 0o700});
    const handles: FakeHandles = {client: null, transport: null};
    const report: {close: (transport: StdioClientTransport) => void} = {
      close: _transport => undefined,
    };
    let connects = 0;
    let blockNext = false;
    let unblock: (() => void) | undefined;

    const connect = async () => {
      connects++;
      const transport = fakeTransport(candidate => report.close(candidate));
      handles.transport = transport;
      if (blockNext) {
        blockNext = false;
        const {promise, resolve} = Promise.withResolvers<void>();
        unblock = resolve;
        await promise;
      }
    };

    const supervisor = superviseMcpServer({
      sessionId,
      connect,
      handles: () => handles,
      giveUp: async () => {
        // This case never reaches the give-up path.
      },
    });
    report.close = transport => supervisor.onTransportClosed(transport);

    await connect();
    const first = handles.transport!;

    // First close starts a respawn whose replacement connect blocks in flight.
    blockNext = true;
    supervisor.onTransportClosed(first);

    // Wait until that replacement connect is running and blocked.
    await waitFor('the respawn to be in flight', () => connects === 2);

    // A second close — the replacement dying during its own startup — arrives
    // while the respawn is still running. It must be coalesced into the one
    // in-flight attempt, not spawn a parallel one.
    supervisor.onTransportClosed(handles.transport!);
    await sleep(50);
    assert.strictEqual(connects, 2, 'no parallel respawn may start');

    // Let the blocked connect resolve so the run (and its retry) can settle.
    unblock!();
    await waitFor('the deferred retry', () => connects === 3);
  });
});
