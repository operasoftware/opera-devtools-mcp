/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import type fs from 'node:fs';

import type {parseArguments} from '../config/mcp-options.js';
import {
  closeBrowserIfOpen,
  ensureBrowserLaunched,
  getCurrentBrowser,
} from '../browser.js';
import type {Browser} from '../third_party/index.js';
import {logger} from '../utils/logger.js';

import {otherBrowserUsers} from './browserActivity.js';
import {buildLaunchOptions} from './browserLaunch.js';

type ServerArgs = ReturnType<typeof parseArguments>;

/**
 * Opera's AI features refuse to run when the page reports itself as
 * automation-controlled, so the browser has to be launched with this flag for
 * them. It is deliberately NOT applied to every launch: it changes observable
 * page behaviour, which would silently alter results for ordinary DevTools
 * tools.
 *
 * The flags are therefore acquired the first time an Opera AI tool needs them
 * and then kept for the life of that browser — see `ensureBrowserFlagsForTool`.
 * A browser carrying them is never relaunched to take them away again: the
 * daemon serves several terminals at once, and the tool that used to trigger
 * that relaunch was an ordinary one (`take_snapshot` in another terminal), which
 * closed the browser a running `opera_do` was streaming from.
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
 * The browser this server launched with {@link OPERA_AUTOMATION_FLAGS}, held by
 * identity rather than as a flag that outlives it: a browser that died and was
 * relaunched by the next call carries none of them (`index.ts` launches without
 * the Opera flags), and the tools that need them must not be told otherwise.
 * Module-level rather than per-server because the browser itself is a
 * module-level singleton in `../browser.ts`.
 */
let flagsBrowser: Browser | undefined;

/** Test seam: forget which browser was launched with the Opera flags. */
export function resetOperaFlagState(): void {
  flagsBrowser = undefined;
}

/**
 * Relaunching swaps the browser process out from under the server, so the
 * caller has to drop its `McpContext` first. `index.ts` owns that reference.
 */
export interface OperaBrowserControl {
  resetContext(): void;
}

/**
 * One source of truth for "did we launch the browser, or attach to one that was
 * already running". `index.ts` picks the branch with the same three options at
 * invocation time, and the CLI reports the mode from the daemon's stored argv,
 * so the rule must not be re-implemented per caller.
 */
const ATTACH_OPTIONS = ['browserUrl', 'wsEndpoint', 'autoConnect'] as const;

/**
 * True when this server launched the browser itself. When the user attached to
 * an existing browser we must never kill and relaunch it.
 */
export function isLaunchMode(serverArgs: ServerArgs): boolean {
  return !ATTACH_OPTIONS.some(option => Boolean(serverArgs[option]));
}

/**
 * One canonical spelling for a raw flag name. yargs expands `--browser-url` and
 * `--browserUrl` to the same option, and the daemon stores the argv verbatim, so
 * a read-back that does not normalize would call an attached session "launched".
 */
function canonicalOptionName(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * The flags of a stored argv in one pass: canonical name → value, `true` for a
 * value-less flag. `--flag=value`, `--flag value`, `--no-flag` and
 * `--flag=false` all arrive on a real command line, and all four have to read
 * the same as `isLaunchMode` reads the parsed form.
 */
function readFlags(args: readonly string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) {
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf('=');
    if (equals !== -1) {
      flags.set(
        canonicalOptionName(body.slice(0, equals)),
        body.slice(equals + 1),
      );
      continue;
    }
    if (body.startsWith('no-')) {
      flags.set(canonicalOptionName(body.slice(3)), false);
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('-')) {
      flags.set(canonicalOptionName(body), next);
      index++;
      continue;
    }
    flags.set(canonicalOptionName(body), true);
  }
  return flags;
}

/**
 * How a serialized CLI argv (`opera-browser-cli status`) describes the browser
 * it drives: `launched (owned by this daemon)` or `attached to <target>`.
 *
 * The daemon stores the MCP argv it was started with, so this needs no new
 * channel between the two processes — and it is the same predicate the server
 * itself applies, read back from the flags that decided it.
 */
export function describeBrowserMode(args: readonly string[]): string {
  const flags = readFlags(args);
  const attachFlag = ATTACH_OPTIONS.find(option => {
    const value = flags.get(option);
    // `--flag=false` and `--no-flag` are how yargs spells "not set", and
    // `isLaunchMode` reads them the same way.
    return value !== undefined && value !== false && value !== 'false';
  });
  if (!attachFlag) {
    return 'launched (owned by this daemon)';
  }
  const value = flags.get(attachFlag);
  return `attached to ${typeof value === 'string' && value ? value : 'an external browser'}`;
}

/**
 * How long a relaunch waits for the browser to fall idle before it gives up and
 * reports why, and how often it looks. A mutable object so tests can drive the
 * wait without waiting: faking timers is not workable here (sinon's fake clock
 * replaces the globals `node:test` schedules subtests with).
 */
export const browserIdleWaitPolicy = {
  timeoutMs: 10_000,
  pollMs: 100,
};

/** The seams a relaunch needs; injected so tests need no browser singleton. */
export interface FlagRelaunchDeps {
  /** Closes the browser this daemon launched, if it is open. */
  closeBrowserIfOpen: typeof closeBrowserIfOpen;
  /** Launches one with the given options. */
  ensureBrowserLaunched: typeof ensureBrowserLaunched;
  /** The browser currently connected to this server, if any. */
  getCurrentBrowser: typeof getCurrentBrowser;
  /** Pauses the idle wait, so a test can let the browser fall idle instead. */
  sleep(ms: number): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

const defaultFlagRelaunchDeps: FlagRelaunchDeps = {
  closeBrowserIfOpen,
  ensureBrowserLaunched,
  getCurrentBrowser,
  sleep,
};

/**
 * Wait until nothing else is inside a tool invocation, or refuse.
 *
 * A relaunch closes every page in the browser, which is defensible only when
 * nothing is using it: the daemon answers several terminals at once, so the
 * alternative is destroying the pages of an invocation that is still running —
 * the failure this whole module exists to stop.
 */
async function waitForBrowserIdle(
  toolName: string,
  sleep: FlagRelaunchDeps['sleep'],
): Promise<void> {
  const deadline = Date.now() + browserIdleWaitPolicy.timeoutMs;
  for (;;) {
    const users = otherBrowserUsers(toolName);
    if (users.length === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${toolName} needs the browser relaunched with Opera's automation flags, and it is in use by ${users.join(', ')} — relaunching it now would close that work. Timed out waiting for the browser to be free; retry when it is.`,
      );
    }
    await sleep(browserIdleWaitPolicy.pollMs);
  }
}

/**
 * Make sure the running browser has the Opera automation flags `toolName` needs.
 *
 * One direction only, and that is the point. A browser this daemon launched
 * *gains* the flags when an Opera AI tool first needs them and keeps them for the
 * rest of its life; a tool that needs no flags is not this module's business at
 * all. The reverse relaunch — taking the flags away again for an ordinary
 * DevTools tool — was what closed the browser under a running `opera_do` when a
 * second terminal ran `take_snapshot`, failing both streams with the AI
 * dispatcher's "no target" error, and it is gone rather than made conditional:
 * the flags are a property of the browser, not of the tool that happens to be
 * running.
 *
 * The one relaunch that remains — the acquisition — waits for the browser to fall
 * idle first, and reports why instead of closing anything if it does not.
 */
export async function ensureBrowserFlagsForTool(
  toolName: string,
  serverArgs: ServerArgs,
  logFile: fs.WriteStream | undefined,
  control: OperaBrowserControl,
  deps: FlagRelaunchDeps = defaultFlagRelaunchDeps,
): Promise<void> {
  if (!isLaunchMode(serverArgs) || !toolRequiresOperaFlags(toolName)) {
    return;
  }

  const current = deps.getCurrentBrowser();
  if (current?.connected && current === flagsBrowser) {
    return;
  }

  await waitForBrowserIdle(toolName, deps.sleep);
  logger?.(`Relaunching browser with Opera's automation flags for ${toolName}`);

  control.resetContext();
  flagsBrowser = undefined;
  await deps.closeBrowserIfOpen();

  // Launch options come from the shared `buildLaunchOptions` so the relaunch
  // applies exactly the same flags (including blocklist/allowlist and proxy)
  // as the normal launch in `index.ts`, plus the automation flags.
  flagsBrowser = await deps.ensureBrowserLaunched(
    buildLaunchOptions(serverArgs, logFile, {
      extraChromeArgs: OPERA_AUTOMATION_FLAGS,
    }),
  );
}
