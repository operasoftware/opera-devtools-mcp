/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {PassThrough} from 'node:stream';
import {afterEach, beforeEach, describe, it} from 'node:test';
import {fileURLToPath} from 'node:url';

import sinon from 'sinon';

import {detectBrowsers, operaCandidatePaths} from '../../src/opera/detect.js';
import {getConfigFile, readConfigFile} from '../../src/opera/envConfig.js';
import {writeConfigFile} from '../../src/opera/config.js';
import {
  handleSetup,
  parseSetupArgs,
  setupNonInteractive,
} from '../../src/opera/setup.js';

/**
 * The `SKILL.md` the package ships, which `setup` installs for agents. Compiled,
 * this file is `<pkg>/build/tests/opera/setup.test.js`, so `../..` is
 * `<pkg>/build` — and the skill ships beside the compiled modules, where
 * `findSkillSource` looks.
 */
const SHIPPED_SKILL = fileURLToPath(
  new URL('../../src/opera/skills/SKILL.md', import.meta.url),
);

describe('parseSetupArgs', () => {
  it('defaults to the interactive wizard', () => {
    assert.strictEqual(parseSetupArgs([]).interactive, true);
  });

  it('accepts the non-interactive flags', () => {
    assert.strictEqual(
      parseSetupArgs(['--non-interactive']).interactive,
      false,
    );
    assert.strictEqual(parseSetupArgs(['-y']).interactive, false);
    assert.strictEqual(parseSetupArgs(['--yes']).interactive, false);
  });

  it('treats any explicit setting as non-interactive', () => {
    // Passing a value means the caller already knows what they want; stopping
    // to ask would defeat the point in a provisioning script.
    assert.deepStrictEqual(parseSetupArgs(['--executable', '/x/opera']), {
      interactive: false,
      executable: '/x/opera',
      profile: undefined,
      headed: undefined,
    });
    assert.deepStrictEqual(parseSetupArgs(['--profile', 'skip']), {
      interactive: false,
      executable: undefined,
      profile: 'skip',
      headed: undefined,
    });
    assert.deepStrictEqual(parseSetupArgs(['--headless']), {
      interactive: false,
      executable: undefined,
      profile: undefined,
      headed: false,
    });
    assert.deepStrictEqual(parseSetupArgs(['--headed']), {
      interactive: false,
      executable: undefined,
      profile: undefined,
      headed: true,
    });
  });

  it('ignores a flag with no value rather than consuming the next one', () => {
    assert.deepStrictEqual(parseSetupArgs(['--executable']), {
      interactive: true,
      executable: undefined,
      profile: undefined,
      headed: undefined,
    });
  });
});

describe('setupNonInteractive', () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'opera-setup-'));
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    rmSync(home, {recursive: true, force: true});
  });

  function readConfig(): string {
    return readFileSync(join(home, '.opera-browser-cli', 'config'), 'utf-8');
  }

  it('writes the detected executable, headed mode, and a profile', async () => {
    const output = await setupNonInteractive(
      parseSetupArgs(['--non-interactive', '--executable', '/opt/opera']),
      home,
    );

    const config = readConfig();
    assert.match(config, /^OPERA_CLI_EXECUTABLE_PATH="\/opt\/opera"$/m);
    assert.match(config, /^OPERA_CLI_HEADED="1"$/m);
    assert.match(
      config,
      /^OPERA_CLI_USER_DATA_DIR=".+opera-browser-cli\/profile"$/m,
    );
    // The settings block is structured output, the help block is prose.
    assert.ok(output.includes('config:'), output);
    assert.ok(output.includes('OPERA_CLI_EXECUTABLE_PATH'), output);
    assert.ok(output.includes('help['), output);
  });

  it('omits the profile when the caller asks to skip it, and stays headless', async () => {
    await setupNonInteractive(
      parseSetupArgs([
        '--executable',
        '/opt/opera',
        '--profile',
        'skip',
        '--headless',
      ]),
      home,
    );

    const config = readConfig();
    assert.match(config, /^OPERA_CLI_EXECUTABLE_PATH="\/opt\/opera"$/m);
    assert.ok(!config.includes('OPERA_CLI_USER_DATA_DIR'), config);
    assert.ok(!config.includes('OPERA_CLI_HEADED'), config);
  });

  it('uses the profile the caller named', async () => {
    await setupNonInteractive(
      parseSetupArgs(['--executable', '/opt/opera', '--profile', '/tmp/prof']),
      home,
    );

    assert.match(readConfig(), /^OPERA_CLI_USER_DATA_DIR="\/tmp\/prof"$/m);
  });

  it('records the detection result, and says so when there is none', async () => {
    // Whether this machine has Opera installed is not the test's business; that
    // the note and the config agree with detection is.
    const detected = detectBrowsers(process.platform, home)[0];

    const output = await setupNonInteractive(
      parseSetupArgs(['--non-interactive']),
      home,
    );

    if (detected) {
      assert.ok(
        output.includes(`OPERA_CLI_EXECUTABLE_PATH: ${detected.path}`),
        `detected ${detected.path} but the output does not record it:\n${output}`,
      );
      assert.ok(!output.includes('No Opera installation found'), output);
    } else {
      assert.ok(
        output.includes('No Opera installation found'),
        `expected a detection note, got:\n${output}`,
      );
      assert.ok(!readConfig().includes('OPERA_CLI_EXECUTABLE_PATH'));
    }
  });

  it('installs SKILL.md for both agent directories', async () => {
    await setupNonInteractive(
      parseSetupArgs(['--non-interactive', '--executable', '/opt/opera']),
      home,
    );

    for (const dir of [
      join(home, '.claude', 'skills', 'opera-browser-cli'),
      join(home, '.agents', 'skills', 'opera-browser-cli'),
    ]) {
      const installed = join(dir, 'SKILL.md');
      assert.ok(existsSync(installed), `${installed} was not installed`);
      assert.strictEqual(
        readFileSync(installed, 'utf-8'),
        readFileSync(SHIPPED_SKILL, 'utf-8'),
      );
    }
  });
});

describe('handleSetup', () => {
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'opera-setup-handle-'));
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    sinon.restore();
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    rmSync(home, {recursive: true, force: true});
  });

  function readConfig(): Record<string, string> {
    return readConfigFile(getConfigFile(home));
  }

  function neonPath(): string {
    return join(
      home,
      'Applications',
      'Opera Neon.app',
      'Contents',
      'MacOS',
      'Opera',
    );
  }

  function createCandidate(path: string): string {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, '');
    return path;
  }

  interface WizardStep {
    when: RegExp;
    answer: string;
    fired?: boolean;
  }

  /**
   * Drive the interactive wizard with a fake TTY: a PassThrough with
   * `isTTY = true` stands in for stdin, and stdout is captured so each prompt
   * can be matched and answered in order as it is written.
   *
   * The wizard is pinned to macOS. Every scenario below installs its candidates
   * under the temp `home` at the paths macOS uses, and takes the profile list it
   * seeds from `~/Library/Application Support`. Detection only resolves those
   * paths on darwin — on Linux both candidate lists are empty, so the wizard
   * would prompt for something else and never answer — and the wizard takes the
   * platform as a seam for exactly this reason.
   */
  async function runWizard(
    steps: WizardStep[],
  ): Promise<{output: string; stdout: string}> {
    const input = new PassThrough();
    (input as PassThrough & {isTTY: boolean}).isTTY = true;
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', {
      value: input,
      configurable: true,
    });

    let stdout = '';
    // The step objects are shared across tests; clear their fired flags so a
    // previous run cannot leave them pre-consumed and deadlock this one.
    for (const step of steps) {
      step.fired = false;
    }
    const writeStub = sinon.stub(process.stdout, 'write').callsFake(chunk => {
      const text = String(chunk);
      stdout += text;
      for (const step of steps) {
        if (!step.fired && step.when.test(stdout)) {
          step.fired = true;
          input.write(step.answer + '\n');
        }
      }
      return true;
    });

    try {
      const output = await handleSetup([], home, 'darwin');
      return {output, stdout};
    } finally {
      writeStub.restore();
      input.end();
      if (stdinDescriptor) {
        Object.defineProperty(process, 'stdin', stdinDescriptor);
      }
    }
  }

  // The interactive default: accepting the headed prompt sets headed mode.
  const headedDefault: WizardStep = {
    when: /Run in headed \(visible\) mode\? \[Y\/n\]:/,
    answer: '',
  };
  const profileDefault: WizardStep = {
    when: /Persistent profile directory/,
    answer: '',
  };

  it('falls back to the non-interactive path when stdin is not a TTY', async () => {
    // The runner's stdin has no TTY, and no flags are given, so handleSetup
    // must neither hang on a prompt nor diverge from setupNonInteractive.
    // Both are pinned to the same platform so the comparison is about the
    // fallback, not about what this host happens to have installed.
    const viaHandle = await handleSetup([], home, 'darwin');
    const viaNonInteractive = await setupNonInteractive(
      parseSetupArgs([]),
      home,
      'darwin',
    );

    assert.strictEqual(viaHandle, viaNonInteractive);
  });

  it('renders the Neon list with a (current) marker and selects by index', async () => {
    const dev = createCandidate(
      join(
        home,
        'Applications',
        'Opera Neon Developer.app',
        'Contents',
        'MacOS',
        'Opera',
      ),
    );
    const app = createCandidate(neonPath());
    // The current config points at the first candidate, so [1] is marked.
    writeConfigFile({OPERA_CLI_EXECUTABLE_PATH: dev}, home);

    const {stdout} = await runWizard([
      {
        when: /Select \[1-2\], enter a custom path, or "clear" to unset \[1\]:/,
        answer: '2',
      },
      headedDefault,
      profileDefault,
    ]);

    assert.ok(stdout.includes('Opera Neon installations found'), stdout);
    assert.match(stdout, / {2}\[1\] Opera Neon Developer \(current\)/, stdout);
    assert.match(stdout, / {2}\[2\] Opera Neon\n/, stdout);
    assert.strictEqual(readConfig()['OPERA_CLI_EXECUTABLE_PATH'], app);
    assert.strictEqual(readConfig()['OPERA_CLI_HEADED'], '1');
  });

  it('accepts a custom executable path', async () => {
    createCandidate(neonPath());

    const {stdout} = await runWizard([
      {
        when: /Select \[1-1\], enter a custom path, or "clear" to unset \[1\]:/,
        answer: '/custom/opera',
      },
      headedDefault,
      profileDefault,
    ]);

    assert.ok(stdout.includes('Opera Neon installations found'), stdout);
    assert.strictEqual(
      readConfig()['OPERA_CLI_EXECUTABLE_PATH'],
      '/custom/opera',
    );
  });

  it('keeps a configured executable when nothing is newly detected', async () => {
    // The "configured but not detected" branch: an existing executable, but no
    // Neon candidate on the machine to list.
    const existing = '/configured/opera';
    writeConfigFile({OPERA_CLI_EXECUTABLE_PATH: existing}, home);

    const {stdout} = await runWizard([
      {
        when: /Enter a new path, "clear" to remove, or press Enter to keep:/,
        answer: '',
      },
      headedDefault,
      profileDefault,
    ]);

    assert.ok(stdout.includes(`Browser binary: ${existing}`), stdout);
    assert.strictEqual(readConfig()['OPERA_CLI_EXECUTABLE_PATH'], existing);
  });

  it('unsets the executable with "clear"', async () => {
    createCandidate(neonPath());
    writeConfigFile({OPERA_CLI_EXECUTABLE_PATH: neonPath()}, home);

    await runWizard([
      {
        when: /Select \[1-1\], enter a custom path, or "clear" to unset \[1\]:/,
        answer: 'clear',
      },
      headedDefault,
      profileDefault,
    ]);

    assert.ok(!Object.hasOwn(readConfig(), 'OPERA_CLI_EXECUTABLE_PATH'));
  });

  it('removes headed mode when the headed prompt is answered n', async () => {
    const app = createCandidate(neonPath());

    await runWizard([
      {
        when: /Select \[1-1\], enter a custom path, or "clear" to unset \[1\]:/,
        answer: '',
      },
      {
        when: /Run in headed \(visible\) mode\? \[Y\/n\]:/,
        answer: 'n',
      },
      profileDefault,
    ]);

    assert.strictEqual(readConfig()['OPERA_CLI_EXECUTABLE_PATH'], app);
    assert.ok(!Object.hasOwn(readConfig(), 'OPERA_CLI_HEADED'));
  });

  it('omits the profile when the profile prompt is answered "skip"', async () => {
    createCandidate(neonPath());

    await runWizard([
      {
        when: /Select \[1-1\], enter a custom path, or "clear" to unset \[1\]:/,
        answer: '',
      },
      headedDefault,
      {
        when: /Persistent profile directory/,
        answer: 'skip',
      },
    ]);

    assert.ok(!Object.hasOwn(readConfig(), 'OPERA_CLI_USER_DATA_DIR'));
  });

  it('records a custom persistent profile path', async () => {
    createCandidate(neonPath());

    await runWizard([
      {
        when: /Select \[1-1\], enter a custom path, or "clear" to unset \[1\]:/,
        answer: '',
      },
      headedDefault,
      {
        when: /Persistent profile directory/,
        answer: '/tmp/custom-profile',
      },
    ]);

    assert.strictEqual(
      readConfig()['OPERA_CLI_USER_DATA_DIR'],
      '/tmp/custom-profile',
    );
  });

  // Seed the "configured profile + a different detected profile" precondition
  // so handleSetup takes its two-option list branch.
  function seedProfileListScenario(): string {
    const app = createCandidate(neonPath());
    const detected = join(
      home,
      'Library',
      'Application Support',
      'com.operasoftware.OperaNeon',
    );
    mkdirSync(detected, {recursive: true});
    writeConfigFile(
      {
        OPERA_CLI_EXECUTABLE_PATH: app,
        OPERA_CLI_USER_DATA_DIR: '/custom/configured-profile',
      },
      home,
    );
    return detected;
  }

  it('renders the profile list and keeps the configured profile on 1', async () => {
    seedProfileListScenario();

    const {stdout} = await runWizard([
      {
        when: /Select \[1-1\], enter a custom path, or "clear" to unset \[1\]:/,
        answer: '',
      },
      headedDefault,
      {
        when: /Select \[1\/2\], enter a custom path, or "skip" to omit \[1\]:/,
        answer: '1',
      },
    ]);

    assert.ok(stdout.includes('Persistent profile directory:'), stdout);
    assert.match(
      stdout,
      / {2}\[1\] \/custom\/configured-profile {2}\(current\)/,
      stdout,
    );
    assert.match(stdout, / {2}\[2\] .* {2}\(detected\)/, stdout);
    assert.strictEqual(
      readConfig()['OPERA_CLI_USER_DATA_DIR'],
      '/custom/configured-profile',
    );
  });

  it('selects the detected profile on 2', async () => {
    const detected = seedProfileListScenario();

    await runWizard([
      {
        when: /Select \[1-1\], enter a custom path, or "clear" to unset \[1\]:/,
        answer: '',
      },
      headedDefault,
      {
        when: /Select \[1\/2\], enter a custom path, or "skip" to omit \[1\]:/,
        answer: '2',
      },
    ]);

    assert.strictEqual(readConfig()['OPERA_CLI_USER_DATA_DIR'], detected);
  });

  it('stores a custom path entered at the profile list', async () => {
    seedProfileListScenario();

    await runWizard([
      {
        when: /Select \[1-1\], enter a custom path, or "clear" to unset \[1\]:/,
        answer: '',
      },
      headedDefault,
      {
        when: /Select \[1\/2\], enter a custom path, or "skip" to omit \[1\]:/,
        answer: '/tmp/list-custom',
      },
    ]);

    assert.strictEqual(
      readConfig()['OPERA_CLI_USER_DATA_DIR'],
      '/tmp/list-custom',
    );
  });

  it('offers the detected plain Opera as a fallback when Neon is missing', async () => {
    // Guarantee at least one plain Opera candidate under the temp HOME; the
    // wizard resolves detection itself on the macOS it is pinned to, so mirror
    // that lookup.
    createCandidate(
      join(home, 'Applications', 'Opera.app', 'Contents', 'MacOS', 'Opera'),
    );
    const detectedOpera = operaCandidatePaths('darwin', home).find(p =>
      existsSync(p),
    );
    assert.ok(detectedOpera, 'a plain Opera candidate must be detectable');

    const {stdout} = await runWizard([
      {
        when: /Use .* as the browser\? .*\[Y\/n\]:/,
        answer: 'y',
      },
      headedDefault,
      profileDefault,
    ]);

    assert.ok(stdout.includes('Opera Neon not found'), stdout);
    assert.ok(stdout.includes('Found Opera at:'), stdout);
    assert.ok(stdout.includes('as the browser?'), stdout);
    assert.strictEqual(
      readConfig()['OPERA_CLI_EXECUTABLE_PATH'],
      detectedOpera,
    );
  });
});
