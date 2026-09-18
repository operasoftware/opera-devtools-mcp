/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Browser process-tree teardown, owned by Opera.
 *
 * Chrome calls `setsid()` while it initializes, so the browser is a process
 * group leader and its helpers (GPU, renderer, utility) join *its* group rather
 * than sitting below it in the process tree. That is why a helper survives
 * SIGKILL to the main process: it is a sibling, not a child, so killing the
 * parent orphans it instead of ending it.
 *
 * Killing the group is therefore the only teardown that reaches the helpers. A
 * descendant walk from the browser pid cannot: by the time `disconnected`
 * fires the pid is gone, the helpers are re-parented to init, and the walk
 * returns nothing.
 *
 * On Linux the group id persists as long as any member is alive, even after the
 * leader exits, so `kill(-pgid)` still names the whole group at that point.
 *
 * `watchBrowserForOrphans` is the seam `src/browser.ts` calls: it owns the pid
 * capture and the `disconnected` listener, so the upstream file gets one line
 * after `launch()` rather than a handler body.
 */

import process from 'node:process';

import type {Browser} from '../third_party/index.js';

/**
 * SIGKILL every process in the browser's process group.
 *
 * Synchronous by design: `process.kill` is a syscall, and this runs from the
 * `disconnected` handler, where the SIGKILL has to reach the group before the
 * event loop yields to whatever teardown is already in flight.
 *
 * Takes the group id rather than the `Browser`: `browser.process()` is not
 * reliable once `disconnected` has fired — the main process is gone, and a pid
 * read at that point could already name an unrelated process that the kernel
 * reused. The caller captures the pid at launch and holds it; the group outlives
 * its leader, so that value still addresses every helper.
 *
 * No-op on Windows, which has no POSIX process groups: there the browser's
 * helpers are its children and Puppeteer's own close path reaps them.
 */
export function killBrowserProcessGroup(pid: number | undefined): void {
  if (process.platform === 'win32' || !pid) {
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ESRCH — the group is already gone, which is what a graceful `close()`
    // leaves behind, so the signal is a no-op either way. EPERM — the browser
    // is not a group leader, which `setsid()` makes impossible for a browser
    // Puppeteer launched.
  }
}

/**
 * Arm the browser's teardown: when it disconnects without closing, kill the
 * process group it left behind.
 *
 * The pid is read here, while the browser is alive, because by the time
 * `disconnected` fires the main process is gone and a pid read then could
 * already name a process the kernel reused. `.once` because Puppeteer emits
 * `disconnected` on an abnormal exit and again on `close()`, and one group kill
 * is the whole job.
 *
 * Called from `ensureBrowserLaunched` right after `launch()`, which is the one
 * place in `src/browser.ts` that owns a launched browser.
 */
export function watchBrowserForOrphans(browser: Browser): void {
  const pgid = browser.process()?.pid;
  browser.once('disconnected', () => {
    killBrowserProcessGroup(pgid);
  });
}
