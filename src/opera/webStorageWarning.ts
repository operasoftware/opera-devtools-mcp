/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Node's Web Storage warning, and the one read of `localStorage` that provokes
 * it.
 *
 * Node defines `localStorage` as a lazy global accessor. Reading it without
 * `--localstorage-file` yields `undefined` and prints, once, to stderr:
 *
 *   ExperimentalWarning: localStorage is not available because
 *   --localstorage-file was not provided.
 *
 * The bundled `debug` package reads it when it initializes
 * (`node_modules/debug/src/browser.js` → `localstorage()`, reached through
 * `lighthouse-logger` and `third_party/lighthouse-devtools-mcp-bundle.js`), and
 * every entry point reaches that: the warning preceded a CLI command's own
 * output, led the MCP server's stderr, and opened the daemon's log. The read
 * only ever wants the "no storage here" answer its `try { return localStorage }
 * catch {}` falls back to anyway; the warning is its entire effect.
 *
 * This module takes the accessor away first, replacing it with the `undefined`
 * the read produces. It is deliberately neither `--disable-warning` nor
 * `process.removeAllListeners('warning')`: those hide every experimental
 * warning, including the ones worth reading, and the flag cannot reach a
 * Windows `.cmd` shim or a plain `node build/…/bin.js`.
 *
 * The guard installs on import, so a process whose own imports load
 * `third_party` first — the daemon — can preload this file instead; see
 * `preloadWebStorageWarningGuardInChildren`.
 */

import fs from 'node:fs';
import process from 'node:process';
import {fileURLToPath, pathToFileURL} from 'node:url';

/**
 * Removes the accessor, so the read becomes the `undefined` it already fell back
 * to and prints nothing.
 *
 * Nothing happens on a Node without the accessor, or when the process was told
 * where to keep Web Storage: `--localstorage-file` is the whole of the opt-in,
 * and with it the getter hands back a real `Storage` that must survive.
 */
function installWebStorageWarningGuard(): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage',
  );
  // `--localstorage-file` can arrive as a Node flag or through NODE_OPTIONS,
  // which the daemon inherits from this process.
  const configured = [
    ...process.execArgv,
    ...(process.env.NODE_OPTIONS?.split(/\s+/) ?? []),
  ].some(
    arg =>
      arg === '--localstorage-file' || arg.startsWith('--localstorage-file='),
  );
  // No accessor — older Node, or Web Storage not exposed at all — leaves
  // nothing to do. A second call lands here too: the install below replaces the
  // accessor with a plain value, so the `get` is gone.
  if (!descriptor?.get || configured) {
    return;
  }
  Object.defineProperty(globalThis, 'localStorage', {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

installWebStorageWarningGuard();

/**
 * Hand the guard to every Node child this process spawns, by preloading it
 * through `NODE_OPTIONS`.
 *
 * The daemon is the child that needs it: `src/daemon/daemon.ts` reaches
 * `third_party/index.ts` through its own static imports, so no module of ours
 * can run first in that process — only a `--import` preload can. The daemon
 * passes its environment on to the MCP server it supervises, so one call at the
 * CLI's entry point covers both.
 *
 * A guard file that is not there is not a reason to fail a spawn: this removes
 * a warning, and a preload that cannot be resolved would abort the child.
 */
export function preloadWebStorageWarningGuardInChildren(): void {
  const guardFile = fileURLToPath(
    new URL('./webStorageWarning.js', import.meta.url),
  );
  if (!fs.existsSync(guardFile)) {
    return;
  }
  const option = `--import=${pathToFileURL(guardFile).href}`;
  const current = process.env.NODE_OPTIONS?.trim();
  if (current?.includes(option)) {
    return;
  }
  process.env.NODE_OPTIONS = current ? `${current} ${option}` : option;
}
