/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * The CLI's output path: compaction, the URL lookup table, suggestions, and the
 * TOON-structured blocks they are delivered in.
 *
 * Ported from opera-browser-cli's `src/cli.ts` (`renderHelp`, `renderOutput`,
 * `renderError`, `formatPageOutput`, `parseSnapshotFromResponse`,
 * `stripSnapshotHeader`). The source compacted in the CLI, not in the bridge,
 * and this keeps that split: the MCP server's response is unchanged and the
 * trick (a third of the tokens, and refs an agent can copy straight into the
 * next command) is applied on the way out.
 *
 * Everything here is Opera-owned, so the literal binary name is the branding
 * constant rather than a copy of the source string.
 */

import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import type {CallToolResult} from '../third_party/index.js';
import {getToonEncode} from '../third_party/index.js';
import {assertValidSessionId} from '../daemon/utils.js';

import {CLI_BIN_NAME} from './branding.js';
import {
  applyUrlLut,
  compactSnapshot,
  countRefs,
  extractPageOrigin,
  extractPageUrl,
  extractTitle,
  truncateSnapshot,
  type UrlLutResult,
} from './compactSnapshot.js';
import {CdpError, checkAiResultForCdpError, exitCodeFor} from './cdpErrors.js';
import {getStateDir} from './envConfig.js';
import {getSuggestions} from './suggestions.js';
import {isOperaAiTool} from './streamingTools.js';

// ---------------------------------------------------------------------------
// TOON
// ---------------------------------------------------------------------------

/**
 * `@toon-format/toon` is an optional peer dependency, so it is loaded on first
 * use rather than at module load: a user who never asks for structured output
 * never needs it installed. Mirrors `McpResponse.ts`'s `getToonEncode` call.
 */
export async function encode(value: unknown): Promise<string> {
  try {
    const toonEncode = await getToonEncode();
    return toonEncode(value);
  } catch {
    throw new CdpError(
      'The `@toon-format/toon` package is required for TOON output. ' +
        'Install the peer dependency: npm install @toon-format/toon (add -g if installed globally).',
      'BRIDGE_NOT_READY',
    );
  }
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** `help[N]:` followed by two-space-indented lines — the source's shape. */
export function renderHelp(lines: string[]): string {
  if (lines.length === 0) {
    return '';
  }
  const indented = lines.map(line => `  ${line}`).join('\n');
  return `help[${lines.length}]:\n${indented}`;
}

/** Joins non-empty blocks with a newline. */
export function renderOutput(blocks: string[]): string {
  return blocks.filter(Boolean).join('\n');
}

/** `encode({error, code})` plus a help block, so a failure is still structured. */
export async function renderError(
  message: string,
  code: string,
  suggestions: string[] = [],
): Promise<string> {
  const blocks = [await encode({error: message, code})];
  if (suggestions.length > 0) {
    blocks.push(renderHelp(suggestions));
  }
  return blocks.join('\n');
}

/**
 * The output and exit code for a failure, so a caller can branch on *why*
 * without parsing the message.
 */
export async function formatError(
  error: unknown,
): Promise<{output: string; exitCode: number}> {
  const code = error instanceof CdpError ? error.code : 'UNKNOWN';
  const message = error instanceof Error ? error.message : String(error);
  const suggestions = error instanceof CdpError ? error.suggestions : [];
  return {
    output: await renderError(message, code, suggestions),
    exitCode: exitCodeFor(error),
  };
}

// ---------------------------------------------------------------------------
// URL map sidecar
// ---------------------------------------------------------------------------

/**
 * What a `last-url-map` file holds: the token assignments the agent saw, plus
 * the page origin they were shortened against.
 *
 * The map values stay in their compact, origin-relative form (that shortening
 * is most of what the LUT saves), so the origin travels with them: `url $uN` is
 * answered from this file alone, and without the origin it could only hand back
 * `/path` instead of the full URL. The origin is the one the *raw* tree carried
 * — `compactSnapshot` has already replaced the root node's `url=` with `/` by
 * the time the map exists.
 */
export interface UrlMapSidecar {
  origin: string | null;
  tokens: Map<string, string>;
}

/**
 * Where `url $uN` finds the token assignments the agent actually saw.
 *
 * Written on every rendered snapshot: the map is derived from the *truncated*
 * body, so re-deriving it from a fresh full snapshot would hand out different
 * token IDs than the ones in the output the user is quoting.
 *
 * Scoped per session, like every other piece of daemon state (pid file, socket,
 * log). Two invocations with different `--sessionId` values drive two browsers,
 * and one shared file let `url $u3` in one shell answer with the URL the other
 * shell's page had assigned to `$u3`. The default session (`''`) has exactly one
 * daemon, so it keeps one file.
 */
function getUrlMapFile(sessionId: string): string {
  assertValidSessionId(sessionId);
  const suffix = sessionId ? `-${sessionId}` : '';
  return join(getStateDir(), `last-url-map${suffix}.json`);
}

export function writeUrlMapSidecar(
  urlMap: Map<string, string>,
  sessionId: string,
  origin: string | null,
): void {
  try {
    // The state dir is normally created by autoconfiguration, but a machine
    // configured entirely through `OPERA_CLI_*` in the environment never runs
    // it — and a missing dir here must not cost the user `url`.
    mkdirSync(getStateDir(), {recursive: true, mode: 0o700});
    writeFileSync(
      getUrlMapFile(sessionId),
      JSON.stringify({origin, tokens: Object.fromEntries(urlMap)}),
    );
  } catch {
    // Non-fatal: `url` falls back to re-deriving the map if the write fails.
  }
}

export function loadUrlMapSidecar(sessionId: string): UrlMapSidecar | null {
  try {
    // The wire shape, not `UrlMapSidecar`: `tokens` is a plain object on disk.
    const stored = JSON.parse(
      readFileSync(getUrlMapFile(sessionId), 'utf-8'),
    ) as {origin?: unknown; tokens?: unknown} | Record<string, string>;
    if (stored === null || typeof stored !== 'object') {
      return null;
    }
    // A file written before the origin was recorded is a flat token map; read
    // it as tokens-only so an upgrade does not break a token mid-session.
    if (!('tokens' in stored)) {
      return {
        origin: null,
        tokens: new Map(Object.entries(stored as Record<string, string>)),
      };
    }
    return {
      origin: typeof stored.origin === 'string' ? stored.origin : null,
      tokens: new Map(
        Object.entries((stored.tokens ?? {}) as Record<string, string>),
      ),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Snapshot extraction
// ---------------------------------------------------------------------------

const SNAPSHOT_MARKER = '## Latest page snapshot';

/**
 * Slice the `## Latest page snapshot` section out of an MCP response. Returns
 * null when the response carries no snapshot — most tools do not.
 */
export function parseSnapshotFromResponse(response: string): string | null {
  const idx = response.indexOf(SNAPSHOT_MARKER);
  if (idx === -1) {
    return null;
  }
  const after = response.slice(idx + SNAPSHOT_MARKER.length);
  // The snapshot follows the header line, possibly after a blank line.
  const trimmed = after.replace(/^\s*\n/, '');
  // It ends at the next `## ` heading.
  const nextHeading = trimmed.indexOf('\n## ');
  return nextHeading === -1
    ? trimmed.trimEnd()
    : trimmed.slice(0, nextHeading).trimEnd();
}

/**
 * Everything before the actual accessibility tree, stripped: the MCP preamble
 * and headers a caller may have wrapped the tree in.
 */
export function stripSnapshotHeader(text: string): string {
  const lines = text.split('\n');
  const treeStart = lines.findIndex(line =>
    /\bRootWebArea\b|\buid=/.test(line),
  );
  const result =
    treeStart > 0
      ? lines.slice(treeStart).join('\n')
      : text.replace(/^[\s\S]*?##\s+Latest page snapshot\s*\n/, '');
  // Name the command users actually run, not the internal tool.
  return result.replace(
    /Call list_pages\b/g,
    `Run \`${CLI_BIN_NAME} list_pages\``,
  );
}

/**
 * Whether a section is the accessibility-tree grammar `compactSnapshot` was
 * written against. A `--experimentalDataFormat=toon` (or gcf) snapshot is a
 * different language entirely, and compacting it would corrupt it, so it is
 * passed through untouched.
 */
function isAccessibilityTree(section: string): boolean {
  return /^\s*(?:uid=\S+|@\S+)\s+\S/m.test(section);
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

export interface ToolOutputContext {
  /** The tool that produced the result; the suggestion text names it. */
  command: string;
  /**
   * The session whose daemon produced the snapshot. The URL map the trailer
   * hands out is written beside that session's other state, so two sessions
   * cannot answer each other's `url $uN` queries.
   */
  sessionId: string;
  /** The URL the command navigated to, when it had one; otherwise the page's own. */
  url?: string;
  /** Disable truncation. */
  full?: boolean;
  /**
   * Unprocessed MCP output: no compaction, no URL LUT, and the wider
   * truncation ceiling. The snapshot is still labelled, so `--raw` remains
   * scriptable against the same block structure.
   */
  raw?: boolean;
}

interface PageOutput {
  page: Record<string, unknown>;
  snapshot: {
    body: string;
    trailer: string;
    truncated: boolean;
    totalLength: number;
  };
  suggestions: string[];
}

/**
 * Compact, truncate, then apply the URL LUT — in that order, because the LUT
 * trailer must only reference URLs still visible in the truncated body.
 */
function buildPageOutput(
  snapshot: string,
  context: ToolOutputContext,
): PageOutput {
  const {command, url, full = false, raw = false, sessionId} = context;
  const tree = raw ? snapshot : compactSnapshot(snapshot);

  const page: Record<string, unknown> = {};
  const title = extractTitle(tree);
  if (title) {
    page.title = title;
  }
  // A command that navigated knows the URL it went to; every other command takes
  // the page's own, read from the *raw* tree (compaction has already replaced
  // the root node's url= with the origin-relative `/`).
  const pageUrl = url ?? extractPageUrl(snapshot);
  if (pageUrl) {
    page.url = pageUrl;
  }
  page.refs = countRefs(tree);

  const truncation = truncateSnapshot(tree, full, raw ? 16000 : 12000);
  const lut: UrlLutResult = raw
    ? {body: truncation.text, trailer: '', urlMap: new Map<string, string>()}
    : applyUrlLut(truncation.text);
  // The origin comes from the *raw* tree: a later `compactSnapshot`-shaped tree
  // (and so the body the map is derived from) has the root node's url= already
  // shortened to `/`.
  writeUrlMapSidecar(lut.urlMap, sessionId, extractPageOrigin(snapshot));

  const suggestions = getSuggestions({command, url, snapshot: tree});
  if (truncation.truncated) {
    suggestions.push(
      `Run \`${CLI_BIN_NAME} ${command}${url ? ' ' + url : ''} --full\` to see complete snapshot`,
    );
  }

  return {
    page,
    snapshot: {
      body: lut.body,
      trailer: lut.trailer,
      truncated: truncation.truncated,
      totalLength: truncation.totalLength,
    },
    suggestions,
  };
}

/** `page` metadata block, the `snapshot:` block, then the suggestions. */
async function renderPageOutput(out: PageOutput): Promise<string> {
  let snapshotBlock = `snapshot:\n${out.snapshot.body.trimEnd()}`;
  if (out.snapshot.trailer) {
    snapshotBlock += `\n${out.snapshot.trailer}`;
  }
  if (out.snapshot.truncated) {
    snapshotBlock += `\n    ... (truncated, ${out.snapshot.totalLength} chars total)`;
  }
  return renderOutput([
    await encode({page: out.page}),
    snapshotBlock,
    renderHelp(out.suggestions),
  ]);
}

/** The same content as one structured document, for `--output-format toon`. */
async function renderPageToon(out: PageOutput): Promise<string> {
  return encode({
    page: out.page,
    snapshot: {
      body: out.snapshot.body.trimEnd(),
      ...(out.snapshot.trailer ? {urls: out.snapshot.trailer} : {}),
      ...(out.snapshot.truncated
        ? {truncated: true, totalLength: out.snapshot.totalLength}
        : {}),
    },
    ...(out.suggestions.length > 0 ? {help: out.suggestions} : {}),
  });
}

/**
 * The text of a tool result, formatted for a terminal or for a machine.
 *
 * `json` is delegated to the daemon client's own `handleResponse` unchanged.
 * For `md` and `toon` the response is flattened to text exactly once — so an
 * image result is spilled to a file once, not twice — and only a response that
 * carries an accessibility tree gets the compaction treatment.
 *
 * The flattening is also where Opera's "successful" error results are caught:
 * the browser extension reports an unsigned user, or a browser with no Opera AI
 * extension, as ordinary text on a successful call, and `checkAiResultForCdpError`
 * is the only thing that can turn that into an exit code the caller can branch
 * on. It throws, so the caller's error path handles it like any other failure.
 */
export async function formatToolResult(
  result: CallToolResult,
  format: 'md' | 'json' | 'toon',
  context: ToolOutputContext,
  handleResponse: (
    result: CallToolResult,
    format: 'md' | 'json',
  ) => Promise<string>,
): Promise<string> {
  if (format === 'json') {
    return handleResponse(result, 'json');
  }

  const text = await handleResponse(result, 'md');
  if (result.isError !== true && isOperaAiTool(context.command)) {
    checkAiResultForCdpError(context.command, text);
  }
  const section =
    result.isError === true ? null : parseSnapshotFromResponse(text);
  if (section === null || !isAccessibilityTree(section)) {
    return format === 'toon' ? encode({result: text}) : text;
  }

  const out = buildPageOutput(section, context);
  return format === 'toon' ? renderPageToon(out) : renderPageOutput(out);
}
