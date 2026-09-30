/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Stop the legacy `opera-browser-cli` HTTP bridge.
 *
 * Before the two packages were merged, `opera-browser-cli` ran an HTTP bridge
 * that held port 9225 (scanning up to 9234) and wrote its identity to
 * `~/.opera-browser-cli/bridge.pid`. A user upgrading to `opera-devtools-mcp`
 * may still have that bridge running, holding a browser and a stdio child of
 * the old MCP server. The new CLI speaks to a Unix-socket daemon instead, so a
 * surviving bridge is a resource leak and a confusing second `opera-browser-cli`
 * in `ps` — this module removes it.
 *
 * Nothing here runs at install time. npm ≥12 blocks install scripts unless the
 * user opts in with a flag nobody types, so the cleanup lives where it always
 * executes: `runLegacyMigrationGuard` is awaited by both entry points — the CLI
 * bin (`opera-browser-cli`) and the MCP bin (`opera-devtools-mcp`), which an MCP
 * client starts on its own, with no CLI invocation anywhere.
 *
 * Two rules govern which process may be signalled, both lifted from the old
 * client's own identity contract: a PID is only trusted when its PID file also
 * records *this* boot (a recycled PID after a reboot must never be killed), and
 * a bridge answering `/health` is trusted by that answer alone. Port probing and
 * the PID file are therefore two independent ways to recognise the same bridge,
 * and neither ever signals a process it has not identified.
 *
 * The legacy CLI starts its bridge `detached`, which makes the bridge a process
 * group leader whose browser and stdio MCP child share its group. Every signal
 * goes to that group: a bridge that ignores SIGTERM is SIGKILLed, and its exit
 * handler — the one that group-kills its children — never runs on SIGKILL.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {getRuntimeHome} from '../daemon/utils.js';
import {STATE_DIR_NAME} from './branding.js';
import {notifyLegacyPackageInstalled} from './launcherNotice.js';
import {
  getEffectiveHome,
  isMigrationActive,
  isProcessAlive,
  terminateProcess,
  warn,
} from './migrationShared.js';

/** Port the legacy bridge prefers, and how many consecutive ports it scans. */
export const LEGACY_DEFAULT_PORT = 9225;
export const LEGACY_PORT_SCAN_COUNT = 10;

/** What the legacy bridge names itself in its `/health` payload. */
const LEGACY_SERVER_NAME = 'opera-browser-cli';

const HEALTH_TIMEOUT_MS = 2_000;

export interface LegacyBridgeStopOptions {
  /** Home directory holding `.opera-browser-cli`. Defaults to `os.homedir()`. */
  home?: string;
}

interface LegacyPidInfo {
  pid: number;
  port: number;
  /** Absent on bridges that predate the identity fields. */
  bootMinute?: number;
}

/** `~/.opera-browser-cli/bridge.pid` (or `<home>/.opera-browser-cli/bridge.pid`). */
export function getLegacyPidFilePath(home: string = os.homedir()): string {
  return path.join(home, STATE_DIR_NAME, 'bridge.pid');
}

/**
 * The ports the legacy bridge may live on, in preference order. Reads the same
 * `OPERA_CLI_PORT` override the old client honoured.
 */
export function legacyCandidatePorts(): number[] {
  const base = Number.parseInt(
    process.env.OPERA_CLI_PORT ?? String(LEGACY_DEFAULT_PORT),
    10,
  );
  const start = Number.isFinite(base) ? base : LEGACY_DEFAULT_PORT;
  return Array.from({length: LEGACY_PORT_SCAN_COUNT}, (_, i) => start + i);
}

/**
 * The instant this machine booted, in whole minutes since the epoch, or null
 * when the process cannot ask — some sandboxes deny the `uptime` syscall.
 * A null answer means "cannot verify this boot", which is a refusal to signal,
 * not a reason to fail.
 */
function computeBootMinute(nowMs: number = Date.now()): number | null {
  try {
    return Math.floor((nowMs - os.uptime() * 1000) / 60_000);
  } catch {
    return null;
  }
}

function readLegacyPidFile(home: string): LegacyPidInfo | null {
  try {
    const data = JSON.parse(
      fs.readFileSync(getLegacyPidFilePath(home), 'utf-8'),
    ) as Partial<LegacyPidInfo>;
    if (typeof data.pid === 'number' && typeof data.port === 'number') {
      return data as LegacyPidInfo;
    }
    return null;
  } catch {
    return null;
  }
}

function removeLegacyPidFile(home: string): void {
  try {
    fs.rmSync(getLegacyPidFilePath(home), {force: true});
  } catch {
    // Best-effort: a PID file we cannot remove is not worth failing the install.
  }
}

/** The one notice both stop paths print before signalling a bridge. */
function legacyStopWarning(pid: number): string {
  return `opera-devtools-mcp: stopping legacy HTTP bridge (pid ${pid}) for migration — any active browser session will be interrupted.`;
}

/**
 * Stop the bridge the PID file names, if it names a live one from this boot.
 *
 * This is the CLI's fast path: one file read, no network. It never throws — the
 * CLI calls it before every command, and a migration convenience must not be
 * able to break a working CLI — so anything unexpected reads as "nothing to
 * do". A PID file that names a dead process, or one stamped with a different
 * boot, is cleaned up but never signalled; the port probe is the only way to
 * identify that bridge safely.
 */
export async function stopLegacyBridge(
  options: LegacyBridgeStopOptions = {},
): Promise<boolean> {
  try {
    const home = options.home ?? os.homedir();
    const info = readLegacyPidFile(home);
    if (info === null) {
      return false;
    }
    if (!isProcessAlive(info.pid)) {
      removeLegacyPidFile(home);
      return false;
    }
    const bootMinute = computeBootMinute();
    const fromThisBoot =
      typeof info.bootMinute === 'number' &&
      bootMinute !== null &&
      Math.abs(info.bootMinute - bootMinute) <= 1;
    if (!fromThisBoot) {
      // An unverifiable PID may be a stranger's after a reboot. Leave the file
      // so the port probe can identify the bridge by its `/health` answer.
      return false;
    }
    warn(legacyStopWarning(info.pid));
    const gone = await terminateProcess(info.pid, {group: true});
    if (gone) {
      removeLegacyPidFile(home);
    }
    return gone;
  } catch {
    return false;
  }
}

/** One HTTP GET, resolving to the body or null on any error or timeout. */
function httpGetHealth(port: number): Promise<string | null> {
  const {promise, resolve} = Promise.withResolvers<string | null>();
  const req = http.request(
    {
      hostname: '127.0.0.1',
      port,
      path: '/health',
      method: 'GET',
      timeout: HEALTH_TIMEOUT_MS,
    },
    res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        body += chunk;
      });
      res.on('end', () => resolve(body));
      res.on('error', () => resolve(null));
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

/**
 * Probe the candidate ports and stop every bridge of ours that answers.
 *
 * Used on install, where the bridge's PID file may be missing or root-owned and
 * `/health` is the only remaining identity. A response is ours when its `server`
 * field says so; its `pid` is then the process to stop, falling back to a live
 * PID file that names the same port.
 */
export async function probeAndStopLegacyBridges(
  ports: number[],
  options: LegacyBridgeStopOptions = {},
): Promise<boolean> {
  try {
    const home = options.home ?? os.homedir();
    const fileInfo = readLegacyPidFile(home);
    const probes = await Promise.all(
      ports.map(async port => {
        const body = await httpGetHealth(port);
        if (body === null) {
          return null;
        }
        try {
          const record = JSON.parse(body) as {server?: unknown; pid?: unknown};
          if (record.server !== LEGACY_SERVER_NAME) {
            return null;
          }
          return {
            port,
            pid: typeof record.pid === 'number' ? record.pid : 0,
          };
        } catch {
          return null;
        }
      }),
    );

    let stopped = false;
    for (const probe of probes) {
      if (probe === null) {
        continue;
      }
      const pid =
        probe.pid > 0
          ? probe.pid
          : fileInfo &&
              fileInfo.port === probe.port &&
              isProcessAlive(fileInfo.pid)
            ? fileInfo.pid
            : null;
      if (pid === null || !isProcessAlive(pid)) {
        continue;
      }
      warn(legacyStopWarning(pid));
      stopped = (await terminateProcess(pid, {group: true})) || stopped;
    }

    if (fileInfo !== null && !isProcessAlive(fileInfo.pid)) {
      removeLegacyPidFile(home);
    }
    return stopped;
  } catch {
    return false;
  }
}

/** The file that records the boot this user's boot-scoped pass already ran in. */
const BOOT_SCOPED_PASS_FILE = 'legacy-guard';

/**
 * Claim the once-per-boot pass, and say whether this call owns it.
 *
 * The pass probes the bridge's port window, which is the only way to identify a
 * bridge whose PID file is missing, unreadable (it is mode 0600, so another user
 * cannot read it), or stamped with a boot this process cannot verify. That is
 * network I/O and a possible kill, so it happens at most once per boot per user
 * rather than on every command and every MCP server start.
 *
 * The recorded stamp is the boot instant, exactly as in the bridge's own PID
 * file, so a stale marker cannot outlive a reboot — `/tmp` is not guaranteed to
 * be cleared on macOS, and the marker may also live under `XDG_RUNTIME_DIR`.
 * A marker that cannot be written, or a boot that cannot be computed, claims the
 * pass: a repeated probe is cheap, skipping the cleanup is not.
 */
function claimBootScopedPass(): boolean {
  const marker = path.join(getRuntimeHome(''), BOOT_SCOPED_PASS_FILE);
  let recorded: number | null = null;
  try {
    const text = fs.readFileSync(marker, 'utf-8');
    recorded = Number.parseInt(text, 10);
  } catch {
    // No marker yet, or one we cannot read: this call owns the pass and
    // rewrites it below.
  }
  const bootMinute = computeBootMinute();
  if (
    bootMinute !== null &&
    recorded !== null &&
    Number.isFinite(recorded) &&
    Math.abs(recorded - bootMinute) <= 1
  ) {
    return false;
  }
  try {
    fs.mkdirSync(getRuntimeHome(''), {recursive: true});
    fs.writeFileSync(marker, String(bootMinute ?? ''), {mode: 0o600});
  } catch {
    // A pass that cannot be recorded runs again next time; the probe is cheap
    // and the cleanup is not something to skip over a filesystem error.
  }
  return true;
}

/**
 * The migration guard both entry points await before they do any work.
 *
 * Split by cost, not by entry point: the PID-file fast path is one read and runs
 * on every command and every MCP server start, so a bridge that left its PID
 * file behind is stopped even by `--version`; the port window is swept once per
 * boot, which covers the orphan the PID file cannot name.
 *
 * Never throws, and never writes to stdout — the CLI's result and the MCP
 * transport both own that stream, and a migration convenience must not be able
 * to break either.
 */
export async function runLegacyMigrationGuard(): Promise<void> {
  if (!isMigrationActive()) {
    return;
  }
  // Under `sudo`, the bridge belongs to the invoking user, not to root.
  const home = getEffectiveHome();
  await stopLegacyBridge({home});
  if (!claimBootScopedPass()) {
    return;
  }
  await probeAndStopLegacyBridges(legacyCandidatePorts(), {home});
  notifyLegacyPackageInstalled();
}
