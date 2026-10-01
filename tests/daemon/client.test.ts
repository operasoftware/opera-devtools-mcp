/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import {dirname} from 'node:path';
import {describe, it, afterEach, beforeEach} from 'node:test';

import {
  handleResponse,
  startDaemon,
  stopDaemon,
  verifyDaemonVersion,
} from '../../src/daemon/client.js';
import {getRuntimeHome, isDaemonRunning} from '../../src/daemon/utils.js';
import {writeExitReason} from '../../src/opera/daemonLifecycle.js';
import {
  daemonExitMessage,
  getDaemonLogPath,
  getPreviousDaemonLogPath,
} from '../../src/opera/daemonLog.js';
import {VERSION} from '../../src/version.js';

describe('daemon client', () => {
  let sessionId: string;

  beforeEach(async () => {
    sessionId = crypto.randomUUID();
    await stopDaemon(sessionId);
  });

  afterEach(async () => {
    await stopDaemon(sessionId);
  });

  describe('start/stop', () => {
    it('should start and stop daemon', async () => {
      assert.ok(
        !isDaemonRunning(sessionId),
        'Daemon should not be running initially',
      );

      await startDaemon([], sessionId);
      assert.ok(
        isDaemonRunning(sessionId),
        'Daemon should be running after start',
      );

      await stopDaemon(sessionId);
      assert.ok(
        !isDaemonRunning(sessionId),
        'Daemon should not be running after stop',
      );
    });

    it('should handle starting daemon when already running', async () => {
      await startDaemon([], sessionId);
      assert.ok(isDaemonRunning(sessionId), 'Daemon should be running');

      // Starting again should be a no-op
      await startDaemon([], sessionId);
      assert.ok(isDaemonRunning(sessionId), 'Daemon should still be running');
    });

    it('should handle stopping daemon when not running', async () => {
      assert.ok(
        !isDaemonRunning(sessionId),
        'Daemon should not be running initially',
      );

      // Stopping when not running should be a no-op
      await stopDaemon(sessionId);
      assert.ok(
        !isDaemonRunning(sessionId),
        'Daemon should still not be running',
      );
    });
  });

  describe('verifyDaemonVersion', () => {
    it('warns when daemon version does not match CLI version', async () => {
      await startDaemon([], sessionId);
      const warning = await verifyDaemonVersion(sessionId, '0.0.0-mismatch');
      assert.ok(
        warning &&
          warning.includes('does not match CLI version (0.0.0-mismatch)'),
        `Expected warning message about version mismatch, got: ${warning}`,
      );
    });

    it('does not warn when daemon version matches CLI version', async () => {
      await startDaemon([], sessionId);
      const warning = await verifyDaemonVersion(sessionId, VERSION);
      assert.strictEqual(
        warning,
        undefined,
        'Should not return warning when version matches',
      );
    });

    it('does nothing when daemon is not running', async () => {
      const warning = await verifyDaemonVersion(sessionId, '0.0.0-mismatch');
      assert.strictEqual(
        warning,
        undefined,
        'Should not return warning when daemon is stopped',
      );
    });
  });

  describe('daemon exit reporting', () => {
    it('reports the reason a daemon recorded on its way out', () => {
      mkdirSync(getRuntimeHome(sessionId), {recursive: true, mode: 0o700});
      writeExitReason(sessionId, 'unhandled rejection: boom');

      assert.strictEqual(
        daemonExitMessage(sessionId),
        'Daemon exited while running the command: unhandled rejection: boom',
      );
    });

    it('points at the daemon output when a killed daemon left no reason', () => {
      const message = daemonExitMessage(sessionId);

      assert.ok(
        message.includes(getDaemonLogPath(sessionId)),
        `a daemon that left no reason must still name its output, got: ${message}`,
      );
    });
  });

  describe('daemon log', () => {
    it('keeps the previous daemon output when a new daemon starts', async () => {
      await startDaemon([], sessionId);
      await stopDaemon(sessionId);

      const logPath = getDaemonLogPath(sessionId);
      appendFileSync(logPath, 'MARKER previous daemon output\n');
      await startDaemon([], sessionId);

      // Rotated, not truncated: the log is where a killed daemon's output is
      // diagnosed from, and a restart must not be the thing that erases it.
      assert.ok(
        readFileSync(getPreviousDaemonLogPath(sessionId), 'utf-8').includes(
          'MARKER previous daemon output',
        ),
        'the previous daemon output must survive the next start',
      );
      assert.ok(
        !readFileSync(logPath, 'utf-8').includes('MARKER'),
        'the new daemon must start a fresh log',
      );
    });
  });

  describe('parsing', () => {
    it('handles MCP response with text format', async () => {
      const textResponse = {content: [{type: 'text' as const, text: 'test'}]};
      assert.strictEqual(await handleResponse(textResponse, 'md'), 'test');
    });

    it('handles JSON response', async () => {
      const jsonResponse = {
        content: [],
        structuredContent: {
          test: 'data',
          number: 123,
        },
      };
      assert.strictEqual(
        await handleResponse(jsonResponse, 'json'),
        JSON.stringify(jsonResponse.structuredContent),
      );
    });

    it('handles error response when isError is true with md format', async () => {
      const errorResponse = {
        isError: true,
        content: [{type: 'text' as const, text: 'Something went wrong'}],
      };
      assert.strictEqual(
        await handleResponse(errorResponse, 'md'),
        'Something went wrong',
      );
    });

    it('handles error response when isError is true with json format', async () => {
      const errorResponse = {
        isError: true,
        content: [{type: 'text' as const, text: 'Something went wrong'}],
      };
      assert.strictEqual(
        await handleResponse(errorResponse, 'json'),
        JSON.stringify(errorResponse.content),
      );
    });

    it('handles text response when json format is requested but no structured content', async () => {
      const textResponse = {
        content: [{type: 'text' as const, text: 'Fall through text'}],
      };
      assert.deepStrictEqual(
        await handleResponse(textResponse, 'json'),
        JSON.stringify(['Fall through text']),
      );
    });

    it('supports images', async () => {
      const unsupportedContentResponse = {
        content: [
          {
            type: 'image' as const,
            data: 'base64data',
            mimeType: 'image/png',
          },
        ],
        structuredContent: {},
      };
      const response = await handleResponse(unsupportedContentResponse, 'md');
      assert.ok(response.includes('.png'));
    });

    it('includes saved image file paths in structured JSON responses', async () => {
      const imageContentResponse = {
        content: [
          {
            type: 'text' as const,
            text: 'Took a screenshot.',
          },
          {
            type: 'image' as const,
            data: Buffer.from('image data').toString('base64'),
            mimeType: 'image/png',
          },
        ],
        structuredContent: {
          message: 'Took a screenshot.',
        },
      };
      let filePath: string | undefined;
      try {
        const response = await handleResponse(imageContentResponse, 'json');
        const parsed = JSON.parse(response) as {
          message: string;
          images: Array<{filePath: string; mimeType: string}>;
        };
        assert.strictEqual(parsed.message, 'Took a screenshot.');
        assert.strictEqual(parsed.images.length, 1);
        assert.strictEqual(parsed.images[0].mimeType, 'image/png');
        filePath = parsed.images[0].filePath;
        assert.ok(filePath.endsWith('.png'));
        assert.ok(existsSync(filePath));
      } finally {
        if (filePath) {
          rmSync(dirname(filePath), {recursive: true, force: true});
        }
      }
    });

    it('uses the webp extension for WebP images', async () => {
      const webpContentResponse = {
        content: [
          {
            type: 'image' as const,
            data: 'base64data',
            mimeType: 'image/webp',
          },
        ],
        structuredContent: {},
      };
      const response = await handleResponse(webpContentResponse, 'md');
      assert.ok(response.includes('.webp'));
    });
  });
});
