/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {McpContext} from '../../src/McpContext.js';
import {McpPage} from '../../src/McpPage.js';
import {resolveSelectedPage} from '../../src/opera/pageRecovery.js';

import sinon from 'sinon';

/** A stubbed context, so this runs without a browser. */
function stubContext() {
  const context = sinon.createStubInstance(McpContext);
  const page = sinon.createStubInstance(McpPage);
  return {context, page};
}

/** The response lines the recovery reports itself through. */
function stubResponse() {
  const lines: string[] = [];
  return {
    lines,
    appendResponseLine: (line: string) => {
      lines.push(line);
    },
  };
}

describe('pageRecovery', () => {
  it('returns the selected page without listing pages', async () => {
    const {context, page} = stubContext();
    context.getSelectedMcpPage.returns(page);

    const response = stubResponse();
    assert.strictEqual(await resolveSelectedPage(context, response), page);

    // The happy path must stay free of CDP round trips: this is the accessor
    // every page-scoped tool call goes through.
    assert.strictEqual(context.createPagesSnapshot.called, false);
    assert.strictEqual(context.newPage.called, false);
    assert.deepStrictEqual(response.lines, []);
  });

  it('re-selects a live page when the selected one is gone', async () => {
    const {context, page} = stubContext();
    Object.assign(page, {id: 7});
    context.getSelectedMcpPage.onFirstCall().throws(new Error('closed'));
    context.getSelectedMcpPage.onSecondCall().returns(page);
    const response = stubResponse();

    assert.strictEqual(await resolveSelectedPage(context, response), page);

    assert.strictEqual(context.createPagesSnapshot.calledOnce, true);
    assert.strictEqual(context.newPage.called, false);
    assert.deepStrictEqual(response.lines, [
      'Note: the previously selected page was closed. Page 7 is now selected.',
    ]);
  });

  it('opens a page when the browser has none, and reports it', async () => {
    const {context, page} = stubContext();
    Object.assign(page, {id: 3});
    context.getSelectedMcpPage.throws(new Error('closed'));
    context.newPage.resolves(page);
    const response = stubResponse();

    assert.strictEqual(await resolveSelectedPage(context, response), page);

    assert.strictEqual(context.newPage.calledOnce, true);
    // Opening a tab in the user's browser (attached mode) must never be silent.
    assert.deepStrictEqual(response.lines, [
      'Note: the browser had no open pages, so a new one was opened. Page 3 is now selected.',
    ]);
  });

  it('opens one page for concurrent resolutions, reporting it to each caller', async () => {
    const {context, page} = stubContext();
    Object.assign(page, {id: 5});
    context.getSelectedMcpPage.throws(new Error('closed'));
    const {promise, resolve} = Promise.withResolvers<McpPage>();
    context.newPage.returns(promise);

    // Opera tools bypass the tool mutex, so two of them can resolve at the same
    // moment; they must share one page rather than open one each — and each
    // caller's own response has to carry the note, because only one of them
    // caused the open and a silent tab in the user's browser is not acceptable.
    const first = stubResponse();
    const second = stubResponse();
    const both = Promise.all([
      resolveSelectedPage(context, first),
      resolveSelectedPage(context, second),
    ]);
    resolve(page);

    assert.deepStrictEqual(await both, [page, page]);
    assert.strictEqual(context.newPage.calledOnce, true);
    assert.deepStrictEqual(first.lines, [
      'Note: the browser had no open pages, so a new one was opened. Page 5 is now selected.',
    ]);
    assert.deepStrictEqual(second.lines, first.lines);
  });

  it('recovers again after a first recovery, if the page is closed again', async () => {
    const {context, page} = stubContext();
    context.getSelectedMcpPage.throws(new Error('closed'));
    context.newPage.resolves(page);

    assert.strictEqual(await resolveSelectedPage(context), page);
    assert.strictEqual(await resolveSelectedPage(context), page);

    // The single-flight entry must not survive its own completion, or the second
    // close would be served by the first recovery's result.
    assert.strictEqual(context.newPage.callCount, 2);
  });

  it('clears a failed recovery so the next caller retries', async () => {
    const {context, page} = stubContext();
    Object.assign(page, {id: 9});
    context.getSelectedMcpPage.throws(new Error('closed'));
    context.newPage.onFirstCall().rejects(new Error('tab crashed'));

    const first = stubResponse();
    await assert.rejects(resolveSelectedPage(context, first), /tab crashed/);

    // The single-flight entry is cleared by `.finally` on rejection — a failed
    // recovery never poisons the entry, so the next caller opens a fresh page
    // instead of being handed the dead promise.
    context.newPage.onSecondCall().resolves(page);
    const second = stubResponse();
    assert.strictEqual(await resolveSelectedPage(context, second), page);

    assert.strictEqual(context.newPage.callCount, 2);
    assert.deepStrictEqual(second.lines, [
      'Note: the browser had no open pages, so a new one was opened. Page 9 is now selected.',
    ]);
  });
});
