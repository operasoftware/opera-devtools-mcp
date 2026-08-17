/**
 * @license
 * Copyright 2026 Opera Software AS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Opera's behavioural deltas on top of upstream `chrome-devtools-mcp`.
 *
 * The fork does not collect usage statistics and does not send performance
 * trace URLs to Google's CrUX API. Upstream defaults both to `true`; here they
 * default to `false`, the help text is inverted accordingly, and the MCP
 * server entry point additionally forces them off even if a flag asked for
 * them.
 */

import {ENV_NO_USAGE_STATISTICS, MCP_BIN_NAME} from './branding.js';

/** Upstream default is `true`. */
export const USAGE_STATISTICS_DEFAULT = false;

/** Upstream default is `true`. */
export const PERFORMANCE_CRUX_DEFAULT = false;

/** Inverted from upstream's "Set to false to disable ..." wording. */
export const PERFORMANCE_CRUX_DESCRIPTION =
  'Set to true to enable sending URLs from performance traces to CrUX API to get field performance data.';

/** Inverted from upstream's "Set to false to opt-out ..." wording. */
export const USAGE_STATISTICS_DESCRIPTION = `Set to true to opt-in to usage statistics collection. Google collects usage data to improve the tool, handled under the Google Privacy Policy (https://policies.google.com/privacy). This is independent from Chrome browser metrics. Disabled if \`${ENV_NO_USAGE_STATISTICS}\` or \`CI\` env variables are set.`;

/**
 * Hard-off switch applied by the MCP server entry point after argument
 * parsing. Defaults alone are not enough: a client could pass
 * `--usageStatistics` or `--performanceCrux` explicitly.
 */
export function enforceTelemetryPolicy(args: {
  usageStatistics?: boolean;
  performanceCrux?: boolean;
}): void {
  if (args.usageStatistics || args.performanceCrux) {
    console.error(
      'Warning: usage statistics or CrUX were enabled via flags — forcing off.',
    );
  }
  args.usageStatistics = false;
  args.performanceCrux = false;
}

/** Branded replacement for upstream's browser-exposure disclaimer. */
export const BROWSER_EXPOSURE_DISCLAIMER = `${MCP_BIN_NAME} exposes content of the browser instance to the MCP clients allowing them to inspect,
debug, and modify any data in the browser or DevTools.
Avoid sharing sensitive or personal information that you do not want to share with MCP clients.`;

/**
 * Upstream prints a Google usage-statistics opt-out paragraph from
 * `logDisclaimers`. Opera never collects them, so the paragraph is suppressed.
 *
 * A function rather than a `false` constant so that upstream's block in
 * `src/index.ts` stays live code and merges untouched.
 */
export function showUsageStatisticsDisclaimer(): boolean {
  return false;
}
