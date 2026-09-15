/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Browser profile inspection. Ported from opera-browser-cli's `src/profile.ts`
 * (Phase 1b) as a subset: only `defaultProfileDir`, which first-run
 * autoconfiguration needs. Lock inspection and DevTools endpoint probing
 * arrive with the takeover phase.
 */

import {existsSync} from 'node:fs';

import {browserDisplayName, type OperaBuild} from './detect.js';

/** macOS bundle id that owns the profile of each build. */
const MAC_BUNDLE_ID: Record<OperaBuild, string> = {
  'Opera Neon Developer': 'com.operasoftware.OperaNeonDeveloper',
  'Opera Neon': 'com.operasoftware.OperaNeon',
  'Opera GX': 'com.operasoftware.OperaGX',
  Opera: 'com.operasoftware.Opera',
};

/**
 * Where the given Opera build keeps its real profile, if we can find it.
 * `platform` and `env` are test seams; production callers use the defaults.
 */
export function defaultProfileDir(
  browserPath: string | undefined,
  home: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // The build name decides both paths: it is the Windows profile folder
  // verbatim, and the key of the macOS bundle id.
  const build = browserDisplayName(browserPath ?? '');
  let candidate: string;
  if (platform === 'darwin') {
    candidate = `${home}/Library/Application Support/${MAC_BUNDLE_ID[build]}`;
  } else if (platform === 'win32') {
    const appData = env.APPDATA ?? `${home}\\AppData\\Roaming`;
    candidate = `${appData}\\Opera Software\\${build}`;
  } else {
    return null;
  }
  return existsSync(candidate) ? candidate : null;
}
