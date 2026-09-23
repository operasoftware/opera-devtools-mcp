/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {commands} from '../../src/config/cli-options.js';
import {getPidFilePath} from '../../src/daemon/utils.js';
import {registerToolCommand} from '../../src/opera/cliCommands.js';
import {normalizeRefArgs, refArgNames} from '../../src/opera/refArgs.js';
import {yargs} from '../../src/third_party/index.js';
import {VERSION} from '../../src/version.js';

/**
 * The whole premise of this module is that the snapshot prints `@4.11` and the
 * MCP tools take `4_11`, so the CLI has to translate between them at the
 * command boundary. These cases cover both halves: the naming rule that decides
 * which arguments are refs, and the frame the CLI actually puts on the socket.
 */

describe('refArgNames', () => {
  it('finds the ref arguments of a command', () => {
    assert.deepStrictEqual(refArgNames(commands.drag.args), [
      'from_uid',
      'to_uid',
    ]);
  });

  it('leaves non-ref arguments alone', () => {
    assert.deepStrictEqual(refArgNames(commands.fill.args), ['uid']);
  });
});

describe('normalizeRefArgs', () => {
  const fill = (uid: unknown) => normalizeRefArgs(commands.fill.args, {uid});

  it('translates the form the snapshot prints', () => {
    assert.deepStrictEqual(fill('@4.11'), {uid: '4_11'});
  });

  it('accepts an already-wire ref, and the bare display form', () => {
    assert.deepStrictEqual(fill('4_11'), {uid: '4_11'});
    assert.deepStrictEqual(fill('4.11'), {uid: '4_11'});
  });

  it('translates a single-part ref', () => {
    assert.deepStrictEqual(fill('@4'), {uid: '4'});
  });

  it('translates both ends of a drag', () => {
    assert.deepStrictEqual(
      normalizeRefArgs(commands.drag.args, {
        from_uid: '@4.11',
        to_uid: '@4.12',
      }),
      {from_uid: '4_11', to_uid: '4_12'},
    );
  });

  it('keeps the rest of the command arguments untouched', () => {
    assert.deepStrictEqual(
      normalizeRefArgs(commands.fill.args, {uid: '@4.11', value: '@4.11'}),
      {uid: '4_11', value: '@4.11'},
    );
  });

  it('keeps a non-string ref value untouched', () => {
    assert.deepStrictEqual(fill(4), {uid: 4});
  });
});

/**
 * The names are derived from a naming rule the generated table does not declare
 * as such, so pin the rule against the descriptions upstream writes for these
 * arguments. An intake merge that renames a ref argument, or adds one under a
 * name the rule misses, fails here instead of quietly shipping a ref the CLI
 * cannot translate — the failure the user sees is `Element uid "@4.11" not
 * found on page 58.`
 */
describe('ref argument intake guard', () => {
  // Deliberately not imported from `refArgs.ts`: the literal must drift only
  // when upstream does, and then loudly.
  const UPSTREAM_REF_DESCRIPTION = 'The uid of ';

  const named = Object.entries(commands)
    .flatMap(([command, def]) =>
      refArgNames(def.args).map(name => `${command}.${name}`),
    )
    .sort();
  const described = Object.entries(commands)
    .flatMap(([command, def]) =>
      Object.values(def.args)
        .filter(arg => arg.description.startsWith(UPSTREAM_REF_DESCRIPTION))
        .map(arg => `${command}.${arg.name}`),
    )
    .sort();

  it('names exactly the arguments upstream describes as refs', () => {
    assert.deepStrictEqual(
      named,
      described,
      'The ref naming rule and the upstream descriptions disagree: one of ' +
        'them now covers an argument the other does not. Re-check the ' +
        'generated table, then update refArgNames() in src/opera/refArgs.ts.',
    );
  });

  it('covers every command that takes a ref', () => {
    assert.deepStrictEqual(named, [
      'click.uid',
      'drag.from_uid',
      'drag.to_uid',
      'fill.uid',
      'hover.uid',
      'take_screenshot.uid',
      'upload_file.uid',
    ]);
  });
});

// --- The socket boundary ---

type Frame = Record<string, unknown>;

/** Frames the fake daemon received, in arrival order. */
let received: Frame[] = [];

/**
 * One fake connection per `net.createConnection`, answering as soon as a
 * request arrives: the daemon's real socket cannot be bound in a restricted
 * sandbox (an `AF_UNIX` bind is denied outright), and what is under test is the
 * frame the CLI sends, not the kernel's ability to carry it. Each connection
 * gets its own socket, because the CLI's version check and the tool call run
 * concurrently on separate connections.
 */
function fakeDaemon(): void {
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
        received.push(request);
        queueMicrotask(() =>
          socket.emit('data', Buffer.from(respondTo(request) + '\0')),
        );
      }
      return true;
    };
    socket.destroy = () => socket.emit('close');
    return socket as unknown as net.Socket;
  });
}

function respondTo(request: Frame): string {
  const frame: Frame =
    request.method === 'status'
      ? {
          success: true,
          result: JSON.stringify({
            pid: process.pid,
            socketPath: '',
            startDate: '',
            version: VERSION,
            args: [],
          }),
          error: null,
        }
      : {
          success: true,
          result: JSON.stringify({content: [{type: 'text', text: 'ok'}]}),
          error: null,
        };
  return JSON.stringify(frame);
}

/** Everything `sendCommand` checks before it connects: a live pid. */
function claimSession(): string {
  const sessionId = crypto.randomUUID();
  const pidFile = getPidFilePath(sessionId);
  mkdirSync(dirname(pidFile), {recursive: true});
  writeFileSync(pidFile, String(process.pid));
  return sessionId;
}

describe('a tool command on the wire', () => {
  let runtimeDir: string;
  let savedRuntimeDir: string | undefined;
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'opera-ref-args-'));
    savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    home = mkdtempSync(join(tmpdir(), 'opera-ref-args-home-'));
    savedHome = process.env.HOME;
    process.env.HOME = home;
    received = [];
  });

  afterEach(() => {
    sinon.restore();
    if (savedRuntimeDir === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = savedRuntimeDir;
    }
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    rmSync(runtimeDir, {recursive: true, force: true});
    rmSync(home, {recursive: true, force: true});
  });

  it('sends the ref in MCP form, not the form the snapshot printed', async () => {
    const sessionId = claimSession();
    fakeDaemon();

    const y = yargs([])
      .scriptName('opera-browser-cli')
      .option('sessionId', {type: 'string', default: sessionId, hidden: true})
      .strict()
      .demandCommand();
    registerToolCommand(y, 'fill', commands.fill, {
      start: () => Promise.reject(new Error('daemon must not be started')),
    });
    await y.parse(['fill', '@4.11', 'hello']);

    const calls = received.filter(frame => frame.method === 'invoke_tool');
    assert.strictEqual(calls.length, 1, 'exactly one tool call');
    assert.strictEqual(calls[0].tool, 'fill');
    assert.deepStrictEqual(calls[0].args, {uid: '4_11', value: 'hello'});
  });

  it('translates a ref passed as an optional flag too', async () => {
    const sessionId = claimSession();
    fakeDaemon();

    const y = yargs([])
      .scriptName('opera-browser-cli')
      .option('sessionId', {type: 'string', default: sessionId, hidden: true})
      .strict()
      .demandCommand();
    registerToolCommand(y, 'take_screenshot', commands.take_screenshot, {
      start: () => Promise.reject(new Error('daemon must not be started')),
    });
    await y.parse([
      'take_screenshot',
      '--uid',
      '@4.11',
      '--filePath',
      'shot.png',
    ]);

    const calls = received.filter(frame => frame.method === 'invoke_tool');
    assert.strictEqual(calls.length, 1, 'exactly one tool call');
    assert.strictEqual((calls[0].args as Record<string, unknown>).uid, '4_11');
  });
});
