/**
 * @license
 * Copyright 2026 Opera Software AS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single source of truth for every product string that differs from upstream
 * `chrome-devtools-mcp`.
 *
 * Upstream files reference these constants instead of hardcoding literals, so
 * the merge seam for rebranding is one changed line per string rather than a
 * forked copy of the file.
 */

/** npm package name. Doubles as the MCP server binary name. */
export const PACKAGE_NAME = 'opera-devtools-mcp';

/** MCP server binary / daemon app name, also used as `process.title`. */
export const MCP_BIN_NAME = PACKAGE_NAME;

/** CLI binary name, e.g. `opera-devtools start`. */
export const CLI_BIN_NAME = 'opera-devtools';

/** Human-readable product name used in log lines. */
export const PRODUCT_NAME = 'Opera DevTools MCP Server';

/** Public repository, referenced from help text and disclaimers. */
export const REPO_URL = 'https://github.com/operasoftware/opera-devtools-mcp';

/** Directory under `$HOME/.cache` holding the update-check snapshot. */
export const CACHE_DIR_NAME = PACKAGE_NAME;

/** Bin script the daemon spawns to run the MCP server. */
export const INDEX_SCRIPT_NAME = `${MCP_BIN_NAME}.js`;

/** Upstream reads `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS`. */
export const ENV_NO_USAGE_STATISTICS = 'OPERA_DEVTOOLS_NO_USAGE_STATISTICS';

/** Upstream reads `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS`. */
export const ENV_NO_UPDATE_CHECKS = 'OPERA_DEVTOOLS_NO_UPDATE_CHECKS';

/** Upstream reads `CHROME_DEVTOOLS_MCP_CRASH_ON_UNCAUGHT`. */
export const ENV_CRASH_ON_UNCAUGHT = 'OPERA_DEVTOOLS_CRASH_ON_UNCAUGHT';
