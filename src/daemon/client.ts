/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';

import {ensureCleanStart, readExitReason} from '../opera/daemonLifecycle.js';
import {
  daemonExitMessage,
  nameSpawnFailure,
  openDaemonLog,
} from '../opera/daemonLog.js';
import type {CallToolResult} from '../third_party/index.js';
import {PipeTransport} from '../third_party/index.js';
import {getTempFilePath} from '../utils/files.js';
import {logger, puppeteerLogger} from '../utils/logger.js';

import type {
  DaemonMessage,
  DaemonResponse,
  DaemonStatusResult,
} from './types.js';
import {
  DAEMON_SCRIPT_PATH,
  getSocketPath,
  getPidFilePath,
  isDaemonRunning,
} from './utils.js';

const FILE_TIMEOUT = 10_000;
const READY_CHECK_INTERVAL = 100;
const READY_CHECK_COMMAND_TIMEOUT = 1_000;

/**
 * Waits for a file to be created and populated (removed = false) or removed (removed = true).
 */
function waitForFile(filePath: string, removed = false) {
  return new Promise<void>((resolve, reject) => {
    const check = () => {
      const exists = fs.existsSync(filePath);
      if (removed) {
        return !exists;
      }
      if (!exists) {
        return false;
      }
      try {
        return fs.statSync(filePath).size > 0;
      } catch {
        return false;
      }
    };

    if (check()) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      fs.unwatchFile(filePath);
      reject(
        new Error(
          `Timeout: file ${filePath} ${removed ? 'not removed' : 'not found'} within ${FILE_TIMEOUT}ms`,
        ),
      );
    }, FILE_TIMEOUT);

    fs.watchFile(filePath, {interval: 500}, () => {
      if (check()) {
        clearTimeout(timer);
        fs.unwatchFile(filePath);
        resolve();
      }
    });
  });
}

function delay(ms: number) {
  return new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}

async function waitForDaemonReady(sessionId: string) {
  const deadline = Date.now() + FILE_TIMEOUT;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await sendCommand(
        {method: 'status'},
        sessionId,
        READY_CHECK_COMMAND_TIMEOUT,
      );
      if (response.success) {
        return;
      }
      lastError = new Error(String(response.error));
    } catch (error) {
      lastError = error;
    }

    const timeLeft = deadline - Date.now();
    if (timeLeft > 0) {
      await delay(Math.min(READY_CHECK_INTERVAL, timeLeft));
    }
  }

  throw new Error(
    `Timeout: daemon not ready within ${FILE_TIMEOUT}ms`,
    lastError === undefined ? undefined : {cause: lastError},
  );
}

export async function startDaemon(mcpArgs: string[] = [], sessionId: string) {
  // Not `isDaemonRunning`: that reads the pid file, and a daemon whose pid file
  // is gone (or whose socket a racing starter unlinked) is invisible to it.
  // `ensureCleanStart` probes the socket and reaps whatever the last daemon left
  // behind, so the daemon we are about to fork is the only one in the session.
  if (await ensureCleanStart(sessionId)) {
    logger?.('Daemon is already running');
    await waitForDaemonReady(sessionId);
    return;
  }

  logger?.('Starting daemon...', ...mcpArgs);
  const pidFilePath = getPidFilePath(sessionId);
  const logFd = openDaemonLog(sessionId);
  let child;
  try {
    child = spawn(process.execPath, [DAEMON_SCRIPT_PATH, ...mcpArgs], {
      detached: true,
      // Not 'ignore' unless there was nothing to open: the daemon is detached
      // with no terminal, so discarding its output leaves a daemon that dies
      // silently unexplainable. The file is what the mid-command failure below
      // points the user at.
      stdio: logFd === 'ignore' ? 'ignore' : ['ignore', logFd, logFd],
      env: {...process.env, CHROME_DEVTOOLS_MCP_SESSION_ID: sessionId},
      cwd: process.cwd(),
      windowsHide: true,
    });
  } finally {
    // The child holds its own descriptor; the parent's copy would outlive it.
    if (logFd !== 'ignore') {
      fs.closeSync(logFd);
    }
  }
  child.unref();

  // The pid file and the spawn's own failure, whichever comes first. See
  // `opera/daemonLog.ts` for why a failed spawn must not surface as a timeout.
  await Promise.race([
    waitForFile(pidFilePath),
    nameSpawnFailure(child, sessionId),
  ]);
  await waitForDaemonReady(sessionId);
}

const SEND_COMMAND_TIMEOUT = 60_000; // ms

/**
 * `sendCommand` opens a socket connection sends a single command and disconnects.
 */
export async function sendCommand(
  command: DaemonMessage,
  sessionId: string,
  timeout = SEND_COMMAND_TIMEOUT,
): Promise<DaemonResponse> {
  // Before connecting and sending, verify the daemon is still alive.
  if (!isDaemonRunning(sessionId)) {
    // A daemon that tore itself down leaves a reason behind; surfacing it is
    // the difference between "Daemon is not running." and knowing why.
    const reason = readExitReason(sessionId);
    throw new Error(
      reason ? `Daemon is not running: ${reason}` : 'Daemon is not running.',
    );
  }

  const socketPath = getSocketPath(sessionId);

  const socket = net.createConnection({
    path: socketPath,
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Timeout waiting for daemon response'));
    }, timeout);

    const transport = new PipeTransport(socket, socket, puppeteerLogger);
    transport.onmessage = async (message: string) => {
      clearTimeout(timer);
      logger?.('onmessage', message);
      resolve(JSON.parse(message));
    };
    socket.on('error', error => {
      clearTimeout(timer);
      logger?.('Socket error:', error);
      reject(error);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      logger?.('Socket closed:');
      reject(new Error(daemonExitMessage(sessionId)));
    });
    logger?.('Sending message', command);
    transport.send(JSON.stringify(command));
  });
}

export async function stopDaemon(sessionId: string) {
  if (!isDaemonRunning(sessionId)) {
    logger?.('Daemon is not running');
    return;
  }

  const pidFilePath = getPidFilePath(sessionId);

  await sendCommand({method: 'stop'}, sessionId);

  await waitForFile(pidFilePath, /*removed=*/ true);
}

export async function verifyDaemonVersion(
  sessionId: string,
  cliVersion: string,
): Promise<string | undefined> {
  if (!isDaemonRunning(sessionId)) {
    return undefined;
  }
  try {
    const response = await sendCommand({method: 'status'}, sessionId);
    if (response.success) {
      const data: DaemonStatusResult = JSON.parse(response.result);
      if (data?.version && data.version !== cliVersion) {
        return `Warning: Daemon server version (${data.version}) does not match CLI version (${cliVersion}). Run 'chrome-devtools start' to update and restart the daemon.`;
      }
    }
  } catch {
    // Suppress communication failures during check; command execution handles unreachable daemon errors.
  }
  return undefined;
}

export async function handleResponse(
  response: CallToolResult,
  format: 'json' | 'md',
): Promise<string> {
  if (response.isError) {
    if (format === 'md') {
      const chunks = [];
      for (const content of response.content) {
        if (content.type === 'text') {
          chunks.push(content.text);
        }
      }
      return chunks.join(' ');
    }
    return JSON.stringify(response.content);
  }
  const chunks = [];
  const images: Array<{filePath: string; mimeType: string}> = [];
  for (const content of response.content) {
    if (content.type === 'text') {
      chunks.push(content.text);
    } else if (content.type === 'image') {
      const imageData = content.data;
      const mimeType = content.mimeType;
      let extension = '.png';
      switch (mimeType) {
        case 'image/jpg':
        case 'image/jpeg':
          extension = '.jpeg';
          break;
        case 'image/webp':
          extension = '.webp';
          break;
      }
      const data = Buffer.from(imageData, 'base64');
      const name = crypto.randomUUID();
      const filepath = await getTempFilePath(`${name}${extension}`);
      fs.writeFileSync(filepath, data);
      images.push({filePath: filepath, mimeType});
      chunks.push(`Saved to ${filepath}.`);
    } else {
      throw new Error('Not supported response content type');
    }
  }
  if (format === 'json') {
    if (response.structuredContent) {
      const structuredContent = {
        ...response.structuredContent,
        ...(images.length ? {images} : {}),
      };
      return JSON.stringify(structuredContent);
    }
    // Fall-through to text for backward compatibility.
  }
  return format === 'md' ? chunks.join(' ') : JSON.stringify(chunks);
}
