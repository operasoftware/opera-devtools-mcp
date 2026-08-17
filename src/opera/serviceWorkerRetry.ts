/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Opera's AI service worker may not be running yet when the first CDP command
 * arrives, so dispatches are retried with a fixed backoff.
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
      if (attempt < maxAttempts - 1) {
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}
