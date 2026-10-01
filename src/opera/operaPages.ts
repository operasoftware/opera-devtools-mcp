/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Opera's own pages, as far as the URL policy is concerned.
 *
 * Upstream lets Chrome's start pages through — `chrome://newtab` and
 * `chrome://new-tab-page` — because the page a browser opens by itself is often
 * the only page there is, and refusing it would leave `list_pages` reporting an
 * empty browser. Opera's equivalent is the Speed Dial, and it is not a corner
 * case: `chrome://startpageshared/` is the URL of *every* tab a user opens from
 * the tab strip, before that tab navigates anywhere.
 *
 * Rejecting it costs more than a missing line of output, because the same
 * predicate is also the Puppeteer target filter (`makeTargetFilter`). A target
 * the filter refuses is detached at attach time and recorded as ignored
 * (`TargetManager`), and `TargetManager` skips a target that is ignored on
 * every later `Target.targetInfoChanged` — so the tab is never attached, never
 * tracked, and stays invisible to `list_pages` for the rest of its life, even
 * after the user navigates it to a real site.
 *
 * Upstream's own file keeps its shape; this is the one rule that decides which
 * Opera URLs it must additionally accept.
 */

/**
 * Speed Dial paths under `chrome://`. `startpageshared` is the one Opera 100+
 * loads (and the one Opera records for its tabs); `startpage` is the older
 * spelling, kept so a build that still uses it is not filtered.
 */
const OPERA_START_PAGE_PATHS: Record<string, true> = {
  startpage: true,
  startpageshared: true,
};

/**
 * Whether the URL is one of Opera's Speed Dial pages.
 *
 * Accepts both the `chrome://startpageshared/` and the single-slash
 * `chrome:startpageshared` spelling: `new URL` parses the latter with an empty
 * host, which is how upstream's `newtab` allowance is written too.
 */
export function isOperaStartPage(url: URL): boolean {
  if (url.protocol !== 'chrome:') {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (OPERA_START_PAGE_PATHS[host] === true) {
    return true;
  }
  return (
    host === '' &&
    OPERA_START_PAGE_PATHS[url.pathname.toLowerCase().split('/')[0] ?? ''] ===
      true
  );
}
