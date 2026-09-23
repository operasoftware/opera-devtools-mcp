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
 * Whether the teardown above must stay its hand — set while *we* close the
 * browser.
 *
 * `disconnected` is not an abnormal-exit signal: Puppeteer's own `close()` ends
 * with `disconnect()`, so a deliberate shutdown fires the same event a crash
 * does. Killing the process group at that moment SIGKILLs a browser that is
 * still flushing its profile — IndexedDB and LevelDB writes are done by its
 * child storage utility, not by the browser process — and a store that loses
 * those writes keeps records pointing at files that never landed. Blink reports
 * the read of such a record as `NotReadableError: Data lost due to missing
 * file. Affected record should be considered irrecoverable` (`indexeddb/`
 * `idb_request_queue_item.cc`), and Opera AI's chat path then fails on every
 * later run in that profile.
 *
 * So the group kill is armed for a browser that goes away without us closing
 * it, and disarmed for the close we asked for.
 *
 * The flag lives in the watching handler's closure, not in module state: a
 * handler for a browser we already closed can fire *after* the next launch has
 * installed its own, and module state would then be read through the new cycle
 * — an arm resets it to false, so the late handler for the deliberately closed
 * browser sees "not ours" and SIGKILLs a group whose helpers may still be
 * flushing that profile. One flag per armed handler means each browser's
 * teardown answers only for its own close.
 */
let disarmActiveWatcher: (() => void) | undefined;

/**
 * Mark the teardown that follows as deliberate, so the `disconnected` it emits
 * is not answered with a group kill. Called by both browser-closing paths in
 * `src/browser.ts`, which are the only places that close a browser we launched.
 */
export function disarmBrowserOrphanCleanup(): void {
  disarmActiveWatcher?.();
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
 * place in `src/browser.ts` that owns a launched browser. Each launch installs
 * a fresh watcher with its own disarm flag, so a browser launched after a
 * deliberate close is protected again — and the previous launch's watcher,
 * which may fire afterwards, is still answered by its own flag.
 */
export function watchBrowserForOrphans(browser: Browser): void {
  const pgid = browser.process()?.pid;
  let disarmed = false;
  disarmActiveWatcher = () => {
    disarmed = true;
  };
  browser.once('disconnected', () => {
    if (disarmed) {
      return;
    }
    killBrowserProcessGroup(pgid);
  });
}
