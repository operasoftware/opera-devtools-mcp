/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {STATE_DIR_NAME} from './branding.js';

/**
 * The five `OPERA_CLI_*` variables the fork recognises. Ported from
 * opera-browser-cli's `KNOWN_CONFIG_KEYS` and filtered to Phase 1a scope —
 * `PORT`, `MCP_BIN`, `ENABLE_HOOKS`, `TAKEOVER` and `DEV` are dropped or
 * deferred to feature-owning phases. Also the promotion allowlist: only these
 * keys may reach `process.env`, so a typo (or a stray `NODE_OPTIONS`) in the
 * config file cannot silently become part of the daemon's environment.
 */
export const KNOWN_CONFIG_KEYS = [
  'OPERA_CLI_EXECUTABLE_PATH',
  'OPERA_CLI_BROWSER_URL',
  'OPERA_CLI_USER_DATA_DIR',
  'OPERA_CLI_HEADED',
  'OPERA_CLI_CHROME_ARGS',
] as const;

/** `~/.opera-browser-cli`, derived from the branding constant. */
export function getStateDir(home: string = homedir()): string {
  return join(home, STATE_DIR_NAME);
}

/** `~/.opera-browser-cli/config`, derived from the branding constant. */
export function getConfigFile(home: string = homedir()): string {
  return join(getStateDir(home), 'config');
}

/** Module-load snapshot of `getConfigFile()`; `readConfigFile` defaults to it. */
const DEFAULT_CONFIG_FILE = getConfigFile();

/**
 * Strip a matching quote pair and unescape the escaped quotes inside it.
 * Ported verbatim from opera-browser-cli's `parseConfigValue`.
 */
export function parseConfigValue(raw: string): string {
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return raw;
}

/** Levenshtein distance, capped — only used to suggest a corrected key. */
function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = Array.from({length: cols}, (_, i) => i);
  for (let i = 1; i < rows; i++) {
    const curr = [i, ...Array<number>(cols - 1).fill(0)];
    for (let j = 1; j < cols; j++) {
      curr[j] = Math.min(
        prev[j]! + 1,
        curr[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[cols - 1]!;
}

export interface UnknownKey {
  key: string;
  suggestion: string | null;
}

/** Config keys this program does not read, with a likely intended key where obvious. */
export function findUnknownConfigKeys(
  config: Record<string, string>,
): UnknownKey[] {
  const unknown: UnknownKey[] = [];
  for (const key of Object.keys(config)) {
    if ((KNOWN_CONFIG_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of KNOWN_CONFIG_KEYS) {
      const distance = editDistance(key, candidate);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = candidate;
      }
    }
    const tolerance = Math.max(4, Math.ceil(key.length / 3));
    unknown.push({key, suggestion: bestDistance <= tolerance ? best : null});
  }
  return unknown;
}

/**
 * Read the config file as KEY=VALUE lines. `#` comments and blank lines are
 * skipped, along with lines without a `=`; an unreadable or missing file reads
 * as `{}` — config is a cache, never a prerequisite.
 *
 * `filePath` exists only as a test seam; production callers use the default.
 */
export function readConfigFile(
  filePath = DEFAULT_CONFIG_FILE,
): Record<string, string> {
  const config: Record<string, string> = {};
  try {
    for (const line of readFileSync(filePath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }
      const eq = trimmed.indexOf('=');
      if (eq === -1) {
        continue;
      }
      config[trimmed.slice(0, eq).trim()] = parseConfigValue(
        trimmed.slice(eq + 1).trim(),
      );
    }
  } catch {
    // Unreadable or missing config is treated as absent — never fail a command over it.
  }
  return config;
}

/**
 * Promote the recognised config-file entries into `process.env`, only where the
 * variable is not already set (so environment beats config). Unrecognised keys
 * are never promoted — the file is user-writable data, and handing it arbitrary
 * environment variables (a stray `NODE_OPTIONS`, say) would let it steer the
 * daemon the CLI spawns. They warn instead: once per unrecognised key per call,
 * with the closest suggestion. Never fails a run.
 */
export function loadOperaCliConfig(filePath = DEFAULT_CONFIG_FILE): void {
  const config = readConfigFile(filePath);
  for (const [key, value] of Object.entries(config)) {
    if (
      (KNOWN_CONFIG_KEYS as readonly string[]).includes(key) &&
      !(key in process.env)
    ) {
      process.env[key] = value;
    }
  }
  for (const {key, suggestion} of findUnknownConfigKeys(config)) {
    console.error(
      suggestion
        ? `Warning: unknown config key "${key}" — did you mean "${suggestion}"?`
        : `Warning: unknown config key "${key}".`,
    );
  }
}

/** True when any of `flags` (bare or `=value` form) already appears on argv. */
function hasArg(argv: string[], ...flags: string[]): boolean {
  return argv.some(arg =>
    flags.some(flag => arg === flag || arg.startsWith(`${flag}=`)),
  );
}

/**
 * Default Chromium arguments Puppeteer injects that must be reverted when
 * launching Opera against a persistent profile. Ported from
 * opera-browser-cli's `buildTransportArgs()`: a mocked keychain and
 * `--password-store=basic` stop the browser decrypting the real Keychain (so
 * the profile launches logged out), while the component-extension and
 * background default blockers stop the Opera AI extension from loading (so
 * `Opera.dispatchAction` has "no target" to dispatch to).
 */
const PERSISTENT_PROFILE_IGNORE_DEFAULT_ARGS = [
  '--use-mock-keychain',
  '--password-store=basic',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-default-apps',
  '--disable-background-networking',
];
/**
 * Translate `OPERA_CLI_*` env vars into the equivalent yargs flags and append
 * them to `argv`, only when the flag was not already passed on the command
 * line (so an explicit flag beats the environment). Replaces
 * opera-browser-cli's `buildTransportArgs`, which emitted the same mapping as
 * bridge spawn args rather than argv.
 */
export function applyEnvToArgv(argv: string[]): void {
  const env = process.env;

  // The CLI never routes by pageId (it replaces the retired opera-browser-cli).
  // Only CLI-spawned sessions — not direct MCP clients — disable routing on the
  // server.
  if (argv.includes('--viaCli') && !hasArg(argv, '--no-page-id-routing')) {
    argv.push('--no-page-id-routing');
  }
  const headed = env.OPERA_CLI_HEADED?.trim();
  if (headed && !hasArg(argv, '--headless', '--no-headless')) {
    if (headed === '1' || headed.toLowerCase() === 'true') {
      argv.push('--headless=false');
    } else if (headed === '0' || headed.toLowerCase() === 'false') {
      argv.push('--headless=true');
    } else {
      // `true`/`false` are natural spellings; anything else is a typo that
      // would otherwise be dropped without a trace.
      console.error(
        `Warning: ignoring OPERA_CLI_HEADED="${env.OPERA_CLI_HEADED}" — expected 1, 0, true, or false.`,
      );
    }
  }

  const chromeArgs = env.OPERA_CLI_CHROME_ARGS;
  if (chromeArgs?.trim() && !hasArg(argv, '--chromeArg', '--chrome-arg')) {
    for (const arg of chromeArgs.trim().split(/\s+/)) {
      argv.push(`--chromeArg=${arg}`);
    }
  }

  const browserUrl = env.OPERA_CLI_BROWSER_URL;
  if (browserUrl && !hasArg(argv, '--browserUrl', '--browser-url', '-u')) {
    argv.push(`--browserUrl=${browserUrl}`);
  }

  // Attaching to an already-running browser (by URL or WS endpoint) means the
  // browser lifecycle is managed externally. `--userDataDir` and
  // `--executablePath` both conflict with a browser URL/WS endpoint in yargs
  // (see `browserOptions.conflicts`), so injecting either from config here
  // aborts argument parsing — the "Arguments userDataDir and browserUrl are
  // mutually exclusive" crash. Mirror opera-browser-cli's `buildTransportArgs`:
  // a browser URL wins and the profile/executable flags are skipped entirely.
  const attachesToBrowser = hasArg(
    argv,
    '--browserUrl',
    '--browser-url',
    '-u',
    '--wsEndpoint',
    '--ws-endpoint',
    '-w',
  );

  // A persistent profile overrides isolated mode, and `--userDataDir` is
  // mutually exclusive with `--isolated` in yargs — so emit the dir alone, plus
  // the companion flags ported from opera-browser-cli's `buildTransportArgs()`
  // (drop the Puppeteer defaults that block Keychain decryption and extension
  // loading, and load the Opera AI component extension explicitly).
  const userDataDir = env.OPERA_CLI_USER_DATA_DIR;
  if (
    userDataDir &&
    !attachesToBrowser &&
    !hasArg(argv, '--userDataDir', '--user-data-dir')
  ) {
    argv.push(`--userDataDir=${userDataDir}`);
    for (const flag of PERSISTENT_PROFILE_IGNORE_DEFAULT_ARGS) {
      argv.push(`--ignoreDefaultChromeArg=${flag}`);
    }
    argv.push('--chromeArg=--show-component-extension-options');
  }

  const executablePath = env.OPERA_CLI_EXECUTABLE_PATH;
  if (
    executablePath &&
    !attachesToBrowser &&
    !hasArg(argv, '--autoConnect', '--auto-connect') &&
    !hasArg(argv, '--executablePath', '--executable-path', '-e')
  ) {
    argv.push(`--executablePath=${executablePath}`);
  }
}
