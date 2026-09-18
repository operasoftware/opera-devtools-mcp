#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs, {constants, writeSync, closeSync} from 'node:fs';
import {createServer, type Server} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {claimPidFile} from '../opera/daemonPidFile.js';
import {
  installShutdownHandlers,
  recordShutdownReason,
} from '../opera/daemonShutdown.js';
import {
  answerSocketMessage,
  reportStartupFailure,
} from '../opera/daemonSocket.js';
import {superviseMcpServer} from '../opera/mcpServerSupervisor.js';
import {
  Client,
  PipeTransport,
  StdioClientTransport,
} from '../third_party/index.js';
import {logger, puppeteerLogger} from '../utils/logger.js';
import {VERSION} from '../version.js';

import type {DaemonMessage, DaemonStatusResult} from './types.js';
import {
  DAEMON_CLIENT_NAME,
  getPidFilePath,
  getSocketPath,
  INDEX_SCRIPT_PATH,
  IS_WINDOWS,
  isDaemonRunning,
  assertValidSessionId,
} from './utils.js';

const sessionId = process.env.CHROME_DEVTOOLS_MCP_SESSION_ID || '';
assertValidSessionId(sessionId);
logger?.(`Daemon sessionId: ${sessionId}`);
if (isDaemonRunning(sessionId)) {
  logger?.('Another daemon process is running.');
  process.exit(1);
}
const pidFilePath = getPidFilePath(sessionId);
const pidDir = path.dirname(pidFilePath);
const currentUserUid = os.userInfo().uid;

try {
  fs.mkdirSync(pidDir, {recursive: true, mode: 0o700});
  if (os.platform() !== 'win32') {
    // POSIX specific checks
    try {
      const stats = fs.statSync(pidDir);

      // 1. Check Ownership: Ensure the directory is owned by the current user.
      if (stats.uid !== currentUserUid) {
        console.error(
          `[MCP Daemon] Critical error: PID directory ${pidDir} is not owned by the current user (Expected: ${currentUserUid}, Found: ${stats.uid}). Possible tampering.`,
        );
        process.exit(1);
      }

      // 2. Check Permissions: Ensure the directory is not group or world-writable.
      // Mode is a number, e.g., 0o700. We check if bits for group/world write are set.
      const mode = stats.mode;
      if (mode & constants.S_IWGRP || mode & constants.S_IWOTH) {
        console.error(
          `[MCP Daemon] Critical error: PID directory ${pidDir} has insecure permissions (Mode: ${mode.toString(8)}). It should not be writable by group or others.`,
        );
        process.exit(1);
      }
    } catch (statErr) {
      console.error(
        `[MCP Daemon] Critical error stating PID directory ${pidDir}:`,
        statErr,
      );
      process.exit(1);
    }
  }
} catch (err) {
  console.error(
    `[MCP Daemon] Critical error creating/validating PID directory: ${pidDir}`,
    err,
  );
  process.exit(1);
}

let fd = -1;
try {
  // The claim is `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` — write only,
  // create if absent, fail if another daemon owns it, never follow a symlink —
  // at 0o600. See `opera/daemonPidFile.ts` for why it is not upstream's
  // `O_TRUNC`.
  fd = claimPidFile(sessionId);
  writeSync(fd, process.pid.toString());
} catch (err) {
  console.error(
    `[MCP Daemon] Critical error writing PID file: ${pidFilePath}`,
    err,
  );
  // If openSync fails due to O_NOFOLLOW on a symlink, the error will be caught here.
  process.exit(1);
} finally {
  if (fd !== -1) {
    try {
      closeSync(fd);
    } catch (err) {
      console.error(`[MCP Daemon] Error closing PID file: ${pidFilePath}`, err);
    }
  }
}
logger?.(`Writing ${process.pid.toString()} to ${pidFilePath}`);

const socketPath = getSocketPath(sessionId);

const startDate = new Date();
const mcpServerArgs = process.argv.slice(2);

let mcpClient: Client | null = null;
let mcpTransport: StdioClientTransport | null = null;
let server: Server | null = null;
/** Set once `listen` succeeds, so a later failure knows it owns the socket. */
let bound = false;
/** Brings the MCP server back when its stdio child dies; see the module. */
const mcpSupervisor = superviseMcpServer({
  sessionId,
  connect: setupMCPClient,
  handles: () => ({client: mcpClient, transport: mcpTransport}),
  giveUp: () => cleanup(1),
});

async function setupMCPClient() {
  console.log('Setting up MCP client connection...');

  // Create stdio transport for chrome-devtools-mcp
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [INDEX_SCRIPT_PATH, ...mcpServerArgs],
    env: process.env as Record<string, string>,
  });
  mcpTransport = transport;
  mcpClient = new Client(
    {
      name: DAEMON_CLIENT_NAME,
      version: VERSION,
    },
    {
      capabilities: {},
    },
  );
  // Set onclose BEFORE connect: the SDK's Protocol.connect() captures the
  // transport's existing onclose and wraps it. Setting it after connect
  // overwrites that wrapper, so _onclose() never runs and pending callTool
  // requests hang forever when the MCP server dies. The callback carries the
  // transport it belongs to, so a respawn can tell a server it replaced from the
  // one it is watching.
  transport.onclose = () => mcpSupervisor.onTransportClosed(transport);
  await mcpClient.connect(transport);

  console.log('MCP client connected');
}

interface McpContent {
  type: string;
  text?: string;
}

interface McpResult {
  content?: McpContent[] | string;
  text?: string;
}
async function handleRequest(msg: DaemonMessage) {
  try {
    if (msg.method === 'invoke_tool') {
      if (!mcpClient) {
        throw new Error('MCP client not initialized');
      }
      const {tool, args} = msg;

      const result = (await mcpClient.callTool({
        name: tool,
        arguments: args || {},
      })) as McpResult | McpContent[];

      return {
        success: true,
        result: JSON.stringify(result),
      };
    } else if (msg.method === 'stop') {
      // Ensure we are not interrupting in-progress starting.
      await started;
      // Trigger cleanup asynchronously.
      setImmediate(() => {
        void cleanup(0, 'stopped by request');
      });
      return {
        success: true,
        message: 'stopping',
      };
    } else if (msg.method === 'status') {
      await started;
      const statusResult: DaemonStatusResult = {
        pid: process.pid,
        socketPath,
        startDate: startDate.toISOString(),
        version: VERSION,
        args: mcpServerArgs,
      };
      return {
        success: true,
        result: JSON.stringify(statusResult),
      };
    }
    {
      return {
        success: false,
        error: `Unknown method: ${JSON.stringify(msg, null, 2)}`,
      };
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

async function startSocketServer() {
  // Remove existing socket file if it exists (only on non-Windows)
  if (!IS_WINDOWS) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // ignore errors.
    }
  }

  return await new Promise<void>((resolve, reject) => {
    server = createServer(socket => {
      const transport = new PipeTransport(socket, socket, puppeteerLogger);
      transport.onmessage = async (message: string) => {
        logger?.('onmessage', message);
        const response = await answerSocketMessage(message, handleRequest);
        transport.send(JSON.stringify(response));
        socket.end();
      };
      socket.on('error', error => {
        logger?.('Socket error:', error);
      });
    });

    server.listen(
      {
        path: socketPath,
        readableAll: false,
        writableAll: false,
      },
      async () => {
        bound = true;
        console.log(`Daemon server listening on ${socketPath}`);

        try {
          // Setup MCP client
          await setupMCPClient();
          resolve();
        } catch (err) {
          reject(err);
        }
      },
    );

    server.on('error', error => {
      logger?.('Server error:', error);
      reject(error);
    });
  });
}

async function cleanup(exitCode = 0, reason?: string) {
  // The reason is the diagnostic, so it goes first: `recordShutdownReason` is
  // best-effort, and nothing else in this teardown should be able to cost us it.
  recordShutdownReason(sessionId, reason);
  // Then stop supervising. Closing the client below closes the transport, which
  // would otherwise land in the respawn path and spawn a replacement server
  // while this teardown is running.
  mcpSupervisor.stop();
  console.log('Cleaning up daemon...');

  try {
    await mcpClient?.close();
  } catch (error) {
    logger?.('Error closing MCP client:', error);
  }
  try {
    await mcpTransport?.close();
  } catch (error) {
    logger?.('Error closing MCP transport:', error);
  }
  if (server) {
    await new Promise<void>(resolve => {
      server!.close(() => resolve());
    });
  }
  if (!IS_WINDOWS) {
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // ignore errors
    }
  }
  logger?.(`unlinking ${pidFilePath}`);
  if (fs.existsSync(pidFilePath)) {
    fs.unlinkSync(pidFilePath);
  }
  process.exit(exitCode);
}

// The shutdown wiring — three signals and the two uncaught-error handlers, each
// naming itself in the reason the CLI reports — lives in
// `opera/daemonShutdown.ts`. Every path that reaches it records why it left, so
// "left no reason behind" means only what it says: a SIGKILL or the OOM killer.
installShutdownHandlers({
  onSignal: reason => cleanup(0, reason),
  onException: reason => cleanup(1, reason),
});

// Start the server
const started = startSocketServer().catch(error => {
  logger?.('Failed to start daemon server:', error);
  void reportStartupFailure(error, {
    socketBound: bound,
    sessionId,
    teardown: reason => cleanup(1, reason),
  });
});
