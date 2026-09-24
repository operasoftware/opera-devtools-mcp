/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {afterEach, beforeEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {parseArguments} from '../../src/config/mcp-options.js';
import {
  noteToolFinished,
  noteToolStarted,
  otherBrowserUsers,
  resetBrowserActivity,
} from '../../src/opera/browserActivity.js';
import {
  OPERA_AUTOMATION_FLAGS,
  browserIdleWaitPolicy,
  describeBrowserMode,
  ensureBrowserFlagsForTool,
  isLaunchMode,
  resetOperaFlagState,
  toolRequiresOperaFlags,
} from '../../src/opera/browserFlags.js';

describe('describeBrowserMode', () => {
  it('reports a launch when no attach option is on the command line', () => {
    assert.strictEqual(
      describeBrowserMode(['--headless', '--isolated']),
      'launched (owned by this daemon)',
    );
  });

  it('reads the attach target out of the camelCase form', () => {
    assert.strictEqual(
      describeBrowserMode(['--browserUrl=http://127.0.0.1:9222']),
      'attached to http://127.0.0.1:9222',
    );
  });

  it('reads the kebab-case form the CLI documents', () => {
    // `--help` lists `--browser-url` and `--auto-connect`, and the daemon stores
    // the argv verbatim: reporting either as "launched" would claim ownership of
    // a browser the daemon must never restart.
    assert.strictEqual(
      describeBrowserMode(['--browser-url=http://127.0.0.1:9222']),
      'attached to http://127.0.0.1:9222',
    );
    assert.strictEqual(
      describeBrowserMode(['--auto-connect']),
      'attached to an external browser',
    );
  });

  it('reads a value given as the next argument', () => {
    assert.strictEqual(
      describeBrowserMode(['--browserUrl', 'http://127.0.0.1:9222']),
      'attached to http://127.0.0.1:9222',
    );
    assert.strictEqual(
      describeBrowserMode([
        '--ws-endpoint',
        'ws://127.0.0.1:9222/devtools/browser/abc',
      ]),
      'attached to ws://127.0.0.1:9222/devtools/browser/abc',
    );
  });

  it('names no target for an attach flag that carries no value', () => {
    assert.strictEqual(
      describeBrowserMode(['--autoConnect']),
      'attached to an external browser',
    );
    assert.strictEqual(
      describeBrowserMode(['--ws-endpoint', '--headless']),
      'attached to an external browser',
    );
  });

  it('reads a negated attach flag as a launch, the way yargs parses it', () => {
    assert.strictEqual(
      describeBrowserMode(['--no-autoConnect']),
      'launched (owned by this daemon)',
    );
    assert.strictEqual(
      describeBrowserMode(['--autoConnect=false']),
      'launched (owned by this daemon)',
    );
  });

  it('agrees with the predicate the server itself applies', () => {
    const argv = (extra: string[]) =>
      parseArguments('1.0.0', ['node', 'script.js', ...extra], {
        CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
      });

    for (const extra of [
      ['--browser-url=http://127.0.0.1:9222'],
      ['--wsEndpoint', 'ws://127.0.0.1:9222/devtools/browser/abc'],
      ['--auto-connect'],
      ['--no-autoConnect'],
      ['--headless'],
    ]) {
      assert.strictEqual(
        describeBrowserMode(extra).startsWith('launched'),
        isLaunchMode(argv(extra)),
        `argv: ${extra.join(' ')}`,
      );
    }
  });
});

describe('toolRequiresOperaFlags', () => {
  it('requires the flags only for the tools that drive Opera', () => {
    assert.strictEqual(toolRequiresOperaFlags('opera_do'), true);
    assert.strictEqual(toolRequiresOperaFlags('opera_research'), true);

    assert.strictEqual(toolRequiresOperaFlags('opera_chat'), false);
    assert.strictEqual(toolRequiresOperaFlags('opera_make'), false);
    assert.strictEqual(toolRequiresOperaFlags('opera_list_models'), false);
    assert.strictEqual(toolRequiresOperaFlags('take_snapshot'), false);
    assert.strictEqual(toolRequiresOperaFlags('fill'), false);
  });
});

describe('OPERA_AUTOMATION_FLAGS', () => {
  it('carries the flag that defeats the automation-controlled detection', () => {
    assert.ok(
      OPERA_AUTOMATION_FLAGS.includes(
        '--disable-blink-features=AutomationControlled',
      ),
    );
  });
});

describe('ensureBrowserFlagsForTool', () => {
  const args = (extra: string[]) =>
    parseArguments('1.0.0', ['node', 'script.js', ...extra], {
      CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: 'true',
    });

  const IDLE_WAIT_DEFAULTS = {...browserIdleWaitPolicy};

  /**
   * A browser this server launched, and the seams a relaunch goes through.
   * `getCurrentBrowser` answers with `current`, which is what the flags are
   * matched against — a browser that is not the one launched with them needs
   * them again.
   */
  function makeDeps() {
    const launched = {connected: true};
    const deps = {
      closeBrowserIfOpen: sinon.stub().resolves(),
      ensureBrowserLaunched: sinon.stub().resolves(launched),
      getCurrentBrowser: sinon.stub().returns(undefined) as sinon.SinonStub,
      sleep: sinon.stub<[number], Promise<void>>().resolves(),
    };
    return {launched, deps};
  }

  function control() {
    return {resetContext: sinon.stub()};
  }

  beforeEach(() => {
    resetOperaFlagState();
    resetBrowserActivity();
  });
  afterEach(() => {
    resetOperaFlagState();
    resetBrowserActivity();
    Object.assign(browserIdleWaitPolicy, IDLE_WAIT_DEFAULTS);
    sinon.restore();
  });

  it('never touches the browser when the server attached to one', async () => {
    const {deps} = makeDeps();
    const flags = control();

    await ensureBrowserFlagsForTool(
      'opera_do',
      args(['--browserUrl=http://127.0.0.1:9222']),
      undefined,
      flags,
      deps,
    );

    assert.strictEqual(flags.resetContext.called, false);
    assert.strictEqual(deps.closeBrowserIfOpen.called, false);
    assert.strictEqual(deps.ensureBrowserLaunched.called, false);
  });

  it('relaunches a launched browser with the Opera flags for opera_do', async () => {
    const {deps} = makeDeps();
    const flags = control();

    await ensureBrowserFlagsForTool(
      'opera_do',
      args([]),
      undefined,
      flags,
      deps,
    );

    assert.strictEqual(flags.resetContext.callCount, 1);
    assert.strictEqual(deps.closeBrowserIfOpen.callCount, 1);
    assert.strictEqual(deps.ensureBrowserLaunched.callCount, 1);

    const launched = deps.ensureBrowserLaunched.getCall(0).args[0] as {
      chromeArgs: string[];
    };
    assert.ok(
      launched.chromeArgs.includes(
        '--disable-blink-features=AutomationControlled',
      ),
    );
  });

  it('keeps the flags for the rest of the browser’s life', async () => {
    const {launched, deps} = makeDeps();
    const flags = control();

    await ensureBrowserFlagsForTool(
      'opera_do',
      args([]),
      undefined,
      flags,
      deps,
    );
    deps.getCurrentBrowser.returns(launched);
    flags.resetContext.resetHistory();
    deps.closeBrowserIfOpen.resetHistory();
    deps.ensureBrowserLaunched.resetHistory();

    await ensureBrowserFlagsForTool(
      'opera_do',
      args([]),
      undefined,
      flags,
      deps,
    );

    assert.strictEqual(flags.resetContext.called, false);
    assert.strictEqual(deps.closeBrowserIfOpen.called, false);
    assert.strictEqual(deps.ensureBrowserLaunched.called, false);
  });

  it('does not relaunch a browser that already has the flags for a tool that needs none', async () => {
    // The regression: terminal 1's `opera_do` leaves the browser carrying the
    // automation flags, and terminal 3's `take_snapshot` used to take them away
    // again by closing that browser — killing the streaming do with the AI
    // dispatcher's "no target" error.
    const {launched, deps} = makeDeps();
    const flags = control();

    await ensureBrowserFlagsForTool(
      'opera_do',
      args([]),
      undefined,
      flags,
      deps,
    );
    deps.getCurrentBrowser.returns(launched);
    flags.resetContext.resetHistory();
    deps.closeBrowserIfOpen.resetHistory();
    deps.ensureBrowserLaunched.resetHistory();

    await ensureBrowserFlagsForTool(
      'take_snapshot',
      args([]),
      undefined,
      flags,
      deps,
    );

    assert.strictEqual(flags.resetContext.called, false);
    assert.strictEqual(deps.closeBrowserIfOpen.called, false);
    assert.strictEqual(deps.ensureBrowserLaunched.called, false);
  });

  it('acquires the flags again for a browser relaunched without them', async () => {
    // A browser that died was relaunched by the next call without the Opera
    // flags, so the flags are a property of the browser holding them, not a
    // fact about the server.
    const {launched, deps} = makeDeps();
    const flags = control();

    await ensureBrowserFlagsForTool(
      'opera_do',
      args([]),
      undefined,
      flags,
      deps,
    );
    const replacement = {connected: true};
    deps.getCurrentBrowser.returns(replacement);
    assert.notStrictEqual(replacement, launched);
    flags.resetContext.resetHistory();
    deps.closeBrowserIfOpen.resetHistory();
    deps.ensureBrowserLaunched.resetHistory();

    await ensureBrowserFlagsForTool(
      'opera_do',
      args([]),
      undefined,
      flags,
      deps,
    );

    assert.strictEqual(flags.resetContext.callCount, 1);
    assert.strictEqual(deps.ensureBrowserLaunched.callCount, 1);
  });

  it('waits for another invocation to finish instead of closing under it', async () => {
    const {deps} = makeDeps();
    const flags = control();
    noteToolStarted('navigate_page');
    // The next pause of the wait is where the other invocation finishes, so the
    // wait itself is what is exercised — not a sleep long enough to guess at.
    deps.sleep.callsFake(async () => {
      noteToolFinished('navigate_page');
    });

    await ensureBrowserFlagsForTool(
      'opera_do',
      args([]),
      undefined,
      flags,
      deps,
    );

    sinon.assert.calledOnce(deps.sleep);
    assert.strictEqual(deps.closeBrowserIfOpen.callCount, 1);
    assert.strictEqual(deps.ensureBrowserLaunched.callCount, 1);
  });

  it('refuses rather than closing a browser another invocation is using', async () => {
    const {deps} = makeDeps();
    const flags = control();
    browserIdleWaitPolicy.timeoutMs = 0;

    noteToolStarted('take_snapshot');
    noteToolStarted('opera_chat');

    await assert.rejects(
      ensureBrowserFlagsForTool('opera_do', args([]), undefined, flags, deps),
      /in use by opera_chat, take_snapshot/,
    );

    assert.strictEqual(flags.resetContext.called, false);
    assert.strictEqual(deps.closeBrowserIfOpen.called, false);
    assert.strictEqual(deps.ensureBrowserLaunched.called, false);
  });

  it('counts only the invocations besides the one asking', () => {
    // The caller is one of the counted claims, so its own name is an "other"
    // only when the same tool is in flight twice.
    noteToolStarted('take_snapshot');
    assert.deepStrictEqual(otherBrowserUsers('take_snapshot'), []);

    noteToolStarted('take_snapshot');
    noteToolStarted('opera_chat');
    assert.deepStrictEqual(otherBrowserUsers('take_snapshot'), [
      'opera_chat',
      'take_snapshot',
    ]);

    noteToolFinished('take_snapshot');
    noteToolFinished('take_snapshot');
    noteToolFinished('opera_chat');
    assert.deepStrictEqual(otherBrowserUsers('take_snapshot'), []);

    // A release with nothing to release is ignored rather than counted down
    // into a negative claim.
    noteToolFinished('opera_chat');
    assert.deepStrictEqual(otherBrowserUsers('take_snapshot'), []);
  });
});
