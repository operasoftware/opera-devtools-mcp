/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import {ConnectionClosedError, TargetCloseError} from '../third_party/index.js';

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

/**
 * Connection-closed errors mean the CDP session is permanently gone (the
 * browser died or the connection broke), unlike the transient
 * service-worker-not-ready failures this retry exists for. Retrying them only
 * burns maxAttempts * delayMs before surfacing the same permanent failure.
 *
 * Matched by class, not by `error.name`: the names are Puppeteer's to change,
 * and a rename would silently turn every permanent failure back into five
 * retries. The classes come through `third_party/index.ts`.
 */
function isRetryableError(error: Error): boolean {
  return !(
    error instanceof TargetCloseError || error instanceof ConnectionClosedError
  );
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
      await sleep(delayMs);
    }
  }
  throw lastError;
}
