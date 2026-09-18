/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * The page a page-scoped tool acts on, when the browser's tabs are shared with a
 * human who closes them.
 *
 * `McpContext.getSelectedMcpPage()` is strict on purpose — it throws rather than
 * acting on a page the caller did not ask for, and a caller that must not be
 * redirected (an explicitly named `pageId`) needs exactly that. Tool invocation
 * is not that caller: the browser is supposed to always have at least one page
 * (`close_page` refuses to close the last one), so an empty browser can only come
 * from outside, and the product's answer is to restore the page it is supposed to
 * have rather than to fail the call with a page error for a command that may have
 * nothing to do with pages.
 *
 * Everything here goes through `McpContext`'s public API, which is what keeps the
 * upstream seam at the single call site in `ToolHandler.ts`. The reporting is the
 * fork's own for a reason: upstream records a selection fallback and lets the
 * response print it, but the response clears it by taking its own page snapshot
 * first (`McpResponse.handle`), so a replacement made *before* the tool runs is
 * never reported. A page this module had to open is a side effect the caller has
 * to hear about — in attached mode it is a new tab in their browser.
 */

import type {McpContext} from '../McpContext.js';
import type {McpPage} from '../McpPage.js';

/**
 * The slice of the response this module writes to: `McpResponse` and its slim
 * subclass both provide it, and nothing else is needed here.
 */
export interface ResponseSink {
  appendResponseLine(line: string): void;
}

/**
 * The in-flight recovery, per context. Scoped to the context because that is all
 * the sharing there is: Opera tools bypass the tool mutex, so two of them
 * resolving a page at the same moment share one new page rather than open one
 * each, and each caller reports the note in its own response.
 */
const recoveries = new WeakMap<McpContext, Promise<McpPage>>();

async function openRecoveryPage(context: McpContext): Promise<McpPage> {
  const inFlight = recoveries.get(context);
  if (inFlight) {
    return await inFlight;
  }
  // Cleared as soon as it settles — on rejection as well as on success, so a
  // failed recovery never poisons the entry: the next caller tries again.
  const started = context.newPage().finally(() => {
    recoveries.delete(context);
  });
  recoveries.set(context, started);
  return await started;
}

/**
 * The page a page-scoped tool should act on.
 *
 * Cheap on the happy path: the strict accessor answers it without listing pages
 * or touching CDP, so only a selection that has actually gone costs anything.
 */
export async function resolveSelectedPage(
  context: McpContext,
  response?: ResponseSink,
): Promise<McpPage> {
  try {
    return context.getSelectedMcpPage();
  } catch {
    // The selection is gone. The snapshot below is what can replace it.
  }

  await context.createPagesSnapshot();
  try {
    const selected = context.getSelectedMcpPage();
    response?.appendResponseLine(
      `Note: the previously selected page was closed. Page ${selected.id} is now selected.`,
    );
    return selected;
  } catch {
    // Still nothing to select: the browser has no pages at all.
  }

  const opened = await openRecoveryPage(context);
  response?.appendResponseLine(
    `Note: the browser had no open pages, so a new one was opened. Page ${opened.id} is now selected.`,
  );
  return opened;
}
