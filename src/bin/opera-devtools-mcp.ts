#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Opera Software AS.
 * SPDX-License-Identifier: Apache-2.0
 */

// Opera-named bin entry (see `package.json` `bin`). The implementation lives in
// the upstream-owned file and is branded via `src/opera/branding.ts`.
import {applyEnvToArgv, loadOperaCliConfig} from '../opera/envConfig.js';

// Apply ~/.opera-browser-cli/config and OPERA_CLI_* env vars before the
// upstream implementation reads `process.argv`.
loadOperaCliConfig();
applyEnvToArgv(process.argv);

// Dynamic import: static imports are hoisted above the module body, so the
// env/config setup above would otherwise run after the server parsed argv.
await import('./chrome-devtools-mcp.js');
