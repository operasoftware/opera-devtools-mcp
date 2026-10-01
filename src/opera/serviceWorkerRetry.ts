/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import {ConnectionClosedError, TargetCloseError} from '../third_party/index.js';
import {logger} from '../utils/logger.js';

/**
 * Opera's AI service worker may not be running yet when the first CDP command
 * arrives, so a dispatch that failed *before reaching it* is retried with a
 * fixed backoff.
 *
 * Exposed as a mutable object so tests can drive the retry loop without waiting
 * on real time. Faking timers is not a workable alternative here: sinon's fake
 * clock replaces the globals `node:test` uses to schedule subtests, which
 * silently drops whole suites from the run.
 */
export const serviceWorkerRetryPolicy = {
  maxAttempts: 5,
  delayMs: 2500,
};

function sleep(ms: number): Promise<void> {
  const {promise, resolve} = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * The one failure a replay is allowed after: Opera's dispatcher had nothing to
 * dispatch to, which is what a service worker that is still coming up reports.
 * `opera/cdpErrors.ts` recognises the same wording to tell the user a browser
 * without Opera AI apart from one that is merely not ready yet.
 */
const NOT_DISPATCHED = /dispatcher was not able to dispatch|no target/i;

/**
 * Whether a replay of this failure is safe.
 *
 * A dispatch is not idempotent — `chat`, `do`, `make` and `research` each open
 * the tab they run in, and the AI run behind them may already be under way — so
 * a retry is only defensible when the error proves the action never reached
 * Opera's AI at all. Retrying every other failure multiplied real side effects:
 * a chat that kept failing on a browser-side storage error was sent five times
 * and left five tabs, and the last four failures were logged only as "attempt
 * N/5", with the actual error buried.
 *
 * Connection-closed errors are permanent for a different reason (the CDP
 * session is gone for good) and are matched by class rather than by `error.name`
 * — the names are Puppeteer's to change, and a rename would silently turn every
 * permanent failure back into five retries. The classes come through
 * `third_party/index.ts`.
 */
function isRetryableError(error: Error): boolean {
  if (
    error instanceof TargetCloseError ||
    error instanceof ConnectionClosedError
  ) {
    return false;
  }
  return NOT_DISPATCHED.test(error.message);
}

export async function withServiceWorkerRetry<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const {maxAttempts, delayMs} = serviceWorkerRetryPolicy;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e as Error;
      if (attempt >= maxAttempts - 1 || !isRetryableError(lastError)) {
        break;
      }
      // The line is what makes a replay visible in `opera-browser-cli logs`:
      // the extra tab it may leave is the only other trace of it.
      logger?.(
        `Opera dispatch attempt ${attempt + 1}/${maxAttempts} failed, retrying in ${delayMs}ms: ${lastError.message}`,
      );
      await sleep(delayMs);
    }
  }
  throw lastError;
}
