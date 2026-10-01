/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Keeps the daemon's MCP server alive.
 *
 * The MCP server is a stdio child of the daemon, and the SDK's transport already
 * reports its exit through `onclose` — upstream simply never sets that callback.
 * The daemon therefore outlives its only means of serving tools: it keeps
 * answering `status` while every tool call fails, and the CLI has no way to tell
 * that the session is useless.
 *
 * Two things make the callback harder than it looks. The close that the respawn
 * itself causes — releasing the dead server — lands in the same callback as a
 * real failure, so the transport object identifies itself and its own retirement
 * is ignored. And a replacement can die while `connect()` is still running,
 * before it is anybody's idea of "the current server": that close arrives while
 * the respawn is in flight and is recorded, so the attempt is not mistaken for a
 * healthy one.
 *
 * `giveUp` exists for the same reason in the other direction: a daemon that
 * cannot be brought back to health must not keep answering. It records why,
 * tears itself down, and leaves a working daemon to be started in its place
 * instead of a zombie that reports itself ready.
 */

import {setTimeout as sleep} from 'node:timers/promises';

import type {Client, StdioClientTransport} from '../third_party/index.js';
import {logger} from '../utils/logger.js';

import {writeExitReason} from './daemonLifecycle.js';

const RESPAWN_ATTEMPTS = 3;
const RESPAWN_DELAY_MS = 500;

export interface McpServerHandles {
  client: Client | null;
  transport: StdioClientTransport | null;
}

export interface McpServerSupervisorOptions {
  /** Session whose exit reason file records a give-up. */
  sessionId: string;
  /** Spawn an MCP server and connect to it. */
  connect(): Promise<void>;
  /** The client and transport currently in use, to be released before a respawn. */
  handles(): McpServerHandles;
  /** The server could not be brought back; the reason is recorded. Tear down. */
  giveUp(): Promise<void>;
}

export interface McpServerSupervisor {
  /** The `onclose` of the transport that closed, as the daemon wired it. */
  onTransportClosed(transport: StdioClientTransport): void;
  /** Stop supervising: the daemon itself is going away. */
  stop(): void;
}

export function superviseMcpServer(
  options: McpServerSupervisorOptions,
): McpServerSupervisor {
  let stopped = false;
  let respawning = false;
  /** A close that arrived while a respawn was already in flight. */
  let respawnRequested = false;
  /** The transport this supervisor closed itself, whose close is not a failure. */
  let retired: StdioClientTransport | null = null;

  /**
   * Let go of the server that just died, and remember it, so the close this
   * causes is not read back as a second failure.
   */
  async function releaseHandles(): Promise<void> {
    const {client, transport} = options.handles();
    if (transport) {
      retired = transport;
    }
    try {
      await client?.close();
    } catch (error) {
      logger?.('Error closing MCP client:', error);
    }
    try {
      // The client closes the transport too. The transport is still closed on
      // its own because it is the thing that must not outlive the respawn, and
      // a client that failed between construction and `connect` left it loose.
      await transport?.close();
    } catch (error) {
      logger?.('Error closing MCP transport:', error);
    }
  }

  async function respawn(): Promise<void> {
    // `stop()` comes from the daemon's own teardown, which closes the client and
    // therefore the transport and therefore lands here: a teardown must not
    // spawn a replacement. `respawning` keeps a burst of closes to one attempt,
    // remembering that another one arrived.
    if (stopped) {
      return;
    }
    if (respawning) {
      respawnRequested = true;
      return;
    }
    respawning = true;
    try {
      let lastError: unknown;
      for (let attempt = 1; attempt <= RESPAWN_ATTEMPTS; attempt++) {
        await releaseHandles();
        // Any close from here on belongs to the server we are about to spawn,
        // not to the one just released.
        respawnRequested = false;
        try {
          await options.connect();
          // A server that died while `connect` was still running reported itself
          // through `onclose`, which set the flag while it was already in flight.
          // `connect` resolving then proves nothing: retry rather than sit here
          // believing a dead server is up.
          if (!respawnRequested) {
            return;
          }
          lastError = new Error('the MCP server died during startup');
        } catch (error) {
          lastError = error;
        }
        if (attempt < RESPAWN_ATTEMPTS) {
          await sleep(RESPAWN_DELAY_MS);
        }
      }
      throw lastError;
    } catch (err) {
      const reason = `MCP server respawn failed after ${RESPAWN_ATTEMPTS} attempts: ${
        err instanceof Error ? err.message : String(err)
      }`;
      logger?.(reason);
      writeExitReason(options.sessionId, reason);
      await options.giveUp();
    } finally {
      respawning = false;
    }
  }

  return {
    onTransportClosed: transport => {
      if (transport === retired) {
        return;
      }
      void respawn();
    },
    stop: () => {
      stopped = true;
    },
  };
}
