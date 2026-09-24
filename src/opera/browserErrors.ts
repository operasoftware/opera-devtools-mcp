/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * The browser-lifecycle failures whose wording decides what the user does next,
 * kept here for the same reason the branding strings are: `src/browser.ts` gets
 * call sites, the fork keeps the prose.
 *
 * Two of them were actively misleading upstream. "The browser is already running
 * for X. Use --isolated to run multiple browser instances." answers "the profile
 * is in use" with "start a third browser on a throwaway profile" — wrong for the
 * one case that matters, driving the browser you already have. And an attach
 * failure has to say that the browser belongs to the user: a launched browser is
 * restarted for them, an attached one never is.
 */

/** Where an attach was pointed, in the order the server resolves it. */
export interface AttachTarget {
  browserURL?: string;
  wsEndpoint?: string;
  userDataDir?: string;
}

function attachTarget(target: AttachTarget): string | undefined {
  return target.browserURL ?? target.wsEndpoint ?? target.userDataDir;
}

/** A launch failed because a browser already holds the profile. */
export function profileInUse(userDataDir: string): string {
  return (
    `A browser is already running with the profile ${userDataDir}, so a second one cannot be launched on it. ` +
    `Either drive that browser — start it with --remote-debugging-port=<port> (9222 is the usual one) and run with --browser-url=http://127.0.0.1:<port> ` +
    `(or --autoConnect on Chrome 144+) — or launch on a separate profile with --isolated.`
  );
}

/**
 * An attach through a profile found no DevTools endpoint in it, i.e. the browser
 * is running but was not started with remote debugging.
 */
export function noDevToolsEndpoint(userDataDir: string): string {
  return (
    `Could not attach to the browser running with the profile ${userDataDir}: no DevTools endpoint was found there. ` +
    `Check that it is running and that remote debugging is enabled (chrome://inspect/#remote-debugging).`
  );
}

/** An attach failed outright: the browser is gone, or not debuggable. */
export function attachFailed(
  target: AttachTarget,
  autoConnect: boolean,
): string {
  const at = attachTarget(target);
  const hint = autoConnect ? ' (chrome://inspect/#remote-debugging)' : '';
  return (
    `Could not attach to the browser${at ? ` at ${at}` : ''}. ` +
    `Check that it is running with remote debugging enabled${hint}. ` +
    `An attached browser is not managed by this daemon, so it is not restarted for you — start it again and re-attach.`
  );
}
