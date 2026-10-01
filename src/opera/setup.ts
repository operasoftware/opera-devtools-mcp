/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * `setup` — interactive and non-interactive configuration.
 *
 * Ported from opera-browser-cli's `src/cli.ts`. The three settings it writes
 * are the three the fork reads (`OPERA_CLI_EXECUTABLE_PATH`, `OPERA_CLI_HEADED`,
 * `OPERA_CLI_USER_DATA_DIR`); hooks are not ported, so nothing here installs
 * them.
 *
 * Two shape changes from the source:
 *
 * - The skill files are installed to `~/.claude/skills/opera-browser-cli/` and
 *   `~/.agents/skills/opera-browser-cli/`, from the `SKILL.md` kept at
 *   `src/opera/skills/` (copied to `build/src/opera/skills/` by
 *   `scripts/post-build.ts`, so it publishes with the rest of `build/src`).
 * - A non-TTY falls back to the non-interactive path rather than refusing: the
 *   callers that most need `setup` are agents, provisioning scripts and
 *   containers, and none of them have a terminal.
 */

import {copyFileSync, existsSync, mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';

import {CLI_BIN_NAME} from './branding.js';
import {encode, renderHelp, renderOutput} from './cliOutput.js';
import {writeConfigFile} from './config.js';
import {
  browserDisplayName,
  detectBrowsers,
  neonCandidatePaths,
  operaCandidatePaths,
} from './detect.js';
import {getConfigFile, getStateDir, readConfigFile} from './envConfig.js';
import {defaultProfileDir} from './profile.js';

export interface SetupArgs {
  interactive: boolean;
  executable: string | undefined;
  profile: string | undefined;
  headed: boolean | undefined;
}

/** `--executable`, `--profile`, `--headed`/`--headless` each imply non-interactive. */
export function parseSetupArgs(args: string[]): SetupArgs {
  let interactive = true;
  let executable: string | undefined;
  let profile: string | undefined;
  let headed: boolean | undefined;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--non-interactive':
      case '--yes':
      case '-y':
        interactive = false;
        break;
      case '--executable':
        if (i + 1 < args.length) {
          executable = args[++i];
          interactive = false;
        }
        break;
      case '--profile':
        if (i + 1 < args.length) {
          profile = args[++i];
          interactive = false;
        }
        break;
      case '--headed':
        headed = true;
        interactive = false;
        break;
      case '--headless':
        headed = false;
        interactive = false;
        break;
    }
  }
  return {interactive, executable, profile, headed};
}

/**
 * Where `SKILL.md` lives: the `skills/` directory beside this module.
 *
 * The layout is the same in the source tree (`src/opera/skills/`) and in the
 * build output (`build/src/opera/skills/`, written by `scripts/post-build.ts`),
 * so one candidate covers both.
 */
function findSkillSource(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = join(here, 'skills', 'SKILL.md');
  return existsSync(candidate) ? candidate : null;
}

/** Install SKILL.md for Claude Code and the generic cross-agent path. */
export function installSkillFiles(
  report: (line: string) => void,
  home: string = homedir(),
): void {
  const skillSrc = findSkillSource();
  if (skillSrc === null) {
    report('SKILL.md not found in src/opera/skills — skipping skill install');
    return;
  }
  for (const {agent, dir} of [
    {agent: 'Claude', dir: join(home, '.claude', 'skills')},
    {agent: 'generic', dir: join(home, '.agents', 'skills')},
  ]) {
    // The skill directory name is the skill's own identity (see the
    // `name:` frontmatter in SKILL.md), not the binary name.
    const skillDst = join(dir, 'opera-browser-cli', 'SKILL.md');
    mkdirSync(dirname(skillDst), {recursive: true});
    copyFileSync(skillSrc, skillDst);
    report(`Installed ${agent} skill -> ${skillDst}`);
  }
}

/**
 * Configure without prompting: detection plus whatever the flags override.
 *
 * `home` and `platform` are test seams; production callers use the defaults.
 * Detection, the executable it finds and the profile that follows from it must
 * all agree on one platform, so the seam is threaded rather than read again.
 */
export async function setupNonInteractive(
  parsed: SetupArgs,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const config = readConfigFile(getConfigFile(home));

  const executable =
    parsed.executable ??
    config.OPERA_CLI_EXECUTABLE_PATH ??
    detectBrowsers(platform, home)[0]?.path;
  if (executable) {
    config.OPERA_CLI_EXECUTABLE_PATH = executable;
  }

  const headed =
    parsed.headed ?? (config.OPERA_CLI_HEADED === '1' || Boolean(executable));
  if (headed) {
    config.OPERA_CLI_HEADED = '1';
  } else {
    delete config.OPERA_CLI_HEADED;
  }

  if (parsed.profile === 'skip') {
    delete config.OPERA_CLI_USER_DATA_DIR;
  } else {
    const profile =
      parsed.profile ??
      config.OPERA_CLI_USER_DATA_DIR ??
      defaultProfileDir(executable, home, platform) ??
      join(getStateDir(home), 'profile');
    config.OPERA_CLI_USER_DATA_DIR = profile;
  }

  writeConfigFile(config, home);
  const notes: string[] = [];
  installSkillFiles(line => notes.push(line), home);

  const help = [
    `Run \`${CLI_BIN_NAME} new_page https://example.com\` to start browsing`,
  ];
  if (!executable) {
    help.unshift(
      'No Opera installation found — set OPERA_CLI_EXECUTABLE_PATH or pass --executable <path>',
    );
  }
  return renderOutput([
    await encode({config: getConfigFile(home), settings: config}),
    notes.join('\n'),
    renderHelp(help),
  ]);
}

/**
 * The interactive wizard. `home` and `platform` are test seams: the prompts are
 * per-platform (which installs exist, and where each build keeps its profile),
 * so callers that simulate a machine pin both rather than reading the host.
 */
export async function handleSetup(
  args: string[],
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const parsed = parseSetupArgs(args);
  // No terminal to prompt in is a reason to fall back, not to fail.
  if (!parsed.interactive || !process.stdin.isTTY) {
    return setupNonInteractive(parsed, home, platform);
  }

  const stateDir = getStateDir(home);
  const configFile = getConfigFile(home);
  const existing = readConfigFile(configFile);

  const rl = createInterface({input: process.stdin, output: process.stdout});
  const ask = (question: string): Promise<string> =>
    new Promise(resolve => rl.question(question, resolve));

  const config: Record<string, string> = {...existing};

  try {
    process.stdout.write(`${CLI_BIN_NAME} setup\n\n`);

    // 1. Browser executable path
    const detectedNeons = neonCandidatePaths(platform, home).filter(path =>
      existsSync(path),
    );
    const detectedOpera = operaCandidatePaths(platform, home).find(path =>
      existsSync(path),
    );
    const currentExec = existing['OPERA_CLI_EXECUTABLE_PATH'];

    if (detectedNeons.length > 0) {
      // Always show the full list so the user can switch between versions.
      // Mark whichever entry matches the current config (if any).
      const currentIdx = detectedNeons.indexOf(currentExec ?? '');
      process.stdout.write('Opera Neon installations found:\n');
      detectedNeons.forEach((path, i) => {
        const marker = i === currentIdx ? ' (current)' : '';
        process.stdout.write(
          `  [${i + 1}] ${browserDisplayName(path)}${marker}\n      ${path}\n`,
        );
      });
      const defaultIdx = currentIdx >= 0 ? currentIdx + 1 : 1;
      const ans = (
        await ask(
          `Select [1-${detectedNeons.length}], enter a custom path, or "clear" to unset [${defaultIdx}]: `,
        )
      ).trim();
      if (ans.toLowerCase() === 'clear') {
        delete config['OPERA_CLI_EXECUTABLE_PATH'];
      } else if (!ans) {
        config['OPERA_CLI_EXECUTABLE_PATH'] = detectedNeons[defaultIdx - 1]!;
      } else {
        const idx = Number.parseInt(ans, 10);
        if (Number.isFinite(idx) && idx >= 1 && idx <= detectedNeons.length) {
          config['OPERA_CLI_EXECUTABLE_PATH'] = detectedNeons[idx - 1]!;
        } else {
          config['OPERA_CLI_EXECUTABLE_PATH'] = ans; // custom path
        }
      }
    } else if (currentExec) {
      // No auto-detected Neons but something is already configured.
      process.stdout.write(`Browser binary: ${currentExec}\n`);
      const ans = (
        await ask(
          'Enter a new path, "clear" to remove, or press Enter to keep: ',
        )
      ).trim();
      if (ans.toLowerCase() === 'clear') {
        delete config['OPERA_CLI_EXECUTABLE_PATH'];
      } else if (ans) {
        config['OPERA_CLI_EXECUTABLE_PATH'] = ans;
      }
    } else {
      // Nothing detected or configured.
      process.stdout.write(
        'Opera Neon not found. Install it from https://www.operaneon.com to enable the full Opera AI tool set.\n',
      );
      if (detectedOpera) {
        const operaName = browserDisplayName(detectedOpera);
        process.stdout.write(`\nFound ${operaName} at:\n  ${detectedOpera}\n`);
        const ans = (
          await ask(
            `Use ${operaName} as the browser? (invoke-do/make/research require Opera Neon) [Y/n]: `,
          )
        )
          .trim()
          .toLowerCase();
        if (ans === '' || ans === 'y') {
          config['OPERA_CLI_EXECUTABLE_PATH'] = detectedOpera;
        }
      }
    }

    // 2. Headed mode (defaults to Y so users see the browser they're driving)
    const headedAns = (await ask('Run in headed (visible) mode? [Y/n]: '))
      .trim()
      .toLowerCase();
    if (headedAns === 'n') {
      delete config['OPERA_CLI_HEADED'];
    } else {
      config['OPERA_CLI_HEADED'] = '1';
    }

    // 3. Persistent profile directory
    const currentProfile = existing['OPERA_CLI_USER_DATA_DIR'] ?? '';
    const detectedProfile = defaultProfileDir(
      config['OPERA_CLI_EXECUTABLE_PATH'],
      home,
      platform,
    );

    let profilePrompt: string;
    let profileDefault: string;
    let profileListShown = false;

    if (
      currentProfile &&
      detectedProfile &&
      currentProfile !== detectedProfile
    ) {
      profileListShown = true;
      process.stdout.write('Persistent profile directory:\n');
      process.stdout.write(`  [1] ${currentProfile}  (current)\n`);
      process.stdout.write(`  [2] ${detectedProfile}  (detected)\n`);
      profilePrompt =
        'Select [1/2], enter a custom path, or "skip" to omit [1]: ';
      profileDefault = currentProfile;
    } else {
      profileDefault =
        currentProfile || detectedProfile || join(stateDir, 'profile');
      profilePrompt = `Persistent profile directory (blank to use default, "skip" to omit):\n  [${profileDefault}]: `;
    }

    const profileAns = (await ask(profilePrompt)).trim();
    if (profileAns.toLowerCase() === 'skip') {
      delete config['OPERA_CLI_USER_DATA_DIR'];
    } else if (profileListShown && profileAns === '2' && detectedProfile) {
      config['OPERA_CLI_USER_DATA_DIR'] = detectedProfile;
    } else if (profileListShown && (profileAns === '1' || !profileAns)) {
      config['OPERA_CLI_USER_DATA_DIR'] = currentProfile;
    } else if (profileAns) {
      config['OPERA_CLI_USER_DATA_DIR'] = profileAns;
    } else {
      config['OPERA_CLI_USER_DATA_DIR'] = profileDefault;
    }
  } finally {
    rl.close();
  }

  writeConfigFile(config, home);
  process.stdout.write(`\nSaved to ${configFile}\n`);
  installSkillFiles(line => process.stdout.write(line + '\n'), home);

  return renderOutput([
    await encode({config: configFile, settings: config}),
    renderHelp([
      `Run \`${CLI_BIN_NAME} --help\` to see all commands`,
      `Run \`${CLI_BIN_NAME} setup\` again to reconfigure`,
      `Run \`${CLI_BIN_NAME} new_page https://example.com\` to start browsing`,
    ]),
  ]);
}
