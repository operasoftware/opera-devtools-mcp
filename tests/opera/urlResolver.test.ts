/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {writeUrlMapSidecar} from '../../src/opera/cliOutput.js';
import {CdpError} from '../../src/opera/cdpErrors.js';
import {handleUrl} from '../../src/opera/urlResolver.js';

const TREE = [
  'uid=1_0 RootWebArea "Example" url="https://example.com/"',
  '  uid=1_1 link "Home" url="https://example.com/home"',
  '  uid=1_2 link "Docs" url="https://example.com/docs/guide"',
  '  uid=1_3 link "Ad" url="https://ads.example.net/very-long-tracking-url?utm_source=x&utm_medium=y"',
  '  uid=1_4 link "Ad again" url="https://ads.example.net/very-long-tracking-url?utm_source=x&utm_medium=y"',
].join('\n');

/** The same page shape, from a tree whose root carries no url= (e.g. about:blank). */
const TREE_WITHOUT_ORIGIN = TREE.replace(' url="https://example.com/"', '');

/** The session whose sidecar every case below reads. */
const TEST_SESSION = 'a1b2c3d4';

describe('handleUrl', () => {
  let home: string;
  let savedHome: string | undefined;
  let fetches: number;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'opera-url-'));
    savedHome = process.env.HOME;
    process.env.HOME = home;
    fetches = 0;
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    rmSync(home, {recursive: true, force: true});
  });

  async function fetchSnapshot(): Promise<string> {
    fetches += 1;
    return TREE;
  }

  async function fetchSnapshotWithoutOrigin(): Promise<string> {
    fetches += 1;
    return TREE_WITHOUT_ORIGIN;
  }

  it('refuses to guess when no target was given', async () => {
    await assert.rejects(
      handleUrl([], fetchSnapshot, TEST_SESSION),
      (error: unknown) => {
        assert.ok(error instanceof CdpError);
        assert.strictEqual(error.code, 'VALIDATION_ERROR');
        return true;
      },
    );
  });

  it('answers a $uN token from the sidecar alone', async () => {
    writeUrlMapSidecar(
      new Map([['$u1', 'https://example.com/from-sidecar']]),
      TEST_SESSION,
      null,
    );

    const {output, exitCode} = await handleUrl(
      ['$u1'],
      fetchSnapshot,
      TEST_SESSION,
    );

    assert.strictEqual(output, 'https://example.com/from-sidecar');
    assert.strictEqual(exitCode, 0);
    // The whole point of the sidecar: no browser round-trip for a token.
    assert.strictEqual(fetches, 0);
  });

  it('re-attaches the page origin to a same-site token', async () => {
    // The form the sidecar really holds: compaction shortened the URL to a path
    // before the token was assigned, so the origin has to come back from the
    // same file.
    writeUrlMapSidecar(
      new Map([['$u1', '/downloads/installer.tar.gz']]),
      TEST_SESSION,
      'https://example.com',
    );

    const {output, exitCode} = await handleUrl(
      ['$u1'],
      fetchSnapshot,
      TEST_SESSION,
    );

    assert.strictEqual(
      output,
      'https://example.com/downloads/installer.tar.gz',
    );
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(fetches, 0);
  });

  it('does not read a ref-shaped target as a token', async () => {
    writeUrlMapSidecar(
      new Map([['$u2', '/two']]),
      TEST_SESSION,
      'https://example.com',
    );

    // `@` is the ref marker, so `@$u2` is a ref that is not on the page — not
    // the token `$u2`. The two shapes are disjoint by design.
    const {output, exitCode} = await handleUrl(
      ['@$u2'],
      fetchSnapshot,
      TEST_SESSION,
    );

    assert.notStrictEqual(output, '/two');
    assert.strictEqual(exitCode, 6);
    assert.ok(output.includes('"@$u2" not found'), output);
  });

  it('falls back to a fresh snapshot for a token the sidecar does not know', async () => {
    const {output, exitCode} = await handleUrl(
      ['$u99'],
      fetchSnapshot,
      TEST_SESSION,
    );

    assert.strictEqual(fetches, 1);
    assert.strictEqual(exitCode, 6);
    assert.ok(output.includes('"$u99" not found'), output);
  });

  it('resolves an element ref against the page it came from', async () => {
    const {output, exitCode} = await handleUrl(
      ['@1.1'],
      fetchSnapshot,
      TEST_SESSION,
    );

    assert.strictEqual(fetches, 1);
    // Compaction stored the same-site link as `/home`; the answer is the full
    // URL it came from, not the shortened form.
    assert.strictEqual(output, 'https://example.com/home');
    assert.strictEqual(exitCode, 0);
  });

  it('leaves the URL untouched when the page has no origin to restore', async () => {
    const {output, exitCode} = await handleUrl(
      ['@1.1'],
      fetchSnapshotWithoutOrigin,
      TEST_SESSION,
    );

    // With no root url= there is nothing to strip, so the link kept its own
    // absolute URL and the answer needs no re-attachment.
    assert.strictEqual(output, 'https://example.com/home');
    assert.strictEqual(exitCode, 0);
  });

  it('resolves a ref written in MCP wire form', async () => {
    // `--raw` prints `uid=1_1`, and api/scripted callers pass the same form the
    // daemon takes, so the wire form is answered like the display form.
    const wired = await handleUrl(['1_1'], fetchSnapshot, TEST_SESSION);
    const underscored = await handleUrl(['@1_1'], fetchSnapshot, TEST_SESSION);

    assert.strictEqual(wired.output, 'https://example.com/home');
    assert.strictEqual(wired.exitCode, 0);
    assert.strictEqual(underscored.output, 'https://example.com/home');
    assert.strictEqual(underscored.exitCode, 0);
  });

  it('resolves a ref whose URL was replaced by a token', async () => {
    const {output} = await handleUrl(['@1.3'], fetchSnapshot, TEST_SESSION);

    // Compaction strips the tracking query before the token is assigned, so the
    // map holds the cleaned URL — which is what the agent saw. The URL is on
    // another origin, so no page origin is joined onto it.
    assert.strictEqual(
      output,
      'https://ads.example.net/very-long-tracking-url',
    );
  });

  it('reports a ref that is not on the page as a stale-ref failure', async () => {
    const {output, exitCode} = await handleUrl(
      ['@9.9'],
      fetchSnapshot,
      TEST_SESSION,
    );

    assert.strictEqual(exitCode, 6);
    assert.ok(output.includes('"@9.9" not found'), output);
  });
});
