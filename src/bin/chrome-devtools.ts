#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Opera Software AS.
 */

import process from 'node:process';

import {startDaemon, stopDaemon, sendCommand} from '../daemon/client.js';
import type {DaemonStatusResult} from '../daemon/types.js';
import {
  isDaemonRunning,
  serializeArgs,
  assertValidSessionId,
} from '../daemon/utils.js';
import {logDisclaimers} from '../index.js';
import {CLI_BIN_NAME, MCP_BIN_NAME, PACKAGE_NAME} from '../opera/branding.js';
import {describeBrowserMode} from '../opera/browserFlags.js';
import {EXIT_CODES} from '../opera/cdpErrors.js';
import {
  registerOperaCommands,
  registerToolCommand,
} from '../opera/cliCommands.js';
import {hideBin, yargs} from '../third_party/index.js';
import {checkForUpdates} from '../utils/check-for-updates.js';
import {VERSION} from '../version.js';

import {commands} from '../config/cli-options.js';
import {
  mcpOptions,
  parseArguments,
  getMcpOptionsForViaCli,
} from '../config/mcp-options.js';

process.title = CLI_BIN_NAME;

await checkForUpdates(
  `Run \`npm install -g ${PACKAGE_NAME}@latest\` and \`${CLI_BIN_NAME} start\` to update and restart the daemon.`,
);

const DEFAULT_CLI_ARGS = ['--viaCli'];

async function start(args: string[], sessionId: string) {
  const combinedArgs = [...DEFAULT_CLI_ARGS, ...args];
  await startDaemon(combinedArgs, sessionId);
  logDisclaimers(parseArguments(VERSION, combinedArgs));
}

function getCliOptions() {
  const options: Partial<typeof mcpOptions> = {
    ...getMcpOptionsForViaCli(),
  };

  // Missing CLI serialization.
  delete options.viewport;

  // Change the defaults for the CLI.
  delete options.experimentalStructuredContent;
  delete options.experimentalInteropTools;

  return options;
}

const y = yargs(hideBin(process.argv))
  .locale('en') // Force English to ensure error string matching works in .fail, all custom messages we output are in English anyways
  .scriptName(CLI_BIN_NAME)
  .showHelpOnFail(true)
  .usage(`${CLI_BIN_NAME} <command> [...args] --flags`)
  .usage(
    `Run '${CLI_BIN_NAME} <command> --help' for help on the specific command.`,
  )
  .option('sessionId', {
    type: 'string',
    description: 'Session ID for daemon scoping',
    default: '',
    hidden: true,
    coerce: (sessionId: string) => {
      assertValidSessionId(sessionId);
      return sessionId;
    },
  })
  .demandCommand()
  .version(VERSION)
  .strict()
  .help(true)
  .wrap(120)
  .fail((msg, err) => {
    if (msg) {
      console.error('Error:', msg);
      if (
        msg.includes('Not enough non-option arguments') ||
        msg.includes('Unknown argument') ||
        msg.includes('Unknown arguments')
      ) {
        console.error('\n=========================================');
        console.error('💡 TIP FOR AI AGENT / DEVELOPER:');
        console.error(`In the \`${CLI_BIN_NAME}\` CLI:`);
        console.error(
          '1. Required parameters MUST be passed as positional arguments (without flags).',
        );
        console.error(
          `   - INCORRECT: ${CLI_BIN_NAME} click --pageId 1 --uid "1_2"`,
        );
        console.error(`   - CORRECT:   ${CLI_BIN_NAME} click 1 "1_2"`);
        console.error(
          '2. Optional parameters are passed as double-dash options/flags (e.g. --dblClick true).',
        );
        console.error(
          '3. Make sure to escape quotes properly for your shell environment.',
        );
        console.error(
          `Run \`${CLI_BIN_NAME} <command> --help\` to see exact positional and optional parameters.`,
        );
        console.error('=========================================');
      }
    } else if (err) {
      console.error(err);
    }
    // A parse failure is exactly what exit code 2 means — "fix the command" — so
    // it is reported as one rather than as an unknown failure.
    process.exit(msg ? EXIT_CODES.VALIDATION_ERROR : EXIT_CODES.UNKNOWN);
  });

y.command(
  'start',
  `Start or restart ${MCP_BIN_NAME}`,
  y =>
    y
      .options(getCliOptions())
      .example(
        '$0 start --browserUrl http://localhost:9222',
        'Start the server connecting to an existing browser',
      )
      .strict(),
  async argv => {
    if (isDaemonRunning(argv.sessionId)) {
      await stopDaemon(argv.sessionId);
    }
    // Defaults but we do not want to affect the yargs conflict resolution.
    if (
      argv.isolated === undefined &&
      argv.userDataDir === undefined &&
      !argv.autoConnect &&
      !argv.browserUrl &&
      !argv.wsEndpoint
    ) {
      argv.isolated = true;
    }
    if (
      argv.headless === undefined &&
      !argv.autoConnect &&
      !argv.browserUrl &&
      !argv.wsEndpoint
    ) {
      argv.headless = true;
    }
    const args = serializeArgs(mcpOptions, argv);
    await start(args, argv.sessionId);
    process.exit(0);
  },
).strict(); // Re-enable strict validation for other commands; this is applied to the yargs instance itself

y.command(
  'status',
  `Checks if ${MCP_BIN_NAME} is running`,
  y => y,
  async argv => {
    if (isDaemonRunning(argv.sessionId)) {
      console.log(`${MCP_BIN_NAME} daemon is running.`);
      const response = await sendCommand(
        {
          method: 'status',
        },
        argv.sessionId,
      );
      if (response.success) {
        const data: DaemonStatusResult = JSON.parse(response.result);
        console.log(
          `pid=${data.pid} socket=${data.socketPath} start-date=${data.startDate} version=${data.version}`,
        );
        // Who owns the browser decides what recovery to expect from it: we
        // relaunch what we launched, and never touch a browser we attached to.
        console.log(`browser=${describeBrowserMode(data.args)}`);
        console.log(`args=${JSON.stringify(data.args)}`);
        if (data.version !== VERSION) {
          console.warn(
            `Warning: Daemon server version (${data.version}) does not match CLI version (${VERSION}). Run '${CLI_BIN_NAME} start' to update and restart the daemon.`,
          );
        }
      } else {
        console.error('Error:', response.error);
        process.exit(1);
      }
    } else {
      console.log(`${MCP_BIN_NAME} daemon is not running.`);
    }
    process.exit(0);
  },
);

y.command(
  'stop',
  `Stop ${MCP_BIN_NAME} if any`,
  y => y,
  async argv => {
    const sessionId = argv.sessionId as string;
    if (!isDaemonRunning(sessionId)) {
      process.exit(0);
    }
    await stopDaemon(sessionId);
    process.exit(0);
  },
);

// The fork's own commands (`setup`, `doctor`, `logs`, `url`) and the wrapper
// that turns a generated tool definition into a runnable command live in
// `src/opera/cliCommands.ts`, along with the exit-code and streaming plumbing
// of a tool call. `start` stays here: it is upstream's, and prepends `--viaCli`.
registerOperaCommands(y, {start});

for (const [commandName, commandDef] of Object.entries(commands)) {
  registerToolCommand(y, commandName, commandDef, {start});
}

await y.parse();
