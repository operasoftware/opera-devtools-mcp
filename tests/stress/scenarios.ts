/**
 * @license
 * Copyright 2026 Opera Software AS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The eight stress scenarios of the first iteration, from
 * `docs/specs/stress-test-system-plan.md`.
 *
 * Each scenario asserts the robustness property the product promises - no
 * orphaned process survives, any abnormal termination is recovered from - not
 * the behaviour the code happens to have today. Where the plan's Expected
 * Results table documents a current defect, today's run fails and the
 * assertion message names the processes that leaked, which is the bug report.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';

import {
  getDaemonPid,
  getPidFilePath,
  isDaemonRunning,
} from '../../src/daemon/utils.js';
import {MCP_BIN_NAME} from '../../src/opera/branding.js';

import {
  assertNoOrphans,
  assertNoOrphansWithin,
  cleanupSession,
  createProfileDir,
  delay,
  describeProcs,
  findSessionLeftovers,
  findSessionProcesses,
  getDescendantPids,
  isPidAlive,
  killProcess,
  persistentProfileArgs,
  profileDirOf,
  registerSessionProcesses,
  runCliQuiet,
  sendRawSocketMessage,
  sessionStartArgs,
  startDaemonForTest,
  waitFor,
  waitForProcessExit,
  waitForSessionProcessRole,
  type Scenario,
  type SessionProcess,
} from './helpers.js';

/** How many pages a page-listing response reports (`"<id>: <url>"` rows). */
function pageCount(stdout: string): number {
  return (stdout.match(/^\d+: /gm) ?? []).length;
}

/** Launch the browser through a tool call, then wait for its page to be up. */
async function openPage(sessionId: string): Promise<void> {
  const result = await runCliQuiet(
    ['navigate_page', '--url', 'about:blank'],
    sessionId,
  );
  assert.strictEqual(
    result.status,
    0,
    `navigate_page failed: ${result.stderr}`,
  );
}

/**
 * A1 - the liveness check is pid-file-only, so deleting the pid file hides a
 * live daemon. The next `start` cannot see it, spawns a second daemon, and the
 * first one keeps running: an orphan with an unlinked socket.
 */
export const A1: Scenario = {
  id: 'A1',
  title: 'a daemon hidden by a stale pid file is reaped by the next start',
  iterations: 5,
  run: async sessionId => {
    const firstPid = await startDaemonForTest(sessionId);
    assert.strictEqual(
      getDaemonPid(sessionId),
      firstPid,
      'the pid file should name the daemon that was just started',
    );
    assert.ok(
      isDaemonRunning(sessionId),
      'the daemon should report as running',
    );

    // The pid file is the only liveness signal there is.
    fs.unlinkSync(getPidFilePath(sessionId));
    assert.ok(
      !isDaemonRunning(sessionId),
      'without a pid file the session must report as not running (pid-file-only liveness)',
    );

    const secondPid = await startDaemonForTest(sessionId);
    assert.notStrictEqual(
      secondPid,
      firstPid,
      'the restart must fork a new daemon',
    );
    assert.strictEqual(getDaemonPid(sessionId), secondPid);

    assert.ok(
      !isPidAlive(firstPid),
      `daemon ${firstPid} survived the restart and is now an invisible orphan; ` +
        `the session is served by ${secondPid}`,
    );
    await assertNoOrphans(sessionId);
  },
};

/**
 * A2 - two clients racing through `start` both observe "not running". The
 * unlucky interleaving leaves two daemons, one of which the pid file does not
 * mention (and whose socket the loser unlinked).
 */
export const A2: Scenario = {
  id: 'A2',
  title: 'concurrent starts leave exactly one daemon',
  iterations: 10,
  run: async sessionId => {
    const results = await Promise.all([
      runCliQuiet(sessionStartArgs(sessionId), sessionId),
      runCliQuiet(sessionStartArgs(sessionId), sessionId),
    ]);

    const winner = getDaemonPid(sessionId);
    assert.ok(
      winner !== null,
      `no daemon wrote a pid file; start statuses: ${results
        .map(result => result.status)
        .join(', ')}`,
    );
    await registerSessionProcesses(sessionId);

    const daemons = (await findSessionProcesses(sessionId)).filter(
      proc => proc.role === 'daemon',
    );
    assert.strictEqual(
      daemons.length,
      1,
      `expected exactly one daemon for the session, found ${daemons.length}:\n${describeProcs(daemons)}`,
    );
    assert.strictEqual(
      daemons[0].pid,
      winner,
      'the pid file must name the surviving daemon',
    );
    assert.ok(
      isDaemonRunning(sessionId),
      'the surviving daemon must be reachable',
    );
    await assertNoOrphans(sessionId);
  },
};

/**
 * B1/B2 - the daemon spawns the MCP server as an unsupervised stdio child. When
 * that child dies the daemon stays up and keeps answering `status`, but every
 * tool call is broken until something respawns it.
 */
async function crashMcpServer(
  sessionId: string,
  signal: NodeJS.Signals,
): Promise<void> {
  const daemonPid = await startDaemonForTest(sessionId);
  await openPage(sessionId);
  const mcpServer = await waitForSessionProcessRole(
    sessionId,
    'mcp-server',
    15_000,
  );

  assert.ok(
    await killProcess(mcpServer.pid, sessionId, signal),
    `the MCP server ${mcpServer.pid} was already gone`,
  );
  assert.ok(
    await waitForProcessExit(mcpServer.pid, 5_000),
    `the MCP server ${mcpServer.pid} survived ${signal} and is now a zombie or a leak`,
  );
  assert.ok(
    isPidAlive(daemonPid),
    `the daemon ${daemonPid} must survive an MCP server ${signal}`,
  );

  const brokenCall = await runCliQuiet(['list_pages'], sessionId);
  const evidence = `tool call after ${signal}: status=${brokenCall.status} stdout=${JSON.stringify(
    brokenCall.stdout.trim().slice(0, 200),
  )}`;

  let revived: SessionProcess;
  try {
    revived = await waitForSessionProcessRole(
      sessionId,
      'mcp-server',
      5_000,
      mcpServer.pid,
    );
  } catch {
    const leftovers = await findSessionProcesses(sessionId);
    assert.fail(
      `the daemon ${daemonPid} is still alive but never respawned its MCP server within 5s ` +
        `(${evidence}); session processes:\n${describeProcs(leftovers)}`,
    );
  }
  assert.notStrictEqual(
    revived.pid,
    mcpServer.pid,
    'the respawned MCP server must be a new process',
  );

  await waitFor(
    'a working tool call after the MCP server was respawned',
    10_000,
    async () => {
      const result = await runCliQuiet(['list_pages'], sessionId);
      return result.status === 0 ? {value: result} : null;
    },
  );
  // The respawn has to replace the MCP server, not add one. This is the leak
  // the orphan assertion below no longer covers: a second server is a child of
  // the live daemon, so it is inside the live tree by definition.
  const servers = (await findSessionProcesses(sessionId)).filter(
    proc => proc.role === 'mcp-server',
  );
  assert.deepStrictEqual(
    servers.map(proc => proc.pid),
    [revived.pid],
    `the respawn left ${servers.length} MCP server(s):\n${describeProcs(servers)}`,
  );
  await assertNoOrphansWithin(sessionId, 5_000);
}

export const B1: Scenario = {
  id: 'B1',
  title: 'a SIGKILLed MCP server is respawned by its daemon',
  iterations: 5,
  run: sessionId => crashMcpServer(sessionId, 'SIGKILL'),
};

export const B2: Scenario = {
  id: 'B2',
  title: 'an aborted MCP server is respawned by its daemon',
  iterations: 5,
  run: sessionId => crashMcpServer(sessionId, 'SIGABRT'),
};

/**
 * C1 - the browser lives under the MCP server. Killing it is survivable: the
 * next tool call is expected to relaunch a browser lazily and cleanly.
 */
export const C1: Scenario = {
  id: 'C1',
  title: 'a crashed browser is relaunched by the next tool call',
  iterations: 10,
  run: async sessionId => {
    const daemonPid = await startDaemonForTest(sessionId);
    await openPage(sessionId);
    const browser = await waitForSessionProcessRole(
      sessionId,
      'browser',
      15_000,
    );
    await registerSessionProcesses(sessionId);

    assert.ok(
      await killProcess(browser.pid, sessionId),
      `the browser ${browser.pid} was already gone`,
    );
    assert.ok(
      await waitForProcessExit(browser.pid, 5_000),
      `the browser ${browser.pid} survived SIGKILL`,
    );
    assert.ok(isPidAlive(daemonPid), 'the daemon must survive a browser crash');

    const mcpServer = await waitForSessionProcessRole(
      sessionId,
      'mcp-server',
      5_000,
    );
    assert.ok(
      isPidAlive(mcpServer.pid),
      `the MCP server ${mcpServer.pid} must survive a browser crash`,
    );

    await waitFor('a tool call to relaunch the browser', 10_000, async () => {
      const result = await runCliQuiet(['list_pages'], sessionId);
      return result.status === 0 ? {value: result} : null;
    });
    const relaunched = await waitForSessionProcessRole(
      sessionId,
      'browser',
      10_000,
      browser.pid,
    );
    assert.notStrictEqual(
      relaunched.pid,
      browser.pid,
      'the relaunched browser must be a new process',
    );
    assert.ok(
      !isPidAlive(browser.pid),
      `the crashed browser ${browser.pid} must not be reused`,
    );

    // The orphan assertion belongs to C2: a hard browser kill is expected to
    // leave Chrome helpers behind today, and folding that into C1 made a
    // working lazy relaunch look like a recovery failure. What C1 owns is that
    // the crashed browser is replaced and the session keeps serving tools.
  },
};

/**
 * C2 - SIGKILL to the main browser process only. Chrome's helpers sit in the
 * browser's process tree; nothing kills the group, so whatever survives its
 * parent is an orphan re-parented to init.
 */
export const C2: Scenario = {
  id: 'C2',
  title: 'SIGKILLing the browser leaves no orphaned helper processes',
  iterations: 5,
  run: async sessionId => {
    const daemonPid = await startDaemonForTest(sessionId);
    await openPage(sessionId);
    const browser = await waitForSessionProcessRole(
      sessionId,
      'browser',
      15_000,
    );
    await registerSessionProcesses(sessionId);
    const helpers = await getDescendantPids(browser.pid);

    assert.ok(
      await killProcess(browser.pid, sessionId),
      `the browser ${browser.pid} was already gone`,
    );
    assert.ok(
      await waitForProcessExit(browser.pid, 5_000),
      `the browser ${browser.pid} survived SIGKILL`,
    );

    await waitFor('a tool call to relaunch the browser', 10_000, async () => {
      const result = await runCliQuiet(['list_pages'], sessionId);
      return result.status === 0 ? {value: result} : null;
    });
    assert.ok(
      isPidAlive(daemonPid),
      'the daemon must survive an orphaned browser helper',
    );

    try {
      await assertNoOrphansWithin(sessionId, 5_000);
    } catch (error) {
      assert.fail(
        `${(error as Error).message}\n  browser ${browser.pid} had ${helpers.length} child processes: ${helpers.join(', ') || '(none)'}`,
      );
    }
  },
};

/**
 * D1 - the daemon parses socket messages without a guard. One malformed frame
 * rejects the transport callback, the daemon's own `unhandledRejection` handler
 * runs `cleanup(1)`, and the whole session dies with it.
 */
export const D1: Scenario = {
  id: 'D1',
  title: 'malformed socket input does not take the daemon down',
  iterations: 10,
  run: async sessionId => {
    const daemonPid = await startDaemonForTest(sessionId);

    // The socket parsing needs no browser, but the tool call at the end of this
    // scenario does: it is what proves the daemon still serves tools, not just
    // `status`, after a malformed frame.
    const raw = Buffer.concat([Buffer.from('NOT JSON'), Buffer.from('\0')]);
    await sendRawSocketMessage(sessionId, raw, 2_000);
    await delay(500);

    assert.ok(
      isPidAlive(daemonPid),
      `the daemon ${daemonPid} died on a malformed socket message ` +
        '(JSON.parse throws outside a try/catch -> unhandledRejection -> cleanup(1))',
    );
    assert.ok(
      isDaemonRunning(sessionId),
      'the pid file should still describe a live daemon',
    );

    const status = await runCliQuiet(['status'], sessionId);
    assert.strictEqual(status.status, 0, `status failed: ${status.stderr}`);
    assert.ok(
      status.stdout.startsWith(`${MCP_BIN_NAME} daemon is running.`),
      `unexpected status output: ${JSON.stringify(status.stdout)}`,
    );

    await waitFor(
      'a tool call after malformed socket input',
      10_000,
      async () => {
        const result = await runCliQuiet(['list_pages'], sessionId);
        return result.status === 0 ? {value: result} : null;
      },
    );
    await assertNoOrphans(sessionId);
  },
};

/**
 * E2 - SIGKILL is what the OOM killer sends, so `cleanup()` never runs: no
 * signal handlers, no socket unlink, no child teardown. Whatever the daemon
 * owned is left to the OS.
 */
export const E2: Scenario = {
  id: 'E2',
  title: 'an OOM-killed daemon leaves no orphans and the session recovers',
  iterations: 5,
  run: async sessionId => {
    const daemonPid = await startDaemonForTest(sessionId);
    await openPage(sessionId);
    const mcpServer = await waitForSessionProcessRole(
      sessionId,
      'mcp-server',
      15_000,
    );
    const browser = await waitForSessionProcessRole(
      sessionId,
      'browser',
      15_000,
    );
    await registerSessionProcesses(sessionId);

    assert.ok(
      await killProcess(daemonPid, sessionId),
      `the daemon ${daemonPid} was already gone`,
    );
    assert.ok(
      await waitForProcessExit(daemonPid, 5_000),
      `the daemon ${daemonPid} survived SIGKILL`,
    );

    // Recovery has to start from a clean table, and waiting on those two pids
    // alone would not prove it. The MCP server's stdio pipe to the dead daemon
    // breaks with it, so it can exit on its own - the OS closing a pipe, not the
    // product supervising its children - and the assertion would pass with the
    // browser and its helpers still running. Asserting on *every* process of the
    // session is what makes this evidence of a supervision mechanism (a reaper,
    // a process-group kill) rather than of one lucky exit.
    try {
      await assertNoOrphansWithin(sessionId, 5_000);
    } catch (error) {
      assert.fail(
        `${(error as Error).message}\n  the daemon ${daemonPid} took a SIGKILL, so its ` +
          `cleanup() never ran: nothing reaped the MCP server ${mcpServer.pid}, the browser ` +
          `${browser.pid} or the browser's helpers`,
      );
    }

    const freshPid = await startDaemonForTest(sessionId);
    assert.notStrictEqual(
      freshPid,
      daemonPid,
      'recovery must fork a new daemon',
    );
    assert.ok(isDaemonRunning(sessionId), 'the fresh daemon must be reachable');

    const allowed = new Set([freshPid, ...(await getDescendantPids(freshPid))]);
    const stale = (await findSessionLeftovers(sessionId)).filter(
      proc => !allowed.has(proc.pid),
    );
    assert.strictEqual(
      stale.length,
      0,
      `processes from the killed daemon are still running under the new one:\n${describeProcs(stale)}`,
    );

    const listed = await runCliQuiet(['list_pages'], sessionId);
    assert.strictEqual(
      listed.status,
      0,
      `the recovered session cannot serve tool calls: ${listed.stderr}`,
    );
  },
};

/**
 * G1 - the non-isolated launch is the product's whole reason to exist: the
 * browser runs against a persistent profile, and consecutive CLI commands must
 * reach the same browser rather than start a new one per command.
 */
export const G1: Scenario = {
  id: 'G1',
  title: 'a non-isolated browser is reused across commands',
  iterations: 3,
  run: async sessionId => {
    const profileDir = createProfileDir(sessionId, 'persistent');
    const daemonPid = await startDaemonForTest(
      sessionId,
      persistentProfileArgs(profileDir),
    );
    await openPage(sessionId);
    const browser = await waitForSessionProcessRole(
      sessionId,
      'browser',
      15_000,
    );
    await registerSessionProcesses(sessionId);

    assert.strictEqual(
      profileDirOf(browser.command),
      profileDir,
      `the browser ignored the persistent profile it was given:\n${browser.command.slice(0, 200)}`,
    );
    assert.ok(
      !browser.command.includes('puppeteer_dev_chrome_profile'),
      `--isolated was still in effect: ${browser.command.slice(0, 200)}`,
    );

    // A second command must find the same browser, not a fresh one.
    const second = await runCliQuiet(['list_pages'], sessionId);
    assert.strictEqual(
      second.status,
      0,
      `second command failed: ${second.stderr}`,
    );
    const browsers = (await findSessionProcesses(sessionId)).filter(
      proc => proc.role === 'browser',
    );
    assert.strictEqual(
      browsers.length,
      1,
      `expected one browser across two commands:\n${describeProcs(browsers)}`,
    );
    assert.strictEqual(
      browsers[0].pid,
      browser.pid,
      'the second command replaced the browser instead of reusing it',
    );
    assert.strictEqual(
      profileDirOf(browsers[0].command),
      profileDir,
      'the browser must keep the profile it was launched with',
    );
    assert.ok(isPidAlive(daemonPid), 'the daemon must survive two commands');
  },
};

/**
 * G2 - a hard crash of a persistent-profile browser. The relaunch has to reuse
 * the same profile, which is where a stale Chromium `SingletonLock` would bite:
 * "the profile appears to be in use by another process" is the failure a real
 * Opera session would hit, and it must not be left behind by a crash.
 */
export const G2: Scenario = {
  id: 'G2',
  title:
    'a crashed persistent-profile browser is relaunched on the same profile',
  iterations: 3,
  run: async sessionId => {
    const profileDir = createProfileDir(sessionId, 'persistent');
    await startDaemonForTest(sessionId, persistentProfileArgs(profileDir));
    await openPage(sessionId);
    const browser = await waitForSessionProcessRole(
      sessionId,
      'browser',
      15_000,
    );
    await registerSessionProcesses(sessionId);

    assert.ok(
      await killProcess(browser.pid, sessionId),
      `the browser ${browser.pid} was already gone`,
    );
    assert.ok(
      await waitForProcessExit(browser.pid, 5_000),
      `the browser ${browser.pid} survived SIGKILL`,
    );

    await waitFor(
      'a tool call to relaunch the browser on the same profile',
      15_000,
      async () => {
        const result = await runCliQuiet(['list_pages'], sessionId);
        if (result.status !== 0) {
          return null;
        }
        const relaunched = (await findSessionProcesses(sessionId)).filter(
          proc => proc.role === 'browser' && proc.pid !== browser.pid,
        );
        return relaunched.length ? {value: relaunched[0]} : null;
      },
    ).catch(async error => {
      const leftovers = await findSessionProcesses(sessionId);
      assert.fail(
        `${(error as Error).message}; the stale lock or the relaunch is the suspect here ` +
          `(profile ${profileDir}). Session processes:\n${describeProcs(leftovers)}`,
      );
    });

    const relaunched = (await findSessionProcesses(sessionId)).filter(
      proc => proc.role === 'browser' && proc.pid !== browser.pid,
    );
    assert.ok(relaunched.length > 0, 'no replacement browser appeared');
    assert.strictEqual(
      profileDirOf(relaunched[0].command),
      profileDir,
      'the relaunched browser must reuse the persistent profile',
    );
  },
};

/**
 * G3 - two sessions share one persistent profile, because the profile directory
 * is derived from the home directory rather than from the session id. Only one
 * Chromium can own it, so the second session must fail without disturbing the
 * first and without leaving a half-started browser behind.
 */
export const G3: Scenario = {
  id: 'G3',
  title:
    'a second session on the same persistent profile fails without disturbing the first',
  iterations: 3,
  run: async sessionId => {
    const sharedProfileDir = createProfileDir(sessionId, 'shared');
    await startDaemonForTest(
      sessionId,
      persistentProfileArgs(sharedProfileDir),
    );
    await openPage(sessionId);
    const browser = await waitForSessionProcessRole(
      sessionId,
      'browser',
      15_000,
    );
    await registerSessionProcesses(sessionId);

    const secondSessionId = crypto.randomUUID();
    try {
      // The second session starts its own daemon against the *same* profile.
      // Only one Chromium can own it, and the browser launch happens on the
      // first tool call below.
      await startDaemonForTest(
        secondSessionId,
        persistentProfileArgs(sharedProfileDir),
      );
      const second = await runCliQuiet(['list_pages'], secondSessionId);
      const secondBrowsers = (
        await findSessionProcesses(secondSessionId)
      ).filter(
        proc => proc.role === 'browser' || proc.role === 'browser-helper',
      );

      assert.ok(
        isPidAlive(browser.pid),
        `the first session's browser ${browser.pid} was killed by the second session ` +
          `(second command status=${second.status}: ${second.stdout.trim().slice(0, 200)})`,
      );
      const first = await runCliQuiet(['list_pages'], sessionId);
      assert.strictEqual(
        first.status,
        0,
        `the first session stopped working (second command status=${second.status}: ` +
          `${second.stdout.trim().slice(0, 200)}): ${first.stderr}`,
      );
      assert.ok(
        isPidAlive(browser.pid),
        `the first session's browser ${browser.pid} did not survive`,
      );
      assert.strictEqual(
        secondBrowsers.length,
        0,
        `the failed launch of the second session left browser processes behind:\n` +
          `${describeProcs(secondBrowsers)}`,
      );
    } finally {
      await cleanupSession(secondSessionId);
    }
  },
};

/**
 * H1 - the user closes the browser's tabs while the process keeps running. The
 * product's own `close_page` refuses to leave the browser with no pages at all
 * (CLOSE_PAGE_ERROR), so a browser with no pages can only come from outside: the
 * next tool call used to fail with "The selected page has been closed", which is
 * an error about a page nobody selected and a command that may have nothing to
 * do with pages. The call must instead resolve a page — the one the browser is
 * supposed to always have — say so, and not restart the browser to do it.
 *
 * `--keep-alive-for-test` keeps the process alive with no pages, which is what a
 * user's last-tab close leaves behind on a desktop browser that keeps running
 * for its background services.
 */
export const H1: Scenario = {
  id: 'H1',
  title: 'a browser left with no pages is served by opening one',
  iterations: 5,
  run: async sessionId => {
    const daemonPid = await startDaemonForTest(sessionId, [
      '--chrome-arg=--keep-alive-for-test',
    ]);
    await openPage(sessionId);
    const browser = await waitForSessionProcessRole(
      sessionId,
      'browser',
      15_000,
    );
    await registerSessionProcesses(sessionId);

    // Close the last page from outside the product: a page a script opened is
    // allowed to close itself, the first page is not, so it is closed by id
    // first and the script-opened one closes itself afterwards.
    //
    // The body is a block so the call returns `undefined`: `evaluate_script`
    // serializes its result with `JSON.stringify` (src/tools/script.ts), and
    // `window.open()` returns a `Window`, which is circular and throws. The
    // window opens either way, but the tool call itself fails — and a step
    // asserted to exit 0 must be a step that succeeds.
    const opened = await runCliQuiet(
      ['evaluate_script', '() => { window.open("about:blank"); }'],
      sessionId,
    );
    assert.strictEqual(
      opened.status,
      0,
      `window.open() failed, so the browser cannot be driven to zero pages: ${opened.stderr}${opened.stdout}`,
    );
    await runCliQuiet(['select_page', '2'], sessionId);
    const closed = await runCliQuiet(['close_page', '1'], sessionId);
    assert.strictEqual(closed.status, 0, `close_page failed: ${closed.stderr}`);
    // The page closes itself mid-call, so its own CDP response may never arrive.
    await runCliQuiet(['evaluate_script', '() => window.close()'], sessionId);
    await delay(500);

    const listed = await runCliQuiet(['list_pages'], sessionId);
    assert.ok(
      !listed.stdout.includes('## Pages'),
      `expected a browser with no pages left, got:
${listed.stdout}${listed.stderr}`,
    );
    assert.ok(
      isPidAlive(browser.pid),
      `the browser ${browser.pid} exited instead of staying alive with no pages; ` +
        'this scenario needs --keep-alive-for-test to be honoured',
    );

    // The call under test: a page-scoped tool with nothing to select.
    const recovered = await waitFor(
      'a page-scoped tool call to recover the missing page',
      10_000,
      async () => {
        const result = await runCliQuiet(
          ['navigate_page', '--url', 'about:blank'],
          sessionId,
        );
        return result.status === 0 ? {value: result} : null;
      },
    );
    assert.ok(
      recovered.stdout.includes(
        'the browser had no open pages, so a new one was opened',
      ),
      `the recovery was not reported, so the page was not opened by us:
${recovered.stdout}`,
    );
    assert.strictEqual(
      pageCount(recovered.stdout),
      1,
      `expected exactly one page after the recovery, got:\n${recovered.stdout}`,
    );
    assert.ok(
      isPidAlive(browser.pid),
      `the browser ${browser.pid} was restarted instead of reused`,
    );

    // Once is enough: the page we opened is the selection from now on.
    const second = await runCliQuiet(
      ['navigate_page', '--url', 'about:blank'],
      sessionId,
    );
    assert.strictEqual(
      second.status,
      0,
      `second call failed: ${second.stderr}`,
    );
    assert.ok(
      !second.stdout.includes('had no open pages'),
      `a page was opened again although one existed:
${second.stdout}`,
    );
    assert.strictEqual(
      pageCount(second.stdout),
      1,
      `a second page was left behind:\n${second.stdout}`,
    );
    assert.ok(isPidAlive(daemonPid), 'the daemon must survive the recovery');
    await assertNoOrphansWithin(sessionId, 5_000);
  },
};

/** Every scenario, in the order the runner executes them. */
export const SCENARIOS: Scenario[] = [
  A1,
  A2,
  B1,
  B2,
  C1,
  C2,
  D1,
  E2,
  G1,
  G2,
  G3,
  H1,
];
