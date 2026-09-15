/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Finding an installed browser. Ported from opera-browser-cli's `src/detect.ts`
 * (Phase 1b). Opera Neon is preferred because it is the only build with the
 * full Opera AI tool set; a plain Opera still gives `chat`. Anything else means
 * the AI commands cannot work, which the caller reports rather than discovering
 * halfway through a command.
 */

import {existsSync} from 'node:fs';

/** The Opera builds this module can name. */
export type OperaBuild =
  'Opera Neon Developer' | 'Opera Neon' | 'Opera GX' | 'Opera';

export function neonCandidatePaths(
  platform: NodeJS.Platform = process.platform,
  home = '',
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Opera Neon Developer.app/Contents/MacOS/Opera',
      '/Applications/Opera Neon.app/Contents/MacOS/Opera',
      `${home}/Applications/Opera Neon Developer.app/Contents/MacOS/Opera`,
      `${home}/Applications/Opera Neon.app/Contents/MacOS/Opera`,
    ];
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? `${home}\\AppData\\Local`;
    const programFiles = env.PROGRAMFILES ?? 'C:\\Program Files';
    return [
      `${localAppData}\\Programs\\Opera Neon Developer\\opera.exe`,
      `${programFiles}\\Opera Neon Developer\\opera.exe`,
      `${localAppData}\\Programs\\Opera Neon\\opera.exe`,
      `${programFiles}\\Opera Neon\\opera.exe`,
    ];
  }
  // Opera Neon does not ship for Linux.
  return [];
}

export function operaCandidatePaths(
  platform: NodeJS.Platform = process.platform,
  home = '',
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Opera GX.app/Contents/MacOS/Opera',
      '/Applications/Opera.app/Contents/MacOS/Opera',
      `${home}/Applications/Opera GX.app/Contents/MacOS/Opera`,
      `${home}/Applications/Opera.app/Contents/MacOS/Opera`,
    ];
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? `${home}\\AppData\\Local`;
    const programFiles = env.PROGRAMFILES ?? 'C:\\Program Files';
    return [
      `${localAppData}\\Programs\\Opera GX\\opera.exe`,
      `${localAppData}\\Programs\\Opera\\opera.exe`,
      `${programFiles}\\Opera GX\\opera.exe`,
      `${programFiles}\\Opera\\opera.exe`,
    ];
  }
  return [];
}

/**
 * Which Opera build an install path belongs to, judged by the directory the
 * executable sits in. Matching whole install-directory names — rather than a
 * substring anywhere in the path — keeps an unrelated directory that merely
 * mentions a build (`/tmp/GX-tests/opera`) from being misreported.
 */
export function browserDisplayName(binPath: string): OperaBuild {
  const dirs = binPath
    .split(/[\\/]/)
    .slice(0, -1)
    .map(segment => segment.replace(/\.app$/, ''));
  if (dirs.includes('Opera Neon Developer')) {
    return 'Opera Neon Developer';
  }
  if (dirs.includes('Opera Neon')) {
    return 'Opera Neon';
  }
  if (dirs.includes('Opera GX')) {
    return 'Opera GX';
  }
  return 'Opera';
}

export interface DetectedBrowser {
  path: string;
  name: OperaBuild;
  /** Only Neon has invoke-do / make / research. */
  isNeon: boolean;
}

/** Every Opera install we can find, Neon first, each path reported once. */
export function detectBrowsers(
  platform: NodeJS.Platform = process.platform,
  home = '',
  exists: (p: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): DetectedBrowser[] {
  const neon = new Set(neonCandidatePaths(platform, home, env));
  const found: DetectedBrowser[] = [];
  const seen = new Set<string>();
  for (const path of [...neon, ...operaCandidatePaths(platform, home, env)]) {
    // `home` defaults to '', which collapses the `${home}/Applications`
    // candidates onto the absolute ones; without this check the same install
    // would be reported twice.
    if (seen.has(path) || !exists(path)) {
      continue;
    }
    seen.add(path);
    found.push({path, name: browserDisplayName(path), isNeon: neon.has(path)});
  }
  return found;
}

/** The browser to use when nobody has said which. */
export function detectBrowser(
  platform: NodeJS.Platform = process.platform,
  home = '',
  exists: (p: string) => boolean = existsSync,
  env: NodeJS.ProcessEnv = process.env,
): DetectedBrowser | null {
  return detectBrowsers(platform, home, exists, env)[0] ?? null;
}
