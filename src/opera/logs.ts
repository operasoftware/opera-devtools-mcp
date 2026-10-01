/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * `logs` — tail the daemon's log, optionally following it or filtering to the
 * lines that matter.
 *
 * Ported from opera-browser-cli's `src/cli.ts`. The file is the daemon's own
 * stdout/stderr (`opera/daemonLog.ts`), so everything the source read from the
 * bridge log is here: no extra state, and one less process to keep alive.
 *
 * Rotation is the daemon's, done on startup, so unlike the source there is no
 * rotation command — `followLog` still handles a shrinking file, because
 * `doctor --fix` can rotate under a running tail.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs';

import {CLI_BIN_NAME} from './branding.js';
import {encode, renderHelp, renderOutput} from './cliOutput.js';
import {getDaemonLogPath} from './daemonLog.js';

const LOGS_DEFAULT_LINES = 50;

export interface LogsArgs {
  lines: number;
  follow: boolean;
  errorsOnly: boolean;
}

export function parseLogsArgs(args: string[]): LogsArgs {
  let lines = LOGS_DEFAULT_LINES;
  let follow = false;
  let errorsOnly = false;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-n' || args[i] === '--lines') && i + 1 < args.length) {
      const parsed = Number.parseInt(args[++i] ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        lines = parsed;
      }
    } else if (args[i] === '-f' || args[i] === '--follow') {
      follow = true;
    } else if (args[i] === '--errors') {
      errorsOnly = true;
    }
  }
  return {lines, follow, errorsOnly};
}

/** The lines worth looking at when something has gone wrong. */
const LOG_ERROR_PATTERN =
  /error|failed|fatal|exception|refused|denied|timeout|timed out|in use|EADDRINUSE|ECONNREFUSED|EACCES|not found|unauthorized|cannot/i;

export function filterLogLines(lines: string[], errorsOnly: boolean): string[] {
  return errorsOnly
    ? lines.filter(line => LOG_ERROR_PATTERN.test(line))
    : lines;
}

/** Stream appended log output until interrupted. */
async function followLog(logFile: string, errorsOnly: boolean): Promise<void> {
  let offset = existsSync(logFile) ? statSync(logFile).size : 0;
  let stop = false;
  const onSigint = (): void => {
    stop = true;
  };
  process.on('SIGINT', onSigint);
  try {
    while (!stop) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (!existsSync(logFile)) {
        continue;
      }
      const size = statSync(logFile).size;
      // A rotation shrinks the file; start over from the top of the new one.
      if (size < offset) {
        offset = 0;
      }
      if (size === offset) {
        continue;
      }
      const fd = openSync(logFile, 'r');
      try {
        const buffer = Buffer.alloc(size - offset);
        readSync(fd, buffer, 0, buffer.length, offset);
        offset = size;
        const fresh = filterLogLines(
          buffer.toString('utf-8').split('\n').filter(Boolean),
          errorsOnly,
        );
        if (fresh.length > 0) {
          process.stdout.write(fresh.join('\n') + '\n');
        }
      } finally {
        closeSync(fd);
      }
    }
  } finally {
    process.off('SIGINT', onSigint);
  }
}

export async function handleLogs(
  args: string[],
  sessionId: string,
): Promise<string> {
  const {lines, follow, errorsOnly} = parseLogsArgs(args);
  const logFile = getDaemonLogPath(sessionId);
  if (!existsSync(logFile)) {
    return renderOutput([
      await encode({logs: 'no log file yet', path: logFile}),
      renderHelp([
        `Run any command (e.g. \`${CLI_BIN_NAME} start\`) to start the daemon`,
      ]),
    ]);
  }
  const allLines = readFileSync(logFile, 'utf-8').split('\n');
  // Drop the trailing empty line from the final newline.
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }
  const matched = filterLogLines(allLines, errorsOnly);
  const tail = matched.slice(-lines);

  if (follow) {
    process.stdout.write(
      renderOutput([
        await encode({path: logFile, following: true, errors_only: errorsOnly}),
        tail.join('\n'),
      ]) + '\n',
    );
    await followLog(logFile, errorsOnly);
    return '';
  }

  return renderOutput([
    await encode({
      path: logFile,
      lines: tail.length,
      total: allLines.length,
      ...(errorsOnly ? {matched: matched.length} : {}),
    }),
    tail.join('\n'),
    renderHelp([
      `Run \`${CLI_BIN_NAME} logs --lines <N>\` to show more (default ${LOGS_DEFAULT_LINES})`,
      `Run \`${CLI_BIN_NAME} logs --errors\` to show only failure lines`,
      `Run \`${CLI_BIN_NAME} logs --follow\` to stream new output`,
    ]),
  ]);
}
