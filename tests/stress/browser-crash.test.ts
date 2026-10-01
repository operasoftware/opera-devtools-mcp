/**
 * @license
 * Copyright 2026 Opera Software AS.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scenarios C1/C2: browser crashes and the helpers they orphan.
 * H1: the browser survives, but the user closed its pages.
 */

import {describeScenario} from './helpers.js';
import {C1, C2, H1} from './scenarios.js';

describeScenario(C1);
describeScenario(C2);
describeScenario(H1);
