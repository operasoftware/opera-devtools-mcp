/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Opera Software AS.
 */

import '../utils/polyfill.js';

import process from 'node:process';

import {closeBrowser} from '../browser.js';
import {createMcpServer, logDisclaimers} from '../index.js';
import {
  ENV_CRASH_ON_UNCAUGHT,
  PACKAGE_NAME,
  PRODUCT_NAME,
} from '../opera/branding.js';
import {enforceTelemetryPolicy} from '../opera/policy.js';
import {ClearcutLogger} from '../telemetry/ClearcutLogger.js';
import {computeFlagUsage} from '../telemetry/flagUtils.js';
import {StdioServerTransport} from '../third_party/index.js';
import {checkForUpdates} from '../utils/check-for-updates.js';
import {logger, saveLogsToFile} from '../utils/logger.js';
import {VERSION} from '../version.js';

import {cliOptions, parseArguments} from './chrome-devtools-mcp-cli-options.js';

await checkForUpdates(`Run \`npm install ${PACKAGE_NAME}@latest\` to update.`);

export const args = parseArguments(VERSION);

const logFile = args.logFile ? saveLogsToFile(args.logFile) : undefined;

enforceTelemetryPolicy(args);

if (process.env[ENV_CRASH_ON_UNCAUGHT] !== 'true') {
  process.on('unhandledRejection', (reason, promise) => {
    logger?.('Unhandled promise rejection', promise, reason);
  });
}

logger?.(`Starting ${PRODUCT_NAME} v${VERSION}`);
// Shutdown on stdin EOF (stdio MCP convention — the client closes the
// transport to signal exit) and on standard termination signals. Without
// this, an active Chrome subprocess keeps the Node event loop ref'd after
// stdin closes and the server hangs until something else kills it.
let shuttingDown = false;
async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger?.(`Shutting down (${reason})`);
  // Backstop in case browser teardown hangs (e.g. unresponsive Chrome,
  // slow beforeunload handlers, many tabs). Exits 0 because we still
  // honored the shutdown request; the log line preserves observability.
  // Unref'd so it doesn't keep the loop alive on the clean path.
  setTimeout(() => {
    logger?.('Shutdown timeout exceeded, forcing exit');
    process.exit(0);
  }, 5000).unref();
  await closeBrowser();
  process.exit(0);
}
process.stdin.on('end', () => {
  void shutdown('stdin end');
});
process.stdin.on('close', () => {
  void shutdown('stdin close');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGHUP', () => {
  void shutdown('SIGHUP');
});

const {server} = await createMcpServer(args, {
  logFile,
});
const transport = new StdioServerTransport();
await server.connect(transport);
logger?.(`${PRODUCT_NAME} connected`);
logDisclaimers(args);
void ClearcutLogger.get()?.logDailyActiveIfNeeded();
void ClearcutLogger.get()?.logServerStart(computeFlagUsage(args, cliOptions));
