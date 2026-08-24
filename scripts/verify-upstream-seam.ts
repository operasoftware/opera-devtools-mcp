/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Enforces the upstream seam described in docs/UPSTREAM.md.
 *
 * The fork stays mergeable only while every divergence from upstream is a
 * deliberate, written-down one. This script makes that mechanical:
 *
 * 1. Every upstream-owned file that differs from the fork base must appear in
 *    the "## Registry" section of docs/UPSTREAM.md. Unregistered drift fails.
 * 2. Every `merge=opera-ours` path in .gitattributes must also be registered —
 *    that driver silently discards upstream's side of a merge, so it may only
 *    point at files we have consciously claimed.
 * 3. The `opera-ours` merge driver must actually be configured in this
 *    checkout. An unregistered driver is not an error to git; it just falls
 *    back to a normal merge, which is the failure mode `.gitattributes` exists
 *    to prevent.
 * 4. Every path registered as renamed or deleted must stay gone. The merge
 *    driver does not apply to a delete: git reports a modify/delete conflict
 *    and leaves upstream's copy in the tree, so a reflexive `git add -A`
 *    resurrects the file silently.
 *
 * Stale registry rows (registered, but no longer diverging) are reported as
 * warnings, not failures — they only mean the registry can be trimmed.
 *
 * Run with `npm run verify-upstream-seam`. Requires the fork base commit to be
 * present locally, so CI must check out with `fetch-depth: 0`.
 */

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const UPSTREAM_DOC = path.join('docs', 'UPSTREAM.md');
const GITATTRIBUTES = '.gitattributes';
const DRIVER_NAME = 'opera-ours';
const MODIFIED_HEADING = 'Upstream files we modify';
const DELETED_HEADING = 'Upstream files we rename or delete';

function git(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function gitOk(args: string[]): boolean {
  try {
    execFileSync('git', args, {stdio: 'ignore'});
    return true;
  } catch {
    return false;
  }
}

/** The commit this fork was last merged up to, read from docs/UPSTREAM.md. */
function readForkBase(doc: string): string {
  const match = doc.match(/Current fork base:\s*`([0-9a-f]{7,40})`/);
  if (!match) {
    fail(
      `Could not find a "Current fork base: \`<sha>\`" line in ${UPSTREAM_DOC}.`,
    );
  }
  return match![1]!;
}

/**
 * Every path mentioned in a code span inside the "## Registry" section.
 *
 * Deliberately loose: the registry is a human document with tables, prose and
 * comma-separated lists, and requiring a rigid machine format would just make
 * people stop updating it. Tokens that are not real paths (prose like
 * `Object.values()`) are dropped below by the existence check.
 */
function readRegistrySection(doc: string): string {
  const start = doc.indexOf('\n## Registry');
  if (start === -1) {
    fail(`Could not find a "## Registry" section in ${UPSTREAM_DOC}.`);
  }
  const rest = doc.slice(start + 1);
  const end = rest.indexOf('\n## ', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

function readRegisteredPaths(section: string): Set<string> {
  const paths = new Set<string>();
  for (const [, span] of section.matchAll(/`([^`\n]+)`/g)) {
    for (const token of span!.split(/[,\s]+/)) {
      const cleaned = token.replace(/[.,;]+$/, '');
      if (cleaned) {
        paths.add(cleaned);
      }
    }
  }
  return paths;
}

/**
 * A single `### ` subsection of the registry.
 *
 * Staleness is only meaningful for the "files we modify" subsection: generated
 * artifacts and Opera-owned prose are registered because of how they merge, not
 * because they currently differ, so a momentarily-identical one is not a stale
 * row.
 */
function readRegistrySubsection(section: string, heading: string): string {
  const start = section.indexOf(`### ${heading}`);
  if (start === -1) {
    fail(`Could not find a "### ${heading}" subsection in ${UPSTREAM_DOC}.`);
  }
  const rest = section.slice(start);
  const end = rest.indexOf('\n### ', 1);
  return end === -1 ? rest : rest.slice(0, end);
}

/** Paths marked `merge=opera-ours` in .gitattributes. */
function readMergeOursPaths(): string[] {
  const contents = fs.readFileSync(GITATTRIBUTES, 'utf8');
  const paths: string[] = [];
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    if (/\bmerge=opera-ours\b/.test(trimmed)) {
      paths.push(trimmed.split(/\s+/)[0]!);
    }
  }
  return paths;
}

/**
 * Upstream-owned files that differ from the fork base.
 *
 * Compares the base against the *working tree*, so it catches drift before it
 * is committed. Files we added ourselves are not upstream-owned and never
 * conflict, so they are filtered out by the "exists at base" check. For a
 * rename it is the old path that upstream still owns, so that is what must be
 * registered.
 */
function readDriftedUpstreamPaths(base: string): string[] {
  const output = git(['diff', '--name-status', '-z', base]);
  const fields = output.split('\0').filter(Boolean);
  const candidates = new Set<string>();

  for (let i = 0; i < fields.length; i++) {
    const status = fields[i]!;
    if (status.startsWith('R') || status.startsWith('C')) {
      candidates.add(fields[i + 1]!);
      candidates.add(fields[i + 2]!);
      i += 2;
    } else {
      candidates.add(fields[i + 1]!);
      i += 1;
    }
  }

  return [...candidates]
    .filter(file => gitOk(['cat-file', '-e', `${base}:${file}`]))
    .sort();
}

/** Translates a .gitattributes-style pattern into a matcher. */
function matches(pattern: string, file: string): boolean {
  if (!pattern.includes('*')) {
    return pattern === file;
  }
  const source = pattern
    .split(/(\*\*|\*)/)
    .map(part => {
      if (part === '**') {
        return '.*';
      }
      if (part === '*') {
        return '[^/]*';
      }
      return part.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`).test(file);
}

function isRegistered(registered: Set<string>, file: string): boolean {
  if (registered.has(file)) {
    return true;
  }
  for (const pattern of registered) {
    if (pattern.includes('*') && matches(pattern, file)) {
      return true;
    }
  }
  return false;
}

function fail(message: string): never {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function main(): void {
  // Every path below is repo-relative, and `git diff` reports repo-relative
  // paths, so anchor to the root rather than to wherever this was invoked.
  try {
    process.chdir(git(['rev-parse', '--show-toplevel']));
  } catch {
    fail('Not inside a git repository, so there is nothing to verify.');
  }

  const doc = fs.readFileSync(UPSTREAM_DOC, 'utf8');
  const base = readForkBase(doc);

  if (!gitOk(['cat-file', '-e', `${base}^{commit}`])) {
    fail(
      `The fork base commit ${base} is not in this checkout.\n` +
        `  Locally:  git remote add upstream https://github.com/ChromeDevTools/chrome-devtools-mcp.git && git fetch upstream\n` +
        `  In CI:    check out with fetch-depth: 0`,
    );
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  const section = readRegistrySection(doc);
  const registered = readRegisteredPaths(section);
  const drifted = readDriftedUpstreamPaths(base);

  const unregistered = drifted.filter(file => !isRegistered(registered, file));
  if (unregistered.length) {
    errors.push(
      `${unregistered.length} upstream-owned file(s) differ from ${base} but are not in the ${UPSTREAM_DOC} registry:\n` +
        unregistered.map(file => `    ${file}`).join('\n') +
        `\n  Either revert the change, move it behind a seam in src/opera/, or add a row\n` +
        `  to the registry saying what the divergence is and why it is permanent.`,
    );
  }

  for (const pattern of readMergeOursPaths()) {
    if (!isRegistered(registered, pattern)) {
      errors.push(
        `${GITATTRIBUTES} marks '${pattern}' as merge=opera-ours, but it is not in the ${UPSTREAM_DOC} registry.\n` +
          `  That driver throws away upstream's side of the merge, so the file must be listed as ours.`,
      );
    }
  }

  let driver = '';
  try {
    driver = git(['config', '--get', `merge.${DRIVER_NAME}.driver`]);
  } catch {
    driver = '';
  }
  if (driver !== 'true') {
    errors.push(
      `The '${DRIVER_NAME}' merge driver is not configured in this checkout, so every\n` +
        `  merge=opera-ours entry in ${GITATTRIBUTES} would silently fall back to a normal merge.\n` +
        `  Fix: npm run prepare   (or: git config merge.${DRIVER_NAME}.driver true)`,
    );
  }

  const modified = readRegisteredPaths(
    readRegistrySubsection(section, MODIFIED_HEADING),
  );
  const stale = [...modified]
    .filter(entry => !entry.includes('*'))
    .filter(entry => gitOk(['cat-file', '-e', `${base}:${entry}`]))
    .filter(entry => !drifted.includes(entry))
    .sort();
  if (stale.length) {
    warnings.push(
      `${stale.length} registry entr(ies) no longer differ from upstream and can be dropped:\n` +
        stale.map(entry => `    ${entry}`).join('\n'),
    );
  }

  const deleted = readRegisteredPaths(
    readRegistrySubsection(section, DELETED_HEADING),
  );
  const resurrected = [...deleted]
    .filter(entry => !entry.includes('*'))
    .filter(entry => gitOk(['cat-file', '-e', `${base}:${entry}`]))
    .filter(entry => fs.existsSync(entry))
    .sort();
  if (resurrected.length) {
    errors.push(
      `${resurrected.length} path(s) registered as renamed or deleted exist in the working tree:\n` +
        resurrected.map(entry => `    ${entry}`).join('\n') +
        `\n  An intake merge probably restored them: the merge driver does not apply to a\n` +
        `  delete, so git leaves upstream's copy in the tree. Fix: git rm <path>`,
    );
  }

  for (const warning of warnings) {
    console.warn(`\n! ${warning}`);
  }

  if (errors.length) {
    for (const error of errors) {
      console.error(`\n✗ ${error}`);
    }
    console.error('');
    process.exit(1);
  }

  console.log(
    `✓ Upstream seam verified against ${base}: ${drifted.length} upstream file(s) diverge, all registered.`,
  );
}

main();
