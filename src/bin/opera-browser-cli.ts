#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Opera Software AS.
 * SPDX-License-Identifier: Apache-2.0
 */

// Opera-named bin entry (see `package.json` `bin`). The implementation lives in
// the upstream-owned file and is branded via `src/opera/branding.ts`.
import {CLI_BIN_NAME} from '../opera/branding.js';
import {autoConfigure, shouldAutoConfigure} from '../opera/config.js';
import {loadOperaCliConfig} from '../opera/envConfig.js';

/**
 * Configure a fresh machine in place, without asking. Skips pure queries and
 * the (future) `setup`/`logs` commands; reports what it did on stderr so a
 * scripted user sees the same first-run note as opera-browser-cli.
 */
function ensureConfigured(argv: string[]): void {
  if (!shouldAutoConfigure(argv)) {
    return;
  }
  const command = argv[2];

  const result = autoConfigure();
  if (result.status === 'configured') {
    const ai = result.browser.isNeon
      ? 'Opera AI available'
      : 'chat only — install Opera Neon for invoke-do/make/research';
    process.stderr.write(
      `configured: ${result.browser.name} (${ai}) — run \`${CLI_BIN_NAME} setup\` to change\n`,
    );
    return;
  }
  if (result.status === 'no-browser' && command !== 'doctor') {
    process.stderr.write(
      `hint: no Opera installation found — run \`${CLI_BIN_NAME} setup\`, or set OPERA_CLI_EXECUTABLE_PATH\n`,
    );
  }
}

// Promote ~/.opera-browser-cli/config into process.env (and warn on unknown
// keys) before the CLI spawns the daemon, which inherits this environment. The
// OPERA_CLI_* env-var → flag translation runs in the MCP server bin — which
// accepts those flags — not here, where the strict per-command parser would
// reject them on `status`, `stop`, and the tool commands.
loadOperaCliConfig();

// On a machine that has never been configured, detect the installed Opera
// build and write a config + set OPERA_CLI_* so this first command works.
ensureConfigured(process.argv);

// Dynamic import: static imports are hoisted above the module body, so the
// config load above would otherwise run after the CLI already parsed argv.
await import('./chrome-devtools.js');
