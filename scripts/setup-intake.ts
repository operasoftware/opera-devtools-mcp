/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Registers the `opera-ours` merge driver referenced by `.gitattributes`.
 *
 * Git does not ship a built-in "keep ours" driver, and — this is the trap — an
 * *unregistered* driver is not an error: git silently falls back to a normal
 * three-way merge, so the `.gitattributes` entries would look like they were
 * working right up until an intake quietly conflicted in a generated file.
 *
 * `true` is a real command that exits 0 without touching %A, which is exactly
 * "resolve to ours". Run via `npm run prepare`, so a fresh clone that has done
 * `npm install` is ready for `git merge upstream/main`.
 *
 * See docs/UPSTREAM.md.
 */

import {execFileSync} from 'node:child_process';

const DRIVER_NAME = 'opera-ours';

function git(args: string[]): string {
  return execFileSync('git', args, {encoding: 'utf8'}).trim();
}

function main(): void {
  try {
    git(['rev-parse', '--git-dir']);
  } catch {
    // Installing from a tarball (npm install opera-devtools-mcp) has no repo.
    // Nothing to configure, and nothing to warn about.
    return;
  }

  const existing = (() => {
    try {
      return git(['config', '--get', `merge.${DRIVER_NAME}.driver`]);
    } catch {
      return '';
    }
  })();

  if (existing === 'true') {
    return;
  }

  git(['config', `merge.${DRIVER_NAME}.name`, 'Keep the Opera version']);
  git(['config', `merge.${DRIVER_NAME}.driver`, 'true']);
  console.log(
    `Registered the '${DRIVER_NAME}' git merge driver (see docs/UPSTREAM.md).`,
  );
}

main();
