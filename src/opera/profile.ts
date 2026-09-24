/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Browser profile inspection — where a build keeps its profile, whether that
 * profile is in use, and whether the browser holding it can be talked to.
 *
 * Ported from opera-browser-cli's `src/profile.ts` (Phase 1b brought only
 * `defaultProfileDir`; Phase 2 adds the inspection half, which `doctor`'s
 * profile check needs).
 *
 * Chromium refuses to start a second instance on a user-data-dir that is
 * already open: it hands its command line to the running instance through a
 * singleton socket and exits. Launching into a live profile therefore does not
 * fail loudly, it fails as "the browser we asked for never appeared" — which is
 * why this has to be detected before launch rather than diagnosed after it.
 *
 * Two files in the user-data-dir root tell us what we need:
 *
 *   SingletonLock       a symlink whose target is "<hostname>-<pid>" (POSIX),
 *                       or "Mac-<pid>" (Chromium's macOS singleton variant).
 *                       Present and live => the profile is in use.
 *   DevToolsActivePort  written whenever the browser was started with
 *                       --remote-debugging-port. Line 1 is the port.
 *
 * Neither file is authoritative on its own: SingletonLock outlives a crash, and
 * DevToolsActivePort outlives a clean exit. Both are confirmed against the live
 * system before being acted on.
 */

import {existsSync, lstatSync, readFileSync, readlinkSync} from 'node:fs';
import {request} from 'node:http';
import {hostname} from 'node:os';
import {join} from 'node:path';

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
    // Joined, not interpolated: the returned path is compared and printed, and
    // a caller on the same machine builds the same location with `path.join`.
    candidate = join(
      home,
      'Library',
      'Application Support',
      MAC_BUNDLE_ID[build],
    );
  } else if (platform === 'win32') {
    const appData = env.APPDATA ?? `${home}\\AppData\\Roaming`;
    candidate = `${appData}\\Opera Software\\${build}`;
  } else {
    return null;
  }
  return existsSync(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------------
// Lock inspection
// ---------------------------------------------------------------------------

export type ProfileLockState =
  /** No lock file, or the lock belongs to a process that is gone. */
  | 'free'
  /** A live process on this machine holds the profile. */
  | 'locked'
  /** A lock exists but we cannot attribute it — another host, or unreadable. */
  | 'unknown';

export interface ProfileLock {
  state: ProfileLockState;
  /** The owning browser process, when the lock names one we can verify. */
  pid: number | null;
  hostname: string | null;
}

/**
 * Split a SingletonLock target into hostname and pid.
 *
 * The hostname routinely contains dashes ("Someones-MacBook-Pro-24601"), so the
 * split has to come from the right.
 */
export function parseSingletonTarget(
  target: string,
): {hostname: string; pid: number} | null {
  const split = target.lastIndexOf('-');
  if (split <= 0) {
    return null;
  }
  const pid = Number.parseInt(target.slice(split + 1), 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return {hostname: target.slice(0, split), pid};
}

/**
 * Whether a parsed lock identity can belong to a process on this machine.
 *
 * The POSIX singleton writes "<hostname>-<pid>"; Chromium's macOS singleton
 * writes "Mac-<pid>", where "Mac" is that implementation's fixed local marker
 * rather than a hostname. It is only treated as local on darwin, so a machine
 * that is genuinely named "Mac" elsewhere keeps its lock unattributable.
 */
function isLocalLockIdentity(
  hostnamePart: string,
  platform: NodeJS.Platform,
): boolean {
  if (hostnamePart === hostname()) {
    return true;
  }
  return platform === 'darwin' && hostnamePart === 'Mac';
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Determine whether a user-data-dir is currently held by a running browser.
 *
 * A dangling lock reads as "free": Chromium cleans those up itself on the next
 * launch, so treating one as a conflict would block a launch that would in fact
 * succeed.
 */
export function inspectProfileLock(
  userDataDir: string,
  aliveCheck: (pid: number) => boolean = isProcessAlive,
  platform: NodeJS.Platform = process.platform,
): ProfileLock {
  const lockPath = join(userDataDir, 'SingletonLock');

  let target: string;
  try {
    // lstat, not stat: the link is expected to dangle after a crash, and a
    // dangling symlink is exactly the case we want to report as free.
    if (!lstatSync(lockPath).isSymbolicLink()) {
      // Windows writes a regular file instead of a symlink. We can see that the
      // profile is claimed but not by whom.
      return {state: 'unknown', pid: null, hostname: null};
    }
    target = readlinkSync(lockPath);
  } catch {
    return {state: 'free', pid: null, hostname: null};
  }

  const parsed = parseSingletonTarget(target);
  if (parsed === null) {
    return {state: 'unknown', pid: null, hostname: null};
  }

  // Foreign (another machine) or genuinely unattributable: never signal its pid.
  if (!isLocalLockIdentity(parsed.hostname, platform)) {
    return {state: 'unknown', pid: null, hostname: parsed.hostname};
  }
  if (!aliveCheck(parsed.pid)) {
    return {state: 'free', pid: null, hostname: parsed.hostname};
  }
  return {state: 'locked', pid: parsed.pid, hostname: parsed.hostname};
}

// ---------------------------------------------------------------------------
// DevTools endpoint
// ---------------------------------------------------------------------------

/** First line of DevToolsActivePort is the port; the second is a ws path. */
export function parseDevToolsActivePort(contents: string): number | null {
  const first = contents.split('\n')[0]?.trim() ?? '';
  const port = Number.parseInt(first, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return null;
  }
  return port;
}

/** The debug port a running browser advertised, if it was given one. */
export function readDevToolsPort(userDataDir: string): number | null {
  const portFile = join(userDataDir, 'DevToolsActivePort');
  try {
    if (!existsSync(portFile)) {
      return null;
    }
    return parseDevToolsActivePort(readFileSync(portFile, 'utf-8'));
  } catch {
    return null;
  }
}

export interface DevToolsIdentity {
  /** e.g. "Opera/121.0.0.0" or "Chrome/141.0.0.0" */
  browser: string;
  isOpera: boolean;
}

/**
 * Confirm a debug port is live and find out what is on the other end.
 *
 * DevToolsActivePort survives a clean exit, so a recorded port proves nothing
 * until something answers on it.
 */
export function probeDevToolsEndpoint(
  port: number,
  timeoutMs = 1500,
): Promise<DevToolsIdentity | null> {
  const {promise, resolve} = Promise.withResolvers<DevToolsIdentity | null>();
  const req = request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/json/version',
      method: 'GET',
      timeout: timeoutMs,
    },
    res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as {Browser?: unknown};
          if (typeof parsed.Browser !== 'string') {
            resolve(null);
            return;
          }
          resolve({
            browser: parsed.Browser,
            isOpera: /opera|opr\//i.test(parsed.Browser),
          });
        } catch {
          resolve(null);
        }
      });
    },
  );
  req.on('error', () => resolve(null));
  req.on('timeout', () => {
    req.destroy();
    resolve(null);
  });
  req.end();
  return promise;
}
