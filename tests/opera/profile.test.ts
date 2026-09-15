/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import {defaultProfileDir} from '../../src/opera/profile.js';

const tempDirs: string[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opera-profile-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

/** Create the profile dir the build should map to, and assert it is found. */
function assertProfileDir(browserPath: string, bundle: string): void {
  const home = tempHome();
  const expected = path.join(home, 'Library', 'Application Support', bundle);
  fs.mkdirSync(expected, {recursive: true});

  assert.strictEqual(defaultProfileDir(browserPath, home, 'darwin'), expected);
}

describe('defaultProfileDir', () => {
  it('maps Opera Neon Developer to its own bundle', () => {
    assertProfileDir(
      '/Applications/Opera Neon Developer.app/Contents/MacOS/Opera',
      'com.operasoftware.OperaNeonDeveloper',
    );
  });

  it('maps Opera Neon to its own bundle', () => {
    assertProfileDir(
      '/Applications/Opera Neon.app/Contents/MacOS/Opera',
      'com.operasoftware.OperaNeon',
    );
  });

  it('maps Opera GX to com.operasoftware.OperaGX', () => {
    assertProfileDir(
      '/Applications/Opera GX.app/Contents/MacOS/Opera',
      'com.operasoftware.OperaGX',
    );
  });

  it('maps plain Opera to com.operasoftware.Opera', () => {
    assertProfileDir(
      '/Applications/Opera.app/Contents/MacOS/Opera',
      'com.operasoftware.Opera',
    );
  });

  it('returns null when the profile dir does not exist', () => {
    const home = tempHome();
    assert.strictEqual(
      defaultProfileDir(
        '/Applications/Opera.app/Contents/MacOS/Opera',
        home,
        'darwin',
      ),
      null,
    );
  });

  it('maps the Windows profile folder from the build name, via the env seam', () => {
    const home = tempHome();
    const appData = `${home}\\Roaming`;
    const expected = `${appData}\\Opera Software\\Opera Neon`;
    fs.mkdirSync(expected, {recursive: true});

    assert.strictEqual(
      defaultProfileDir(
        'C:\\Users\\opera\\AppData\\Local\\Programs\\Opera Neon\\opera.exe',
        home,
        'win32',
        {APPDATA: appData},
      ),
      expected,
    );
  });

  it('falls back to home-relative APPDATA when the env seam has none', () => {
    const home = tempHome();
    const expected = `${home}\\AppData\\Roaming\\Opera Software\\Opera`;
    fs.mkdirSync(expected, {recursive: true});

    assert.strictEqual(
      defaultProfileDir(
        'C:\\Program Files\\Opera\\opera.exe',
        home,
        'win32',
        {},
      ),
      expected,
    );
  });
});
