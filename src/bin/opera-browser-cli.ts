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
import {applyEnvToArgv, loadOperaCliConfig} from '../opera/envConfig.js';
import {preloadWebStorageWarningGuardInChildren} from '../opera/webStorageWarning.js';

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
// keys) before the CLI spawns the daemon, which inherits this environment.
loadOperaCliConfig();

// The daemon cannot import this module before its own static imports reach
// `third_party`, so the guard travels to it (and to the MCP server it spawns)
// through NODE_OPTIONS instead.
preloadWebStorageWarningGuardInChildren();

// On a machine that has never been configured, detect the installed Opera
// build and write a config + set OPERA_CLI_* so this first command works.
ensureConfigured(process.argv);

// `start` is the command that decides the daemon's browser options, and its own
// defaults (`--headless` from the viaCli options, `--isolated`) are serialized
// as if the user had passed them — so the MCP server bin's `applyEnvToArgv`,
// which skips a flag already on argv, can no longer see OPERA_CLI_HEADED or
// OPERA_CLI_USER_DATA_DIR. Translating the environment into explicit flags
// here, before yargs parses the command, lets the config beat those defaults.
// Only `start` takes the browser flags; `status`, `stop` and the tool commands
// have strict parsers that would reject them, and a directly-run MCP server
// still does the translation in its own bin.
if (process.argv[2] === 'start') {
  applyEnvToArgv(process.argv);
}

// Dynamic import: static imports are hoisted above the module body, so the
// config load above would otherwise run after the CLI already parsed argv.
await import('./chrome-devtools.js');
