/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {describe, it} from 'node:test';

import {VERSION} from '../../src/version.js';

describe('VERSION', () => {
  it('matches the version in package.json', () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
    );

    // `npm ci` already fails when package-lock.json drifts from package.json,
    // so src/version.ts is the only copy of the version nothing else checks.
    // It is reported in the MCP handshake, by `--version`, and to the update
    // checker, which compares it against the version published on npm — a
    // stale one tells every user an update is available.
    assert.strictEqual(
      VERSION,
      packageJson.version,
      `src/version.ts is ${VERSION} but package.json is ${packageJson.version}; a release must bump both.`,
    );
  });
});
