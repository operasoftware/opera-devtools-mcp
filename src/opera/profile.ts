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

import childProcess from 'node:child_process';
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
 * The names this machine's Chromium may have written into a `SingletonLock`.
 *
 * `os.hostname()` is `gethostname()`, and on macOS that is the short,
 * ComputerName-derived name — "Mac", on a laptop that has been renamed — while
 * Chromium's POSIX singleton asks `[[NSHost currentHost] name]`, the Bonjour
 * name built from the LocalHostName ("opera-users-MacBook-Pro-2.local"). The
 * two disagree on any renamed Mac, and a lock that names the other spelling is
 * still this machine's. Treating it as foreign discards the pid, and the pid is
 * the only thing that can restart the browser holding the profile: the user is
 * told to quit Opera themselves for a browser we could have identified.
 *
 * `scutil` is asked per call rather than cached, so a test can stub the process
 * seam and see its own answer; it costs a few milliseconds on a path that runs
 * once per command, and a failure (no `scutil`, or a sandbox that blocks it)
 * simply leaves the name out — the old behaviour.
 */
export function localHostNames(
  platform: NodeJS.Platform = process.platform,
): string[] {
  const names = [hostname()];
  if (platform === 'darwin') {
    const local = readMacLocalHostName();
    if (local !== null) {
      names.push(local, `${local}.local`);
    }
    // Chromium's macOS singleton has also been seen writing this marker in
    // place of a hostname; it means this machine either way.
    names.push('Mac');
  }
  return [...new Set(names)];
}

function readMacLocalHostName(): string | null {
  try {
    const name = childProcess
      .execFileSync('scutil', ['--get', 'LocalHostName'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();
    return name && name !== 'not set' ? name : null;
  } catch {
    return null;
  }
}

/**
 * Whether a pid belongs to a running process on this machine.
 *
 * `EPERM` means it exists but belongs to another user, which still counts as
 * alive; anything else means it is gone. Exported because the pid is polled
 * while waiting for a signalled browser to exit (`browserTarget.ts`), and that
 * poll has to agree with this one about the EPERM case.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
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
  localNames: readonly string[] = localHostNames(platform),
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

  // Another machine (a synced profile) or a local name we do not know: never
  // signal its pid.
  if (!localNames.includes(parsed.hostname)) {
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

export interface AttachableEndpoint {
  /** e.g. `http://127.0.0.1:9222` */
  url: string;
  identity: DevToolsIdentity;
}

/**
 * The browser URL to attach to for this profile, or null when there is nothing
 * live to attach to.
 *
 * This is the one signal that makes driving the user's own browser automatic:
 * a browser started with `--remote-debugging-port` records its port in the
 * profile, so every later command finds it without any configuration.
 */
export async function findAttachableEndpoint(
  userDataDir: string,
): Promise<AttachableEndpoint | null> {
  const port = readDevToolsPort(userDataDir);
  if (port === null) {
    return null;
  }
  const identity = await probeDevToolsEndpoint(port);
  if (identity === null) {
    return null;
  }
  return {url: `http://127.0.0.1:${port}`, identity};
}
