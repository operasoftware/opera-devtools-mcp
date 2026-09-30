#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Opera Software AS.
 * SPDX-License-Identifier: Apache-2.0
 */

// Opera-named bin entry (see `package.json` `bin`). The implementation lives in
// the upstream-owned file and is branded via `src/opera/branding.ts`.
import {applyEnvToArgv, loadOperaCliConfig} from '../opera/envConfig.js';
import {runLegacyMigrationGuard} from '../opera/legacyBridgeCleanup.js';
// Import for its side effect: silences Node's Web Storage warning before
// `third_party` reads `localStorage`. See `opera/webStorageWarning.ts`.
import '../opera/webStorageWarning.js';

// Apply ~/.opera-browser-cli/config and OPERA_CLI_* env vars before the
// upstream implementation reads `process.argv`.
loadOperaCliConfig();
applyEnvToArgv(process.argv);

// An MCP client starts this bin directly, with no CLI invocation anywhere, so
// the migration guard has to run here too: a machine that upgraded from the
// two-package era may still have the old HTTP bridge (port 9225) holding a
// browser. Nothing runs at install time — npm ≥12 blocks install scripts unless
// the user opts in — and this file is also the server the daemon spawns, so both
// shapes of MCP start are covered. One file read when there is no bridge; the
// port probe behind it runs once per boot. Never throws, never writes to stdout.
await runLegacyMigrationGuard();

// Dynamic import: static imports are hoisted above the module body, so the
// env/config setup above would otherwise run after the server parsed argv.
await import('./chrome-devtools-mcp.js');
