/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * The exit-code contract, and the browser error strings that map onto it.
 *
 * Ported from opera-browser-cli's `src/cli.ts` (`EXIT_CODES`,
 * `CDP_RESULT_ERRORS`, `callAiTool`'s wrapping) and `src/client.ts`
 * (`ErrorCode`, `CdpError`). The source extended `axi-sdk-js`'s `AxiError`;
 * the fork has no such dependency, so `CdpError` is a plain `Error` subclass
 * carrying the same two extra fields.
 *
 * The codes are a contract, documented in `SKILL.md`: a caller branches on
 * *why* something failed without parsing the message.
 *
 *   2 fix the command    3 environment not ready    4 ask the user
 *   5 retry later        6 page state moved; re-snapshot
 */

import {CLI_BIN_NAME} from './branding.js';

export type ErrorCode =
  | 'BRIDGE_NOT_READY'
  | 'REF_NOT_FOUND'
  | 'TIMEOUT'
  | 'PAGE_CLOSED'
  | 'BROWSER_ERROR'
  /** Sign-in, subscription, or consent — only the user can resolve it. */
  | 'AUTH_REQUIRED'
  | 'VALIDATION_ERROR'
  | 'UNSUPPORTED_OPERATION'
  | 'EXTENSION_NOT_FOUND'
  | 'NOT_FOUND'
  | 'CONVERSATION_NOT_FOUND'
  | 'SERVER_DISCONNECTED'
  | 'UNKNOWN';

export class CdpError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode,
    readonly suggestions: string[] = [],
  ) {
    super(message);
    this.name = 'CdpError';
  }
}

export const EXIT_CODES: Record<ErrorCode, number> = {
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
};

/** A clean run exits 0; every failure is one of `EXIT_CODES`. */
export const SUCCESS_EXIT_CODE = 0;

export function exitCodeFor(error: unknown): number {
  if (error instanceof CdpError) {
    return EXIT_CODES[error.code] ?? 1;
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Opera AI result errors
// ---------------------------------------------------------------------------

/**
 * Error keys that are part of the CDP contract between the CLI and the Opera
 * browser extension. Any change here MUST be mirrored in opera-chat:
 * `src/sagas/chat/handleCdpActionRequested.ts` → `CdpResultErrorKey`.
 */
export const CDP_RESULT_ERROR_KEYS = {
  NOT_SIGNED_IN: '[OPERA_CDP_ERR:NOT_SIGNED_IN]',
  SUBSCRIPTION_REQUIRED: '[OPERA_CDP_ERR:SUBSCRIPTION_REQUIRED]',
  CONSENT_REQUIRED: '[OPERA_CDP_ERR:CONSENT_REQUIRED]',
  NEON_ONLY: '[OPERA_CDP_ERR:NEON_ONLY]',
  CONVERSATION_NOT_FOUND: '[OPERA_CDP_ERR:CONVERSATION_NOT_FOUND]',
} as const;

const NEON_ONLY_HELP = [
  'Install Opera Neon from https://www.operaneon.com',
  `Run \`${CLI_BIN_NAME} setup\` to point at it`,
  `Run \`${CLI_BIN_NAME} doctor\` to inspect the current configuration`,
];

interface CdpResultErrorDescriptor {
  match: (result: string) => boolean;
  message: string | ((command: string) => string);
  code: ErrorCode;
  suggestions: (command: string) => string[];
}

/**
 * The wording that means the dispatch never reached Opera's AI at all: the
 * connected browser has no Opera AI extension, or — for a browser that has one
 * — its service worker was still coming up through every retry.
 *
 * Deliberately narrower than a bare `no target`: this text is scanned on
 * *successful* calls too, where AI prose could contain the two words.
 */
const DISPATCH_NOT_REACHED =
  /dispatcher was not able to dispatch|no target to dispatch/i;

/**
 * What the browser reports when the Opera AI extension is not there to take the
 * dispatch — seen verbatim from a Neon-only command on an Opera build without
 * it: `Protocol error (Opera.dispatchWithStreamedResponse): Opera extension not
 * available for this profile`. Not the same thing as `DISPATCH_NOT_REACHED`,
 * which is about a dispatch that had somewhere to go and did not get there.
 */
const AI_EXTENSION_UNAVAILABLE = /Opera extension not available/i;

/**
 * `Opera: …` — the AI extension the commands dispatch into is missing from the
 * browser profile that is running. `chat` runs on any Opera build, so only a
 * command Neon owns can call it a Neon problem; for the rest the profile is what
 * to look at.
 */
export function aiExtensionUnavailableFailure(command: string): CdpError {
  const neonOnly = command !== 'opera_chat';
  return new CdpError(
    'Opera: the Opera AI extension is not available for this profile',
    'EXTENSION_NOT_FOUND',
    [
      neonOnly
        ? `\`${command}\` requires Opera Neon — install it from https://www.operaneon.com`
        : 'Run it on an Opera profile that has the AI extension loaded',
      `Run \`${CLI_BIN_NAME} setup\` to point at another browser or profile`,
      `Run \`${CLI_BIN_NAME} doctor\` to inspect the current configuration`,
    ],
  );
}

/**
 * Opera reports "no target to dispatch to" when the connected browser has no
 * Opera AI extension — i.e. it is not Opera at all, or not Opera Neon for the
 * tools that require it. The raw CDP text says nothing about that, so it is
 * rewritten into something the user can act on.
 *
 * One diagnosis for both shapes the wording arrives in: thrown out of the tool
 * (`wrapAiToolError`) and appended to a successful result (`CDP_RESULT_ERRORS`).
 */
export function unsupportedAiBrowserFailure(command: string): CdpError {
  const neonOnly = command !== 'opera_chat';
  return new CdpError(
    neonOnly
      ? `${command} requires Opera Neon — the connected browser does not support Opera AI`
      : `${command} requires an Opera browser — the connected browser does not support Opera AI`,
    'BROWSER_ERROR',
    [
      neonOnly
        ? 'Install Opera Neon from https://www.operaneon.com'
        : 'Install Opera from https://www.opera.com or Opera Neon from https://www.operaneon.com',
      `Run \`${CLI_BIN_NAME} setup\` to configure the${neonOnly ? ' Opera Neon' : ''} executable path`,
      `Run \`${CLI_BIN_NAME} doctor\` to inspect the current configuration`,
    ],
  );
}

/**
 * The remedies that belong to a *code* rather than to a matched message, for a
 * failure that arrived without one. Only codes whose exit-code contract names a
 * next step have an entry: 6 means the page state moved, so a fresh snapshot is
 * the fix.
 */
const FRESH_SNAPSHOT = [
  `Run \`${CLI_BIN_NAME} take_snapshot\` to see the current page state and its refs`,
];

const CODE_SUGGESTIONS: Partial<Record<ErrorCode, string[]>> = {
  REF_NOT_FOUND: FRESH_SNAPSHOT,
  PAGE_CLOSED: FRESH_SNAPSHOT,
};

/**
 * Error conditions that Opera returns as plain text content on a successful
 * tool call (no MCP `isError` flag). Each descriptor is checked in order; the
 * first match is converted to a `CdpError`.
 */
const CDP_RESULT_ERRORS: readonly CdpResultErrorDescriptor[] = [
  {
    match: r => r.includes(CDP_RESULT_ERROR_KEYS.NOT_SIGNED_IN),
    message: 'Opera: user is not signed in',
    code: 'AUTH_REQUIRED',
    suggestions: cmd => [
      `Run \`${CLI_BIN_NAME} login\` to sign in to your Opera account`,
      `Re-run \`${CLI_BIN_NAME} ${cmd}\` afterwards`,
    ],
  },
  {
    match: r => r.includes(CDP_RESULT_ERROR_KEYS.SUBSCRIPTION_REQUIRED),
    message: 'Opera: an active subscription is required',
    code: 'AUTH_REQUIRED',
    suggestions: cmd => [
      'Check your Opera subscription at https://auth.opera.com/account/',
      `Re-run \`${CLI_BIN_NAME} ${cmd}\` after activating a subscription`,
    ],
  },
  {
    match: r => r.includes(CDP_RESULT_ERROR_KEYS.CONSENT_REQUIRED),
    message: 'Opera: user consent has not been accepted',
    code: 'AUTH_REQUIRED',
    suggestions: cmd => [
      `Run \`${CLI_BIN_NAME} login\` — the consent prompt appears on first use`,
      `Re-run \`${CLI_BIN_NAME} ${cmd}\` after accepting consent`,
    ],
  },
  {
    match: r => r.includes(CDP_RESULT_ERROR_KEYS.NEON_ONLY),
    message: cmd => `Opera: ${cmd} is only available on Opera Neon`,
    code: 'UNSUPPORTED_OPERATION',
    suggestions: () => NEON_ONLY_HELP,
  },
  {
    match: r => r.includes(CDP_RESULT_ERROR_KEYS.CONVERSATION_NOT_FOUND),
    message: 'Opera: the specified conversation was not found or has expired',
    code: 'CONVERSATION_NOT_FOUND',
    suggestions: cmd => [
      `Run \`${CLI_BIN_NAME} ${cmd}\` without --conversation-id to start a new conversation`,
      `Use \`${CLI_BIN_NAME} opera_list_models\` to see available models`,
    ],
  },
  {
    // Opera's AI keeps its own records in the browser profile, and reports a
    // store it cannot read as an aborted, not-readable record. The action never
    // starts: `chat` comes back with this text, and a streamed action (`do`,
    // `research`) opens its tab and then reports nothing at all, because the
    // failure happens before its first event.
    match: r =>
      /NotReadableError/i.test(r) &&
      /Data lost due to missing file|irrecoverable/i.test(r),
    message:
      "Opera AI's own storage rejected the action — the browser reported a missing file",
    code: 'BROWSER_ERROR',
    suggestions: (_cmd: string) => [
      `Try it on a throwaway profile, which tells browser state from browser behaviour: \`${CLI_BIN_NAME} stop\` then \`${CLI_BIN_NAME} start --isolated --no-headless\``,
      `If it repeats there too the browser side is at fault: the browser's own error is in \`${CLI_BIN_NAME} logs\`, and the profile it launched on is the one named by --userDataDir or OPERA_CLI_USER_DATA_DIR (otherwise ~/.cache/chrome-devtools-mcp-cli/chrome-profile)`,
      `Check whether the other Opera AI commands on the same path fail too: \`${CLI_BIN_NAME} opera_list_models\``,
    ],
  },
  {
    // Raised by the tool itself (`opera/tools/opera.ts`) when a streamed action
    // emitted nothing at all — the shape a stalled action takes, and the one
    // the browser reports no error for.
    match: r => /no progress was reported for/i.test(r),
    message: 'Opera never started the action in the browser',
    code: 'BROWSER_ERROR',
    suggestions: cmd => [
      `Run \`${CLI_BIN_NAME} logs --errors\` to see what the browser side reported for \`${cmd}\``,
      `If it names unreadable AI storage, delete the profile this daemon launched (--userDataDir, or OPERA_CLI_USER_DATA_DIR; otherwise ~/.cache/chrome-devtools-mcp-cli/chrome-profile) and run \`${CLI_BIN_NAME} ${cmd}\` again`,
    ],
  },
  {
    // The dispatch had nowhere to go because the AI extension is not in this
    // profile at all. Like the entry below, the tool appends it to a successful
    // result rather than throwing, so it has to be recognised from the text.
    match: r => AI_EXTENSION_UNAVAILABLE.test(r),
    message: cmd => aiExtensionUnavailableFailure(cmd).message,
    code: 'EXTENSION_NOT_FOUND',
    suggestions: cmd => aiExtensionUnavailableFailure(cmd).suggestions,
  },
  {
    // The dispatch never reached Opera's AI. `serviceWorkerRetry` replays this
    // wording *inside* the tool while the service worker is still coming up, so
    // a copy that arrives here is one the retries already exhausted — the tool
    // appends it to the response instead of throwing, which is what makes it
    // this list's business rather than only `wrapAiToolError`'s. Last, because
    // its match is the loosest.
    match: r => DISPATCH_NOT_REACHED.test(r),
    message: cmd => unsupportedAiBrowserFailure(cmd).message,
    code: 'BROWSER_ERROR',
    suggestions: cmd => unsupportedAiBrowserFailure(cmd).suggestions,
  },
];

/**
 * The `CdpError` a result text describes, or null when it describes no known
 * condition. One lookup behind both the throw (a successful-looking AI result)
 * and the value (a failure classified for its exit code and message).
 */
export function findCdpResultError(
  command: string,
  result: string,
): CdpError | null {
  for (const descriptor of CDP_RESULT_ERRORS) {
    if (descriptor.match(result)) {
      const message =
        typeof descriptor.message === 'function'
          ? descriptor.message(command)
          : descriptor.message;
      return new CdpError(
        message,
        descriptor.code,
        descriptor.suggestions(command),
      );
    }
  }
  return null;
}

/** Throws a `CdpError` when a successful-looking AI result is really an error. */
export function checkAiResultForCdpError(
  command: string,
  result: string,
): void {
  const error = findCdpResultError(command, result);
  if (error) {
    throw error;
  }
}

export interface ToolFailure {
  /** What to print: the diagnosis when one is known, else the raw text. */
  message: string;
  code: ErrorCode;
  suggestions: string[];
}

/**
 * Everything a caller needs to report a failure that arrived as text: the
 * message, the code to exit with, and the next step.
 *
 * The descriptors come first because they carry a diagnosis and its remedies —
 * an error result holding `[OPERA_CDP_ERR:NOT_SIGNED_IN]` is answered with the
 * same sign-in instructions a successful-looking one gets, rather than with the
 * extension's marker. Text no descriptor knows keeps its own words and takes
 * its code from `classifyToolError`.
 */
export function describeToolFailure(
  command: string,
  text: string,
): ToolFailure {
  const known = findCdpResultError(command, text);
  if (known) {
    return {
      message: known.message,
      code: known.code,
      suggestions: known.suggestions,
    };
  }
  const code = classifyToolError(text);
  return {message: text, code, suggestions: CODE_SUGGESTIONS[code] ?? []};
}

/**
 * Opera reports "no target to dispatch to" when the connected browser has no
 * Opera AI extension — i.e. it is not Opera at all, or not Opera Neon for the
 * tools that require it. The raw CDP text says nothing about that, so it is
 * rewritten into something the user can act on.
 *
 * The tool appends this wording to a *successful* result instead of throwing
 * when its own retries are spent (`tools/opera.ts`), so the same diagnosis is in
 * `CDP_RESULT_ERRORS` for that path.
 */
export function wrapAiToolError(command: string, error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (AI_EXTENSION_UNAVAILABLE.test(message)) {
    return aiExtensionUnavailableFailure(command);
  }
  if (!DISPATCH_NOT_REACHED.test(message)) {
    return error;
  }
  return unsupportedAiBrowserFailure(command);
}

/**
 * Classify a tool failure that arrived as text rather than as a code.
 *
 * Upstream's `ToolHandler` turns a thrown error into `isError: true` with the
 * message as content, so the *reason* has to be recovered from the message to
 * pick an exit code. Anything unrecognised is `UNKNOWN` (1) rather than a wrong
 * specific code.
 *
 * **Order is load-bearing: most specific first.** Every entry must be able to
 * match the message on its own terms, because an earlier broad pattern will
 * shadow a later exact one. The unknown-argument reply is the standing example —
 * it lists the tool's expected arguments, and `navigate_page`'s list contains
 * `"timeout"`, so a bare `timeout` pattern placed before it reports a bad
 * argument as a timeout.
 */
const TOOL_ERROR_PATTERNS: ReadonlyArray<{match: RegExp; code: ErrorCode}> = [
  // Unsigned / unsubscribed Opera AI — the user has to act.
  {
    match: /not signed in|subscription|consent|OPERA_CDP_ERR/i,
    code: 'AUTH_REQUIRED',
  },
  // A stale uid, or a page that moved under the call.
  {
    match:
      /uid .* not found|element .*not found|no node with given id|stashed element/i,
    code: 'REF_NOT_FOUND',
  },
  {
    match:
      /detached|execution context was destroyed|cannot find context|target closed|page.*closed/i,
    code: 'PAGE_CLOSED',
  },
  // A bad argument the caller can fix. `ToolHandler.ts`'s reply is a fixed
  // prefix, so it is anchored rather than merely matched.
  {
    match: /^unknown arguments? for tool/i,
    code: 'VALIDATION_ERROR',
  },
  // `evaluate_script` serializes its result with `JSON.stringify`, so a script
  // returning something unserializable (a `Window`, a DOM node, a cyclic object)
  // fails here rather than in the script. The script is the thing to fix.
  {
    match: /converting circular structure to json/i,
    code: 'VALIDATION_ERROR',
  },
  // A tool or feature the browser is not allowed to use. `ToolHandler.ts`'s
  // disabled message is the common one; `utils/url.ts`'s refusal to navigate to
  // a `javascript:` URL is the other shape, and it names the same cause.
  {
    match:
      /(?:is|are)\s+(?:currently\s+)?disabled|not allowed|requires experimental feature/i,
    code: 'UNSUPPORTED_OPERATION',
  },
  // Only timeout *phrasing*, never the bare word: it is a common argument name.
  {
    match:
      /timed out\b|timeout of \d|timeout \d+\s*ms exceeded|exceeded the timeout|within the configured timeout|timeout waiting for/i,
    code: 'TIMEOUT',
  },
  // The shapes the CDP descriptors own when they arrive as content on a
  // successful call. `describeToolFailure` asks the descriptors first, so these
  // entries are the backstop for the same wording arriving as a daemon error
  // string instead — without them it would report UNKNOWN (1) rather than the
  // environment failure it is.
  {
    match:
      /NotReadableError|Data lost due to missing file|irrecoverable|no progress was reported for/i,
    code: 'BROWSER_ERROR',
  },
  {
    match: AI_EXTENSION_UNAVAILABLE,
    code: 'EXTENSION_NOT_FOUND',
  },
  {
    match: DISPATCH_NOT_REACHED,
    code: 'BROWSER_ERROR',
  },
  {
    match: /ECONNREFUSED|ECONNRESET|EPIPE|socket hang up/i,
    code: 'SERVER_DISCONNECTED',
  },
];

export function classifyToolError(message: string): ErrorCode {
  for (const {match, code} of TOOL_ERROR_PATTERNS) {
    if (match.test(message)) {
      return code;
    }
  }
  return 'UNKNOWN';
}
