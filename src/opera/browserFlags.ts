/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import type fs from 'node:fs';

import type {parseArguments} from '../bin/chrome-devtools-mcp-cli-options.js';
import type {Channel} from '../browser.js';
import {
  closeBrowserIfOpen,
  ensureBrowserLaunched,
  getCurrentBrowser,
} from '../browser.js';
import {logger} from '../utils/logger.js';

type ServerArgs = ReturnType<typeof parseArguments>;

/**
 * Opera's AI features refuse to run when the page reports itself as
 * automation-controlled, so the browser has to be launched with this flag for
 * them. It is deliberately NOT applied to every launch: it changes observable
 * page behaviour, which would silently alter results for ordinary DevTools
 * tools.
 */
export const OPERA_AUTOMATION_FLAGS = [
  '--disable-blink-features=AutomationControlled',
];

/**
 * Only the tools that drive Opera's agentic AI need the automation flags.
 * `opera_chat`, `opera_make` and `opera_list_models` talk to the service worker
 * directly and work without them.
 */
const TOOLS_REQUIRING_OPERA_FLAGS = new Set(['opera_do', 'opera_research']);

export function toolRequiresOperaFlags(toolName: string): boolean {
  return TOOLS_REQUIRING_OPERA_FLAGS.has(toolName);
}

/**
 * Tracks whether the currently running browser was launched with
 * {@link OPERA_AUTOMATION_FLAGS}. Module-level rather than per-server because
 * the browser itself is a module-level singleton in `../browser.ts`.
 */
let browserHasOperaFlags = false;

export function browserWasLaunchedWithOperaFlags(): boolean {
  return browserHasOperaFlags;
}

/** Test seam: forget what we believe about the current browser. */
export function resetOperaFlagState(): void {
  browserHasOperaFlags = false;
}

/**
 * Relaunching swaps the browser process out from under the server, so the
 * caller has to drop its `McpContext` first. `index.ts` owns that reference.
 */
export interface OperaBrowserControl {
  resetContext(): void;
}

/**
 * Mirrors the launch options built by `getContext()` in `../index.ts`. The
 * duplication is deliberate: keeping it here means `index.ts` stays close to
 * upstream. If upstream changes the `ensureBrowserLaunched` call shape, this is
 * the one Opera-side place that has to follow.
 */
function launchOptions(
  serverArgs: ServerArgs,
  logFile: fs.WriteStream | undefined,
  extraChromeArgs: string[],
) {
  const chromeArgs = [
    ...extraChromeArgs,
    ...(serverArgs.chromeArg ?? []).map(String),
  ];
  if (serverArgs.proxyServer) {
    chromeArgs.push(`--proxy-server=${serverArgs.proxyServer}`);
  }
  return {
    headless: serverArgs.headless,
    executablePath: serverArgs.executablePath,
    channel: serverArgs.channel as Channel,
    isolated: serverArgs.isolated ?? false,
    userDataDir: serverArgs.userDataDir,
    logFile,
    viewport: serverArgs.viewport,
    chromeArgs,
    ignoreDefaultChromeArgs: (serverArgs.ignoreDefaultChromeArg ?? []).map(
      String,
    ),
    acceptInsecureCerts: serverArgs.acceptInsecureCerts,
    devtools: serverArgs.experimentalDevtools ?? false,
    enableExtensions: serverArgs.categoryExtensions,
    viaCli: serverArgs.viaCli,
  };
}

/**
 * True when this server launched the browser itself. When the user attached to
 * an existing browser we must never kill and relaunch it.
 */
function isLaunchMode(serverArgs: ServerArgs): boolean {
  return (
    !serverArgs.browserUrl && !serverArgs.wsEndpoint && !serverArgs.autoConnect
  );
}

/**
 * Makes sure the running browser has (or lacks) the Opera automation flags to
 * match what `toolName` needs, relaunching it if not. No-op when we did not
 * launch the browser ourselves, or when the flags already match.
 */
export async function ensureBrowserFlagsForTool(
  toolName: string,
  serverArgs: ServerArgs,
  logFile: fs.WriteStream | undefined,
  control: OperaBrowserControl,
  // Injected so tests do not need a real browser singleton.
  deps = {closeBrowserIfOpen, ensureBrowserLaunched},
): Promise<void> {
  if (!isLaunchMode(serverArgs)) {
    return;
  }

  const needsOperaFlags = toolRequiresOperaFlags(toolName);
  const browserConnected = getCurrentBrowser()?.connected ?? false;

  // A disconnected browser tells us nothing about the flags of the next one.
  if (needsOperaFlags && browserHasOperaFlags && browserConnected) {
    return;
  }
  if (!needsOperaFlags && !(browserHasOperaFlags && browserConnected)) {
    return;
  }

  logger?.(
    `Relaunching browser ${needsOperaFlags ? 'with' : 'without'} Opera automation flags for ${toolName}`,
  );

  control.resetContext();
  browserHasOperaFlags = false;
  await deps.closeBrowserIfOpen();

  if (needsOperaFlags) {
    await deps.ensureBrowserLaunched(
      launchOptions(serverArgs, logFile, OPERA_AUTOMATION_FLAGS),
    );
    browserHasOperaFlags = true;
  }
  // Otherwise leave the browser closed: getContext() relaunches it without the
  // Opera flags on the next call.
}
