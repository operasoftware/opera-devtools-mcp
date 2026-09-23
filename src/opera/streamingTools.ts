/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * The tools whose output arrives in pieces, and the ones that must not be
 * replayed.
 *
 * Ported from opera-browser-cli's `src/client.ts` (`OPERA_AI_TOOLS`,
 * `NON_REPLAYABLE_TOOLS`, `OPERA_AI_TIMEOUT`). The set is the same on both
 * sides of the bridge: the browser streams `notifications/message` chunks while
 * these run, and a dropped connection part-way through is never retried — the
 * call may already have acted on the page or billed the account, so a silent
 * second run could double a booking as easily as it could double a bill.
 */

/** Tools that stream partial output and get the long timeout. */
export const OPERA_AI_TOOLS: Record<string, true> = {
  opera_chat: true,
  opera_do: true,
  opera_research: true,
  opera_make: true,
  opera_call_mcp_tool: true,
  opera_authenticate_mcp_server: true,
};

/**
 * Tools that must never be replayed after a dropped connection.
 *
 * `sendCommand` is single-shot by construction (no retry loop), so this is the
 * contract a test pins rather than a branch in the CLI.
 */
export const NON_REPLAYABLE_TOOLS: Record<string, true> = OPERA_AI_TOOLS;

/** 20 minutes: a research run can legitimately take longer than any other tool. */
export const OPERA_AI_TIMEOUT_MS = 1_200_000;

/**
 * How long a streamed action may report *nothing at all* before it is treated
 * as one that never started.
 *
 * The browser's contract for these actions is an ack, then events: chunks while
 * it works, and a completion or a failure at the end. `do` streams within
 * seconds of its ack. An action that has emitted no event at all for five
 * minutes is not a slow run — it is the failure a research tab sitting open
 * with no prompt in it represents — and waiting out the twenty-minute cap only
 * hides it. The deadline covers the first event alone: once one arrives the run
 * is the browser's to finish, and a research run may legitimately be quiet
 * before and between chunks.
 *
 * Mutable so tests can drive the deadline without waiting on real time, like
 * `serviceWorkerRetryPolicy`.
 */
export const operaAiStreamPolicy = {
  firstEventTimeoutMs: 300_000,
};

/** Whether `toolName` is one of those long-running, streamed tools. */
export function isOperaAiTool(toolName: string): boolean {
  return Object.hasOwn(OPERA_AI_TOOLS, toolName);
}

/**
 * The request timeout `toolName` gets, or `undefined` for the caller's default.
 *
 * Both ends of the chain have to ask this question, because both enforce a
 * timeout of their own and the *shorter* one decides: the CLI's `sendCommand`
 * on the socket, and the daemon's MCP client around `tools/call`. The daemon
 * used to be left on the SDK's 60-second default, so a research run was killed
 * there while the CLI was still waiting out its twenty minutes — and because a
 * timed-out MCP request is cancelled, the tool was aborted mid-run in the
 * browser too.
 */
export function operaAiTimeoutMs(toolName: string): number | undefined {
  return isOperaAiTool(toolName) ? OPERA_AI_TIMEOUT_MS : undefined;
}
