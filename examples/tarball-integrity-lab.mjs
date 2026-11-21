import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { parse, stringify } from 'yaml';

const [beforeCli, afterCli] = process.argv.slice(2).map((path) => resolve(path));
assert(
  beforeCli && afterCli && beforeCli !== afterCli,
  'Pass the published pnpm 10.34.9 CLI and the CLI built at b31b2aa.',
);
const cli = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const run = promisify(execFile);
const lab = mkdtempSync(join(tmpdir(), 'lockcone-tarball-lab-'));
const archiveName = 'lab-tarball';
const port = 41351;
const archivePath = '/lab-tarball.tgz';
const url = `http://127.0.0.1:${port}${archivePath}`;
const packageKey = `${archiveName}@${url}`;
const direct = 'packages/direct';
const transitive = 'packages/transitive';
const independent = 'packages/independent';

// A ustar archive holding only package/package.json, with fixed tar and gzip metadata.
const manifest = Buffer.from(JSON.stringify({ name: archiveName, version: '1.0.0' }));
const header = Buffer.alloc(512);
header.write('package/package.json');
header.write('0000644\0', 100);
header.write('0000000\0', 108);
header.write('0000000\0', 116);
header.write(`${manifest.length.toString(8).padStart(11, '0')}\0`, 124);
header.write('00000000000\0', 136);
header.fill(0x20, 148, 156);
header.write('0', 156);
header.write('ustar\x0000', 257);
const checksum = header.reduce((total, byte) => total + byte, 0);
header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
const archive = gzipSync(
  Buffer.concat([header, manifest, Buffer.alloc(1536 - manifest.length)]),
);
const expectedIntegrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;

const requests = [];
const server = createServer((request, response) => {
  if (request.url !== archivePath || !['HEAD', 'GET'].includes(request.method)) {
    response.writeHead(404).end();
    return;
  }
  requests.push(request.method);
  response.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Length': archive.length,
  });
  response.end(request.method === 'HEAD' ? undefined : archive);
});

const manifests = {
  'package.json': { name: 'lab-root', private: true },
  [`${direct}/package.json`]: {
    name: 'lab-direct',
    dependencies: { [archiveName]: url },
  },
  [`${transitive}/package.json`]: {
    name: 'lab-transitive',
    dependencies: { 'lab-direct': 'workspace:*' },
  },
  [`${independent}/package.json`]: { name: 'lab-independent' },
};

function workspace(directory) {
  for (const [file, data] of Object.entries(manifests)) {
    const path = join(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  }
  writeFileSync(join(directory, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
}

const env = {
  ...process.env,
  CI: 'true',
  XDG_CONFIG_HOME: join(lab, 'config'),
  XDG_CACHE_HOME: join(lab, 'cache'),
  XDG_DATA_HOME: join(lab, 'data'),
  PNPM_HOME: join(lab, 'pnpm-home'),
  npm_config_userconfig: '/dev/null',
  npm_config_globalconfig: '/dev/null',
  npm_config_manage_package_manager_versions: 'false',
};

async function pnpm(label, entry, cwd, ...args) {
  const start = requests.length;
  const result = await run(process.execPath, [entry, ...args], {
    cwd,
    env,
    timeout: 60_000,
  })
    .then((output) => ({ ...output, code: 0 }))
    .catch((error) => {
      if (typeof error.code !== 'number') throw error;
      return error;
    });
  writeFileSync(join(lab, `${label}.log`), `${result.stdout}${result.stderr}`);
  console.log(
    JSON.stringify({ label, args, code: result.code, requests: requests.slice(start) }),
  );
  return result;
}

function readIntegrity(path) {
  const lockfile = parse(readFileSync(path, 'utf8'));
  const resolution = lockfile.packages[packageKey].resolution;
  assert.equal(resolution.tarball, url);
  assert(Object.hasOwn(lockfile.snapshots, packageKey));
  assert.equal(lockfile.importers[direct].dependencies[archiveName].version, url);
  assert.equal(
    lockfile.importers[transitive].dependencies['lab-direct'].version,
    'link:../direct',
  );
  assert.deepEqual(lockfile.importers[independent], {});
  if (!Object.hasOwn(resolution, 'integrity')) return null;
  assert.equal(resolution.integrity, expectedIntegrity);
  return resolution.integrity;
}

async function runVersion(label, entry) {
  const project = join(lab, label, 'workspace');
  workspace(project);
  const version = await pnpm(`${label}-version`, entry, project, '--version');
  assert.equal(version.stdout.trim(), '10.34.9');
  const store = join(lab, label, 'warm-store');
  const lockfile = join(project, 'pnpm-lock.yaml');
  const initial = join(lab, label, 'initial.yaml');
  const updated = join(lab, label, 'updated.yaml');
  const install = await pnpm(
    `${label}-initial`,
    entry,
    project,
    'install',
    '--lockfile-only',
    '--no-frozen-lockfile',
    '--ignore-scripts',
    '--store-dir',
    store,
  );
  assert.equal(install.code, 0, install.stdout + install.stderr);
  copyFileSync(lockfile, initial);
  const initialIntegrity = readIntegrity(initial);
  assert.equal(initialIntegrity, expectedIntegrity);

  const update = await pnpm(
    `${label}-update`,
    entry,
    project,
    '--filter',
    'lab-direct',
    'update',
    '--lockfile-only',
    '--ignore-scripts',
    '--store-dir',
    store,
  );
  copyFileSync(lockfile, updated);
  const updatedIntegrity = readIntegrity(updated);
  if (updatedIntegrity === null && update.code !== 0)
    assert.match(update.stdout + update.stderr, /ERR_PNPM_MISSING_TARBALL_INTEGRITY/);
  else assert.equal(update.code, 0, update.stdout + update.stderr);

  const fresh = join(lab, label, 'frozen-workspace');
  workspace(fresh);
  copyFileSync(updated, join(fresh, 'pnpm-lock.yaml'));
  const frozen = await pnpm(
    `${label}-frozen`,
    entry,
    fresh,
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--store-dir',
    join(lab, label, 'fresh-store'),
  );
  if (updatedIntegrity === null) {
    assert.notEqual(frozen.code, 0);
    assert.match(frozen.stdout + frozen.stderr, /ERR_PNPM_MISSING_TARBALL_INTEGRITY/);
  } else {
    assert.equal(frozen.code, 0, frozen.stdout + frozen.stderr);
    const installed = join(fresh, direct, 'node_modules', archiveName, 'package.json');
    assert.deepEqual(
      JSON.parse(readFileSync(installed, 'utf8')),
      JSON.parse(manifest.toString()),
    );
  }
  console.log(
    JSON.stringify({
      label,
      initialIntegrity,
      updatedIntegrity,
      updateExit: update.code,
      frozenExit: frozen.code,
    }),
  );
  return { initial, updated, updatedIntegrity };
}

async function checkReport(label, before, after, loss) {
  const project = join(lab, `${label}-comparison`);
  workspace(project);
  const git = (...args) => run('git', args, { cwd: project });
  await git('init', '--quiet', '--template=');
  for (const [side, file] of Object.entries({ before, after })) {
    copyFileSync(file, join(project, 'pnpm-lock.yaml'));
    await git('add', '--all');
    await git(
      '-c',
      'user.name=LockCone Lab',
      '-c',
      'user.email=lab@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--allow-empty',
      '--message',
      side,
    );
  }
  const diff = (format) =>
    run(process.execPath, [cli, 'diff', '--cwd', project, '--format', format]);
  const [json, text] = await Promise.all([diff('json'), diff('text')]);
  writeFileSync(join(lab, `${label}-report.json`), json.stdout);
  writeFileSync(join(lab, `${label}-report.txt`), text.stdout);
  const { changes } = JSON.parse(json.stdout).tarballIntegrity;
  assert.equal(changes.length, loss ? 1 : 0);
  if (!loss) {
    assert.doesNotMatch(text.stdout, /Tarball integrity losses/);
    return;
  }

  const [change] = changes;
  assert.equal(change.packageKey, packageKey);
  assert.deepEqual(change.integrity, { before: expectedIntegrity, after: null });
  const directRoot = `dependency:${JSON.stringify([direct, 'dependencies', archiveName])}`;
  const transitiveRoot = `dependency:${JSON.stringify([transitive, 'dependencies', 'lab-direct'])}`;
  const directPath = [directRoot, packageKey];
  const transitivePath = [transitiveRoot, `workspace:${direct}`, ...directPath];
  for (const side of [change.base, change.head]) {
    assert.deepEqual(
      side.instances.map(({ id }) => id),
      [packageKey],
    );
    const consumers = side.instances.flatMap((instance) => instance.consumers);
    assert.deepEqual(
      consumers.map(({ workspace, relation, path }) => [workspace, relation, path]),
      [
        [direct, 'direct', directPath],
        [transitive, 'transitive', transitivePath],
      ],
    );
  }
  assert.match(text.stdout, /Tarball integrity losses/);
  assert(text.stdout.includes(`resolution.integrity: ${expectedIntegrity} → (absent)`));
  for (const path of [directPath, transitivePath])
    assert(text.stdout.includes(path.join(' → ')));
  assert(!text.stdout.includes(independent));
}

console.log(`Lab files: ${lab}`);
writeFileSync(join(lab, 'lab-tarball.tgz'), archive);
await new Promise((listening, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', listening);
});
try {
  const before = await runVersion('published', beforeCli);
  const after = await runVersion('backport', afterCli);
  await checkReport(
    'published',
    before.initial,
    before.updated,
    before.updatedIntegrity === null,
  );
  assert.equal(after.updatedIntegrity, expectedIntegrity);
  await checkReport('backport', after.initial, after.updated, false);
  if (before.updatedIntegrity !== null) {
    const synthetic = join(lab, 'synthetic-integrity-loss.yaml');
    const lockfile = parse(readFileSync(before.updated, 'utf8'));
    delete lockfile.packages[packageKey].resolution.integrity;
    writeFileSync(synthetic, stringify(lockfile));
    await checkReport('synthetic', before.updated, synthetic, true);
  }
  console.log('LockCone reports passed.');
} finally {
  server.close();
}
