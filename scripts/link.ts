/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

/**
 * Deploys this checkout into the user's global npm prefix: `npm run link`.
 *
 * Plain `npm link` does most of it, and deploys the MCP server only — the CLI
 * is not a declared `bin` entry (see `package.json`), so npm cannot write a
 * binstub for it and cannot touch the one the older `opera-browser-cli` repo
 * installed. That is deliberate: npm refuses to write over a binstub owned by
 * another package (`bin-links` checks the existing link's target against the
 * package being linked), so a second owner of that name would fail the link
 * outright, and would fail every global install of this package on a machine
 * that has the older CLI. `npm run link:cli` deploys the CLI binstub here
 * instead, replacing the older repo's.
 *
 * What this script adds around `npm link`:
 *
 * - It stops the previous deployment first — the CLI daemon and everything
 *   under it, or, when no daemon runs, the MCP servers. A daemon or a server
 *   that outlives the deploy keeps serving the build it started with. The
 *   daemon is asked to stop with `SIGTERM`, the signal `src/opera/daemonShutdown.ts`
 *   handles, so it unlinks its socket and pid file and closes its MCP server on
 *   the way out; `SIGKILL` is only for a daemon that ignores that.
 * - It builds, after the stop: a server that died during the build would be
 *   respawned by its daemon's supervisor and would load whatever `tsc` had
 *   written so far.
 * - It reconciles the CLI's binstub with the rule above: left alone, unless it
 *   points into this checkout — the fingerprint `npm link` used to leave on the
 *   older repo's binstub — in which case it is restored to whichever other
 *   global package declares `opera-browser-cli`.
 *
 * `--prefix <dir>` deploys into another prefix (a throwaway one, say, when
 * verifying this script); it defaults to `npm prefix -g`.
 */

import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const PACKAGE_NAME = 'opera-devtools-mcp';
const MCP_BIN_NAME = 'opera-devtools-mcp';
const CLI_BIN_NAME = 'opera-browser-cli';
/** Where `tsc` puts the package's entry points, relative to the package. */
const BIN_DIR_IN_PACKAGE = path.join('build', 'src', 'bin');
const USAGE = 'Usage: node scripts/link.ts [--with-cli] [--prefix <dir>]';

/** How long a stopped process gets to exit on its own before `SIGKILL`. */
const SIGTERM_GRACE_MS = 5000;
const SIGKILL_GRACE_MS = 2000;
const POLL_INTERVAL_MS = 100;

interface Options {
  /** Also deploy `opera-browser-cli`, replacing whatever owns that binstub now. */
  withCli: boolean;
  /** Global prefix to deploy into; `npm prefix -g` when absent. */
  prefix?: string;
}

interface ProcessEntry {
  pid: number;
  ppid: number;
  stat: string;
  command: string;
}

/** A package in the global `node_modules` that declares a given bin name. */
interface BinProvider {
  packageDir: string;
  binPath: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {withCli: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--with-cli') {
      options.withCli = true;
    } else if (arg === '--prefix') {
      const value = argv[++i];
      if (!value) {
        throw new Error(`--prefix needs a directory.\n${USAGE}`);
      }
      options.prefix = value;
    } else if (arg.startsWith('--prefix=')) {
      options.prefix = arg.slice('--prefix='.length);
    } else {
      throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
    }
  }
  return options;
}

function globalPrefix(explicit?: string): string {
  if (explicit) {
    return path.resolve(explicit);
  }
  const printed = execFileSync('npm', ['prefix', '-g'], {encoding: 'utf8'});
  const prefix = printed.trim().split('\n').pop()?.trim();
  if (!prefix) {
    throw new Error(`\`npm prefix -g\` printed no path:\n${printed}`);
  }
  return prefix;
}

// ---------- what the previous deployment left running ----------

/**
 * One `ps` snapshot of the whole process table, minus this script.
 *
 * `ps` rather than `pgrep`: it is the portable one, and the MCP server
 * rewrites its own argv (`process.title`), so matching has to happen in JS
 * against the full command line anyway.
 */
function listProcesses(): ProcessEntry[] {
  const printed = execFileSync('ps', ['-ww', '-eo', 'pid,ppid,stat,command'], {
    encoding: 'utf8',
  });
  const entries: ProcessEntry[] = [];
  for (const line of printed.split('\n').slice(1)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const [, pid, ppid, stat, command] = match;
    if (Number(pid) === process.pid) {
      continue;
    }
    entries.push({
      pid: Number(pid),
      ppid: Number(ppid),
      stat: stat!,
      command: command!,
    });
  }
  return entries;
}

/**
 * The CLI daemon: node running this fork's `build/src/daemon/daemon.js`. The
 * fork's own name is in the path for every normal checkout, and `REPO_ROOT`
 * covers the renamed one.
 */
function isRepoDaemon(command: string): boolean {
  return (
    /build[\\/]src[\\/]daemon[\\/]daemon\.js/.test(command) &&
    (command.includes(PACKAGE_NAME) || command.includes(REPO_ROOT))
  );
}

/**
 * An MCP server of this fork, in either shape `ps` reports it: spawned by the
 * daemon it shows as the bare product name (`process.title` replaced its argv),
 * spawned by hand it still shows the script path.
 */
function isRepoMcpServer(command: string): boolean {
  return (
    command.trim() === MCP_BIN_NAME ||
    /build[\\/]src[\\/]bin[\\/]opera-devtools-mcp\.js/.test(command)
  );
}

function isAlive(pid: number): boolean {
  const entry = listProcesses().find(candidate => candidate.pid === pid);
  // A zombie is already gone; only its exit status is still uncollected, so
  // waiting for it to disappear would be waiting for its parent.
  return Boolean(entry && !entry.stat.startsWith('Z'));
}

function terminate(pids: readonly number[], signal: NodeJS.Signals): void {
  for (const pid of pids) {
    try {
      process.kill(pid, signal);
    } catch {
      // Gone between the scan and the signal.
    }
  }
}

async function waitForExit(
  pids: readonly number[],
  timeoutMs: number,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(isAlive);
  while (alive.length && Date.now() < deadline) {
    const {promise, resolve} = Promise.withResolvers<void>();
    setTimeout(resolve, POLL_INTERVAL_MS);
    await promise;
    alive = alive.filter(isAlive);
  }
  return alive;
}

async function stopProcesses(entries: readonly ProcessEntry[]): Promise<void> {
  const pids = entries.map(entry => entry.pid);
  const described = entries
    .map(entry => `\n  pid ${entry.pid}  ${entry.command}`)
    .join('');
  console.log(`  stopping${described}`);
  terminate(pids, 'SIGTERM');
  const stubborn = await waitForExit(pids, SIGTERM_GRACE_MS);
  if (!stubborn.length) {
    return;
  }
  console.log(`  SIGKILL (ignored SIGTERM): ${stubborn.join(', ')}`);
  terminate(stubborn, 'SIGKILL');
  const survivors = await waitForExit(stubborn, SIGKILL_GRACE_MS);
  if (survivors.length) {
    throw new Error(`Could not kill: ${survivors.join(', ')}`);
  }
}

/**
 * Stop the previous deployment. The CLI daemon takes its MCP server with it —
 * its exit closes the stdio transport, and the server exits on stdin. A daemon
 * that had to be SIGKILLed leaves that server behind, which is the one case
 * where the servers are swept even though a daemon was found.
 */
async function stopDeployment(): Promise<void> {
  const processes = listProcesses();
  const daemons = processes.filter(entry => isRepoDaemon(entry.command));
  if (daemons.length) {
    console.log(`Stopping the CLI daemon (${daemons.length}):`);
    await stopProcesses(daemons);
    const strays = listProcesses().filter(entry =>
      isRepoMcpServer(entry.command),
    );
    if (strays.length) {
      console.log('The daemon left an MCP server behind:');
      await stopProcesses(strays);
    }
    return;
  }
  const servers = processes.filter(entry => isRepoMcpServer(entry.command));
  if (servers.length) {
    console.log(
      `No CLI daemon running; stopping the MCP server (${servers.length}):`,
    );
    await stopProcesses(servers);
    return;
  }
  console.log('No CLI daemon or MCP server of this checkout is running.');
}

// ---------- the deployment ----------

/** `npm run build`, with its output going straight to the terminal. */
function build(): void {
  const built = spawnSync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (built.status !== 0) {
    throw new Error('`npm run build` failed; nothing was deployed.');
  }
}

/** `npm link`: the package link and the MCP server's binstub, into `prefix`. */
function npmLink(prefix: string | undefined): void {
  const linked = spawnSync('npm', ['link'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    // npm reads the global prefix from this, so a request to deploy somewhere
    // else reaches the `link` npm runs, not just this script's path maths.
    env: prefix ? {...process.env, npm_config_prefix: prefix} : process.env,
  });
  if (linked.status !== 0) {
    throw new Error(
      '`npm link` failed — see its output above; nothing was deployed.',
    );
  }
}

/** The same relative symlink npm writes: `<link> -> <target>`, both resolved. */
function ensureSymlink(linkPath: string, targetPath: string): string {
  const dir = path.dirname(linkPath);
  fs.mkdirSync(dir, {recursive: true});
  // Relative to the *resolved* directory. A prefix that is itself reached
  // through a symlink — `/tmp` is `/private/tmp` on macOS — would otherwise get
  // a target with one `..` for the lexical path and one too many for the path
  // the kernel resolves, and the link would point at nothing.
  const link = path.relative(fs.realpathSync(dir), targetPath);
  const existing = fs.lstatSync(linkPath, {throwIfNoEntry: false});
  if (existing) {
    if (!existing.isSymbolicLink()) {
      throw new Error(
        `${linkPath} exists and is not a symlink; remove it and re-run.`,
      );
    }
    if (fs.readlinkSync(linkPath) === link) {
      return link;
    }
    fs.unlinkSync(linkPath);
  }
  fs.symlinkSync(link, linkPath);
  return link;
}

/** Where the global `node_modules` entry for this package lives. */
function packageDir(prefix: string): string {
  return path.join(prefix, 'lib', 'node_modules', PACKAGE_NAME);
}

/** `--with-cli`: deploy the CLI binstub, which `package.json` does not declare. */
function deployCliShim(prefix: string): void {
  const target = path.join(
    packageDir(prefix),
    BIN_DIR_IN_PACKAGE,
    `${CLI_BIN_NAME}.js`,
  );
  if (!fs.existsSync(target)) {
    throw new Error(`${target} is missing; run \`npm run build\` first.`);
  }
  // `scripts/post-build.ts` chmods these, but a build that skipped it would
  // otherwise deploy a binstub that fails with EACCES.
  if ((fs.statSync(target).mode & 0o111) === 0) {
    fs.chmodSync(target, 0o755);
  }
  console.log(
    `  bin/${CLI_BIN_NAME} -> ${ensureSymlink(path.join(prefix, 'bin', CLI_BIN_NAME), target)}`,
  );
}

/** Every directory in the global `node_modules`, scopes expanded. */
function globalPackageDirs(globalModules: string): string[] {
  const dirs: string[] = [];
  for (const entry of fs.readdirSync(globalModules, {
    withFileTypes: true,
    encoding: 'utf8',
  })) {
    const entryPath = path.join(globalModules, entry.name);
    if (entry.name.startsWith('@')) {
      for (const scoped of fs.readdirSync(entryPath, {encoding: 'utf8'})) {
        dirs.push(path.join(entryPath, scoped));
      }
      continue;
    }
    dirs.push(entryPath);
  }
  return dirs;
}

/** Every global package (this one excluded) whose `bin` declares `binName`. */
function globalPackagesProviding(
  prefix: string,
  binName: string,
): BinProvider[] {
  const providers: BinProvider[] = [];
  for (const dir of globalPackageDirs(
    path.join(prefix, 'lib', 'node_modules'),
  )) {
    if (path.basename(dir) === PACKAGE_NAME) {
      continue;
    }
    let manifest: {name?: string; bin?: unknown};
    try {
      manifest = JSON.parse(
        fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
      ) as {name?: string; bin?: unknown};
    } catch {
      // Not a readable package: a dangling link, or a permission we lack.
      continue;
    }
    const bin = manifest.bin;
    const declared =
      typeof bin === 'string'
        ? manifest.name === binName
          ? bin
          : undefined
        : typeof bin === 'object' && bin !== null
          ? (bin as Record<string, unknown>)[binName]
          : undefined;
    if (typeof declared !== 'string') {
      continue;
    }
    const binPath = path.resolve(dir, declared);
    if (fs.existsSync(binPath)) {
      providers.push({packageDir: dir, binPath});
    }
  }
  return providers;
}

/**
 * The default target deploys the MCP server only, so the CLI's binstub is not
 * written. It is *reconciled* when it points into this checkout: that is the
 * mark an older `npm link` left on the older repo's binstub, and keeping it
 * would mean this checkout's CLI is deployed after all, which is the one thing
 * this target promises not to do.
 */
function reconcileCliShim(prefix: string): void {
  const binDir = path.join(prefix, 'bin');
  const shimPath = path.join(binDir, CLI_BIN_NAME);
  const shim = fs.lstatSync(shimPath, {throwIfNoEntry: false});
  if (!shim) {
    console.log(
      `  bin/${CLI_BIN_NAME}: absent — \`npm run link:cli\` deploys this checkout's CLI, ` +
        `linking the ${CLI_BIN_NAME} repo provides the older one.`,
    );
    return;
  }
  const ourCli = path.join(
    packageDir(prefix),
    BIN_DIR_IN_PACKAGE,
    `${CLI_BIN_NAME}.js`,
  );
  const current = shim.isSymbolicLink() ? fs.readlinkSync(shimPath) : null;
  // By resolved file, not by the link's text: a shim written by `npm link` and
  // one written here can spell the same target with different `..`s.
  let pointsHere = false;
  if (shim.isSymbolicLink()) {
    try {
      pointsHere = fs.realpathSync(shimPath) === fs.realpathSync(ourCli);
    } catch {
      // A dangling link, or a target that moved: not this checkout's shim.
    }
  }
  if (!pointsHere) {
    console.log(
      `  bin/${CLI_BIN_NAME}: kept (-> ${current ?? 'not a symlink'})`,
    );
    return;
  }
  const provider = globalPackagesProviding(prefix, CLI_BIN_NAME)[0];
  if (!provider) {
    console.warn(
      `  bin/${CLI_BIN_NAME}: points into this checkout and no other global package provides it.\n` +
        `    \`npm run link:cli\` keeps that; linking the ${CLI_BIN_NAME} repo replaces it with the older binary.`,
    );
    return;
  }
  console.log(
    `  bin/${CLI_BIN_NAME}: restored to ${path.relative(binDir, provider.packageDir)} (-> ${ensureSymlink(shimPath, provider.binPath)})`,
  );
}

async function main(): Promise<void> {
  if (process.platform === 'win32') {
    throw new Error(
      'This script writes POSIX symlinks for the CLI binstub. On Windows, ' +
        '`npm link` deploys the server and the CLI binstub has to be created by hand.',
    );
  }
  const options = parseArgs(process.argv.slice(2));
  const prefix = globalPrefix(options.prefix);

  console.log(
    `Deploying ${REPO_ROOT} into ${prefix}${options.withCli ? ' (with the CLI)' : ''}\n`,
  );
  await stopDeployment();

  console.log('\nBuilding:');
  build();

  console.log('\nLinking:');
  npmLink(options.prefix);
  if (options.withCli) {
    deployCliShim(prefix);
  } else {
    reconcileCliShim(prefix);
  }
}

main().catch(error => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
