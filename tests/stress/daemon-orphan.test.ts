/**
 * @license
 * Copyright 2026 Opera Software AS.
 * SPDX-License-Identifier: Apache-2.0
 */

/** Scenarios A1/A2: daemon-level orphans and start races. */

import {describeScenario} from './helpers.js';
import {A1, A2} from './scenarios.js';

describeScenario(A1);
describeScenario(A2);
