/**
 * @license
 * Copyright 2026 Opera Software AS.
 * SPDX-License-Identifier: Apache-2.0
 */

// Runs the stress suite in its disposable container.
//
// `docker compose` is a CLI plugin that is not installed everywhere - Homebrew's
// docker formula ships the standalone `docker-compose` binary instead - so the
// frontend is resolved *before* anything runs. Deciding it from a failing `up`
// would run the whole destructive suite a second time.
//
// The TypeScript build runs here, on the host: the image copies `build/` rather
// than compiling it, because a cold `tsc` over the vendored devtools-frontend
// tree exceeds the heap a container gets from its cgroup limits.

import {spawnSync} from 'node:child_process';
import process from 'node:process';

const COMPOSE_FILE = 'tests/stress/docker/docker-compose.yml';
const IMAGE = 'opera-devtools-stress';
/** Mirrors the `:-3` default of `docker-compose.yml`'s `STRESS_ITERATIONS`. */
const DEFAULT_ITERATIONS = '3';

const COMPOSE_UP_ARGS = [
  '-f',
  COMPOSE_FILE,
  'up',
  '--build',
  '--abort-on-container-exit',
  '--exit-code-from',
  'stress-test',
];

// The container's environment belongs to the caller, not to this script: the
// compose frontend interpolates both names from the shell (`${STRESS_ITERATIONS:-3}`
// and `${STRESS_CHROME_ARGS:-}` in `docker-compose.yml`), and this fallback has
// no compose to do it, so it forwards them itself. A hardcoded iteration count
// here once tripled a run's duration on a host without a compose frontend, and
// no path honoured a caller's `STRESS_ITERATIONS` at all. Empty counts as unset
// - the same rule `:-` applies.
function containerEnvArgs() {
  const args = [
    '-e',
    `STRESS_ITERATIONS=${process.env.STRESS_ITERATIONS || DEFAULT_ITERATIONS}`,
  ];
  if (process.env.STRESS_CHROME_ARGS) {
    args.push('-e', `STRESS_CHROME_ARGS=${process.env.STRESS_CHROME_ARGS}`);
  }
  return args;
}

// Mirrors `docker-compose.yml` for hosts that have neither compose frontend.
// `--init` matters as much as the tmpfs does: pid 1 has to reap, or every
// detached daemon the suite kills stays a zombie that `kill(pid, 0)` calls
// alive. See the note in `docker-compose.yml`.
const RUN_ARGS = [
  'run',
  '--rm',
  '--init',
  '--tmpfs',
  '/tmp',
  '--security-opt',
  'seccomp=unconfined',
  ...containerEnvArgs(),
  IMAGE,
];

function run(command, args) {
  const result = spawnSync(command, args, {stdio: 'inherit'});
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

function isAvailable(command, args) {
  return spawnSync(command, args, {stdio: 'ignore'}).status === 0;
}

function main() {
  // The image ships this output, so it has to exist and be current.
  const buildStatus = run('npm', ['run', 'build']);
  if (buildStatus !== 0) {
    return buildStatus;
  }

  if (isAvailable('docker', ['compose', 'version'])) {
    return run('docker', ['compose', ...COMPOSE_UP_ARGS]);
  }
  if (isAvailable('docker-compose', ['version'])) {
    return run('docker-compose', COMPOSE_UP_ARGS);
  }
  console.warn(
    'No docker compose frontend found; building and running the container directly.',
  );
  const built = run('docker', [
    'build',
    '-f',
    'tests/stress/docker/Dockerfile',
    '-t',
    IMAGE,
    '.',
  ]);
  return built === 0 ? run('docker', RUN_ARGS) : built;
}

process.exit(main());
