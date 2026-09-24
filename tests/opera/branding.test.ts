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

import {
  INDEX_SCRIPT_NAME,
  MCP_BIN_NAME,
  PACKAGE_NAME,
  STATE_DIR_NAME,
} from '../../src/opera/branding.js';

describe('branding', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'),
  ) as {name: string};

  it('names the package the same as package.json', () => {
    // A drift breaks `npx opera-devtools-mcp`, the daemon's spawned bin name,
    // and every log line that names the product.
    assert.strictEqual(
      PACKAGE_NAME,
      packageJson.name,
      `branding.ts is ${PACKAGE_NAME} but package.json is ${packageJson.name}.`,
    );
  });

  it('derives the MCP bin name and index script from the package name', () => {
    assert.strictEqual(MCP_BIN_NAME, PACKAGE_NAME);
    assert.strictEqual(INDEX_SCRIPT_NAME, `${MCP_BIN_NAME}.js`);
  });

  it('keeps the per-user state directory dot-prefixed', () => {
    assert.ok(STATE_DIR_NAME.startsWith('.'), STATE_DIR_NAME);
  });
});
