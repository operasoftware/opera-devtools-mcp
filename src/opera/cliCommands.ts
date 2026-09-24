/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * The fork's half of the CLI's command surface.
 *
 * `src/bin/chrome-devtools.ts` is upstream-owned, and the four commands this
 * fork adds to it — `setup`, `doctor`, `logs`, `url` — plus the wrapper that
 * turns one generated tool definition into a runnable yargs command used to be
 * written inline there. Registering them from here instead leaves upstream's
 * file with one call per group, so upstream churn in that area conflicts on a
 * line rather than on a hundred and fifty of them. See `docs/UPSTREAM.md`,
 * design rule 2.
 *
 * Everything moved here is what the fork owns: the flags the extra commands
 * take, the re-expansion of parsed argv into the ported `parse*Args` parsers,
 * and the exit-code / streaming plumbing around a tool call — which is where
 * that plumbing belongs, next to `cdpErrors.ts` and `cliOutput.ts`. `start` is
 * not ours (it prepends `--viaCli` and prints the disclaimers), so it is
 * injected rather than reimplemented.
 */

import process from 'node:process';

import type {Argv, Options, PositionalOptions} from 'yargs';

import type {Commands} from '../config/cli-options.js';
import {mcpOptions} from '../config/mcp-options.js';
import {
  handleResponse,
  sendCommand,
  verifyDaemonVersion,
} from '../daemon/client.js';
import {isDaemonRunning, serializeArgs} from '../daemon/utils.js';
import type {CallToolResult} from '../third_party/index.js';
import {VERSION} from '../version.js';

import {CLI_BIN_NAME, MCP_BIN_NAME} from './branding.js';
import {
  CdpError,
  EXIT_CODES,
  describeToolFailure,
  wrapAiToolError,
} from './cdpErrors.js';
import {
  formatError,
  formatToolResult,
  parseSnapshotFromResponse,
  renderError,
} from './cliOutput.js';
import {handleDoctor} from './doctor.js';
import {handleLogs} from './logs.js';
import {withoutRoutingPageId} from './pageIdRouting.js';
import {normalizeRefArgs} from './refArgs.js';
import {handleSetup} from './setup.js';
import {isOperaAiTool, operaAiTimeoutMs} from './streamingTools.js';
import {handleUrl} from './urlResolver.js';

/** What the registrations cannot import, because upstream's file owns it. */
export interface CliCommandDeps {
  /** Upstream's `start`: brings the daemon up with the given tool argv. */
  start(args: string[], sessionId: string): Promise<void>;
}

/**
 * Register the commands the fork adds over upstream's `start`/`status`/`stop`
 * and the generated tool table.
 *
 * The flags are declared here so `--help` documents them and `strict` accepts
 * them; the ported `parse*Args` functions then read the re-expanded argv, which
 * keeps one parser per command instead of two.
 */
export function registerOperaCommands(y: Argv, deps: CliCommandDeps): void {
  y.command(
    'setup',
    `Configure the browser ${CLI_BIN_NAME} drives (interactive unless a flag is passed)`,
    y =>
      y
        .option('non-interactive', {
          type: 'boolean',
          description: 'Configure from detection and flags, without prompting',
        })
        .option('yes', {
          type: 'boolean',
          alias: 'y',
          description: 'Same as --non-interactive',
        })
        .option('executable', {
          type: 'string',
          description: 'Path to the Opera binary to drive',
        })
        .option('profile', {
          type: 'string',
          description:
            'Persistent profile directory, or "skip" to use an isolated one',
        })
        .option('headed', {type: 'boolean', description: 'Run in headed mode'})
        .option('headless', {
          type: 'boolean',
          description: 'Run in headless mode',
        })
        .strict(),
    async argv => {
      console.log(
        await handleSetup(
          reExpandArgs(argv as Record<string, unknown>, {
            'non-interactive': 'boolean',
            yes: 'boolean',
            executable: 'string',
            profile: 'string',
            headed: 'boolean',
            headless: 'boolean',
          }),
        ),
      );
    },
  );

  y.command(
    'doctor',
    'Inspect the configuration, browser, daemon, and log',
    y =>
      y
        .option('fix', {
          type: 'boolean',
          description: 'Repair what can be repaired without asking',
        })
        .strict(),
    async argv => {
      console.log(
        await handleDoctor(argv.fix ? ['--fix'] : [], argv.sessionId as string),
      );
    },
  );

  y.command(
    'logs',
    `Show the ${MCP_BIN_NAME} daemon log`,
    y =>
      y
        .option('lines', {
          type: 'number',
          alias: 'n',
          description: 'Number of lines to show (default 50)',
        })
        .option('follow', {
          type: 'boolean',
          alias: 'f',
          description: 'Stream new output until interrupted',
        })
        .option('errors', {
          type: 'boolean',
          description: 'Show only lines that look like failures',
        })
        .strict(),
    async argv => {
      const output = await handleLogs(
        reExpandArgs(argv as Record<string, unknown>, {
          lines: 'number',
          follow: 'boolean',
          errors: 'boolean',
        }),
        argv.sessionId as string,
      );
      // `--follow` prints as it goes and returns nothing.
      if (output) {
        console.log(output);
      }
    },
  );

  y.command(
    'url <target>',
    'Resolve a $uN URL token or an @ref element to its full URL',
    y =>
      y.positional('target', {
        type: 'string',
        describe: 'A $uN token from the urls: trailer, or an @ref like @2.4',
      }),
    async argv => {
      const sessionId = argv.sessionId as string;
      const {output, exitCode} = await handleUrl(
        [argv.target as string],
        () =>
          fetchSnapshotSection(
            sessionId,
            argv as Record<string, unknown>,
            deps,
          ),
        sessionId,
      );
      if (exitCode === 0) {
        console.log(output);
      } else {
        console.error(output);
        process.exitCode = exitCode;
      }
    },
  );
}

/**
 * Register one generated tool as a yargs command.
 *
 * The argument surface comes from the generated `commands` table; the handler
 * brings the daemon up if it is not running, sends the call, and maps the
 * result (or the failure) onto the fork's exit-code contract.
 */
export function registerToolCommand(
  y: Argv,
  commandName: string,
  commandDef: Commands[string],
  deps: CliCommandDeps,
): void {
  // The CLI never routes by pageId: drop the routing positional that
  // chrome-devtools-mcp injects onto page-scoped commands
  // (src/opera/pageIdRouting.ts).
  const args = withoutRoutingPageId(commandDef.args);
  const requiredArgNames = Object.keys(args).filter(
    name => args[name].required,
  );

  const optionalArgNames = Object.keys(args).filter(
    name => !args[name].required,
  );

  let commandStr = commandName;
  for (const arg of requiredArgNames) {
    commandStr += ` <${arg}>`;
  }

  for (const arg of optionalArgNames) {
    commandStr += ` [--${arg}]`;
  }

  y.command(
    commandStr,
    commandDef.description,
    y => {
      y.option('output-format', {
        choices: ['md', 'json', 'toon'],
        default: 'md',
      });
      // The two snapshot flags opera-browser-cli documents on every
      // snapshot-returning command. `--raw` is the whole escape hatch: it
      // disables compaction and the URL lookup table together.
      y.option('full', {
        type: 'boolean',
        description: 'Show the complete snapshot, without truncation',
        default: false,
      });
      y.option('raw', {
        type: 'boolean',
        description:
          'Show the unprocessed MCP output (disables compact format and URL lookup table)',
        default: false,
      });
      for (const [argName, opt] of Object.entries(args)) {
        const type =
          opt.type === 'integer' || opt.type === 'number'
            ? 'number'
            : opt.type === 'boolean'
              ? 'boolean'
              : opt.type === 'array'
                ? 'array'
                : 'string';

        if (opt.required) {
          const options: PositionalOptions = {
            describe: opt.description,
            type: type as PositionalOptions['type'],
          };
          if (opt.default !== undefined) {
            options.default = opt.default;
          }
          if (opt.enum) {
            options.choices = opt.enum as Array<string | number>;
          }
          y.positional(argName, options);
        } else {
          const options: Options = {
            describe: opt.description,
            type: type as Options['type'],
          };
          if (opt.default !== undefined) {
            options.default = opt.default;
          }
          if (opt.enum) {
            options.choices = opt.enum as Array<string | number>;
          }
          y.option(argName, options);
        }
      }
    },
    async argv => {
      const sessionId = argv.sessionId as string;
      // Streaming is per-tool, not per-request: only the Opera AI tools produce
      // partial output, and only they get the long timeout — the same timeout
      // the daemon applies around the same call (`operaAiTimeoutMs`).
      const streaming = isOperaAiTool(commandName);
      try {
        const versionWarningPromise = isDaemonRunning(sessionId)
          ? verifyDaemonVersion(sessionId, VERSION)
          : Promise.resolve(undefined);

        if (!isDaemonRunning(sessionId)) {
          await deps.start(serializeArgs(mcpOptions, argv), sessionId);
        }

        const rawArgs: Record<string, unknown> = {};
        for (const argName of Object.keys(args)) {
          if (argName in argv) {
            rawArgs[argName] = argv[argName];
          }
        }
        // The snapshot prints refs as `@4.11`; the MCP tools take `4_11`
        // (src/opera/refArgs.ts).
        const commandArgs = normalizeRefArgs(args, rawArgs);

        const response = await sendCommand(
          {
            method: 'invoke_tool',
            tool: commandName,
            args: commandArgs,
          },
          sessionId,
          operaAiTimeoutMs(commandName),
          streaming
            ? (chunk: string) => process.stderr.write(chunk + '\n')
            : undefined,
        );

        if (response.success) {
          const result = JSON.parse(
            response.result,
          ) as unknown as CallToolResult;
          const format = argv['output-format'] as 'md' | 'json' | 'toon';
          if (result.isError === true && format !== 'json') {
            // A tool error is a failure like any other: the same `error`/`code`
            // document, the same suggestions, and the same stderr the daemon's
            // own failures get — not the raw MCP text on stdout with an exit
            // code and nothing structured to branch on. `json` stays the raw
            // passthrough, because the MCP result *is* the machine-readable
            // form of the failure.
            const failure = describeToolFailure(
              commandName,
              await handleResponse(result, 'md'),
            );
            console.error(
              await renderError(
                failure.message,
                failure.code,
                failure.suggestions,
              ),
            );
            process.exitCode = EXIT_CODES[failure.code];
          } else {
            const output = await formatToolResult(
              result,
              format,
              {
                command: commandName,
                sessionId,
                url:
                  typeof commandArgs.url === 'string'
                    ? commandArgs.url
                    : undefined,
                full: argv.full === true,
                raw: argv.raw === true,
              },
              handleResponse,
            );
            console.log(output);
            if (result.isError === true) {
              process.exitCode =
                EXIT_CODES[describeToolFailure(commandName, output).code];
            }
          }
        } else {
          const failure = describeToolFailure(
            commandName,
            String(response.error),
          );
          console.error(
            await renderError(
              failure.message,
              failure.code,
              failure.suggestions,
            ),
          );
          process.exitCode = EXIT_CODES[failure.code];
        }

        const versionWarning = await versionWarningPromise;
        if (versionWarning) {
          console.warn(versionWarning);
        }
      } catch (error) {
        const {output, exitCode} = await formatError(
          wrapAiToolError(commandName, error),
        );
        console.error(output);
        process.exitCode = exitCode;
      }
    },
  );
}

/**
 * The `--flag value` argv the ported command parsers read. yargs consumes
 * flags, so a command whose parser is the source's own has to see them again.
 */
function reExpandArgs(
  argv: Record<string, unknown>,
  spec: Record<string, 'boolean' | 'number' | 'string'>,
  positionals: string[] = [],
): string[] {
  const args: string[] = [];
  for (const name of positionals) {
    const value = argv[name];
    if (value !== undefined) {
      args.push(String(value));
    }
  }
  for (const [name, type] of Object.entries(spec)) {
    const value = argv[name];
    if (value === undefined || value === false) {
      continue;
    }
    if (type === 'boolean') {
      args.push(`--${name}`);
    } else {
      args.push(`--${name}`, String(value));
    }
  }
  return args;
}

/**
 * A fresh `take_snapshot` section, for a command that needs the tree but was
 * not itself a snapshot command. Injected into `handleUrl` so the resolver does
 * not have to know how to bring a daemon up.
 */
async function fetchSnapshotSection(
  sessionId: string,
  argv: Record<string, unknown>,
  deps: CliCommandDeps,
): Promise<string> {
  if (!isDaemonRunning(sessionId)) {
    await deps.start(serializeArgs(mcpOptions, argv), sessionId);
  }
  const response = await sendCommand(
    {method: 'invoke_tool', tool: 'take_snapshot', args: {}},
    sessionId,
  );
  if (!response.success) {
    throw new CdpError(String(response.error), 'BROWSER_ERROR');
  }
  const result = JSON.parse(response.result) as unknown as CallToolResult;
  const section = parseSnapshotFromResponse(await handleResponse(result, 'md'));
  if (section === null) {
    throw new CdpError(
      'No page snapshot available — launch a page first',
      'BROWSER_ERROR',
      [`Run \`${CLI_BIN_NAME} new_page https://example.com\` first`],
    );
  }
  return section;
}
