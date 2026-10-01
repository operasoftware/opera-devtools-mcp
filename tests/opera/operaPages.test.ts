/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {makeTargetFilter} from '../../src/browser.js';
import {isOperaStartPage} from '../../src/opera/operaPages.js';
import {isAllowedUrl, validateUrl} from '../../src/utils/url.js';

const START_PAGES = [
  'chrome://startpageshared/',
  'chrome://startpageshared',
  'chrome://startpageshared?foo=bar',
  'chrome:startpageshared',
  'chrome://startpage/',
  'CHROME://startpageshared/',
];

describe('isOperaStartPage', () => {
  for (const url of START_PAGES) {
    it(`accepts ${url}`, () => {
      assert.strictEqual(isOperaStartPage(new URL(url)), true);
    });
  }

  for (const url of [
    'chrome://settings',
    'https://example.com/',
    'about:blank',
    // A page *named* like a start page under another scheme is not one.
    'opera://startpage',
    'chrome-extension://startpageshared/page.html',
  ]) {
    it(`rejects ${url}`, () => {
      assert.strictEqual(isOperaStartPage(new URL(url)), false);
    });
  }
});

describe('the Speed Dial in the URL policy', () => {
  // The regression this pins: the URL of every tab the user opens from the tab
  // strip is the Speed Dial, and a URL the policy rejects here is dropped by
  // the Puppeteer target filter below — after which the tab can never be
  // attached, listed or driven, not even once it navigates to a real site.
  for (const url of START_PAGES) {
    it(`allows ${url}`, () => {
      assert.strictEqual(
        isAllowedUrl(url, {categoryExtensions: undefined}),
        true,
      );
    });
  }

  it('keeps accepting an empty tab and refuses internal pages', () => {
    assert.strictEqual(
      isAllowedUrl('about:blank', {categoryExtensions: undefined}),
      true,
    );
    assert.strictEqual(
      isAllowedUrl('chrome://settings', {categoryExtensions: undefined}),
      false,
    );
    assert.strictEqual(
      isAllowedUrl('chrome-untrusted://terminal', {
        categoryExtensions: undefined,
      }),
      false,
    );
  });

  it('navigates to the Speed Dial, as it already does to chrome://newtab/', () => {
    assert.strictEqual(
      validateUrl('chrome://startpageshared/', {
        javascriptEvaluation: undefined,
        categoryExtensions: undefined,
      }).href,
      'chrome://startpageshared/',
    );
  });
});

describe('makeTargetFilter', () => {
  // What the browser connection is built with: a target the filter refuses is
  // detached at attach time and never looked at again.
  const target = (url: string) => ({url: () => url});

  it('keeps a Speed Dial tab', () => {
    assert.strictEqual(
      makeTargetFilter(true)(target('chrome://startpageshared/')),
      true,
    );
  });

  it('still drops webui pages the tools cannot drive', () => {
    assert.strictEqual(
      makeTargetFilter(true)(target('chrome://settings')),
      false,
    );
    assert.strictEqual(
      makeTargetFilter(true)(target('chrome-untrusted://terminal')),
      false,
    );
  });
});
