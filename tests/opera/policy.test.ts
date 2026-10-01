/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {
  enforceTelemetryPolicy,
  PERFORMANCE_CRUX_DEFAULT,
  showUsageStatisticsDisclaimer,
  USAGE_STATISTICS_DEFAULT,
} from '../../src/opera/policy.js';

describe('policy', () => {
  it('defaults both telemetry switches to off', () => {
    assert.strictEqual(USAGE_STATISTICS_DEFAULT, false);
    assert.strictEqual(PERFORMANCE_CRUX_DEFAULT, false);
  });

  describe('enforceTelemetryPolicy', () => {
    afterEach(() => sinon.restore());

    it('forces an explicit opt-in back off and warns once', () => {
      const warn = sinon.stub(console, 'error');
      const args = {usageStatistics: true, performanceCrux: true};

      enforceTelemetryPolicy(args);

      assert.strictEqual(args.usageStatistics, false);
      assert.strictEqual(args.performanceCrux, false);
      assert.strictEqual(warn.calledOnce, true);
      assert.match(
        warn.firstCall.args[0] as string,
        /forcing off/,
        'the warning names what it did',
      );
    });

    it('stays silent when nothing was enabled', () => {
      const warn = sinon.stub(console, 'error');
      const args: {usageStatistics?: boolean; performanceCrux?: boolean} = {};

      enforceTelemetryPolicy(args);

      assert.strictEqual(args.usageStatistics, false);
      assert.strictEqual(args.performanceCrux, false);
      assert.strictEqual(warn.called, false);
    });

    it('stays silent when the flags were already off', () => {
      const warn = sinon.stub(console, 'error');
      const args = {usageStatistics: false, performanceCrux: false};

      enforceTelemetryPolicy(args);

      assert.strictEqual(args.usageStatistics, false);
      assert.strictEqual(args.performanceCrux, false);
      assert.strictEqual(warn.called, false);
    });
  });

  it('never prints the usage-statistics disclaimer', () => {
    assert.strictEqual(showUsageStatisticsDisclaimer(), false);
  });
});
