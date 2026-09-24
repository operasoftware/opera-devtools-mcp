/**
 * @license
 * Copyright 2026 Opera Software AS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scenarios G1-G3: the non-isolated launch, i.e. the persistent profile the
 * product exists to use. See "Addendum: non-isolated coverage" in
 * docs/specs/stress-test-system-plan.md.
 */

import {describeScenario} from './helpers.js';
import {G1, G2, G3} from './scenarios.js';

describeScenario(G1);
describeScenario(G2);
describeScenario(G3);
