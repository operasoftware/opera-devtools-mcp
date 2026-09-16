/**
 * @license
 * Copyright 2026 Opera Software AS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Orchestrated stress loop.
 *
 * Runs every scenario of `scenarios.ts` for `STRESS_ITERATIONS` rounds, each
 * round on a fresh session, and asserts after every scenario (inside
 * `runScenarioIteration` -> `cleanupSession`) and after every round that the
 * process table holds nothing for the sessions this run created.
 *
 * Repetition targets flakiness, so a scenario that has already failed is not
 * run again: the defects these scenarios reproduce are deterministic, and
 * re-running them only buys the same failure at the cost of its timeouts. The
 * report still lists the skipped runs.
 *
 * The scenarios assert the robustness the product promises, so a red run is
 * the deliverable's own bug report: the failing assertions name the processes
 * that leaked or the recovery that never happened, and
 * `docs/specs/stress-test-system-plan.md` documents which of them are known
 * today.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import process from 'node:process';
import {describe, it} from 'node:test';

import {
  assertNoRunLeftovers,
  ENV_ALLOW_KILLS,
  getIterations,
  processKillsAllowed,
  resetRunRegistry,
  runScenarioIteration,
  stressSkipReason,
} from './helpers.js';
import {SCENARIOS} from './scenarios.js';

interface ScenarioOutcome {
  id: string;
  round: number;
  sessionId: string;
  durationMs: number;
  /** Set when the scenario was not run because it failed in an earlier round. */
  skippedAfter?: string;
  error?: Error;
}

function formatReport(
  outcomes: ScenarioOutcome[],
  iterations: number,
  runErrors: string[],
): string {
  const lines = [
    '',
    `stress runner: ${SCENARIOS.length} scenarios x ${iterations} rounds`,
    '',
    'scenario  passes  failures  skipped',
  ];
  for (const scenario of SCENARIOS) {
    const rows = outcomes.filter(outcome => outcome.id === scenario.id);
    const failures = rows.filter(row => row.error);
    lines.push(
      `${scenario.id.padEnd(9)} ${String(rows.length - failures.length - rows.filter(row => row.skippedAfter).length).padEnd(7)} ${String(
        failures.length,
      ).padEnd(9)} ${rows.filter(row => row.skippedAfter).length}`,
    );
  }

  const failures = outcomes.filter(outcome => outcome.error);
  if (failures.length) {
    lines.push('', `documented defects reproduced (${failures.length}):`);
    for (const failure of failures) {
      lines.push(
        `  round ${failure.round} ${failure.id} (${failure.durationMs}ms): ${failure.error?.message}`,
      );
    }
  }
  const skipped = outcomes.filter(outcome => outcome.skippedAfter);
  if (skipped.length) {
    lines.push(
      '',
      `${skipped.length} later run(s) skipped: a scenario that already failed is ` +
        'deterministic by construction - its defect will not un-happen - so the ' +
        'runner records the first failure and moves on.',
    );
  }
  if (runErrors.length) {
    lines.push('', `run-level failures (${runErrors.length}):`);
    for (const runError of runErrors) {
      lines.push(`  ${runError}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

describe('stress runner', () => {
  it(
    'runs every scenario in a loop and leaves no process behind',
    {skip: stressSkipReason()},
    async () => {
      assert.ok(
        processKillsAllowed(),
        `${ENV_ALLOW_KILLS} is not 'true': the runner kills processes, and the ` +
          'interlock in helpers.ts refuses to signal anything without it',
      );
      const iterations = getIterations();
      resetRunRegistry();
      const outcomes: ScenarioOutcome[] = [];
      /** Scenarios that already failed: repeating a deterministic defect only burns time. */
      const failed = new Map<string, number>();
      const runErrors: string[] = [];

      for (let round = 1; round <= iterations; round++) {
        for (const scenario of SCENARIOS) {
          const failedInRound = failed.get(scenario.id);
          if (failedInRound !== undefined) {
            outcomes.push({
              id: scenario.id,
              round,
              sessionId: '-',
              durationMs: 0,
              skippedAfter: `round ${failedInRound}`,
            });
            continue;
          }
          const sessionId = crypto.randomUUID();
          const startedAt = Date.now();
          const outcome: ScenarioOutcome = {
            id: scenario.id,
            round,
            sessionId,
            durationMs: 0,
          };
          try {
            await runScenarioIteration(
              scenario,
              sessionId,
              `round ${round}/${iterations}`,
            );
          } catch (error) {
            outcome.error = error as Error;
            failed.set(scenario.id, round);
          }
          outcome.durationMs = Date.now() - startedAt;
          outcomes.push(outcome);
          process.stdout.write(
            `[stress] round ${round}/${iterations} ${scenario.id} ${
              outcome.error ? 'FAIL' : 'pass'
            } ${outcome.durationMs}ms\n`,
          );
        }
        // A round-level failure must not cost the run its report, so it is
        // recorded and reported alongside the scenario outcomes.
        try {
          await assertNoRunLeftovers();
        } catch (error) {
          runErrors.push(`round ${round}: ${(error as Error).message}`);
        }
      }

      process.stdout.write(formatReport(outcomes, iterations, runErrors));
      const failures = outcomes.filter(outcome => outcome.error);
      const runs = outcomes.filter(outcome => !outcome.skippedAfter);
      assert.strictEqual(
        failures.length + runErrors.length,
        0,
        `${failures.length} of ${runs.length} scenario runs failed plus ` +
          `${runErrors.length} run-level failure(s); see the report above`,
      );
    },
  );
});
