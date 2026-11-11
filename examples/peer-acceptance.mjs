// Peer context validation: pnpm/pnpm#14895, reproduced with pnpm 12.4.1.
//
//   pnpm build
//   node examples/peer-acceptance.mjs
//
// The lockfiles under tests/fixtures/peers/pnpm-14895 were written by pnpm 12.4.1 on
// the upstream fixture; docs/acceptance/pnpm-14895/README.md records how. This script
// commits them to a throwaway Git repository, runs the public CLI on those revisions,
// and checks the reported bindings against the raw lockfiles with code that does not
// import LockCone. It installs nothing, runs no pnpm, and needs no network. Results go
// to docs/acceptance/pnpm-14895/evidence.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const project = fileURLToPath(new URL('../', import.meta.url));
const fixtures = join(project, 'tests/fixtures/peers/pnpm-14895');
const files = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'];
// `control` repeats the second pass: pnpm's third pass wrote the same bytes.
const steps = [
  ['initial', 'initial'],
  ['pass1', 'pass1'],
  ['pass2', 'pass2'],
  ['control', 'pass2'],
];
// SHA-256 of the pass 1 and pass 2 lockfiles as reported in the upstream issue.
const upstream = {
  pass1: '26efc464356b21b3ea02317e7cc3c18860491948eeeb0eb44e2eefccac206adf',
  pass2: 'fad156b8804d51f7e5a8f875f347cbb08969c0131712b48e016f050f95e4635e',
};
const temporary = mkdtempSync(join(tmpdir(), 'lockcone-peer-acceptance-'));

const git = (...args) =>
  execFileSync('git', args, { cwd: temporary, encoding: 'utf8' }).trim();
const lockcone = (...args) =>
  execFileSync(
    process.execPath,
    [join(project, 'dist/cli/index.js'), ...args, '--cwd', temporary],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const read = (side) => ({
  manifest: JSON.parse(readFileSync(join(fixtures, side, 'package.json'), 'utf8')),
  lockfile: parse(readFileSync(join(fixtures, side, 'pnpm-lock.yaml'), 'utf8')),
});

// Whether the raw lockfile holds the edge between two consecutive path nodes.
function hasEdge(lockfile, from, to) {
  if (from.startsWith('dependency:')) {
    const [importer, section, name] = JSON.parse(from.slice('dependency:'.length));
    return `${name}@${lockfile.importers[importer][section][name].version}` === to;
  }
  const snapshot = lockfile.snapshots[from];
  return ['dependencies', 'optionalDependencies'].some((section) =>
    Object.entries(snapshot[section] ?? {}).some(
      ([name, version]) => `${name}@${version}` === to,
    ),
  );
}

try {
  git('init', '--quiet');
  const revisions = {};
  const hashes = {};
  for (const [tag, side] of steps) {
    for (const file of files)
      copyFileSync(join(fixtures, side, file), join(temporary, file));
    git('add', '--all');
    git(
      '-c',
      'user.name=lockcone',
      '-c',
      'user.email=lockcone@example.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '--message',
      tag,
    );
    revisions[tag] = git('rev-parse', 'HEAD');
    hashes[tag] = Object.fromEntries(
      files.map((file) => [file, sha256(join(fixtures, side, file))]),
    );
  }

  const before = read('pass1');
  const after = read('pass2');

  // The pair differs in the lockfile only, and no package version differs.
  assert.equal(hashes.pass1['package.json'], hashes.pass2['package.json']);
  assert.equal(
    hashes.pass1['pnpm-workspace.yaml'],
    hashes.pass2['pnpm-workspace.yaml'],
  );
  assert.notEqual(hashes.pass1['pnpm-lock.yaml'], hashes.pass2['pnpm-lock.yaml']);
  assert.deepEqual(
    Object.keys(before.lockfile.packages).sort(),
    Object.keys(after.lockfile.packages).sort(),
  );
  const keys = (lockfile) => new Set(Object.keys(lockfile.snapshots));
  const removed = [...keys(before.lockfile)].filter(
    (key) => !keys(after.lockfile).has(key),
  );
  const added = [...keys(after.lockfile)].filter(
    (key) => !keys(before.lockfile).has(key),
  );
  assert.deepEqual(removed.sort(), [
    'debug@4.4.3',
    'vite-plugin-node@8.0.0(vite@8.3.7)',
  ]);
  assert.deepEqual(added.sort(), [
    'debug@4.4.3(supports-color@7.2.0)',
    'vite-plugin-node@8.0.0(supports-color@7.2.0)(vite@8.3.7)',
  ]);

  // Independent reading of the metadata and snapshot edges behind each binding.
  const packages = after.lockfile.packages;
  const snapshots = after.lockfile.snapshots;
  const debugKey = 'debug@4.4.3(supports-color@7.2.0)';
  const pluginKey = 'vite-plugin-node@8.0.0(supports-color@7.2.0)(vite@8.3.7)';
  const independent = {
    debug: {
      declaration: packages['debug@4.4.3'].peerDependencies['supports-color'],
      optional: packages['debug@4.4.3'].peerDependenciesMeta['supports-color'].optional,
      baseEdge:
        before.lockfile.snapshots['debug@4.4.3'].optionalDependencies?.[
          'supports-color'
        ] ??
        before.lockfile.snapshots['debug@4.4.3'].dependencies?.['supports-color'] ??
        null,
      headEdge: snapshots[debugKey].optionalDependencies['supports-color'],
      providerSnapshot: Object.hasOwn(snapshots, 'supports-color@7.2.0'),
    },
    vitePluginNode: {
      declaresSupportsColor: Object.hasOwn(
        packages['vite-plugin-node@8.0.0'].peerDependencies,
        'supports-color',
      ),
      declaresVite: packages['vite-plugin-node@8.0.0'].peerDependencies.vite,
      headDebugEdge: snapshots[pluginKey].dependencies.debug,
      headViteEdge: snapshots[pluginKey].dependencies.vite,
      headTransitivePeers: snapshots[pluginKey].transitivePeerDependencies,
      baseTransitivePeers:
        before.lockfile.snapshots['vite-plugin-node@8.0.0(vite@8.3.7)']
          .transitivePeerDependencies ?? null,
      importer:
        after.lockfile.importers['.'].devDependencies['vite-plugin-node'].version,
    },
  };
  assert.deepEqual(independent.debug, {
    declaration: '*',
    optional: true,
    baseEdge: null,
    headEdge: '7.2.0',
    providerSnapshot: true,
  });
  assert.deepEqual(independent.vitePluginNode, {
    declaresSupportsColor: false,
    declaresVite: '^8.0.0',
    headDebugEdge: '4.4.3(supports-color@7.2.0)',
    headViteEdge: '8.3.7',
    headTransitivePeers: ['supports-color'],
    // pnpm lists the unresolved optional peer before any provider is bound, so the
    // list alone is not evidence of a binding.
    baseTransitivePeers: ['supports-color'],
    importer: '8.0.0(supports-color@7.2.0)(vite@8.3.7)',
  });

  // The public CLI on the two revisions.
  const range = `${revisions.pass1}..${revisions.pass2}`;
  const report = JSON.parse(lockcone('diff', range, '--format', 'json'));
  const text = lockcone('diff', range);
  const whyDebug = lockcone(
    'why',
    'debug',
    '--base',
    revisions.pass1,
    '--head',
    revisions.pass2,
  );
  assert.equal(report.schemaVersion, 4);
  assert.equal(report.peerBindings.reportVersion, 1);
  assert.deepEqual(
    report.peerBindings.changes.map((change) => `${change.name}@${change.version}`),
    ['debug@4.4.3', 'vite-plugin-node@8.0.0'],
  );
  const [debug, plugin] = report.peerBindings.changes;

  assert.deepEqual(
    debug.correspondences.map((pair) => [pair.base, pair.head, pair.established]),
    [['debug@4.4.3', debugKey, true]],
  );
  const debugBinding = debug.head[0].bindings.find(
    (binding) => binding.peer === 'supports-color',
  );
  assert.equal(debugBinding.kind, 'direct');
  assert.equal(debugBinding.declaration.range, independent.debug.declaration);
  assert.equal(debugBinding.declaration.optional, independent.debug.optional);
  assert.equal(debugBinding.edge.section, 'optionalDependencies');
  assert.equal(
    debugBinding.edge.target,
    `supports-color@${independent.debug.headEdge}`,
  );
  assert.equal(
    debug.base[0].bindings.find((binding) => binding.peer === 'supports-color').kind,
    'unbound',
  );

  assert.deepEqual(
    plugin.correspondences.map((pair) => [pair.base, pair.head, pair.support]),
    [['vite-plugin-node@8.0.0(vite@8.3.7)', pluginKey, 'same-holder']],
  );
  const inherited = plugin.head[0].bindings.find(
    (binding) => binding.peer === 'supports-color',
  );
  assert.equal(inherited.kind, 'transitive');
  assert.equal(inherited.declaration, null);
  assert.equal(inherited.listedTransitive, true);
  assert.ok(
    !plugin.base[0].bindings.some((binding) => binding.peer === 'supports-color'),
  );
  assert.deepEqual(plugin.base[0].transitivePeerDependencies, ['supports-color']);
  assert.deepEqual(
    inherited.inheritedThrough.map((edge) => [edge.name, edge.target]),
    [['debug', `debug@${independent.vitePluginNode.headDebugEdge}`]],
  );
  const vite = plugin.head[0].bindings.find((binding) => binding.peer === 'vite');
  assert.equal(vite.kind, 'direct');
  assert.equal(vite.edge.target, `vite@${independent.vitePluginNode.headViteEdge}`);

  // Every consumer path is a chain of edges of the raw lockfile and ends at the instance.
  const paths = [];
  for (const change of report.peerBindings.changes)
    for (const [side, state] of [
      ['base', before],
      ['head', after],
    ])
      for (const instance of change[side]) {
        assert.ok(instance.consumers.length > 0);
        for (const consumer of instance.consumers) {
          assert.equal(consumer.path.at(-1), instance.id);
          for (let index = 1; index < consumer.path.length; index++)
            assert.ok(
              hasEdge(state.lockfile, consumer.path[index - 1], consumer.path[index]),
            );
          paths.push({ side, instance: instance.id, ...consumer });
        }
      }

  // The observation explains nothing by itself: the groups keep their classification.
  assert.equal(report.summary.unknown, report.changes.length);
  assert.equal(report.changes.length, 3);
  assert.deepEqual(report.warnings, []);
  assert.ok(text.includes('debug@4.4.3 → debug@4.4.3(supports-color@7.2.0)'));
  assert.ok(
    whyDebug.includes('optionalDependencies.supports-color -> supports-color@7.2.0'),
  );

  // Control: the same lockfile bytes on both sides.
  const control = JSON.parse(
    lockcone('diff', `${revisions.pass2}..${revisions.control}`, '--format', 'json'),
  );
  assert.deepEqual(control.peerBindings.changes, []);
  assert.deepEqual(control.changes, []);

  // The first pass also moved packages that newer registry releases replaced.
  const first = JSON.parse(
    lockcone('diff', `${revisions.initial}..${revisions.pass1}`, '--format', 'json'),
  );
  const firstPass = first.peerBindings.changes.map((change) => ({
    package: `${change.name}@${change.version}`,
    shape: change.shape,
    events: change.events,
  }));
  assert.ok(
    firstPass.some(
      (item) =>
        item.package === 'debug@4.4.3' && item.events.includes('provider-removed'),
    ),
  );

  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('Peer context changes'));
  writeFileSync(
    join(project, 'docs/acceptance/pnpm-14895/evidence.json'),
    `${JSON.stringify(
      {
        issue: 'https://github.com/pnpm/pnpm/issues/14895',
        fixture: 'https://github.com/orgads/pnpm-update-optional-peer-fixture',
        fixtureRevision: 'dbbfb3ef5afa82bf9c0419ff7f4db1e873fa0e35',
        inputs: hashes,
        upstreamLockfileHashes: upstream,
        matchesUpstreamLockfiles:
          hashes.pass1['pnpm-lock.yaml'] === upstream.pass1 &&
          hashes.pass2['pnpm-lock.yaml'] === upstream.pass2,
        lockcone: { command: 'lockcone diff PASS1..PASS2 --format json' },
        snapshotKeys: { removed: removed.sort(), added: added.sort() },
        independent,
        peerBindings: report.peerBindings,
        consumerPaths: paths,
        summary: report.summary,
        warnings: report.warnings,
        control: {
          peerContextChanges: control.peerBindings.changes.length,
          groups: control.changes.length,
        },
        firstPass: {
          groups: first.changes.length,
          summary: first.summary,
          peerContextChanges: firstPass,
        },
        textExcerpt: lines.slice(
          start,
          lines.findIndex((line, index) => index > start && line === ''),
        ),
      },
      null,
      2,
    )}\n`,
  );
  console.log('Peer binding evidence agrees with the raw lockfiles.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
