/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import {CLI_BIN_NAME} from './branding.js';
import {extractRefs, isInputType} from './compactSnapshot.js';

export interface SuggestionContext {
  command: string;
  url?: string;
  snapshot?: string;
}

/**
 * A label that means "this button submits the form".
 *
 * Anchored, because the label is prose: `Sign in` and `Sign up` are submits, but
 * `Sponsor`, `Booking` and `Register` merely contain `ok`, `go` and `sign`, and
 * treating them as submits both suggests the wrong button after a `fill` and
 * skips them when suggesting what else to click.
 */
const SUBMIT_LABEL_PATTERN = /\b(?:submit|search|go|send|login|sign|ok)\b/i;

export function getSuggestions(ctx: SuggestionContext): string[] {
  // Commands without auto-snapshot — suggest viewing page state
  if (ctx.command === 'wait' || ctx.command === 'eval') {
    return [`Run \`${CLI_BIN_NAME} snapshot\` to see current page state`];
  }

  const refs = ctx.snapshot ? extractRefs(ctx.snapshot) : [];
  const links = refs.filter(r => r.type === 'link');
  const buttons = refs.filter(r => r.type === 'button');
  const inputs = refs.filter(r => isInputType(r.type));
  const lines: string[] = [];

  // After filling a field, suggest submitting
  if (ctx.command === 'fill') {
    const submitBtn = buttons.find(r => SUBMIT_LABEL_PATTERN.test(r.label));
    if (submitBtn) {
      lines.push(
        `Run \`${CLI_BIN_NAME} click @${submitBtn.ref}\` to click "${submitBtn.label}"`,
      );
    } else {
      lines.push(`Run \`${CLI_BIN_NAME} press Enter\` to submit the form`);
    }
  }

  // Suggest filling inputs (unless we just filled one)
  if (inputs.length > 0 && ctx.command !== 'fill') {
    const inp = inputs[0];
    const label = inp.label ? `the "${inp.label}" field` : 'the input field';
    lines.push(
      `Run \`${CLI_BIN_NAME} fill @${inp.ref} "text"\` to fill ${label}`,
    );
  }

  // Suggest clicking buttons
  if (buttons.length > 0) {
    const btn =
      ctx.command === 'fill'
        ? (buttons.find(r => !SUBMIT_LABEL_PATTERN.test(r.label)) ?? buttons[0])
        : buttons[0];
    if (btn && !lines.some(l => l.includes(`@${btn.ref}`))) {
      const label = btn.label ? `"${btn.label}" ` : '';
      lines.push(
        `Run \`${CLI_BIN_NAME} click @${btn.ref}\` to click the ${label}button`,
      );
    }
  }

  // Suggest clicking links
  if (links.length > 0) {
    const link = links[0];
    lines.push(
      `Run \`${CLI_BIN_NAME} click @${link.ref}\` to click the "${link.label}" link`,
    );
  }

  // Suggest scrolling if page has many elements
  if (refs.length > 5) {
    lines.push(`Run \`${CLI_BIN_NAME} scroll down\` to scroll down`);
  }

  // Teach eval syntax — use IIFE for multi-statement logic
  lines.push(
    `Use \`${CLI_BIN_NAME} eval <expr>\` for JS expressions. For multi-statement code, wrap in an IIFE: \`eval "(() => { ...; return result })()"\``,
  );

  return lines;
}
