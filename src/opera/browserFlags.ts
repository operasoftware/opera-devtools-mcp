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
import {buildLaunchOptions} from './browserLaunch.js';
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
    // Launch options come from the shared `buildLaunchOptions` so the relaunch
    // applies exactly the same flags (including blocklist/allowlist and proxy)
    // as the normal launch in `index.ts`, plus the automation flags.
    await deps.ensureBrowserLaunched(
      buildLaunchOptions(serverArgs, logFile, {
        extraChromeArgs: OPERA_AUTOMATION_FLAGS,
      }),
    );
    browserHasOperaFlags = true;
  }
  // Otherwise leave the browser closed: getContext() relaunches it without the
  // Opera flags on the next call.
}
