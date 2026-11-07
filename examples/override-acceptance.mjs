// External override validation: nitsuah/farm-3j, pull request 416 (merged).
//
//   pnpm build
//   node examples/override-acceptance.mjs [/path/to/farm-3j]
//
// Runs the public CLI on two pinned commits and checks its override evidence against
// Git and the raw lockfile with code that does not import LockCone. The upstream
// repository is cloned without a checkout, so no hook, script, or dependency of the
// target runs and no file of it is created. Without an argument the script clones into
// temporary storage; this needs network access. Results go to
// docs/acceptance/farm-3j/evidence.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';

const project = fileURLToPath(new URL('../', import.meta.url));
const repository = 'https://github.com/nitsuah/farm-3j.git';
const base = 'f509a0c41604139766ba0e6d4bfbe18413479625';
const head = 'e9aa40fb36eaaf770587fbcfcc95d470abfd6fa7';
// The squash commit of the merged pull request has the same parent.
const merge = 'd708cc7a55aa6fe12c0240db7976ca7a1bd7de3e';
const selector = 'postcss';
const temporary = mkdtempSync(join(tmpdir(), 'lockcone-override-acceptance-'));

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

// A partial clone fetches blobs lazily, and a batch of fetches can fail transiently.
function lockcone(upstream, command, format) {
  let failure;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return execFileSync(
        process.execPath,
        [
          join(project, 'dist/cli/index.js'),
          command,
          '--cwd',
          upstream,
          '--base',
          base,
          '--head',
          head,
          '--format',
          format,
        ],
        {
          encoding: 'utf8',
          maxBuffer: 512 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}

// Independent reading of one side: the manifest, the recorded override, and every
// dependency entry whose alias is the overridden package.
function inspect(upstream, revision) {
  const show = (path) => git(upstream, 'show', `${revision}:${path}`).toString('utf8');
  const manifest = JSON.parse(show('package.json'));
  const lockfile = parseAllDocuments(show('pnpm-lock.yaml')).at(-1).toJS();
  const entries = [];
  for (const [importer, value] of Object.entries(lockfile.importers))
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'])
      for (const [name, entry] of Object.entries(value[section] ?? {}))
        if (name === selector)
          entries.push({
            holder: `importer ${importer} ${section}`,
            specifier: entry.specifier,
            version: entry.version,
            peer: false,
          });
  for (const [key, snapshot] of Object.entries(lockfile.snapshots)) {
    const metadata = lockfile.packages[key.split('(')[0]];
    for (const section of ['dependencies', 'optionalDependencies'])
      if (selector in (snapshot[section] ?? {}))
        entries.push({
          holder: key,
          specifier: null,
          version: snapshot[section][selector],
          peer: Object.hasOwn(metadata?.peerDependencies ?? {}, selector),
        });
  }
  let workspace = {};
  const tree = git(upstream, 'ls-tree', '--name-only', revision).toString().split('\n');
  if (tree.includes('pnpm-workspace.yaml'))
    workspace = parse(show('pnpm-workspace.yaml'));
  return {
    revision,
    packageManager: manifest.packageManager,
    declared: manifest.pnpm?.overrides?.[selector] ?? null,
    declaredOverrideCount: Object.keys(manifest.pnpm?.overrides ?? {}).length,
    resolutions: manifest.resolutions ?? null,
    workspaceOverrides: workspace?.overrides ?? null,
    recorded: lockfile.overrides?.[selector] ?? null,
    recordedOverrideCount: Object.keys(lockfile.overrides ?? {}).length,
    edges: entries,
  };
}

try {
  const upstream = process.argv[2]
    ? resolve(process.argv[2])
    : join(temporary, 'farm-3j');
  if (!process.argv[2])
    git(
      temporary,
      'clone',
      '--quiet',
      '--filter=blob:none',
      '--no-checkout',
      repository,
      upstream,
    );
  for (const revision of [base, head, merge])
    assert.equal(
      git(upstream, 'rev-parse', `${revision}^{commit}`).toString().trim(),
      revision,
    );
  assert.equal(git(upstream, 'rev-parse', `${head}^`).toString().trim(), base);
  assert.equal(git(upstream, 'rev-parse', `${merge}^`).toString().trim(), base);
  assert.equal(
    git(upstream, 'rev-parse', `${head}^{tree}`).toString().trim(),
    git(upstream, 'rev-parse', `${merge}^{tree}`).toString().trim(),
  );
  const changedFiles = git(upstream, 'diff', '--name-only', base, head)
    .toString()
    .trim()
    .split('\n');
  assert.deepEqual(changedFiles, ['pnpm-lock.yaml']);

  const report = JSON.parse(lockcone(upstream, 'explain', 'json'));
  const text = lockcone(upstream, 'diff', 'text');
  const seen = { base: inspect(upstream, base), head: inspect(upstream, head) };

  // The facts the report must reproduce.
  assert.equal(seen.base.packageManager, 'pnpm@9.0.0');
  assert.equal(seen.base.declared, '8.5.32');
  assert.equal(seen.head.declared, '8.5.32');
  assert.equal(seen.base.recorded, '8.5.31');
  assert.equal(seen.head.recorded, '8.5.32');
  assert.equal(seen.base.workspaceOverrides, null);
  assert.equal(seen.base.resolutions, null);

  assert.equal(report.base, base);
  assert.equal(report.head, head);
  assert.equal(report.schemaVersion, 4);
  assert.equal(report.overrides.reportVersion, 1);
  assert.deepEqual(
    report.overrides.changes.map((item) => item.selector),
    [selector],
  );
  const [change] = report.overrides.changes;
  assert.deepEqual(change.events, ['lockfile-record-changed']);
  for (const side of ['base', 'head']) {
    assert.equal(change[side].declaration.source, 'package.json#pnpm');
    assert.equal(change[side].declaration.sourceStatus, 'active');
    assert.equal(change[side].declaration.value, seen[side].declared);
    assert.equal(change[side].lockfile.value, seen[side].recorded);
  }
  assert.equal(change.base.consistency, 'record-differs');
  assert.equal(change.head.consistency, 'consistent');
  assert.equal(change.attribution.level, 'incomplete');

  // Every edge with this alias resolves to the recorded version on the head side and
  // to a different one on the base side. LockCone counts the non-peer ones as governed.
  const independent = (side) => {
    const edges = seen[side].edges;
    const regular = edges.filter((edge) => !edge.peer);
    return {
      edges: edges.length,
      peers: edges.length - regular.length,
      governed: regular.length,
      violating: regular.filter(
        (edge) => edge.version.split('(')[0] !== seen[side].declared,
      ).length,
    };
  };
  for (const side of ['base', 'head']) {
    const raw = independent(side);
    const counts = change[side].edges;
    assert.equal(counts.candidates, raw.edges);
    assert.equal(counts.peer, raw.peers);
    assert.equal(counts.governed, raw.governed);
    assert.equal(counts.violating, raw.violating);
  }
  assert.equal(independent('head').violating, 0);
  assert.ok(independent('base').violating > 0);

  // Each listed edge appears in the raw lockfile with the reported targets.
  const rawTargets = (side, holder) =>
    seen[side].edges
      .filter((edge) => edge.holder === holder)
      .map((edge) => edge.version.split('(')[0]);
  for (const edge of change.edges) {
    for (const side of ['base', 'head']) {
      const entry = edge[side];
      if (!entry) continue;
      const key = entry.holder.startsWith('dependency:')
        ? `importer ${JSON.parse(entry.holder.slice(11)).slice(0, 2).join(' ')}`
        : entry.holder;
      assert.deepEqual(rawTargets(side, key), [entry.targetVersion]);
      assert.ok(entry.consumers.length > 0);
      for (const consumer of entry.consumers) {
        assert.ok(consumer.path.at(-1) === entry.target);
        assert.equal(consumer.workspace, '.');
      }
    }
  }
  // The unchanged declaration is not reported as a declaration event.
  assert.ok(!change.events.some((event) => event.startsWith('declaration-')));

  // Where the new logic stops: the manifest/lockfile mismatches keep every group unknown.
  const mismatches = report.warnings.filter((item) =>
    item.startsWith('Manifest/lockfile mismatch'),
  );
  assert.ok(mismatches.length > 0);
  assert.equal(report.summary.explained, 0);
  assert.equal(report.summary.unknown, report.changes.length);
  assert.ok(!report.warnings.includes('Lockfile resolution configuration changed.'));
  const linked = report.changes
    .filter((item) => item.evidence.some((entry) => entry.via))
    .map((item) => ({ name: item.name, kind: item.kind, confidence: item.confidence }));

  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith('Override changes'));
  const excerpt = lines.slice(
    start,
    lines.findIndex((line, i) => i > start && line === ''),
  );
  writeFileSync(
    join(project, 'docs/acceptance/farm-3j/evidence.json'),
    `${JSON.stringify(
      {
        repository,
        pullRequest: 'https://github.com/nitsuah/farm-3j/pull/416',
        base,
        head,
        merge,
        lockcone: { command: 'lockcone explain --format json --base BASE --head HEAD' },
        independent: seen,
        counts: { base: independent('base'), head: independent('head') },
        overrides: report.overrides,
        groupsLinkedToOverride: linked,
        warnings: report.warnings,
        summary: report.summary,
        groups: report.changes.length,
        textExcerpt: excerpt,
      },
      null,
      2,
    )}\n`,
  );
  console.log('Override evidence agrees with Git and the raw lockfile.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
