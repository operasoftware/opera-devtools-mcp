/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import 'core-js/modules/es.promise.with-resolvers.js';
import 'core-js/modules/es.set.union.v2.js';
import 'core-js/proposals/iterator-helpers.js';

import type {Flags, OutputMode, Result, RunnerResult} from 'lighthouse';
import type {Page} from 'puppeteer-core';

export type {Flags, Result, RunnerResult, OutputMode};

export type {Options as YargsOptions} from 'yargs';
export {default as yargs} from 'yargs';
export {hideBin} from 'yargs/helpers';
export {default as semver} from 'semver';
export {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
export {type ShapeOutput} from '@modelcontextprotocol/sdk/server/zod-compat.js';
export {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
export {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
export {Client} from '@modelcontextprotocol/sdk/client/index.js';
export type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
export {
  type CallToolResult,
  SetLevelRequestSchema,
  type ImageContent,
  type TextContent,
  type Root,
  ListRootsRequestSchema,
  RootsListChangedNotificationSchema,
  ListRootsResultSchema,
} from '@modelcontextprotocol/sdk/types.js';
export {z as zod} from 'zod';
export {default as ajv} from 'ajv';
export {
  Locator,
  PredefinedNetworkConditions,
  KnownDevices,
  ScreenRecorder,
} from 'puppeteer-core';
// The public `puppeteer-core` re-export strips `@internal` namespace members,
// hiding `CDPSessionEvent.Disconnected` — the only signal that a CDP session
// died. The internal module keeps the full namespace, so import it from there.
// Internal paths pin us to a puppeteer-core version; both imports below are
// verified against puppeteer-core 25.10.0 (`puppeteer` in devDependencies).
export {CDPSessionEvent} from 'puppeteer-core/internal/api/CDPSession.js';
// Same shape for `TargetCloseError`: the class is exported at runtime but is
// `@internal` in the public declarations, so it can only be imported as a value
// from the internal module. `ConnectionClosedError` is public.
export {TargetCloseError} from 'puppeteer-core/internal/common/Errors.js';
export {ConnectionClosedError} from 'puppeteer-core';
export {default as puppeteer} from 'puppeteer-core';
export type * from 'puppeteer-core';
export {PipeTransport} from 'puppeteer-core/internal/node/PipeTransport.js';
export {CdpPage} from 'puppeteer-core/internal/cdp/Page.js';
export type {CdpWebWorker} from 'puppeteer-core/internal/cdp/WebWorker.js';
export type {Realm} from 'puppeteer-core/internal/api/Realm.js';
export type {JSONSchema7, JSONSchema7Definition} from 'json-schema';
export {Mutex} from 'puppeteer-core/internal/util/Mutex.js';
export {
  DisposableStack,
  AsyncDisposableStack,
  SuppressedError,
} from 'puppeteer-core/internal/util/disposable.js';
export {
  resolveDefaultUserDataDir,
  detectBrowserPlatform,
  Browser as BrowserEnum,
  type ChromeReleaseChannel as BrowsersChromeReleaseChannel,
} from '@puppeteer/browsers';
export async function getToonEncode(): Promise<(val: unknown) => string> {
  const {encode} = await import('@toon-format/toon');
  return encode;
}
export async function getGcfEncode(): Promise<(val: unknown) => string> {
  const {encodeGeneric} = await import('@blackwell-systems/gcf');
  return encodeGeneric;
}

import {
  snapshot as snapshotImpl,
  navigation as navigationImpl,
  generateReport as generateReportImpl,
} from './lighthouse-devtools-mcp-bundle.js';

export const snapshot = snapshotImpl as (
  page: Page,
  options: {flags?: Flags},
) => Promise<RunnerResult>;
export const navigation = navigationImpl as (
  page: Page,
  url: string,
  options: {flags?: Flags},
) => Promise<RunnerResult>;
export const generateReport = generateReportImpl as (
  lhr: Result,
  format: string,
) => string;

export * as DevTools from '../../third_party/devtools-frontend/mcp/mcp.js';
