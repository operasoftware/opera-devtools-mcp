/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * `url` — resolve a `$uN` URL token or an `@ref` element ref back to the full
 * URL. Both forms are shortened for the snapshot (same-site URLs lose their
 * origin, repeated/long ones become tokens), so the page origin is re-attached
 * here before the URL is printed.
 *
 * Ported from opera-browser-cli's `src/cli.ts` `handleUrl`. The source read the
 * bridge's cached `/last-snapshot`; here the token→URL map and the origin are
 * persisted next to the config on every rendered snapshot (`cliOutput.ts`'s
 * `writeUrlMapSidecar`, one file per session), so a token is answerable with no
 * round-trip at all.
 *
 * An element ref is different: it is only resolvable against the tree it came
 * from, so that path always asks for one. The narrowed `take_snapshot` fetch is
 * injected by the CLI, which knows how to bring the daemon up.
 */

import {
  absolutizeUrl,
  applyUrlLut,
  compactSnapshot,
  extractPageOrigin,
  refToDisplay,
  refToMcp,
  resolveUrl,
} from './compactSnapshot.js';
import {CLI_BIN_NAME} from './branding.js';
import {loadUrlMapSidecar} from './cliOutput.js';
import {CdpError, EXIT_CODES} from './cdpErrors.js';

export interface UrlResult {
  output: string;
  exitCode: number;
}

export async function handleUrl(
  args: string[],
  fetchSnapshot: () => Promise<string>,
  sessionId: string,
): Promise<UrlResult> {
  const target = args[0];
  if (!target) {
    throw new CdpError('Missing argument', 'VALIDATION_ERROR', [
      `Run \`${CLI_BIN_NAME} url $u3\` to resolve a URL token`,
      `Run \`${CLI_BIN_NAME} url @11.57\` to resolve an element ref`,
    ]);
  }

  const persisted = loadUrlMapSidecar(sessionId);
  // A token is `$uN` and never carries `@` — that is a ref marker, so the two
  // shapes stay disjoint and `url @$u2` is answered like any other bad ref.
  if (persisted && target.startsWith('$u')) {
    const resolved = resolveUrl('', persisted.tokens, target);
    if (resolved !== null) {
      return {
        output: absolutizeUrl(resolved, persisted.origin),
        exitCode: 0,
      };
    }
  }

  // The body is the compact, *non-LUT* tree: a ref lookup searches for the
  // element's literal `url="..."`, so token-index alignment with the map is not
  // needed. The map is only consulted for refs whose URL was tokenised.
  //
  // The raw tree is kept because it is the only place the page origin still
  // exists: compaction rewrites same-site URLs (root `url=` included) to
  // relative paths, and `url`'s contract is the full URL.
  const raw = await fetchSnapshot();
  const origin = extractPageOrigin(raw) ?? persisted?.origin ?? null;
  const body = compactSnapshot(raw);
  const urlMap = persisted?.tokens ?? applyUrlLut(body).urlMap;
  // The same translation the tool commands apply (refArgs.ts): the tree carries
  // display-form refs, and `--raw` prints the wire form `4_11`, so accept both.
  const resolved = resolveUrl(
    body,
    urlMap,
    `@${refToDisplay(refToMcp(target))}`,
  );
  if (resolved === null) {
    return {
      output: `url: "${target}" not found in last snapshot`,
      exitCode: EXIT_CODES.REF_NOT_FOUND,
    };
  }
  return {output: absolutizeUrl(resolved, origin), exitCode: 0};
}
