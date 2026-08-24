/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Opera Software AS.
 */

// Verifies the tarball npm would publish, and that it carries the version the
// release tag names. Runs immediately before `npm publish`, which cannot be
// undone: a version published from a broken tarball can only be abandoned.
//
// Uses `npm pack` rather than `npm publish --dry-run` so the check never talks
// to the registry — no auth, and no failure once the version already exists.

import {execSync} from 'node:child_process';
import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf-8'));

/** Strips the leading `./` npm allows in `bin` targets. */
function normalize(entry) {
  return entry.replace(/^\.\//, '');
}

function packedFiles() {
  const output = execSync('npm pack --dry-run --json', {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  // `prepare` writes to stdout before npm does, so skip to the JSON.
  const start = output.indexOf('[');
  if (start === -1) {
    throw new Error(`npm pack produced no JSON:\n${output}`);
  }
  const [tarball] = JSON.parse(output.slice(start));
  return tarball;
}

function verifyContents(tarball) {
  const packed = tarball.files.map(file => file.path);
  // Derive the entry points from package.json so a renamed bin cannot ship
  // missing, and keep the two module roots upstream already checked.
  const required = [
    'build/src/index.js',
    'build/src/third_party/index.js',
    ...Object.values(packageJson.bin ?? {}).map(normalize),
  ];

  const missing = required.filter(path => !packed.includes(path));
  if (missing.length) {
    throw new Error(
      `tarball is missing ${missing.length} required file(s):\n` +
        missing.map(path => `    ${path}`).join('\n') +
        `\n  It packed ${tarball.entryCount} entries. Did \`npm run bundle\` run?`,
    );
  }
  console.log(
    `tarball ${tarball.filename} contains all ${required.length} required entry point(s) of ${tarball.entryCount} packed.`,
  );
}

function verifyReleaseTag(tarball) {
  const tag = process.env['RELEASE_TAG'];
  if (!tag) {
    return;
  }
  const expected = `${packageJson.name}-v${packageJson.version}`;
  if (tag !== expected) {
    throw new Error(
      `tag '${tag}' does not name the version being published.\n` +
        `  package.json is ${packageJson.version}, so the tag must be '${expected}'.\n` +
        `  Bump package.json, package-lock.json and src/version.ts, then retag.`,
    );
  }
  console.log(`tag ${tag} matches ${tarball.name}@${tarball.version}.`);
}

try {
  const tarball = packedFiles();
  verifyContents(tarball);
  verifyReleaseTag(tarball);
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}
