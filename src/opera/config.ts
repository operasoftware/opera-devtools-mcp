/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Writing, validating, and — on a fresh machine — inventing the configuration
 * file. Ported from opera-browser-cli's `src/config.ts` (Phase 1b), filtered
 * to the write + first-run autoconfiguration path; the read side and unknown
 * key detection live in `envConfig.ts`.
 *
 * The guiding rule is unchanged: config is a cache of decisions, not a
 * prerequisite. A user who has never run `setup` gets a working browser on
 * their first command, not a hint telling them to go and configure something.
 */

import {chmodSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

import {detectBrowser, type DetectedBrowser} from './detect.js';
import {getConfigFile, getStateDir, readConfigFile} from './envConfig.js';
import {defaultProfileDir} from './profile.js';

/**
 * Write the config file. `home` is a test seam; production callers use the
 * default, derived from `os.homedir()` at call time.
 *
 * A value containing a line break is rejected rather than escaped: the reader
 * splits on `\n` and drops what it cannot parse, so such a value would come
 * back truncated. A loud error beats silent data loss.
 */
export function writeConfigFile(
  config: Record<string, string>,
  home: string = homedir(),
): void {
  for (const [key, value] of Object.entries(config)) {
    if (value.includes('\n')) {
      throw new Error(
        `Cannot write ${key}: the value contains a newline, which the config reader treats as a line separator.`,
      );
    }
  }
  mkdirSync(getStateDir(home), {recursive: true, mode: 0o700});
  const lines = [
    '# opera-browser-cli configuration — auto-loaded on every run',
    '# Values here are used as defaults when the env var is not already set.',
    '',
    // Escapes quotes only. Backslashes are left literal on purpose: the reader
    // (parseConfigValue) is a verbatim port that does not unescape `\\`, so
    // escaping backslashes here would corrupt values like UNC paths on read.
    ...Object.entries(config).map(
      ([key, value]) => `${key}="${value.replace(/"/g, '\\"')}"`,
    ),
  ];
  const file = getConfigFile(home);
  writeFileSync(file, lines.join('\n') + '\n', {mode: 0o600});
  // `mode` only applies when the file is created; a file that already exists
  // (hand-written, or left behind by an older tool) keeps its old permissions.
  chmodSync(file, 0o600);
}

/** Apply a patch to the config file. A null value removes the key. */
export function updateConfigFile(
  patch: Record<string, string | null>,
  home: string = homedir(),
): void {
  const config = readConfigFile(getConfigFile(home));
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete config[key];
    } else {
      config[key] = value;
    }
  }
  writeConfigFile(config, home);
}

// ---------------------------------------------------------------------------
// First-run autoconfiguration
// ---------------------------------------------------------------------------

export interface AutoConfigureOptions {
  home?: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  /** Write the result to disk. Off for previewing what would happen. */
  persist?: boolean;
  /** Environment to read for existing-browser detection. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export type AutoConfigureResult =
  | {status: 'already-configured'}
  | {status: 'no-browser'}
  | {
      status: 'configured';
      browser: DetectedBrowser;
      settings: Record<string, string>;
    };

/**
 * Decide the settings for a machine that has never been configured.
 *
 * Chooses the browser's real profile when there is one, rather than a private
 * CLI profile: the point of using Opera is the session you are already signed
 * in to. A profile that turns out to be in use is resolved at launch time, so
 * preferring it here costs nothing.
 *
 * `options.home` threads into every path derivation (config file check, fallback
 * profile, detection) — upstream used a module-load `STATE_DIR` constant for the
 * first two, which made `home` only half-honoured.
 */
export function computeAutoConfig(
  options: AutoConfigureOptions = {},
): AutoConfigureResult {
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const env = options.env ?? process.env;

  const alreadyConfigured =
    exists(getConfigFile(home)) ||
    Boolean(env.OPERA_CLI_EXECUTABLE_PATH) ||
    Boolean(env.OPERA_CLI_BROWSER_URL);
  if (alreadyConfigured) {
    return {status: 'already-configured'};
  }

  const browser = detectBrowser(platform, home, exists, env);
  if (browser === null) {
    return {status: 'no-browser'};
  }

  const settings: Record<string, string> = {
    OPERA_CLI_EXECUTABLE_PATH: browser.path,
    // Every Opera AI feature needs a window to sign in with; a real browser
    // implies the user wants to see it.
    OPERA_CLI_HEADED: '1',
    OPERA_CLI_USER_DATA_DIR:
      defaultProfileDir(browser.path, home, platform, env) ??
      join(getStateDir(home), 'profile'),
  };

  return {status: 'configured', browser, settings};
}

/**
 * Apply settings to the environment this run uses, so the current command
 * benefits too. `env` is the same seam `computeAutoConfig` reads, so a caller
 * that supplies one gets the writes there rather than in `process.env`.
 */
export function applySettingsToEnv(
  settings: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const [key, value] of Object.entries(settings)) {
    if (!(key in env)) {
      env[key] = value;
    }
  }
}

/**
 * Configure a fresh machine, if it needs it. Returns what happened so the
 * caller can tell the user in one line.
 */
export function autoConfigure(
  options: AutoConfigureOptions = {},
): AutoConfigureResult {
  const result = computeAutoConfig(options);
  if (result.status !== 'configured') {
    return result;
  }

  if (options.persist !== false) {
    try {
      writeConfigFile(result.settings, options.home);
    } catch (error) {
      // An unwritable state dir must not stop this run — the settings still
      // apply in-process — and every write failure here is a broken state dir,
      // so say so rather than let `doctor` (a later phase) be the only thing
      // that ever mentions it.
      console.error(
        `Warning: could not save configuration to ${getConfigFile(options.home)}: ${
          error instanceof Error ? error.message : String(error)
        }. Settings apply to this run only.`,
      );
    }
  }
  applySettingsToEnv(result.settings, options.env);
  return result;
}

const AUTO_CONFIG_SKIP_COMMANDS: Record<string, true> = {
  logs: true,
  setup: true,
};

/** Pure query flags — wherever they appear — that must never write state. */
const AUTO_CONFIG_QUERY_FLAGS: Record<string, true> = {
  '--help': true,
  '-h': true,
  '--version': true,
  '-v': true,
  '-V': true,
};

/**
 * Whether this invocation may autoconfigure a fresh machine. Help/version
 * queries and the inspection commands (`logs`, `setup`) are pure and must
 * never write the config file; `setup` is the escape hatch the user runs to
 * change configuration, so autoconfiguring underneath it would be
 * presumptuous. Help/version flags are scanned across the whole argv (not just
 * `argv[2]`), so `opera-browser-cli start --help` stays side-effect free.
 */
export function shouldAutoConfigure(argv: string[]): boolean {
  const command = argv[2];
  const isQuery =
    (command !== undefined &&
      Object.hasOwn(AUTO_CONFIG_SKIP_COMMANDS, command)) ||
    argv.some(arg => Object.hasOwn(AUTO_CONFIG_QUERY_FLAGS, arg));
  return !isQuery;
}
