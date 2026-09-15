/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * pageId routing is a chrome-devtools-mcp convention: most page-scoped tool
 * commands carry a routing `pageId` positional that targets the active page.
 * The retired `opera-browser-cli` never routed by pageId, so its replacement
 * omits that positional from the CLI surface (see §4.7 of
 * docs/specs/migration-poc-phase-1.md) and disables routing on the server via
 * the `--no-page-id-routing` flag injected by `envConfig.ts`.
 */

import type {ArgDef} from '../config/cli-options.js';

/**
 * The routing `pageId` positional is the one upstream injects into page-scoped
 * commands; its description always opens with this sentence. Upstream appends a
 * caveat for `evaluate_script` ("Required when not evaluating in a service
 * worker."), so match the prefix rather than the whole string. The two commands
 * with a `pageId` of their own (`select_page`, `close_page`) describe it in
 * their own words and are left alone.
 *
 * Upstream owns this string, so `tests/opera/pageIdRouting.test.ts` pins it
 * against the generated command table: if an intake merge rewords it, that test
 * fails instead of the CLI silently regaining a pageId positional. The durable
 * fix is an explicit marker on the upstream `ArgDef`.
 */
const ROUTING_PAGE_ID_DESCRIPTION = 'Targets a specific page by ID.';

/**
 * Drop the routing-injected `pageId` positional from a command's arg map. The
 * CLI never routes by pageId, and the daemon it spawns runs with
 * `--no-page-id-routing`, so a pageId left on the CLI surface is not merely
 * useless — the daemon rejects it as an unknown argument.
 */
export function withoutRoutingPageId(
  args: Record<string, ArgDef>,
): Record<string, ArgDef> {
  if (args.pageId?.description.startsWith(ROUTING_PAGE_ID_DESCRIPTION)) {
    // `_pageId` is the discarded key; the eslint config ignores `^_` vars.
    const {pageId: _pageId, ...rest} = args;
    return rest;
  }
  return args;
}
