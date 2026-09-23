/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {CLI_BIN_NAME} from '../../src/opera/branding.js';
import {getSuggestions} from '../../src/opera/suggestions.js';

describe('getSuggestions', () => {
  it('suggests snapshot for wait command', () => {
    const suggestions = getSuggestions({command: 'wait'});
    assert.strictEqual(suggestions.length, 1);
    assert.ok(suggestions[0]!.includes('snapshot'));
  });

  it('suggests snapshot for eval command', () => {
    const suggestions = getSuggestions({command: 'eval'});
    assert.strictEqual(suggestions.length, 1);
    assert.ok(suggestions[0]!.includes('snapshot'));
  });

  it('suggests filling inputs after open', () => {
    const snapshot = `RootWebArea "Login"
  uid=1 textbox "Username"
  uid=2 button "Sign In"`;
    const suggestions = getSuggestions({command: 'open', snapshot});
    assert.ok(suggestions.some(s => s.includes('fill')));
  });

  it('suggests submit after fill', () => {
    const snapshot = `RootWebArea "Login"
  uid=1 textbox "Username"
  uid=2 button "Submit"`;
    const suggestions = getSuggestions({command: 'fill', snapshot});
    assert.ok(suggestions.some(s => s.includes('Submit')));
  });

  it('always includes eval tip', () => {
    const snapshot = `RootWebArea "Page"
  uid=1 textbox "Search"
  uid=2 button "Go"
  uid=3 link "Home"`;
    const suggestions = getSuggestions({command: 'snapshot', snapshot});
    assert.ok(suggestions.some(s => s.includes('eval')));
  });

  it('does not read a submit word inside a longer label as a submit', () => {
    // `Designer` contains `sign` and `Google` contains `go`; neither submits a
    // form. A pattern that matched inside words would name `Designer` as the
    // button to click, and then offer it again as the thing to click next.
    const snapshot = `RootWebArea "Checkout"
  uid=1 textbox "Card number"
  uid=2 button "Designer"
  uid=3 button "Google"`;
    const suggestions = getSuggestions({command: 'fill', snapshot});

    assert.ok(
      suggestions[0]!.includes('press Enter'),
      `a label was read as a submit button: ${suggestions.join('\n')}`,
    );
  });

  it('names the fork binary in every hint', () => {
    const snapshot = `RootWebArea "Page"
  uid=1 textbox "Search"
  uid=2 button "Go"`;
    const suggestions = getSuggestions({command: 'snapshot', snapshot});

    assert.ok(suggestions.length > 0);
    for (const line of suggestions) {
      assert.ok(
        line.includes(CLI_BIN_NAME),
        `suggestion does not name ${CLI_BIN_NAME}: ${line}`,
      );
    }
  });

  it('adds a scroll hint only beyond five refs', () => {
    const snapshot = (buttons: number) =>
      `RootWebArea "Page"\n${Array.from(
        {length: buttons},
        (_, i) => `  uid=${i + 1} button "Btn ${i + 1}"`,
      ).join('\n')}`;

    const five = getSuggestions({command: 'open', snapshot: snapshot(5)});
    assert.ok(!five.some(s => s.includes('scroll down')));

    const six = getSuggestions({command: 'open', snapshot: snapshot(6)});
    assert.ok(six.some(s => s.includes('scroll down')));
  });

  it('suggests clicking the first non-submit button after fill', () => {
    const snapshot = `RootWebArea "Form"
  uid=1 textbox "Name"
  uid=2 button "Submit"
  uid=3 button "Save"
  uid=4 button "Cancel"`;
    const suggestions = getSuggestions({command: 'fill', snapshot});

    // The submit suggestion names @2; the "also click a button" suggestion must
    // pick the first *non-submit* button — "Save" (@3) — not the next one.
    assert.ok(suggestions.some(s => s.includes('@3') && s.includes('Save')));
    assert.ok(!suggestions.some(s => s.includes('@4')));
  });

  it('does not offer the submit button a second time after fill', () => {
    // After fill, the submit suggestion already says `click @2`; the generic
    // "also click a button" fallback would name the same button, and the dedupe
    // guard must suppress that duplicate.
    const snapshot = `RootWebArea "Login"
  uid=1 textbox "Username"
  uid=2 button "Submit"`;
    const suggestions = getSuggestions({command: 'fill', snapshot});
    const clicks = suggestions.filter(s => s.includes('@2'));
    assert.strictEqual(clicks.length, 1);
  });

  it('suggests clicking a link by its label', () => {
    const snapshot = `RootWebArea "Docs"
  uid=1 link "Read the docs"`;
    const suggestions = getSuggestions({command: 'open', snapshot});
    assert.ok(
      suggestions.some(s => s.includes('@1') && s.includes('Read the docs')),
    );
  });
});
