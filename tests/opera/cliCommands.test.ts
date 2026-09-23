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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {getPidFilePath, getRuntimeHome} from '../../src/daemon/utils.js';
import {commands} from '../../src/config/cli-options.js';
import {CdpError} from '../../src/opera/cdpErrors.js';
import {
  registerOperaCommands,
  registerToolCommand,
} from '../../src/opera/cliCommands.js';
import {getDaemonLogPath} from '../../src/opera/daemonLog.js';
import {yargs} from '../../src/third_party/index.js';

type Frame = Record<string, unknown>;

/**
 * One fake connection per `net.createConnection`, answering as soon as a
 * request arrives. The daemon's real socket cannot be bound in a restricted
 * sandbox (an `AF_UNIX` bind is denied outright), and what is under test is
 * the command's behaviour, not the kernel's ability to carry the frame.
 */
function fakeDaemon(
  responder: (request: Frame) => string,
  received: Frame[],
): void {
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
          socket.emit('data', Buffer.from(responder(request) + '\0')),
        );
      }
      return true;
    };
    socket.destroy = () => socket.emit('close');
    return socket as unknown as net.Socket;
  });
}

/** Bring the daemon up the way `deps.start` would: a live pid file. */
function claimSession(sessionId: string): void {
  const pidFile = getPidFilePath(sessionId);
  mkdirSync(dirname(pidFile), {recursive: true});
  writeFileSync(pidFile, String(process.pid));
}

/** A `deps.start` that records its call and makes the daemon appear running. */
function recordingStart(fn: (args: string[], sessionId: string) => void) {
  return (args: string[], sessionId: string): Promise<void> => {
    fn(args, sessionId);
    claimSession(sessionId);
    return Promise.resolve();
  };
}

function makeYargs(sessionId: string) {
  return (
    yargs([])
      .scriptName('opera-browser-cli')
      // Command handlers under test may throw; re-throw rather than exiting.
      .exitProcess(false)
      .fail(() => {
        // Parse failures are asserted through the rejection, not yargs' exit.
      })
      .option('sessionId', {type: 'string', default: sessionId, hidden: true})
  );
}

describe('the fork commands through yargs', () => {
  let runtimeDir: string;
  let savedRuntimeDir: string | undefined;
  let home: string;
  let savedHome: string | undefined;
  let sessionId: string;

  beforeEach(() => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'opera-cli-cmd-'));
    savedRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtimeDir;
    home = mkdtempSync(join(tmpdir(), 'opera-cli-cmd-home-'));
    savedHome = process.env.HOME;
    process.env.HOME = home;
    sessionId = crypto.randomUUID();
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

  describe('logs', () => {
    it('re-expands -n and --errors so only the newest matching lines appear', async () => {
      const logFile = getDaemonLogPath(sessionId);
      mkdirSync(getRuntimeHome(sessionId), {recursive: true});
      writeFileSync(
        logFile,
        [
          'daemon started',
          'error: config failed',
          'request timeout',
          'access denied',
          'cannot connect',
        ].join('\n') + '\n',
      );

      const deps = {
        start: sinon.stub().callsFake(async () => {
          throw new Error('logs must not start a daemon');
        }),
      };
      const y = makeYargs(sessionId);
      registerOperaCommands(y, deps);
      const log = sinon.stub(console, 'log');

      await y.parse(['logs', '--errors', '-n', '3']);

      assert.strictEqual(deps.start.called, false, 'logs must not start');
      const output = log.firstCall.args[0] as string;
      assert.match(output, /^total: 5$/m, output);
      assert.match(output, /^matched: 4$/m, output);
      assert.match(output, /^lines: 3$/m, output);
      // The three newest failure lines, and nothing else.
      assert.ok(output.includes('cannot connect'), output);
      assert.ok(output.includes('access denied'), output);
      assert.ok(output.includes('request timeout'), output);
      assert.ok(!output.includes('config failed'), output);
      assert.ok(!output.includes('daemon started'), output);
    });
  });

  describe('setup', () => {
    it('re-expands --non-interactive, --executable, and --headless', async () => {
      const deps = {
        start: sinon.stub().callsFake(async () => {
          throw new Error('setup must not start a daemon');
        }),
      };
      const y = makeYargs(sessionId);
      registerOperaCommands(y, deps);
      const log = sinon.stub(console, 'log');

      await y.parse([
        'setup',
        '--non-interactive',
        '--executable',
        '/x/opera',
        '--headless',
      ]);

      const config = readFileSync(
        join(home, '.opera-browser-cli', 'config'),
        'utf-8',
      );
      assert.match(config, /^OPERA_CLI_EXECUTABLE_PATH="\/x\/opera"$/m, config);
      assert.ok(!config.includes('OPERA_CLI_HEADED'), config);
      assert.ok(log.calledOnce, 'setup reports its result');
    });
  });

  describe('url', () => {
    const TREE =
      '## Latest page snapshot\n@2.4 link "Example" url="https://example.com"';

    it('starts the daemon and resolves an element ref from a snapshot', async () => {
      const received: Frame[] = [];
      let startArgs: string[] | null = null;
      let startSessionId: string | null = null;

      fakeDaemon((request: Frame) => {
        if (request.method === 'invoke_tool') {
          return JSON.stringify({
            success: true,
            result: JSON.stringify({content: [{type: 'text', text: TREE}]}),
            error: null,
          });
        }
        return JSON.stringify({success: true, result: '{}', error: null});
      }, received);

      const deps = {
        start: sinon.stub().callsFake(
          recordingStart((args, sid) => {
            startArgs = args;
            startSessionId = sid;
          }),
        ),
      };
      const y = makeYargs(sessionId);
      registerOperaCommands(y, deps);
      const log = sinon.stub(console, 'log');

      await y.parse(['url', '@2.4']);

      // The daemon was not running, so the command started it first...
      assert.strictEqual(deps.start.calledOnce, true, 'deps.start was called');
      assert.strictEqual(startSessionId, sessionId);
      assert.ok(Array.isArray(startArgs), 'serialized argv is an array');

      // ...and then asked it for a fresh snapshot.
      const snapshotCall = received.find(f => f.method === 'invoke_tool');
      assert.strictEqual(snapshotCall?.tool, 'take_snapshot');
      assert.deepStrictEqual(snapshotCall?.args, {});

      assert.ok(log.calledWith('https://example.com'), 'resolved URL printed');
    });

    it('surfaces a failed daemon reply as a BROWSER_ERROR', async () => {
      const received: Frame[] = [];
      fakeDaemon(
        () =>
          JSON.stringify({
            success: false,
            result: null,
            error: 'daemon exploded',
          }),
        received,
      );

      const deps = {
        start: sinon.stub().callsFake(
          recordingStart(() => {
            // `start` is only asserted to have been called.
          }),
        ),
      };
      const y = makeYargs(sessionId);
      registerOperaCommands(y, deps);

      await assert.rejects(
        () => y.parseAsync(['url', '@2.4']),
        (err: unknown) =>
          err instanceof CdpError &&
          err.code === 'BROWSER_ERROR' &&
          err.message === 'daemon exploded',
      );
      assert.strictEqual(deps.start.calledOnce, true);
    });

    it('reports when the snapshot reply carries no snapshot at all', async () => {
      const received: Frame[] = [];
      fakeDaemon((request: Frame) => {
        if (request.method === 'invoke_tool') {
          return JSON.stringify({
            success: true,
            result: JSON.stringify({
              content: [{type: 'text', text: 'nothing to see here'}],
            }),
            error: null,
          });
        }
        return JSON.stringify({success: true, result: '{}', error: null});
      }, received);

      const deps = {
        start: sinon.stub().callsFake(
          recordingStart(() => {
            // `start` is only asserted to have been called.
          }),
        ),
      };
      const y = makeYargs(sessionId);
      registerOperaCommands(y, deps);

      await assert.rejects(
        () => y.parseAsync(['url', '@2.4']),
        (err: unknown) =>
          err instanceof CdpError &&
          err.code === 'BROWSER_ERROR' &&
          /No page snapshot available/.test(err.message) &&
          err.suggestions.some(s => s.includes('new_page')),
      );
    });
  });

  describe('tool failures', () => {
    /** What `McpPage.click` reports for a uid the page does not have. */
    const MISSING_UID = 'Element uid "999_999" not found on page 1.';
    /** What the tool appends when an Opera AI dispatch never reached the browser. */
    const NOT_DISPATCHED =
      'Opera.dispatchWithStreamedResponse(do) failed with error: Protocol error (Opera.dispatchWithStreamedResponse): The dispatcher was not able to dispatch: no target';

    /** Run one tool command against a daemon that always answers the same way. */
    async function runTool(
      commandName: 'click' | 'opera_do',
      argv: string[],
      result: unknown,
    ): Promise<{log: sinon.SinonStub; error: sinon.SinonStub}> {
      fakeDaemon(
        () =>
          JSON.stringify({
            success: true,
            result: JSON.stringify(result),
            error: null,
          }),
        [],
      );
      const deps = {
        start: sinon.stub().callsFake(
          recordingStart(() => {
            // `start` is only asserted to have been called.
          }),
        ),
      };
      const y = makeYargs(sessionId);
      registerToolCommand(y, commandName, commands[commandName]!, deps);
      const log = sinon.stub(console, 'log');
      const error = sinon.stub(console, 'error');

      await y.parse(argv);

      return {log, error};
    }

    it('reports a stale uid as a coded failure on stderr, not as a result', async () => {
      const saved = process.exitCode;
      try {
        const {log, error} = await runTool('click', ['click', '999_999'], {
          isError: true,
          content: [{type: 'text', text: MISSING_UID}],
        });

        assert.strictEqual(process.exitCode, 6, 'REF_NOT_FOUND is exit code 6');
        assert.strictEqual(log.called, false, 'a failure is not a result');
        const output = error.firstCall.args[0] as string;
        assert.match(output, /^code: REF_NOT_FOUND$/m);
        // TOON quotes the message, so the uid survives escaped rather than verbatim.
        assert.match(output, /999_999/);
        assert.match(output, /not found on page 1/);
        assert.match(output, /take_snapshot/, 'exit 6 names the next step');
      } finally {
        process.exitCode = saved;
      }
    });

    it('exits 3 and diagnoses the browser when a dispatch never landed', async () => {
      const saved = process.exitCode;
      try {
        const {log, error} = await runTool('opera_do', ['opera_do', 'test'], {
          content: [{type: 'text', text: NOT_DISPATCHED}],
        });

        assert.strictEqual(process.exitCode, 3, 'BROWSER_ERROR is exit code 3');
        assert.strictEqual(log.called, false, 'a failure is not a result');
        const output = error.firstCall.args[0] as string;
        assert.match(output, /^code: BROWSER_ERROR$/m);
        assert.match(output, /opera_do requires Opera Neon/);
        assert.ok(!output.includes(NOT_DISPATCHED), output);
        assert.match(output, /help\[\d+\]:/, 'the remedy travels with it');
      } finally {
        process.exitCode = saved;
      }
    });

    it('exits 3 when the AI extension is missing from the profile', async () => {
      const saved = process.exitCode;
      try {
        const {log, error} = await runTool('opera_do', ['opera_do', 'test'], {
          content: [
            {
              type: 'text',
              text: 'Opera.dispatchWithStreamedResponse(do) failed with error: Protocol error (Opera.dispatchWithStreamedResponse): Opera extension not available for this profile',
            },
          ],
        });

        assert.strictEqual(
          process.exitCode,
          3,
          'EXTENSION_NOT_FOUND is exit code 3',
        );
        assert.strictEqual(log.called, false, 'a failure is not a result');
        const output = error.firstCall.args[0] as string;
        assert.match(output, /^code: EXTENSION_NOT_FOUND$/m);
        assert.match(output, /AI extension is not available for this profile/);
        assert.match(output, /help\[\d+\]:/, 'the remedy travels with it');
      } finally {
        process.exitCode = saved;
      }
    });

    it('keeps json a raw passthrough even when the tool failed', async () => {
      const saved = process.exitCode;
      try {
        const {log, error} = await runTool(
          'click',
          ['click', '999_999', '--output-format', 'json'],
          {isError: true, content: [{type: 'text', text: MISSING_UID}]},
        );

        assert.strictEqual(process.exitCode, 6);
        assert.strictEqual(error.called, false, 'json owns stdout alone');
        assert.deepStrictEqual(JSON.parse(log.firstCall.args[0] as string), [
          {type: 'text', text: MISSING_UID},
        ]);
      } finally {
        process.exitCode = saved;
      }
    });
  });
});
