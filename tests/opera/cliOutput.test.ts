/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';

import {handleResponse} from '../../src/daemon/client.js';
import {
  formatError,
  formatToolResult,
  loadUrlMapSidecar,
  parseSnapshotFromResponse,
  renderHelp,
  renderOutput,
  stripSnapshotHeader,
  writeUrlMapSidecar,
} from '../../src/opera/cliOutput.js';
import {
  CDP_RESULT_ERROR_KEYS,
  classifyToolError,
  CdpError,
  EXIT_CODES,
} from '../../src/opera/cdpErrors.js';
import type {CallToolResult} from '../../src/third_party/index.js';

/**
 * A response shaped like the MCP server's: a preamble, then the snapshot
 * section, exactly as `McpResponse` emits it.
 */
function snapshotResult(snapshot: string): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `Navigate to https://example.com\n## Latest page snapshot\n${snapshot}`,
      },
    ],
  };
}

const SMALL_TREE = `uid=1_0 RootWebArea "Example" url="https://example.com/"
  uid=1_1 button "Click"
  uid=1_2 link "Home" url="https://example.com/home"
  uid=1_3 textbox "Name"`;

/** The session every formatting case below writes its URL map for. */
const TEST_SESSION = 'a1b2c3d4';

describe('cliOutput', () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'opera-cli-output-'));
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    rmSync(home, {recursive: true, force: true});
  });

  describe('block helpers', () => {
    it('renders a help block with a count and two-space indent', () => {
      assert.strictEqual(
        renderHelp(['first', 'second']),
        'help[2]:\n  first\n  second',
      );
    });

    it('renders no help block for no lines', () => {
      assert.strictEqual(renderHelp([]), '');
    });

    it('drops empty blocks when joining', () => {
      assert.strictEqual(renderOutput(['a', '', 'b']), 'a\nb');
    });
  });

  describe('snapshot extraction', () => {
    it('slices the snapshot section out of a response', () => {
      const result = parseSnapshotFromResponse(
        'preamble\n## Latest page snapshot\nuid=1_0 root\n\n## Next heading\ntail',
      );

      assert.strictEqual(result, 'uid=1_0 root');
    });

    it('returns null when the response carries no snapshot', () => {
      assert.strictEqual(parseSnapshotFromResponse('just text'), null);
    });

    it('strips the preamble before the accessibility tree', () => {
      assert.strictEqual(
        stripSnapshotHeader('status: ok\nuid=1_0 root\n  uid=1_1 button "x"'),
        'uid=1_0 root\n  uid=1_1 button "x"',
      );
    });
  });

  describe('snapshot formatting', () => {
    it('compacts the tree and reports page metadata and suggestions', async () => {
      const output = await formatToolResult(
        snapshotResult(SMALL_TREE),
        'md',
        {command: 'take_snapshot', sessionId: TEST_SESSION},
        handleResponse,
      );

      for (const expected of [
        'page:',
        'title: Example',
        'url: "https://example.com/"',
        'refs: 4',
        'snapshot:',
        '@1.1 button "Click"',
        'url="/home"',
        'help[',
      ]) {
        assert.ok(
          output.includes(expected),
          `missing ${expected} in:\n${output}`,
        );
      }
      assert.ok(
        !output.includes('uid=1_1'),
        `compact output still carries raw refs:\n${output}`,
      );
    });

    it('keeps the page URL for a command that did not navigate', async () => {
      const output = await formatToolResult(
        snapshotResult(SMALL_TREE),
        'md',
        {command: 'click', sessionId: TEST_SESSION},
        handleResponse,
      );

      assert.match(output, /^ {2}url: "https:\/\/example\.com\/"$/m, output);
    });

    it('prefers the URL a navigating command went to over the tree’s', async () => {
      const output = await formatToolResult(
        snapshotResult(SMALL_TREE),
        'md',
        {
          command: 'navigate_page',
          sessionId: TEST_SESSION,
          url: 'https://example.com/other',
        },
        handleResponse,
      );

      assert.match(
        output,
        /^ {2}url: "https:\/\/example\.com\/other"$/m,
        output,
      );
      assert.ok(
        !output.includes('url: "https://example.com/"'),
        `the tree URL overrode the navigating command's:\n${output}`,
      );
    });

    it('omits the URL when neither the command nor the tree has one', async () => {
      const output = await formatToolResult(
        snapshotResult(
          'uid=1_0 RootWebArea "Example"\n  uid=1_1 button "Click"',
        ),
        'md',
        {command: 'take_snapshot', sessionId: TEST_SESSION},
        handleResponse,
      );

      assert.ok(output.startsWith('page:\n'), output);
      assert.ok(!output.includes('url:'), output);
    });

    it('passes the MCP output through untouched with raw', async () => {
      const output = await formatToolResult(
        snapshotResult(SMALL_TREE),
        'md',
        {command: 'take_snapshot', sessionId: TEST_SESSION, raw: true},
        handleResponse,
      );

      // The tree is untouched: raw refs, full URLs, no LUT. The suggestions
      // still name display-form refs, so only the snapshot block is asserted.
      assert.ok(output.includes('uid=1_1 button "Click"'), output);
      assert.ok(
        output.includes('uid=1_2 link "Home" url="https://example.com/home"'),
        output,
      );
    });

    it('truncates a long snapshot and says so, unless --full', async () => {
      const long = Array.from(
        {length: 2000},
        (_, i) => `uid=1_${i} button "Label number ${i} with padding"`,
      ).join('\n');

      const truncated = await formatToolResult(
        snapshotResult(long),
        'md',
        {command: 'take_snapshot', sessionId: TEST_SESSION},
        handleResponse,
      );
      assert.match(truncated, /\.\.\. \(truncated, \d+ chars total\)/);

      const full = await formatToolResult(
        snapshotResult(long),
        'md',
        {command: 'take_snapshot', sessionId: TEST_SESSION, full: true},
        handleResponse,
      );
      assert.ok(!full.includes('(truncated,'), 'full output was truncated');
      assert.ok(
        full.includes('button "Label number 1999 with padding"'),
        'full output is missing the tail of the tree',
      );
    });

    it('writes the URL map sidecar the url command reads back', async () => {
      const repeated = [
        `uid=1_0 RootWebArea "Example" url="https://cdn.example.com/"`,
        `  uid=1_1 link "A" url="https://cdn.example.com/a-long-asset-name.js"`,
        `  uid=1_2 link "B" url="https://cdn.example.com/a-long-asset-name.js"`,
      ].join('\n');

      await formatToolResult(
        snapshotResult(repeated),
        'md',
        {command: 'take_snapshot', sessionId: TEST_SESSION},
        handleResponse,
      );

      const stored = JSON.parse(
        readFileSync(
          join(home, '.opera-browser-cli', `last-url-map-${TEST_SESSION}.json`),
          'utf-8',
        ),
      ) as {
        origin: string | null;
        tokens: Record<string, string>;
      };

      // `url $uN` is answered from this file alone, so it carries both halves
      // of the answer: the compact token value and the origin it was shortened
      // against.
      assert.strictEqual(stored.origin, 'https://cdn.example.com');
      assert.deepStrictEqual(Object.keys(stored.tokens), ['$u1']);
      assert.strictEqual(stored.tokens['$u1'], '/a-long-asset-name.js');
    });

    it('keeps two sessions from answering each other’s token lookups', async () => {
      const repeated = [
        `uid=1_0 RootWebArea "Example"`,
        `  uid=1_1 link "A" url="https://cdn.example.com/a-long-asset-name.js"`,
        `  uid=1_2 link "B" url="https://cdn.example.com/a-long-asset-name.js"`,
      ].join('\n');

      await formatToolResult(
        snapshotResult(repeated),
        'md',
        {command: 'take_snapshot', sessionId: 'a1b2c3d4'},
        handleResponse,
      );
      await formatToolResult(
        snapshotResult(
          repeated.replaceAll('a-long-asset-name.js', 'the-other-session.js'),
        ),
        'md',
        {command: 'take_snapshot', sessionId: 'e5f6a7b8'},
        handleResponse,
      );

      // Each shell resolves `$u1` to the page *its* session is driving, which is
      // what one shared sidecar file could not do.
      assert.ok(
        loadUrlMapSidecar('a1b2c3d4')
          ?.tokens.get('$u1')
          ?.includes('a-long-asset'),
      );
      assert.ok(
        loadUrlMapSidecar('e5f6a7b8')
          ?.tokens.get('$u1')
          ?.includes('other-session'),
      );
    });

    it('round-trips a URL map through the sidecar', () => {
      const map = new Map([['$u1', '/a']]);

      writeUrlMapSidecar(map, TEST_SESSION, 'https://example.com');
      const loaded = loadUrlMapSidecar(TEST_SESSION);

      assert.strictEqual(loaded?.origin, 'https://example.com');
      assert.deepStrictEqual([...(loaded?.tokens ?? [])], [...map]);
    });

    it('reads a sidecar written before the origin was recorded', () => {
      // The file format before this was a flat token map; an upgrade mid-session
      // must not cost the user the tokens already in the output they are quoting.
      mkdirSync(join(home, '.opera-browser-cli'), {recursive: true});
      writeFileSync(
        join(home, '.opera-browser-cli', `last-url-map-${TEST_SESSION}.json`),
        JSON.stringify({$u1: '/legacy'}),
      );

      const loaded = loadUrlMapSidecar(TEST_SESSION);

      assert.strictEqual(loaded?.origin, null);
      assert.strictEqual(loaded?.tokens.get('$u1'), '/legacy');
    });

    it('encodes the whole document as TOON for --output-format toon', async () => {
      const output = await formatToolResult(
        snapshotResult(SMALL_TREE),
        'toon',
        {command: 'take_snapshot', sessionId: TEST_SESSION},
        handleResponse,
      );

      assert.ok(output.startsWith('page:'), output);
      assert.match(output, /^ {2}refs: 4$/m);
      assert.match(output, /^ {2}body: /m);
      assert.match(output, /^help\[/m);
    });

    it('delegates json output to the daemon client unchanged', async () => {
      const result = snapshotResult(SMALL_TREE);

      assert.strictEqual(
        await formatToolResult(
          result,
          'json',
          {command: 'take_snapshot', sessionId: TEST_SESSION},
          handleResponse,
        ),
        await handleResponse(result, 'json'),
      );
    });

    it('leaves a snapshot-bearing result alone when the tool reported an error', async () => {
      const result: CallToolResult = {
        isError: true,
        content: [
          {type: 'text', text: '## Latest page snapshot\nuid=1_0 root'},
        ],
      };

      const output = await formatToolResult(
        result,
        'md',
        {command: 'take_snapshot', sessionId: TEST_SESSION},
        handleResponse,
      );

      assert.strictEqual(output, '## Latest page snapshot\nuid=1_0 root');
    });
  });

  describe('error rendering and exit codes', () => {
    it('reports an error with its code and suggestions', async () => {
      const {output, exitCode} = await formatError(
        new CdpError('Opera: user is not signed in', 'AUTH_REQUIRED', [
          'Run `opera-browser-cli login`',
        ]),
      );

      assert.strictEqual(exitCode, 4);
      assert.ok(output.includes('AUTH_REQUIRED'), output);
      assert.ok(
        output.includes('error: "Opera: user is not signed in"'),
        output,
      );
      assert.ok(output.includes('help[1]:'), output);
    });

    it('reports an unrecognised error as UNKNOWN', async () => {
      const {output, exitCode} = await formatError(new Error('boom'));

      assert.strictEqual(exitCode, 1);
      assert.ok(output.includes('UNKNOWN'), output);
    });

    it('maps every documented failure to its exit code', () => {
      assert.deepStrictEqual(EXIT_CODES, {
        VALIDATION_ERROR: 2,
        UNSUPPORTED_OPERATION: 2,
        BRIDGE_NOT_READY: 3,
        BROWSER_ERROR: 3,
        AUTH_REQUIRED: 4,
        TIMEOUT: 5,
        REF_NOT_FOUND: 6,
        PAGE_CLOSED: 6,
        EXTENSION_NOT_FOUND: 3,
        NOT_FOUND: 2,
        CONVERSATION_NOT_FOUND: 2,
        SERVER_DISCONNECTED: 3,
        UNKNOWN: 1,
      });
    });

    it('classifies tool failures by their message', () => {
      assert.strictEqual(
        classifyToolError('Element uid "9_9" not found on page 1.'),
        'REF_NOT_FOUND',
      );
      assert.strictEqual(
        classifyToolError('Node is detached from document'),
        'PAGE_CLOSED',
      );
      assert.strictEqual(
        classifyToolError('Timed out waiting for the page'),
        'TIMEOUT',
      );
      assert.strictEqual(
        classifyToolError('Timeout waiting for daemon response'),
        'TIMEOUT',
      );
      assert.strictEqual(
        classifyToolError(
          'Failed to interact with the element with uid 1_2. The element did not become interactive within the configured timeout.',
        ),
        'TIMEOUT',
      );
      assert.strictEqual(
        classifyToolError(
          'Tool click_at requires experimental feature --experimentalVision and is currently disabled. Enable it by running opera-browser-cli start --experimentalVision=true. For more information check the README.',
        ),
        'UNSUPPORTED_OPERATION',
      );
      assert.strictEqual(
        classifyToolError(
          'Tool list_network_requests is in category Network which is currently disabled. Enable it by running opera-browser-cli start --categoryNetwork=true. For more information check the README.',
        ),
        'UNSUPPORTED_OPERATION',
      );
      assert.strictEqual(
        classifyToolError(
          'Navigating to javascript: URLs is not allowed when JavaScript evaluation is disabled.',
        ),
        'UNSUPPORTED_OPERATION',
      );
      assert.strictEqual(
        classifyToolError(
          'Navigating to chrome-extension: URLs is not allowed without --categoryExtensions.',
        ),
        'UNSUPPORTED_OPERATION',
      );
      assert.strictEqual(classifyToolError('something else'), 'UNKNOWN');
    });

    it('classifies the browser-error shapes the descriptors own', () => {
      // The same two failures the CDP descriptors own when they arrive as text
      // on a successful call. A tool that raises them instead (`isError: true`,
      // message as content) never reaches the descriptors, so these patterns are
      // what keeps the exit code at 3 rather than reporting an unknown failure.
      assert.strictEqual(
        classifyToolError(
          'Error: NotReadableError: Failed to execute \u2018put\u2019 on \u2018IDBObjectStore\u2019: Data lost due to missing file. Affected record should be considered irrecoverable',
        ),
        'BROWSER_ERROR',
      );
      assert.strictEqual(
        classifyToolError(
          'Opera did not start the do action: no progress was reported for 30s after the dispatch',
        ),
        'BROWSER_ERROR',
      );
    });

    it('does not read a tool argument name as a timeout', () => {
      // Verbatim from the server, for `navigate_page --initScript` with
      // JavaScript evaluation off. The expected-argument list contains
      // `"timeout"`, which a bare `timeout` pattern would report as exit 5 —
      // this is the regression that made a bad argument look like a timeout.
      assert.strictEqual(
        classifyToolError(
          'Unknown argument for tool "navigate_page": "initScript". Expected arguments: "type", "url", "ignoreCache", "handleBeforeUnload", "timeout". Remove it and retry.',
        ),
        'VALIDATION_ERROR',
      );
      assert.strictEqual(
        classifyToolError(
          'Unknown arguments for tool "click": "uid", "dblClick". Expected arguments: "pageId". Remove them and retry.',
        ),
        'VALIDATION_ERROR',
      );
    });

    it('blames the script, not the browser, for an unserializable result', () => {
      // Verbatim from `evaluate_script '() => window.open("about:blank")'`:
      // `script.ts` stringifies the return value, and a `Window` is circular.
      assert.strictEqual(
        classifyToolError(
          `Error: Converting circular structure to JSON
    --> starting at object with constructor 'Window'
    --- property 'window' closes the circle
    at JSON.stringify (<anonymous>)`,
        ),
        'VALIDATION_ERROR',
      );
    });
  });
});

describe('cliOutput failure isolation', () => {
  it('creates the state dir when a machine was configured only through the environment', () => {
    const home = mkdtempSync(join(tmpdir(), 'opera-cli-state-'));
    const saved = process.env.HOME;
    process.env.HOME = home;
    try {
      // No `.opera-browser-cli` yet: autoconfiguration never ran.
      writeUrlMapSidecar(new Map([['$u2', '/b']]), TEST_SESSION, null);

      const loaded = loadUrlMapSidecar(TEST_SESSION);
      assert.strictEqual(loaded?.origin, null);
      assert.deepStrictEqual(Object.fromEntries(loaded?.tokens ?? []), {
        $u2: '/b',
      });
    } finally {
      if (saved === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = saved;
      }
      rmSync(home, {recursive: true, force: true});
    }
  });

  it('keeps an unwritable state dir from failing the command', () => {
    // A HOME under a regular file, so the state dir cannot be created at all.
    const pen = join(mkdtempSync(join(tmpdir(), 'opera-cli-pen-')), 'file');
    writeFileSync(pen, '');
    const saved = process.env.HOME;
    process.env.HOME = join(pen, 'nested');

    try {
      assert.doesNotThrow(() =>
        writeUrlMapSidecar(new Map([['$u1', '/a']]), TEST_SESSION, null),
      );
      assert.strictEqual(loadUrlMapSidecar(TEST_SESSION), null);
    } finally {
      if (saved === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = saved;
      }
      rmSync(join(pen, '..'), {recursive: true, force: true});
    }
  });
});

describe('Opera AI "successful" error results', () => {
  // The browser extension reports an unsigned user as plain text on a
  // successful tool call (no MCP `isError`), so only the CDP marker plus the
  // command kind decide the exit code. The signed-out marker maps to
  // AUTH_REQUIRED (exit code 4).
  const NOT_SIGNED_IN_TEXT = `Open the browser and sign in. ${CDP_RESULT_ERROR_KEYS.NOT_SIGNED_IN}`;
  const result: CallToolResult = {
    content: [{type: 'text', text: NOT_SIGNED_IN_TEXT}],
  };
  const OPERA_AI_CONTEXT = {command: 'opera_do', sessionId: 'a1b2c3d4'};

  it('throws an AUTH_REQUIRED CdpError on a "successful" Opera AI result', async () => {
    await assert.rejects(
      () => formatToolResult(result, 'md', OPERA_AI_CONTEXT, handleResponse),
      (err: unknown) =>
        err instanceof CdpError &&
        err.code === 'AUTH_REQUIRED' &&
        /not signed in/i.test(err.message),
    );
  });

  it('leaves a non-Opera-AI command carrying the same text alone', async () => {
    const output = await formatToolResult(
      result,
      'md',
      {command: 'take_snapshot', sessionId: 'a1b2c3d4'},
      handleResponse,
    );

    assert.strictEqual(output, NOT_SIGNED_IN_TEXT);
  });

  it('does not throw from this path when the result is already an error', async () => {
    const errorResult: CallToolResult = {
      isError: true,
      content: [{type: 'text', text: NOT_SIGNED_IN_TEXT}],
    };

    const output = await formatToolResult(
      errorResult,
      'md',
      OPERA_AI_CONTEXT,
      handleResponse,
    );

    assert.strictEqual(output, NOT_SIGNED_IN_TEXT);
  });

  it('bypasses the check entirely for json output', async () => {
    const output = await formatToolResult(
      result,
      'json',
      OPERA_AI_CONTEXT,
      handleResponse,
    );

    // json is delegated to the caller unchanged — no flattening, no marker scan.
    assert.strictEqual(output, await handleResponse(result, 'json'));
  });
});
