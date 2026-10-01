/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Who is using the shared browser at this moment.
 *
 * One daemon serves every terminal through one MCP server and one browser
 * (`../browser.ts` holds a module-level singleton), so invocations that know
 * nothing about each other overlap freely: an Opera AI action streams for
 * minutes while another terminal's `take_snapshot` arrives, and a second
 * `opera_do` joins the first. That is fine for reading the page and fatal for
 * *replacing the browser*, which closes every page in it — including the pages
 * of whatever is still running.
 *
 * `opera/browserFlags.ts` is the one thing that ever replaces the browser, and
 * it asks here first. A count per tool name rather than a boolean because the
 * refusal names the tools holding the browser, and because two invocations of
 * the same tool are two claims rather than one.
 *
 * `ToolHandler` pairs `noteToolStarted` with `noteToolFinished` around every
 * invocation, the second from the same `finally` that releases the tool mutex —
 * so an invocation that fails is not left counted, and neither is one that
 * `beforeInvoke` itself refused (`opera/toolHandlerHooks.ts`).
 */

const inFlight = new Map<string, number>();

/** Claim the browser for the invocation of `toolName` that is starting. */
export function noteToolStarted(toolName: string): void {
  inFlight.set(toolName, (inFlight.get(toolName) ?? 0) + 1);
}

/** Release one claim on the browser; unknown names are ignored. */
export function noteToolFinished(toolName: string): void {
  const count = inFlight.get(toolName);
  if (count === undefined) {
    return;
  }
  if (count > 1) {
    inFlight.set(toolName, count - 1);
    return;
  }
  inFlight.delete(toolName);
}

/**
 * The tools using the browser besides the invocation of `self` asking, split by
 * name so a refusal can name them, sorted so its wording is stable.
 */
export function otherBrowserUsers(self: string): string[] {
  const names = new Set<string>();
  for (const [name, count] of inFlight) {
    if (name === self ? count > 1 : count > 0) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/** Test seam: forget every in-flight invocation. */
export function resetBrowserActivity(): void {
  inFlight.clear();
}
