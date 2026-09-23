/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {
  countRefs,
  extractRefs,
  extractTitle,
  isInputType,
  truncateSnapshot,
  truncateText,
  compactSnapshot,
  refToDisplay,
  refToMcp,
  cleanUrl,
  extractPageOrigin,
  extractPageUrl,
  absolutizeUrl,
  applyUrlLut,
  resolveUrl,
} from '../../src/opera/compactSnapshot.js';

describe('countRefs', () => {
  it('counts uid= occurrences in raw form', () => {
    const snapshot = `RootWebArea "Example"
  uid=1 button "Submit"
  uid=2 textbox "Name"
  uid=3 link "Home"`;
    assert.strictEqual(countRefs(snapshot), 3);
  });

  it('counts @X.Y refs in compact form', () => {
    const snapshot = `@1.0 root "Example"
  @1.1 button "Submit"
  @1.2 textbox "Name"`;
    assert.strictEqual(countRefs(snapshot), 3);
  });

  it('returns 0 for no refs', () => {
    assert.strictEqual(countRefs('RootWebArea "Empty"'), 0);
  });
});

describe('extractRefs', () => {
  it('extracts ref info from raw uid= lines', () => {
    const snapshot = `  uid=1 button "Submit"
  uid=2 textbox "Name"`;
    const refs = extractRefs(snapshot);
    assert.deepStrictEqual(refs, [
      {ref: '1', type: 'button', label: 'Submit'},
      {ref: '2', type: 'textbox', label: 'Name'},
    ]);
  });

  it('extracts ref info from compact @X.Y lines and normalises to display form', () => {
    const snapshot = `  @2.1 button "Submit"
  @2.2 textbox "Name"`;
    const refs = extractRefs(snapshot);
    assert.deepStrictEqual(refs, [
      {ref: '2.1', type: 'button', label: 'Submit'},
      {ref: '2.2', type: 'textbox', label: 'Name'},
    ]);
  });

  it('normalises uid=X_Y refs to display form', () => {
    const refs = extractRefs('  uid=2_4 button "Go"');
    assert.strictEqual(refs[0].ref, '2.4');
  });
});

describe('extractTitle', () => {
  it('extracts title from RootWebArea', () => {
    assert.strictEqual(extractTitle('RootWebArea "My Page"'), 'My Page');
  });

  it('extracts title from compact root', () => {
    assert.strictEqual(
      extractTitle('@1.0 root "My Page" url="https://example.com"'),
      'My Page',
    );
  });

  it('extracts title from compact markdown heading', () => {
    assert.strictEqual(extractTitle('@1.1 # Welcome'), 'Welcome');
    assert.strictEqual(extractTitle('@1.2 ## Section'), 'Section');
  });

  it('falls back to heading', () => {
    assert.strictEqual(extractTitle('  heading "Welcome"'), 'Welcome');
  });

  it('returns empty for no title', () => {
    assert.strictEqual(extractTitle('div'), '');
  });
});

describe('isInputType', () => {
  it('recognizes input types', () => {
    assert.strictEqual(isInputType('textbox'), true);
    assert.strictEqual(isInputType('searchbox'), true);
    assert.strictEqual(isInputType('textarea'), true);
  });

  it('rejects non-input types', () => {
    assert.strictEqual(isInputType('button'), false);
    assert.strictEqual(isInputType('link'), false);
  });
});

describe('truncateSnapshot', () => {
  it('returns snapshot unchanged when under limit', () => {
    const snapshot = 'RootWebArea "Short"\n  uid=1 button "OK"';
    const result = truncateSnapshot(snapshot, false, 4000);
    assert.strictEqual(result.text, snapshot);
    assert.strictEqual(result.truncated, false);
  });

  it('truncates at last newline before limit', () => {
    const lines = Array.from(
      {length: 200},
      (_, i) => `  uid=${i} button "Btn ${i}"`,
    );
    const snapshot = `RootWebArea "Big"\n${lines.join('\n')}`;
    const result = truncateSnapshot(snapshot, false, 200);
    assert.strictEqual(result.truncated, true);
    assert.ok(result.text.length <= 200);
    assert.doesNotMatch(result.text, /\n$/);
    assert.strictEqual(result.totalLength, snapshot.length);
  });

  it('returns full snapshot when full=true regardless of limit', () => {
    const lines = Array.from(
      {length: 200},
      (_, i) => `  uid=${i} button "Btn ${i}"`,
    );
    const snapshot = `RootWebArea "Big"\n${lines.join('\n')}`;
    const result = truncateSnapshot(snapshot, true, 200);
    assert.strictEqual(result.text, snapshot);
    assert.strictEqual(result.truncated, false);
  });

  it('reports accurate totalLength', () => {
    const snapshot = 'x'.repeat(5000);
    const result = truncateSnapshot(snapshot, false, 100);
    assert.strictEqual(result.totalLength, 5000);
  });
});

describe('truncateText', () => {
  it('returns text unchanged when under limit', () => {
    const text = 'short text here';
    const result = truncateText(text, 8000);
    assert.strictEqual(result.text, text);
    assert.strictEqual(result.truncated, false);
  });

  it('keeps head and tail when over limit', () => {
    const lines = Array.from(
      {length: 100},
      (_, i) => `line ${i}: ${'x'.repeat(50)}`,
    );
    const text = lines.join('\n');
    const result = truncateText(text, 500);
    assert.strictEqual(result.truncated, true);
    assert.ok(result.text.includes('line 0:'));
    assert.ok(result.text.includes('line 99:'));
    assert.ok(result.text.includes('chars omitted'));
    assert.strictEqual(result.totalLength, text.length);
  });

  it('preserves tail content for grading visibility', () => {
    const head = 'Year 1901\tAlice\nYear 1902\tBob\n';
    const middle = Array.from(
      {length: 100},
      (_, i) => `Year ${1903 + i}\tPerson${i}`,
    ).join('\n');
    const tail = '\nYear 2023\tRecent Winner\nYear 2024\tLatest Winner';
    const text = head + middle + tail;
    const result = truncateText(text, 500);
    assert.strictEqual(result.truncated, true);
    assert.ok(result.text.includes('Year 2024'));
    assert.ok(result.text.includes('Latest Winner'));
  });

  it('reports accurate totalLength', () => {
    const text = 'x'.repeat(20000);
    const result = truncateText(text, 1000);
    assert.strictEqual(result.totalLength, 20000);
  });

  it('skips truncation when result would be longer than original', () => {
    // Text barely over the limit — marker overhead would make it longer
    const text = 'x'.repeat(120);
    const result = truncateText(text, 100);
    assert.strictEqual(result.text, text);
    assert.strictEqual(result.truncated, false);
    assert.strictEqual(result.totalLength, 120);
  });
});

// --- refToDisplay / refToMcp ---

describe('refToDisplay / refToMcp', () => {
  it('converts MCP underscore refs to dot display form', () => {
    assert.strictEqual(refToDisplay('2_4'), '2.4');
    assert.strictEqual(refToDisplay('12_181'), '12.181');
    assert.strictEqual(refToDisplay('1'), '1');
  });

  it('converts display refs back to MCP underscore form', () => {
    assert.strictEqual(refToMcp('2.4'), '2.4'.replace(/\./g, '_'));
    assert.strictEqual(refToMcp('12.181'), '12_181');
    assert.strictEqual(refToMcp('@2.4'), '2_4');
    assert.strictEqual(refToMcp('@2_4'), '2_4');
    assert.strictEqual(refToMcp('2_4'), '2_4');
  });

  it('round-trips correctly', () => {
    assert.strictEqual(refToMcp(refToDisplay('2_4')), '2_4');
    assert.strictEqual(refToMcp(refToDisplay('12_181')), '12_181');
  });
});

// --- compactSnapshot ---

describe('compactSnapshot', () => {
  it('drops LineBreak nodes', () => {
    const tree = `uid=1_0 root "Page"\n  uid=1_1 button "OK"\n  uid=1_2 LineBreak "\n"\n  uid=1_3 link "Home"`;
    const result = compactSnapshot(tree);
    assert.ok(!result.includes('LineBreak'));
    assert.ok(result.includes('button'));
    assert.ok(result.includes('link'));
  });

  it('drops whitespace-only StaticText nodes', () => {
    const tree = `uid=1_0 root "Page"\n  uid=1_1 StaticText " "\n  uid=1_2 button "OK"`;
    const result = compactSnapshot(tree);
    assert.doesNotMatch(result, /StaticText "\s+"/);
    assert.ok(result.includes('button'));
  });

  it('drops StaticText children that duplicate the parent label', () => {
    const tree = [
      `uid=1_0 root "Page"`,
      `  uid=1_1 link "Home" url="/"`,
      `    uid=1_2 StaticText "Home"`,
      `  uid=1_3 button "Submit"`,
    ].join('\n');
    const result = compactSnapshot(tree);
    // StaticText "Home" should be gone; the link and button should remain
    assert.doesNotMatch(result, /text "Home"/);
    assert.ok(result.includes('link "Home"'));
    assert.ok(result.includes('button "Submit"'));
  });

  it('keeps StaticText children whose label differs from the parent', () => {
    const tree = [
      `uid=1_0 root "Page"`,
      `  uid=1_1 link "Click here" url="/"`,
      `    uid=1_2 StaticText "go"`,
    ].join('\n');
    const result = compactSnapshot(tree);
    assert.ok(result.includes('go'));
  });

  it('collapses consecutive text siblings and drops when merged label echoes parent', () => {
    const tree = [
      `uid=1_0 root "Page"`,
      `  uid=1_1 link "[13]" url="/wiki/cite-13"`,
      `    uid=1_2 StaticText "["`,
      `    uid=1_3 StaticText "13"`,
      `    uid=1_4 StaticText "]"`,
    ].join('\n');
    const result = compactSnapshot(tree);
    assert.ok(result.includes('link "[13]"'));
    assert.doesNotMatch(result, /text "\[/);
    assert.doesNotMatch(result, /text "13"/);
    assert.doesNotMatch(result, /text "\]"/);
    assert.doesNotMatch(result, /text "\[13\]"/);
  });

  it('collapses consecutive text siblings and keeps when merged label differs from parent', () => {
    const tree = [
      `uid=1_0 root "Page"`,
      `  uid=1_1 link "World" url="/"`,
      `    uid=1_2 StaticText "Hel"`,
      `    uid=1_3 StaticText "lo"`,
    ].join('\n');
    const result = compactSnapshot(tree);
    assert.ok(result.includes('link "World"'));
    assert.match(result, /text "Hello"/);
    assert.doesNotMatch(result, /@1\.3/);
  });

  it('does not collapse text nodes at different indent levels', () => {
    const tree = [
      `uid=1_0 root "Page"`,
      `  uid=1_1 StaticText "A"`,
      `    uid=1_2 StaticText "B"`,
    ].join('\n');
    const result = compactSnapshot(tree);
    assert.match(result, /text "A"/);
    assert.match(result, /text "B"/);
  });

  it('drops empty valuetext attribute', () => {
    const tree = `uid=1_0 slider "Volume" value="50" valuemax="100" valuemin="0" valuetext=""`;
    assert.ok(!compactSnapshot(tree).includes('valuetext=""'));
  });

  it('drops disableable when disabled is present', () => {
    const tree = `uid=1_0 button "Go" disableable disabled`;
    assert.ok(!compactSnapshot(tree).includes('disableable'));
    assert.ok(compactSnapshot(tree).includes('disabled'));
  });

  it('drops selectable on option and tab roles', () => {
    const tree = [
      `uid=1_0 option "Alpha" selectable value="a"`,
      `uid=1_1 tab "Home" selectable`,
    ].join('\n');
    const result = compactSnapshot(tree);
    assert.ok(!result.includes('selectable'));
  });

  it("drops relevant='additions text'", () => {
    const tree = `uid=1_0 status live="polite" relevant="additions text"`;
    assert.ok(!compactSnapshot(tree).includes('relevant="additions text"'));
  });

  it('drops atomic and default live= on alert/status', () => {
    const tree = [
      `uid=1_0 status atomic live="polite" relevant="additions text"`,
      `uid=1_1 alert atomic live="assertive" relevant="additions text"`,
    ].join('\n');
    const result = compactSnapshot(tree);
    assert.ok(!result.includes('atomic'));
    assert.ok(!result.includes('live="polite"'));
    assert.ok(!result.includes('live="assertive"'));
  });

  it('drops implied combobox attributes', () => {
    const tree = `uid=1_0 combobox "Country" expandable haspopup="menu" value="Poland"`;
    const result = compactSnapshot(tree);
    assert.ok(!result.includes('haspopup'));
    assert.ok(!result.includes('expandable'));
    assert.ok(result.includes('combobox "Country"'));
  });

  it("drops orientation='horizontal'", () => {
    const tree = `uid=1_0 slider "Volume" orientation="horizontal" value="50"`;
    assert.ok(!compactSnapshot(tree).includes('orientation'));
  });

  it('drops autocomplete attribute', () => {
    const tree = `uid=1_0 combobox "Search" autocomplete="both"`;
    assert.ok(!compactSnapshot(tree).includes('autocomplete'));
  });

  it('renames PascalCase role names to compact lowercase forms', () => {
    const tree = [
      `uid=1_0 RootWebArea "Page"`,
      `  uid=1_1 StaticText "Hello"`,
      `  uid=1_2 DisclosureTriangle "Details" expandable`,
      `  uid=1_3 ColorWell "Colour" value="#ff0000"`,
      `  uid=1_4 InputTime "Appt"`,
    ].join('\n');
    const result = compactSnapshot(tree);
    assert.ok(result.includes('root'));
    assert.ok(result.includes('text'));
    assert.ok(result.includes('disclosure'));
    assert.ok(result.includes('color'));
    assert.ok(result.includes('time'));
    assert.ok(!result.includes('RootWebArea'));
    assert.ok(!result.includes('StaticText'));
    assert.ok(!result.includes('DisclosureTriangle'));
    assert.ok(!result.includes('ColorWell'));
    assert.ok(!result.includes('InputTime'));
  });

  it('strips quotes from numeric attribute values', () => {
    const tree = `uid=1_0 spinbutton "Qty" value="3" valuemin="1" valuemax="10"`;
    const result = compactSnapshot(tree);
    assert.ok(result.includes('value=3'));
    assert.ok(result.includes('valuemin=1'));
    assert.ok(result.includes('valuemax=10'));
    assert.ok(!result.includes('value="3"'));
  });

  it('converts headings to markdown style', () => {
    const tree = [
      `uid=1_0 root "Page"`,
      `  uid=1_1 heading "Section One" level="1"`,
      `  uid=1_2 heading "Subsection" level="2"`,
    ].join('\n');
    const result = compactSnapshot(tree);
    assert.ok(result.includes('# Section One'));
    assert.ok(result.includes('## Subsection'));
    assert.ok(!result.includes('heading "'));
    assert.ok(!result.includes('level='));
  });

  it('rewrites uid=PAGE_ELEM refs to @PAGE.ELEM display form', () => {
    const tree = `uid=2_4 button "Submit"`;
    const result = compactSnapshot(tree);
    assert.ok(result.includes('@2.4'));
    assert.ok(!result.includes('uid='));
  });

  it('processes a realistic multi-element tree and is shorter than the original', () => {
    const tree = [
      `uid=2_0 RootWebArea "Test Page" url="file:///test.html"`,
      `  uid=2_1 heading "Test Page" level="1"`,
      `  uid=2_2 region "Links"`,
      `    uid=2_3 link "Home" url="/"`,
      `      uid=2_4 StaticText "Home"`,
      `    uid=2_5 StaticText " "`,
      `    uid=2_6 LineBreak "\n"`,
      `  uid=2_7 region "Form"`,
      `    uid=2_8 combobox "Country" expandable haspopup="menu" value="Poland"`,
      `      uid=2_9 option "Poland" selectable selected value="Poland"`,
      `      uid=2_10 option "Germany" selectable value="Germany"`,
      `    uid=2_11 status atomic live="polite" relevant="additions text"`,
      `      uid=2_12 StaticText "Ready."`,
    ].join('\n');

    const result = compactSnapshot(tree);

    // Ref format
    assert.ok(!result.includes('uid='));
    assert.ok(result.includes('@2.0'));

    // Role renames
    assert.ok(!result.includes('RootWebArea'));
    assert.ok(!result.includes('StaticText'));
    assert.ok(!result.includes('LineBreak'));

    // Noise removal
    assert.ok(!result.includes('selectable'));
    assert.ok(!result.includes('atomic'));
    assert.ok(!result.includes('expandable'));
    assert.ok(!result.includes('live="polite"'));
    assert.ok(!result.includes('relevant='));

    // Markdown headings
    assert.ok(result.includes('# Test Page'));

    // Shorter overall
    assert.ok(result.length < tree.length);
  });
});

// --- cleanUrl ---

describe('cleanUrl', () => {
  it('returns null for javascript: URLs', () => {
    assert.strictEqual(cleanUrl('javascript:void(0)', null), null);
    assert.strictEqual(cleanUrl('javascript:doStuff()', 'https://x.com'), null);
  });

  it('returns null for data: URLs', () => {
    assert.strictEqual(cleanUrl('data:image/png;base64,abc123', null), null);
    assert.strictEqual(
      cleanUrl('data:text/html,<h1>hi</h1>', 'https://x.com'),
      null,
    );
  });

  it('strips matching page origin', () => {
    assert.strictEqual(
      cleanUrl('https://example.com/foo', 'https://example.com'),
      '/foo',
    );
  });

  it('returns / when URL is exactly the origin', () => {
    assert.strictEqual(
      cleanUrl('https://example.com', 'https://example.com'),
      '/',
    );
  });

  it('does not strip a different origin', () => {
    assert.strictEqual(
      cleanUrl('https://other.com/foo', 'https://example.com'),
      'https://other.com/foo',
    );
  });

  it('leaves absolute URL unchanged when origin is null', () => {
    assert.strictEqual(
      cleanUrl('https://example.com/foo?q=bar', null),
      'https://example.com/foo?q=bar',
    );
  });

  it('drops Google Analytics UTM params', () => {
    assert.strictEqual(
      cleanUrl(
        '/p?id=1&utm_source=nl&utm_medium=email&utm_campaign=spring',
        null,
      ),
      '/p?id=1',
    );
  });

  it('drops Google Ads click IDs (gclid, gbraid, wbraid, dclid, gad_source)', () => {
    assert.strictEqual(
      cleanUrl(
        '/p?q=x&gclid=abc&gbraid=def&wbraid=ghi&dclid=jkl&gad_source=1',
        null,
      ),
      '/p?q=x',
    );
  });

  it('drops social platform click IDs (fbclid, msclkid, yclid, igshid, ttclid, twclid)', () => {
    assert.strictEqual(
      cleanUrl(
        '/p?id=1&fbclid=a&msclkid=b&yclid=c&igshid=d&ttclid=e&twclid=f',
        null,
      ),
      '/p?id=1',
    );
  });

  it('drops LinkedIn, Google Shopping, and Klaviyo click IDs', () => {
    assert.strictEqual(
      cleanUrl('/p?id=1&li_fat_id=a&srsltid=b&_ke=c', null),
      '/p?id=1',
    );
  });

  it('drops Mailchimp mc_ params', () => {
    assert.strictEqual(
      cleanUrl('/p?id=1&mc_cid=abc&mc_eid=xyz', null),
      '/p?id=1',
    );
  });

  it('preserves functional params (q, id, node, page, etc.)', () => {
    assert.strictEqual(
      cleanUrl('/search?q=keyboard&page=2&node=42', null),
      '/search?q=keyboard&page=2&node=42',
    );
  });

  it('preserves ie= and _encoding= (site-specific, not generic tracking)', () => {
    assert.strictEqual(
      cleanUrl('/p?ie=UTF8&_encoding=UTF8&node=42', null),
      '/p?ie=UTF8&_encoding=UTF8&node=42',
    );
  });

  it('drops the ? entirely when all params are noise', () => {
    assert.strictEqual(cleanUrl('/p?gclid=abc&utm_source=google', null), '/p');
  });

  it('preserves the fragment', () => {
    assert.strictEqual(
      cleanUrl(
        'https://example.com/s?q=x&gclid=y#section',
        'https://example.com',
      ),
      '/s?q=x#section',
    );
  });

  it('preserves the fragment when there is no query', () => {
    assert.strictEqual(
      cleanUrl('https://example.com/foo#bar', 'https://example.com'),
      '/foo#bar',
    );
  });

  it('preserves percent-encoded values in non-noise params', () => {
    assert.strictEqual(
      cleanUrl('/p?q=hello%20world&gclid=x', null),
      '/p?q=hello%20world',
    );
  });
});

// --- absolutizeUrl ---

describe('absolutizeUrl', () => {
  it('re-attaches the origin to the paths cleanUrl produces', () => {
    assert.strictEqual(
      absolutizeUrl('/downloads/installer.tar.gz', 'https://example.com'),
      'https://example.com/downloads/installer.tar.gz',
    );
    // Query-only and fragment-only values are what cleanUrl leaves when the
    // original URL had no path.
    assert.strictEqual(
      absolutizeUrl('?q=1', 'https://example.com'),
      'https://example.com?q=1',
    );
    assert.strictEqual(
      absolutizeUrl('#frag', 'https://example.com'),
      'https://example.com#frag',
    );
  });

  it('leaves a cross-origin URL on its own origin', () => {
    assert.strictEqual(
      absolutizeUrl('https://other.com/x', 'https://example.com'),
      'https://other.com/x',
    );
    assert.strictEqual(
      absolutizeUrl('mailto:a@b.c', 'https://example.com'),
      'mailto:a@b.c',
    );
  });

  it('joins a protocol-relative URL to the page scheme', () => {
    assert.strictEqual(
      absolutizeUrl('//cdn.example.net/x.js', 'https://example.com:8080'),
      'https://cdn.example.net/x.js',
    );
  });

  it('passes everything through when the page origin is unknown', () => {
    assert.strictEqual(absolutizeUrl('/docs', null), '/docs');
  });

  it('leaves a value cleanUrl would not have shortened alone', () => {
    // A bare relative URL is not something the origin strip produces, so
    // joining it onto the origin would invent an address.
    assert.strictEqual(
      absolutizeUrl('page2.html', 'https://example.com'),
      'page2.html',
    );
  });

  it('inverts cleanUrl for a same-site URL', () => {
    const origin = 'https://example.com';
    const cleaned = cleanUrl(
      'https://example.com/docs/guide?utm_source=x&page=2',
      origin,
    );
    assert.strictEqual(cleaned, '/docs/guide?page=2');
    assert.strictEqual(
      absolutizeUrl(cleaned!, origin),
      'https://example.com/docs/guide?page=2',
    );
  });

  it('inverts cleanUrl for the page root', () => {
    assert.strictEqual(
      cleanUrl('https://example.com/', 'https://example.com'),
      '/',
    );
    assert.strictEqual(
      absolutizeUrl('/', 'https://example.com'),
      'https://example.com/',
    );
  });
});

// --- extractPageUrl ---

describe('extractPageUrl', () => {
  it('returns the page URL from the root node, path and query included', () => {
    const tree = `uid=1_0 RootWebArea "Page" url="https://www.amazon.com/s?k=x"`;
    assert.strictEqual(extractPageUrl(tree), 'https://www.amazon.com/s?k=x');
  });

  it('returns the URL from compact root + @ref form', () => {
    assert.strictEqual(
      extractPageUrl(`@1.0 root "Page" url="https://example.com:8080/foo#top"`),
      'https://example.com:8080/foo#top',
    );
  });

  it('returns null when there is no root url=', () => {
    assert.strictEqual(extractPageUrl(`uid=1_0 RootWebArea "Page"`), null);
    assert.strictEqual(extractPageUrl(`uid=1_1 button "Click"`), null);
  });

  it('reports what the tree says without validating it', () => {
    // The page block is metadata: an odd URL is printed as it is rather than
    // dropped, which is what a reader needs to notice the page is odd.
    assert.strictEqual(
      extractPageUrl(`uid=1_0 RootWebArea "Page" url="not a url"`),
      'not a url',
    );
  });
});

// --- extractPageOrigin ---

describe('extractPageOrigin', () => {
  it('returns origin from RootWebArea url= attribute', () => {
    const tree = `uid=1_0 RootWebArea "Page" url="https://www.amazon.com/s?k=x"`;
    assert.strictEqual(extractPageOrigin(tree), 'https://www.amazon.com');
  });

  it('returns origin from compact root + @ref form', () => {
    const tree = `@1.0 root "Page" url="https://example.com:8080/foo"`;
    assert.strictEqual(extractPageOrigin(tree), 'https://example.com:8080');
  });

  it('returns null when there is no root url=', () => {
    assert.strictEqual(extractPageOrigin(`uid=1_0 RootWebArea "Page"`), null);
  });

  it('returns null for a tree without a root node', () => {
    assert.strictEqual(extractPageOrigin(`uid=1_1 button "Click"`), null);
  });

  it('returns null for an unparseable URL', () => {
    assert.strictEqual(
      extractPageOrigin(`uid=1_0 RootWebArea "Page" url="not a url"`),
      null,
    );
  });
});

// --- compactSnapshot Layer 1 (URL + description cleanup) ---

describe('compactSnapshot URL cleanup', () => {
  it('drops javascript: url= attributes but keeps the element', () => {
    const tree = [
      `uid=1_0 root "Page" url="https://x.com/"`,
      `  uid=1_1 link "Search" url="javascript:void(0)"`,
    ].join('\n');
    const result = compactSnapshot(tree);
    assert.ok(!result.includes('javascript:'));
    // Link line should have no url= attribute at all (root keeps its url= for origin lookup)
    const linkLine = result.split('\n').find(l => l.includes('link "Search"'))!;
    assert.ok(!linkLine.includes('url='));
    assert.ok(linkLine.includes('link "Search"'));
  });

  it('strips the page origin from same-site URLs', () => {
    const tree = [
      `uid=1_0 root "Page" url="https://www.amazon.com/s?k=x"`,
      `  uid=1_1 link "Logo" url="https://www.amazon.com/ref_logo"`,
      `  uid=1_2 link "Other" url="https://other.com/foo"`,
    ].join('\n');
    const result = compactSnapshot(tree);
    assert.ok(result.includes('url="/ref_logo"'));
    assert.ok(result.includes('url="https://other.com/foo"'));
  });

  it('drops tracking query params from URLs', () => {
    const tree = [
      `uid=1_0 root "Page" url="https://example.com/"`,
      `  uid=1_1 link "News" url="https://example.com/news?utm_source=nl&utm_medium=email&gclid=abc"`,
    ].join('\n');
    const result = compactSnapshot(tree);
    assert.ok(result.includes('url="/news"'));
  });

  it('dedups boilerplate description repeated >= threshold times', () => {
    const boilerplate = 'use arrow keys to navigate';
    const tree = [
      `uid=1_0 root "Page" url="https://x.com/"`,
      `  uid=1_1 link "A" description="${boilerplate}"`,
      `  uid=1_2 link "B" description="${boilerplate}"`,
      `  uid=1_3 link "C" description="${boilerplate}"`,
      `  uid=1_4 link "D" description="${boilerplate}"`,
    ].join('\n');
    const result = compactSnapshot(tree);
    const matches = result.match(/description=/g) ?? [];
    assert.strictEqual(matches.length, 1);
    assert.ok(result.includes(`description="${boilerplate}"`));
    assert.ok(result.includes('link "D"'));
  });

  it('keeps descriptions that occur fewer times than the threshold', () => {
    const tree = [
      `uid=1_0 root "Page" url="https://x.com/"`,
      `  uid=1_1 link "A" description="hint one"`,
      `  uid=1_2 link "B" description="hint one"`,
    ].join('\n');
    const result = compactSnapshot(tree);
    const matches = result.match(/description=/g) ?? [];
    assert.strictEqual(matches.length, 2);
  });

  it('strips tracking params even when page origin is unknown', () => {
    const tree = [
      `uid=1_0 root "Page"`,
      `  uid=1_1 link "News" url="https://example.com/news?utm_source=nl&gclid=abc"`,
    ].join('\n');
    const result = compactSnapshot(tree);
    // No origin stripping (root has no url=), but tracking params are removed
    assert.ok(result.includes('url="https://example.com/news"'));
  });
});

// --- applyUrlLut ---

describe('applyUrlLut', () => {
  it('returns body unchanged and empty trailer when no URLs are present', () => {
    const text = `@1.0 root "Page"\n  @1.1 button "Click"`;
    const {body, trailer, urlMap} = applyUrlLut(text);
    assert.strictEqual(body, text);
    assert.strictEqual(trailer, '');
    assert.strictEqual(urlMap.size, 0);
  });

  it('leaves a short URL that appears once untouched', () => {
    const text = `@1.0 root "Page"\n  @1.1 link "Home" url="/home"`;
    const {body, trailer} = applyUrlLut(text);
    assert.ok(body.includes('url="/home"'));
    assert.strictEqual(trailer, '');
  });

  it('tokenises a URL that appears 2+ times (dedup)', () => {
    const repeated = '/s?k=rgb+mechanical+keyboards&category=electronics';
    const text = [
      `@1.0 root "Page" url="${repeated}"`,
      `  @1.1 link "A" url="${repeated}"`,
      `  @1.2 link "B" url="${repeated}"`,
    ].join('\n');
    const {body, trailer, urlMap} = applyUrlLut(text);
    assert.ok(!body.includes(`url="${repeated}"`));
    assert.match(body, /url=\$u\d/);
    assert.strictEqual(urlMap.size, 1);
    const [token, url] = [...urlMap.entries()][0];
    assert.strictEqual(url, repeated);
    assert.ok(trailer.includes(`${token} ${repeated}`));
    // Full URL in trailer — not hidden form
    assert.ok(!trailer.includes('[hidden'));
  });

  it('assigns tokens in tree-walk (first-occurrence) order', () => {
    const urlA = '/page-a?x=1&y=2&z=3&lots=of&params=here';
    const urlB = '/page-b?x=1&y=2&z=3&lots=of&params=here';
    const text = [
      `@1.0 root "Page"`,
      `  @1.1 link "A" url="${urlA}"`,
      `  @1.2 link "B" url="${urlB}"`,
      `  @1.3 link "A2" url="${urlA}"`,
      `  @1.4 link "B2" url="${urlB}"`,
    ].join('\n');
    const {urlMap} = applyUrlLut(text);
    const tokens = [...urlMap.keys()];
    assert.strictEqual(tokens[0], '$u1');
    assert.strictEqual(urlMap.get('$u1'), urlA);
    assert.strictEqual(tokens[1], '$u2');
    assert.strictEqual(urlMap.get('$u2'), urlB);
  });

  it('lists the trailer in the order the body first used each token', () => {
    // Eleven URLs so the ordering assumption is visible: the token *numbers* go
    // up in first-appearance order, and a lexical sort of the trailer would put
    // `$u10` before `$u2`. Each URL appears twice, the second block in the same
    // order, so "first appearance" is a distinct thing from "last appearance".
    const urls = Array.from(
      {length: 11},
      (_, i) => `/page-${i}?padding=${'p'.repeat(30)}`,
    );
    const text = [
      `@1.0 root "Page"`,
      ...urls.map((u, i) => `  @1.${i} link "A${i}" url="${u}"`),
      ...urls.map((u, i) => `  @1.${i} link "B${i}" url="${u}"`),
    ].join('\n');

    const {body, trailer, urlMap} = applyUrlLut(text);
    const tokens = [...urlMap.keys()];
    const bodyOrder = [...body.matchAll(/url=(\$u\d+)/g)].map(m => m[1]);
    const trailerOrder = [...trailer.matchAll(/^\s+(\$u\d+) /gm)].map(
      m => m[1],
    );

    assert.deepStrictEqual(
      tokens,
      urls.map((_, i) => `$u${i + 1}`),
    );
    // Every repeat resolves to the token of the first occurrence...
    assert.deepStrictEqual(bodyOrder, [...tokens, ...tokens]);
    // ...and the trailer reads top-down in that same order.
    assert.deepStrictEqual(trailerOrder, tokens);
  });

  it('tokenises a long URL appearing once as a whale (hidden in trailer)', () => {
    const whale = '/sspa/click?' + 'x'.repeat(200);
    const text = `@1.0 root "Page"\n  @1.1 link "Ad" url="${whale}"`;
    const {body, trailer, urlMap} = applyUrlLut(text);
    assert.match(body, /url=\$u\d/);
    assert.strictEqual(urlMap.get('$u1'), whale);
    // Hidden form in trailer
    assert.ok(trailer.includes('[hidden'));
    assert.ok(trailer.includes(`${whale.length}b`));
    assert.ok(!trailer.includes(whale));
  });

  it('whale trailer includes a path-stem preview', () => {
    const whale = '/sspa/click?spc=' + 'A'.repeat(200);
    const text = `@1.0 root "Page"\n  @1.1 link "Ad" url="${whale}"`;
    const {trailer} = applyUrlLut(text);
    assert.ok(trailer.includes('→ /sspa/click?spc='));
    assert.ok(trailer.includes('…'));
  });

  it('cross-host whale includes host in the preview (no scheme)', () => {
    const whale = 'https://aax-us-east.amazon.com/x/c/' + 'B'.repeat(200);
    const text = `@1.0 root "Page"\n  @1.1 link "Ad" url="${whale}"`;
    const {trailer} = applyUrlLut(text);
    // Preview should start with host, not https://
    assert.match(trailer, /→ aax-us-east\.amazon\.com/);
  });

  it('dedup wins over whale when URL is both long and repeated', () => {
    const url = '/long?' + 'x'.repeat(200);
    const text = [
      `@1.0 root "Page"`,
      `  @1.1 link "A" url="${url}"`,
      `  @1.2 link "B" url="${url}"`,
    ].join('\n');
    const {trailer} = applyUrlLut(text);
    // Full URL printed in trailer — not the hidden form
    assert.ok(trailer.includes(url));
    assert.ok(!trailer.includes('[hidden'));
  });

  it('body + trailer length does not exceed input length', () => {
    const repeated = '/s?k=rgb+mechanical+keyboards';
    const text = [
      `@1.0 root "Page" url="${repeated}"`,
      `  @1.1 link "A" url="${repeated}"`,
      `  @1.2 link "B" url="${repeated}"`,
      `  @1.3 link "C" url="https://other.com/` + 'x'.repeat(200) + `"`,
    ].join('\n');
    const {body, trailer} = applyUrlLut(text);
    assert.ok(body.length + trailer.length <= text.length);
  });

  it('trailer only lists URLs visible in the supplied text (truncation interaction)', () => {
    const urlInBody = '/visible?k=keyboard';
    const urlTruncated = '/hidden?k=mouse';
    // Simulate: body text was already truncated to contain only the first URL
    const truncatedText = `@1.0 root "Page"\n  @1.1 link "A" url="${urlInBody}"\n  @1.2 link "A" url="${urlInBody}"`;
    const {trailer} = applyUrlLut(truncatedText);
    assert.ok(trailer.includes(urlInBody));
    assert.ok(!trailer.includes(urlTruncated));
  });

  it('does not tokenise a repeated URL shorter than the dedup threshold', () => {
    // MIN_DEDUP_LEN is 15: a URL that recurs but is shorter than that is not
    // worth hiding behind a token. `/home` is 5 chars.
    const short = '/home';
    const text = [
      `@1.0 root "Page"`,
      `  @1.1 link "A" url="${short}"`,
      `  @1.2 link "B" url="${short}"`,
      `  @1.3 link "C" url="${short}"`,
    ].join('\n');
    const {body, trailer, urlMap} = applyUrlLut(text);
    assert.strictEqual(body, text);
    assert.ok(!body.includes('$u'));
    assert.strictEqual(trailer, '');
    assert.strictEqual(urlMap.size, 0);
  });

  it('pins the dedup boundary at exactly 15 characters', () => {
    const fourteen = `/a/${'b'.repeat(11)}`; // 14 chars
    const fifteen = `/a/${'b'.repeat(12)}`; // 15 chars
    assert.strictEqual(fourteen.length, 14);
    assert.strictEqual(fifteen.length, 15);

    const repeated = (url: string) =>
      [
        `@1.0 root "Page"`,
        `  @1.1 link "A" url="${url}"`,
        `  @1.2 link "B" url="${url}"`,
      ].join('\n');

    const below = applyUrlLut(repeated(fourteen));
    assert.strictEqual(below.body, repeated(fourteen));
    assert.strictEqual(below.urlMap.size, 0);
    assert.ok(!below.body.includes('$u'));

    const at = applyUrlLut(repeated(fifteen));
    assert.strictEqual(at.urlMap.size, 1);
    assert.ok(!at.body.includes(`url="${fifteen}"`));
    assert.match(at.body, /url=\$u1/);
    assert.strictEqual([...at.urlMap.values()][0], fifteen);
  });
});

// --- resolveUrl ---

describe('resolveUrl', () => {
  it('resolves a $uN token via urlMap', () => {
    const urlMap = new Map([['$u1', 'https://example.com/foo']]);
    assert.strictEqual(
      resolveUrl('', urlMap, '$u1'),
      'https://example.com/foo',
    );
  });

  it('resolves $uN with leading @ stripped', () => {
    const urlMap = new Map([['$u2', '/bar']]);
    assert.strictEqual(resolveUrl('', urlMap, '$u2'), '/bar');
  });

  it('returns null for an unknown token', () => {
    assert.strictEqual(resolveUrl('', new Map(), '$u99'), null);
  });

  it('resolves a plain ref to its url= attribute in the body', () => {
    const body = `@1.0 root "Page"\n  @1.1 link "Home" url="/home"`;
    assert.strictEqual(resolveUrl(body, new Map(), '1.1'), '/home');
    assert.strictEqual(resolveUrl(body, new Map(), '@1.1'), '/home');
  });

  it('resolves a ref whose url= was tokenised, via urlMap', () => {
    const urlMap = new Map([['$u1', '/the-real-url']]);
    const body = `@1.0 root "Page"\n  @1.1 link "Ad" url=$u1`;
    assert.strictEqual(resolveUrl(body, urlMap, '@1.1'), '/the-real-url');
  });

  it('returns null when the ref has no url= attribute', () => {
    const body = `@1.0 root "Page"\n  @1.1 button "Click"`;
    assert.strictEqual(resolveUrl(body, new Map(), '@1.1'), null);
  });

  it('returns null when the ref does not exist in the body', () => {
    const body = `@1.0 root "Page"`;
    assert.strictEqual(resolveUrl(body, new Map(), '@9.9'), null);
  });
});
