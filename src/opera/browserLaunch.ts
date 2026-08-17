/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import type fs from 'node:fs';

import type {parseArguments} from '../bin/chrome-devtools-mcp-cli-options.js';
import type {Channel, ensureBrowserLaunched} from '../browser.js';

type ServerArgs = ReturnType<typeof parseArguments>;

/**
 * The options object `ensureBrowserLaunched` accepts, derived from the
 * function's own signature so a change to it in `src/browser.ts` becomes a
 * compile error here (and at both call sites) instead of silently dropping a
 * launch flag on an intake.
 */
export type McpLaunchOptions = Parameters<typeof ensureBrowserLaunched>[0];

export interface BuildLaunchOptionsExtra {
  /** Extra Chromium args, e.g. the Opera automation flags. */
  extraChromeArgs?: string[];
  /**
   * Network-request filters and the `experimentalDevtools` flag. Each defaults
   * to the value derived from `serverArgs`; callers that already hold the same
   * derived values (e.g. `index.ts` for its connected branch / `McpContext`)
   * can pass them so the launched browser can never diverge from them.
   */
  blocklist?: string[];
  allowlist?: string[];
  devtools?: boolean;
}

/**
 * Single source of truth for mapping parsed server args to
 * `ensureBrowserLaunched` options. Used by the normal launch in `src/index.ts`
 * (`getContext`) and by the Opera browser relaunch in `opera/browserFlags.ts`.
 *
 * `index.ts` and `browserFlags.ts` used to build these options independently,
 * so a relaunch could quietly omit a launch flag (notably `blocklist` /
 * `allowlist`) and the two could drift apart on an upstream intake. Keep the
 * mapping here so the relaunch path always launches the browser exactly like
 * the normal path does, plus whatever `extraChromeArgs` the caller adds.
 */
export function buildLaunchOptions(
  serverArgs: ServerArgs,
  logFile: fs.WriteStream | undefined = undefined,
  extra: BuildLaunchOptionsExtra = {},
): McpLaunchOptions {
  const chromeArgs = [
    ...(extra.extraChromeArgs ?? []),
    ...(serverArgs.chromeArg ?? []).map(String),
  ];
  if (serverArgs.proxyServer) {
    chromeArgs.push(`--proxy-server=${serverArgs.proxyServer}`);
  }
  const blocklist =
    extra.blocklist ??
    (serverArgs.blockedUrlPattern
      ? serverArgs.blockedUrlPattern.map(String)
      : undefined);
  const allowlist =
    extra.allowlist ??
    (serverArgs.allowedUrlPattern
      ? serverArgs.allowedUrlPattern.map(String)
      : undefined);
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
    devtools: extra.devtools ?? serverArgs.experimentalDevtools ?? false,
    enableExtensions: serverArgs.categoryExtensions,
    viaCli: serverArgs.viaCli,
    blocklist,
    allowlist,
  };
}
