/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {
  browserDisplayName,
  detectBrowser,
  detectBrowsers,
  neonCandidatePaths,
  operaCandidatePaths,
} from '../../src/opera/detect.js';

function existsOnly(...paths: string[]): (p: string) => boolean {
  const set = new Set(paths);
  return p => set.has(p);
}

const NEON = '/Applications/Opera Neon.app/Contents/MacOS/Opera';
const NEON_DEV = '/Applications/Opera Neon Developer.app/Contents/MacOS/Opera';
const OPERA = '/Applications/Opera.app/Contents/MacOS/Opera';
// A non-empty home so the `${home}/Applications/...` candidates stay distinct
// from the absolute `/Applications/...` candidates (an empty home collapses them).
const HOME = '/nonexistent-home';

describe('detectBrowsers', () => {
  it('prefers Opera Neon over plain Opera', () => {
    const found = detectBrowsers('darwin', HOME, existsOnly(NEON, OPERA));

    assert.deepStrictEqual(
      found.map(b => ({path: b.path, isNeon: b.isNeon})),
      [
        {path: NEON, isNeon: true},
        {path: OPERA, isNeon: false},
      ],
    );
  });

  it('prefers Opera Neon Developer over Opera Neon', () => {
    const found = detectBrowser('darwin', HOME, existsOnly(NEON, NEON_DEV));

    assert.deepStrictEqual(found, {
      path: NEON_DEV,
      name: 'Opera Neon Developer',
      isNeon: true,
    });
  });

  it('falls back to plain Opera when Neon is absent', () => {
    const found = detectBrowser('darwin', HOME, existsOnly(OPERA));

    assert.deepStrictEqual(found, {path: OPERA, name: 'Opera', isNeon: false});
  });

  it('finds nothing on Linux, where Opera Neon does not ship', () => {
    assert.deepStrictEqual(neonCandidatePaths('linux', ''), []);
    assert.strictEqual(
      detectBrowser('linux', '', () => true),
      null,
    );
  });

  it('reads the Windows install roots from the env seam', () => {
    const env = {
      LOCALAPPDATA: 'D:\\Users\\opera\\AppData\\Local',
      PROGRAMFILES: 'D:\\Program Files',
    };

    assert.deepStrictEqual(
      neonCandidatePaths('win32', 'C:\\Users\\opera', env),
      [
        'D:\\Users\\opera\\AppData\\Local\\Programs\\Opera Neon Developer\\opera.exe',
        'D:\\Program Files\\Opera Neon Developer\\opera.exe',
        'D:\\Users\\opera\\AppData\\Local\\Programs\\Opera Neon\\opera.exe',
        'D:\\Program Files\\Opera Neon\\opera.exe',
      ],
    );
    assert.strictEqual(
      operaCandidatePaths('win32', 'C:\\Users\\opera', env)[0],
      'D:\\Users\\opera\\AppData\\Local\\Programs\\Opera GX\\opera.exe',
    );
  });

  it('falls back to home-relative Windows roots when the env seam is empty', () => {
    const candidates = operaCandidatePaths('win32', 'C:\\Users\\opera', {});

    assert.strictEqual(
      candidates[0],
      'C:\\Users\\opera\\AppData\\Local\\Programs\\Opera GX\\opera.exe',
    );
    assert.deepStrictEqual(candidates.slice(2), [
      'C:\\Program Files\\Opera GX\\opera.exe',
      'C:\\Program Files\\Opera\\opera.exe',
    ]);
  });

  it('returns null when nothing is installed', () => {
    assert.strictEqual(
      detectBrowser('darwin', HOME, () => false),
      null,
    );
  });

  it('reports each install once when home is empty', () => {
    // The default home collapses the `${home}/Applications` candidates onto the
    // absolute ones; a caller must not be told about the same install twice.
    const paths = detectBrowsers('darwin', '', () => true).map(b => b.path);

    assert.deepStrictEqual(paths, [
      '/Applications/Opera Neon Developer.app/Contents/MacOS/Opera',
      '/Applications/Opera Neon.app/Contents/MacOS/Opera',
      '/Applications/Opera GX.app/Contents/MacOS/Opera',
      '/Applications/Opera.app/Contents/MacOS/Opera',
    ]);
  });

  it('names the Developer build distinctly', () => {
    assert.strictEqual(
      browserDisplayName('/Applications/Opera Neon Developer.app/x'),
      'Opera Neon Developer',
    );
    assert.strictEqual(
      browserDisplayName('/Applications/Opera GX.app/x'),
      'Opera GX',
    );
  });

  it('does not read a build name out of an unrelated directory', () => {
    assert.strictEqual(browserDisplayName('/tmp/Neon-tests/opera'), 'Opera');
    assert.strictEqual(browserDisplayName('/tmp/GX-tests/opera'), 'Opera');
    assert.strictEqual(
      browserDisplayName('C:\\Program Files\\Opera Neon Developer\\opera.exe'),
      'Opera Neon Developer',
    );
  });
});
