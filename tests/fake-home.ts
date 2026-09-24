/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Pointing a test's process at a throwaway home directory.
 *
 * `os.homedir()` reads `HOME` on POSIX and `USERPROFILE` on Windows, so a test
 * that sets only `HOME` keeps reading the real user's profile on Windows — and
 * with it the `~/.opera-browser-cli` config and sidecars the machine already
 * has, which is exactly what these tests isolate themselves from.
 */

/** The variables `os.homedir()` reads, in the order it prefers them. */
export const HOME_ENV_KEYS = ['HOME', 'USERPROFILE'] as const;

/** Point `os.homedir()` at `dir` on every platform; returns what to restore. */
export function pinHome(dir: string): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of HOME_ENV_KEYS) {
    saved[key] = process.env[key];
    process.env[key] = dir;
  }
  return saved;
}

/** Put back the values `pinHome` replaced. */
export function restoreHome(saved: Record<string, string | undefined>): void {
  for (const key of HOME_ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
