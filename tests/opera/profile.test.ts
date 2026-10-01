/**
 * @license
 * Copyright 2026 Opera Norway AS. All rights reserved.
 *
 * This file is an original work developed by Opera.
 */

import assert from 'node:assert';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import {createServer, type Server} from 'node:http';
import {type AddressInfo} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {
  defaultProfileDir,
  findAttachableEndpoint,
  inspectProfileLock,
  localHostNames,
  parseDevToolsActivePort,
  parseSingletonTarget,
  probeDevToolsEndpoint,
  readDevToolsPort,
} from '../../src/opera/profile.js';

const tempDirs: string[] = [];
const servers: Server[] = [];

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opera-profile-'));
  tempDirs.push(dir);
  return dir;
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opera-profilelock-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

/** Create the profile dir the build should map to, and assert it is found. */
function assertProfileDir(browserPath: string, bundle: string): void {
  const home = tempHome();
  const expected = path.join(home, 'Library', 'Application Support', bundle);
  fs.mkdirSync(expected, {recursive: true});

  assert.strictEqual(defaultProfileDir(browserPath, home, 'darwin'), expected);
}

describe('defaultProfileDir', () => {
  it('maps Opera Neon Developer to its own bundle', () => {
    assertProfileDir(
      '/Applications/Opera Neon Developer.app/Contents/MacOS/Opera',
      'com.operasoftware.OperaNeonDeveloper',
    );
  });

  it('maps Opera Neon to its own bundle', () => {
    assertProfileDir(
      '/Applications/Opera Neon.app/Contents/MacOS/Opera',
      'com.operasoftware.OperaNeon',
    );
  });

  it('maps Opera GX to com.operasoftware.OperaGX', () => {
    assertProfileDir(
      '/Applications/Opera GX.app/Contents/MacOS/Opera',
      'com.operasoftware.OperaGX',
    );
  });

  it('maps plain Opera to com.operasoftware.Opera', () => {
    assertProfileDir(
      '/Applications/Opera.app/Contents/MacOS/Opera',
      'com.operasoftware.Opera',
    );
  });

  it('returns null when the profile dir does not exist', () => {
    const home = tempHome();
    assert.strictEqual(
      defaultProfileDir(
        '/Applications/Opera.app/Contents/MacOS/Opera',
        home,
        'darwin',
      ),
      null,
    );
  });

  it('maps the Windows profile folder from the build name, via the env seam', () => {
    const home = tempHome();
    const appData = `${home}\\Roaming`;
    const expected = `${appData}\\Opera Software\\Opera Neon`;
    fs.mkdirSync(expected, {recursive: true});

    assert.strictEqual(
      defaultProfileDir(
        'C:\\Users\\opera\\AppData\\Local\\Programs\\Opera Neon\\opera.exe',
        home,
        'win32',
        {APPDATA: appData},
      ),
      expected,
    );
  });

  it('falls back to home-relative APPDATA when the env seam has none', () => {
    const home = tempHome();
    const expected = `${home}\\AppData\\Roaming\\Opera Software\\Opera`;
    fs.mkdirSync(expected, {recursive: true});

    assert.strictEqual(
      defaultProfileDir(
        'C:\\Program Files\\Opera\\opera.exe',
        home,
        'win32',
        {},
      ),
      expected,
    );
  });
});

describe('parseSingletonTarget', () => {
  it('splits the pid off from the right, keeping dashes in the hostname', () => {
    assert.deepStrictEqual(parseSingletonTarget('Someones-MacBook-Pro-24601'), {
      hostname: 'Someones-MacBook-Pro',
      pid: 24601,
    });
    assert.deepStrictEqual(parseSingletonTarget('Mac-4242'), {
      hostname: 'Mac',
      pid: 4242,
    });
  });

  it('returns null for no separator, a leading dash, or a bad pid', () => {
    assert.strictEqual(parseSingletonTarget('justahostname'), null);
    assert.strictEqual(parseSingletonTarget('-24601'), null);
    assert.strictEqual(parseSingletonTarget('host-nonnumeric'), null);
    assert.strictEqual(parseSingletonTarget('host-0'), null);
    assert.strictEqual(parseSingletonTarget(''), null);
  });
});

describe('localHostNames', () => {
  it('is just the machine’s own name where Chromium asks gethostname()', () => {
    assert.deepStrictEqual(localHostNames('linux'), [os.hostname()]);
    assert.deepStrictEqual(localHostNames('win32'), [os.hostname()]);
  });

  it('adds the macOS names Chromium writes instead of gethostname()', () => {
    const scutil = sinon
      .stub(childProcess, 'execFileSync')
      .returns('opera-users-MacBook-Pro-2\n');

    try {
      const names = localHostNames('darwin');
      assert.ok(names.includes('opera-users-MacBook-Pro-2'), names.join(','));
      assert.ok(
        names.includes('opera-users-MacBook-Pro-2.local'),
        names.join(','),
      );
      assert.ok(names.includes('Mac'), names.join(','));
      assert.deepStrictEqual(scutil.firstCall.args.slice(0, 2), [
        'scutil',
        ['--get', 'LocalHostName'],
      ]);
    } finally {
      sinon.restore();
    }
  });

  it('leaves the name out when scutil cannot answer', () => {
    const scutil = sinon
      .stub(childProcess, 'execFileSync')
      .throws(new Error('Operation not permitted'));

    try {
      assert.deepStrictEqual(localHostNames('darwin'), [
        os.hostname(),
        ...(os.hostname() === 'Mac' ? [] : ['Mac']),
      ]);
      assert.strictEqual(scutil.called, true);
    } finally {
      sinon.restore();
    }
  });
});

describe('inspectProfileLock', () => {
  it('reports free when there is no lock file', () => {
    const dir = tempDir();
    assert.deepStrictEqual(
      inspectProfileLock(dir, () => true, 'linux'),
      {
        state: 'free',
        pid: null,
        hostname: null,
      },
    );
  });

  it(
    'reports free for a dangling lock whose local process is gone',
    {skip: process.platform === 'win32'},
    () => {
      const dir = tempDir();
      // A lock left behind by a crash dangles: its target is gone, but the
      // symlink name still encodes the owning host and pid.
      fs.symlinkSync(`${os.hostname()}-99999`, path.join(dir, 'SingletonLock'));
      assert.deepStrictEqual(
        inspectProfileLock(dir, () => false, 'linux'),
        {
          state: 'free',
          pid: null,
          hostname: os.hostname(),
        },
      );
    },
  );

  it('reports unknown (unattributable) for a regular lock file', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'SingletonLock'), 'some pid');
    assert.deepStrictEqual(
      inspectProfileLock(dir, () => true, 'linux'),
      {
        state: 'unknown',
        pid: null,
        hostname: null,
      },
    );
  });

  it(
    'reports unknown with the foreign hostname for another machine’s lock',
    {skip: process.platform === 'win32'},
    () => {
      const dir = tempDir();
      fs.symlinkSync('not-this-machine-24601', path.join(dir, 'SingletonLock'));
      assert.deepStrictEqual(
        inspectProfileLock(dir, () => true, 'linux'),
        {
          state: 'unknown',
          pid: null,
          hostname: 'not-this-machine',
        },
      );
    },
  );

  it(
    'treats the macOS Marker-<pid> lock as local on darwin',
    {skip: process.platform === 'win32'},
    () => {
      const dir = tempDir();
      fs.symlinkSync('Mac-4242', path.join(dir, 'SingletonLock'));
      assert.deepStrictEqual(
        inspectProfileLock(dir, () => true, 'darwin'),
        {
          state: 'locked',
          pid: 4242,
          hostname: 'Mac',
        },
      );
    },
  );

  it(
    'keeps the pid of a lock that names the macOS LocalHostName',
    {skip: process.platform === 'win32'},
    () => {
      // What a renamed Mac actually gets: Chromium writes the Bonjour name
      // ("<LocalHostName>.local"), while `os.hostname()` reports the short
      // ComputerName-derived one, so the two never match.
      const dir = tempDir();
      fs.symlinkSync(
        'opera-users-MacBook-Pro-2.local-4242',
        path.join(dir, 'SingletonLock'),
      );
      assert.deepStrictEqual(
        inspectProfileLock(dir, () => true, 'darwin', [
          'Mac',
          'opera-users-MacBook-Pro-2',
          'opera-users-MacBook-Pro-2.local',
        ]),
        {
          state: 'locked',
          pid: 4242,
          hostname: 'opera-users-MacBook-Pro-2.local',
        },
      );
    },
  );

  it(
    'keeps a foreign hostname unattributable',
    {skip: process.platform === 'win32'},
    () => {
      const dir = tempDir();
      fs.symlinkSync('someone-elses-mac-4242', path.join(dir, 'SingletonLock'));
      assert.deepStrictEqual(
        inspectProfileLock(dir, () => true, 'darwin', ['Mac']),
        {
          state: 'unknown',
          pid: null,
          hostname: 'someone-elses-mac',
        },
      );
    },
  );

  it(
    'reports locked with the pid when the local process is alive',
    {skip: process.platform === 'win32'},
    () => {
      const dir = tempDir();
      fs.symlinkSync(`${os.hostname()}-4242`, path.join(dir, 'SingletonLock'));
      assert.deepStrictEqual(
        inspectProfileLock(dir, () => true, 'linux'),
        {
          state: 'locked',
          pid: 4242,
          hostname: os.hostname(),
        },
      );
    },
  );
});

describe('parseDevToolsActivePort', () => {
  it('reads the port as the first line', () => {
    assert.strictEqual(
      parseDevToolsActivePort('9222\n/devtools/browser/x\n'),
      9222,
    );
  });

  it('returns null for empty, non-numeric, zero and out-of-range ports', () => {
    assert.strictEqual(parseDevToolsActivePort(''), null);
    assert.strictEqual(
      parseDevToolsActivePort('\n/devtools/browser/x\n'),
      null,
    );
    assert.strictEqual(
      parseDevToolsActivePort('not-a-port\n/devtools/browser/x\n'),
      null,
    );
    assert.strictEqual(
      parseDevToolsActivePort('0\n/devtools/browser/x\n'),
      null,
    );
    assert.strictEqual(
      parseDevToolsActivePort('70000\n/devtools/browser/x\n'),
      null,
    );
  });
});

describe('readDevToolsPort', () => {
  it('returns the advertised port once the file exists', () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, 'DevToolsActivePort'),
      '9223\n/devtools/browser/y\n',
    );
    assert.strictEqual(readDevToolsPort(dir), 9223);
  });

  it('returns null when the file is missing', () => {
    const dir = tempDir();
    assert.strictEqual(readDevToolsPort(dir), null);
  });
});

describe('probeDevToolsEndpoint', () => {
  it('identifies an Opera browser', async () => {
    const port = await serveRaw('{"Browser":"Opera/110.0.0.0"}', 200);
    assert.deepStrictEqual(await probeDevToolsEndpoint(port, 1000), {
      browser: 'Opera/110.0.0.0',
      isOpera: true,
    });
  });

  it('identifies a non-Opera browser', async () => {
    const port = await serveRaw('{"Browser":"Chrome/120.0.0.0"}', 200);
    assert.deepStrictEqual(await probeDevToolsEndpoint(port, 1000), {
      browser: 'Chrome/120.0.0.0',
      isOpera: false,
    });
  });

  it('returns null when nothing is listening on the port', async () => {
    const port = await closedPort();
    assert.strictEqual(await probeDevToolsEndpoint(port, 500), null);
  });

  it('returns null for a non-200 response', async () => {
    const port = await serveRaw('not found', 404);
    assert.strictEqual(await probeDevToolsEndpoint(port, 500), null);
  });

  it('returns null for malformed JSON', async () => {
    const port = await serveRaw('{nope', 200);
    assert.strictEqual(await probeDevToolsEndpoint(port, 500), null);
  });
});

describe('findAttachableEndpoint', () => {
  it('answers with the URL of a live browser on the advertised port', async () => {
    const dir = tempDir();
    const port = await serveRaw('{"Browser":"Opera/121.0.0.0"}', 200);
    fs.writeFileSync(
      path.join(dir, 'DevToolsActivePort'),
      `${port}\n/devtools/browser/x\n`,
    );
    assert.deepStrictEqual(await findAttachableEndpoint(dir), {
      url: `http://127.0.0.1:${port}`,
      identity: {browser: 'Opera/121.0.0.0', isOpera: true},
    });
  });

  it('is null when the recorded port answers nothing', async () => {
    const dir = tempDir();
    const port = await closedPort();
    fs.writeFileSync(
      path.join(dir, 'DevToolsActivePort'),
      `${port}\n/devtools/browser/x\n`,
    );
    assert.strictEqual(await findAttachableEndpoint(dir), null);
  });

  it('is null when the profile recorded no port at all', async () => {
    assert.strictEqual(await findAttachableEndpoint(tempDir()), null);
  });
});

async function serveRaw(body: string, status: number): Promise<number> {
  const {promise, resolve, reject} = Promise.withResolvers<number>();
  const server = createServer((req, res) => {
    res.writeHead(status, {'Content-Type': 'application/json'});
    res.end(body);
  });
  servers.push(server);
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    resolve((server.address() as AddressInfo).port);
  });
  return promise;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.on('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const port = (server.address() as AddressInfo).port;
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  return port;
}
