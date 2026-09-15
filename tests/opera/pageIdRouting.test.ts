/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {commands, type ArgDef} from '../../src/config/cli-options.js';
import {withoutRoutingPageId} from '../../src/opera/pageIdRouting.js';

const ROUTING_PAGE_ID: ArgDef = {
  name: 'pageId',
  type: 'number',
  description: 'Targets a specific page by ID.',
  required: true,
};

const UID: ArgDef = {
  name: 'uid',
  type: 'string',
  description: 'A CSS selector or accessibility uid.',
  required: true,
};

describe('withoutRoutingPageId', () => {
  it('strips the routing pageId positional', () => {
    assert.deepStrictEqual(
      withoutRoutingPageId({pageId: ROUTING_PAGE_ID, uid: UID}),
      {uid: UID},
    );
  });

  it('keeps a pageId with a non-routing description', () => {
    const closePageId: ArgDef = {
      name: 'pageId',
      type: 'number',
      description:
        'The ID of the page to close. Call list_pages to list pages.',
      required: true,
    };
    assert.deepStrictEqual(withoutRoutingPageId({pageId: closePageId}), {
      pageId: closePageId,
    });
  });

  it('leaves args without pageId unchanged', () => {
    assert.deepStrictEqual(withoutRoutingPageId({uid: UID}), {uid: UID});
  });

  it('strips the routing pageId when upstream appends a caveat to it', () => {
    const evaluateScriptPageId: ArgDef = {
      name: 'pageId',
      type: 'number',
      description:
        'Targets a specific page by ID. Required when not evaluating in a service worker.',
      required: false,
    };

    assert.deepStrictEqual(
      withoutRoutingPageId({pageId: evaluateScriptPageId, function: UID}),
      {function: UID},
    );
  });
});

/**
 * The strip keys off a description string that upstream owns, so pin it against
 * the generated command table: an intake merge that rewords the description — or
 * injects the argument under a new name — fails here instead of quietly putting
 * a pageId back on the CLI surface, where the daemon (spawned with
 * `--no-page-id-routing`) rejects it as an unknown argument.
 */
describe('routing pageId intake guard', () => {
  // Deliberately not imported from `pageIdRouting.ts`: the literal must drift
  // only when upstream does, and then loudly.
  const ROUTING_DESCRIPTION = 'Targets a specific page by ID.';
  const isRouting = (arg: ArgDef | undefined) =>
    arg?.description.startsWith(ROUTING_DESCRIPTION) ?? false;
  const routingCommands = Object.entries(commands).filter(([, command]) =>
    isRouting(command.args.pageId),
  );

  it('upstream still describes the routing pageId the way we match', () => {
    assert.ok(
      routingCommands.length > 0,
      'No upstream command carries the routing pageId description any more, ' +
        'so withoutRoutingPageId() is a no-op and the CLI has silently ' +
        'regained a pageId argument. Re-check upstream, then update ' +
        'ROUTING_PAGE_ID_DESCRIPTION in src/opera/pageIdRouting.ts.',
    );
  });

  it('leaves no routing pageId on the command surface', () => {
    for (const [name, command] of Object.entries(commands)) {
      if (isRouting(command.args.pageId)) {
        assert.ok(
          !('pageId' in withoutRoutingPageId(command.args)),
          `${name} still surfaces a routing pageId`,
        );
      }
    }
  });

  it('keeps pageId only on the commands that own one', () => {
    // `select_page` and `close_page` declare a pageId their handler consumes.
    // Any other command exposing one is a routing leak — or a new upstream
    // command this guard has to learn about.
    const kept = Object.entries(commands)
      .filter(([, command]) => 'pageId' in withoutRoutingPageId(command.args))
      .map(([name]) => name)
      .sort();

    assert.deepStrictEqual(kept, ['close_page', 'select_page']);
  });
});
