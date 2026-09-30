/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * What to tell a user whose CLI was delivered by the compatibility launcher.
 *
 * `opera-browser-cli@0.1.55` is a launcher: it declares the old package name
 * and the old bin name, depends on this package, and spawns this CLI. That is
 * how a habit-driven `npm i -g opera-browser-cli` (or `npm update -g
 * opera-browser-cli`) picks up the new implementation without `--force` and
 * without a manual uninstall — npm only retires a foreign binstub on a
 * same-name upgrade.
 *
 * The end state removes the launcher again, and the user has to be told how:
 * npm has no `replaces` field, and an install-time script is blocked by
 * npm ≥12's `allowScripts` gate by default. The launcher therefore marks its
 * child with `OPERA_CLI_LAUNCHER=1` (and passes the prefix it resolved as
 * `OPERA_CLI_LAUNCHER_PREFIX`, for support), and both `--version` and `doctor`
 * — the two commands a stuck user runs — print the retirement recipes when the
 * marker is set.
 *
 * The other direction has no marker to react to: a user who installed this
 * package next to the *pre-launcher* `opera-browser-cli` never runs this CLI at
 * all, they run the old one. `notifyLegacyPackageInstalled` covers that case
 * from the runtime guard, and is the only notice here that reads the filesystem.
 *
 * The recipes are printed verbatim so they can be pasted; a release that
 * publishes the tombstone has to change the text here (see
 * `docs/npm-package-transition.md`).
 */

import fs from 'node:fs';
import path from 'node:path';

import {resolveGlobalPrefix, warn} from './migrationShared.js';

/** Marker the launcher's `bin/cli.js` sets to `1` before it spawns this CLI. */
const LAUNCHER_ENV = 'OPERA_CLI_LAUNCHER';

/**
 * Say one line if the pre-launcher `opera-browser-cli` is still installed.
 *
 * Called from the runtime migration guard (`legacyBridgeCleanup`), because the
 * install hook this used to run in is blocked by npm ≥12's `allowScripts` gate.
 * The check is a filesystem read rather than `npm ls -g`, which would spawn a
 * second npm that contends on the arborist lock npm 7+ holds during a global
 * install — observed to hang on npm 9 and 10. The old package is never
 * uninstalled from here for the same reason: the user is pointed at the command
 * instead.
 *
 * Two of the package's releases are the migration working as intended and must
 * not be reported, because `npm i -g opera-browser-cli@latest` would install
 * exactly what is already there:
 *
 *   - `0.1.55`, the compatibility launcher that delivered this install,
 *     recognised by its `bin/cli.js` marker;
 *   - `0.2.0`, the bin-less tombstone that retires the launcher, recognised by
 *     version (`0.2.0` is the first release without a bin).
 *
 * What remains at that path — an older `0.1.x`, or a hand-copied file — is what
 * this notice is for.
 */
export function notifyLegacyPackageInstalled(): void {
  try {
    const prefix = resolveGlobalPrefix();
    if (prefix === null) {
      return;
    }
    const candidates = [
      path.join(prefix, 'lib', 'node_modules', 'opera-browser-cli'),
      path.join(prefix, 'node_modules', 'opera-browser-cli'),
    ];
    const installed = candidates.find(dir =>
      fs.existsSync(path.join(dir, 'package.json')),
    );
    if (installed === undefined) {
      return;
    }
    if (fs.existsSync(path.join(installed, 'bin', 'cli.js'))) {
      return;
    }
    let version = '';
    try {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(installed, 'package.json'), 'utf-8'),
      ) as {version?: unknown};
      version = typeof manifest.version === 'string' ? manifest.version : '';
    } catch {
      // Unreadable reads as pre-launcher: the status quo this notice is for.
    }
    const [major = 0, minor = 0] = version.split('.').map(part => Number(part));
    if (major > 0 || (major === 0 && minor >= 2)) {
      return;
    }
    warn(
      `opera-devtools-mcp: legacy opera-browser-cli detected at ${installed}; run: npm i -g opera-browser-cli@latest to migrate.`,
    );
  } catch {
    // A notice that cannot be composed must not be the thing that breaks a start.
  }
}

/**
 * The recipes that retire the launcher, or the empty string when this CLI was
 * not launched by it — callers join the result into their output and never have
 * to branch.
 */
export function launcherMigrationNotice(): string {
  if (process.env[LAUNCHER_ENV] !== '1') {
    return '';
  }
  return [
    'Notice: this CLI was launched via the compatibility launcher (opera-browser-cli@0.1.55).',
    'To complete migration, run either:',
    '  npm i -g opera-devtools-mcp@latest opera-browser-cli@latest',
    '    (then optionally: npm rm -g opera-browser-cli)',
    '  — or —',
    '  npm rm -g opera-browser-cli',
    '  npm i -g opera-devtools-mcp@latest',
  ].join('\n');
}
