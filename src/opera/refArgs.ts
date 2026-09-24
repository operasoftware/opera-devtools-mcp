/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Ref arguments: the CLI prints refs as `@4.11`, so it has to accept that form
 * back.
 *
 * `compactSnapshot` rewrites every `uid=4_11` in the tree to the display form
 * `@4.11`, and `suggestions.ts` quotes the same form in its `help[]` block — so
 * that is what a user (or an agent) copies into the next command. The MCP tools
 * take the wire form instead: `TextSnapshot` builds ids as
 * `${snapshotId}_${elementIndex}` and `McpPage.getElementByUid` looks them up
 * verbatim, so `@4.11` can never be a key.
 *
 * The retired `opera-browser-cli` translated the form per command, with a
 * private `parseUid` (`strip the @`, then `dot → underscore`) called on the raw
 * argv value at every ref-taking call site — click, fill, hover, drag, upload.
 * This module is that same conversion, with the same two substitutions and no
 * shape guard, applied once at the boundary of the generated command surface
 * instead of once per hand-written command. The source's `isUidRef` guard lived
 * in `run.ts`'s page helper only to route non-refs to a CSS-selector fallback;
 * the fork's click/fill have no such branch, so every ref argument is a ref.
 *
 * `refToMcp` (`compactSnapshot.ts`) is byte-identical to the source's helper —
 * it was ported, but only ever called from tests. This is its call site.
 */

import type {ArgDef} from '../config/cli-options.js';

import {refToMcp} from './compactSnapshot.js';

/**
 * One command's ref-valued argument names, in table order: `uid` (click, fill,
 * hover, take_screenshot, upload_file) plus `from_uid` and `to_uid` (drag).
 *
 * The naming rule is the whole contract — the descriptions upstream writes for
 * these arguments all open with `The uid of `, and
 * `tests/opera/refArgs.test.ts` pins the two derivations against each other, so
 * an intake merge that renames or adds one fails there instead of quietly
 * shipping a ref the CLI cannot translate.
 */
export function refArgNames(args: Record<string, ArgDef>): string[] {
  return Object.keys(args).filter(
    name => name === 'uid' || name.endsWith('_uid'),
  );
}

/**
 * The command's arguments with every ref value in MCP wire form, so `@4.11` —
 * the form the snapshot printed — reaches the daemon as `4_11`. A value that is
 * not a string, or an argument that is not a ref, is passed through untouched.
 */
export function normalizeRefArgs(
  args: Record<string, ArgDef>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = {...values};
  for (const name of refArgNames(args)) {
    const value = normalized[name];
    if (typeof value === 'string') {
      normalized[name] = refToMcp(value);
    }
  }
  return normalized;
}
