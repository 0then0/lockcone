// External patch validation: radix-ui/primitives, "pnpm 11 migration".
//
//   pnpm build
//   node examples/patch-acceptance.mjs [/path/to/primitives]
//
// Runs the public CLI on two pinned upstream commits and checks its patch evidence
// against Git and the raw lockfile with code that does not import LockCone. The
// upstream repository is cloned without a checkout, so no hook, script, or
// dependency of the target runs and no file of it is created. Without an argument
// the script clones into temporary storage; this needs network access. Results go
// to docs/acceptance/radix-primitives/evidence.json.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';

const project = fileURLToPath(new URL('../', import.meta.url));
const repository = 'https://github.com/radix-ui/primitives.git';
const base = 'da4175faf82a3f0bbf8d290b1caddf47ced7a4e7';
const head = '3bc7532514ef1451d09648fc98d3ed8ddfcc55f4';
const patchPath = 'patches/@changesets__apply-release-plan.patch';
const temporary = mkdtempSync(join(tmpdir(), 'lockcone-patch-acceptance-'));

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, maxBuffer: 256 * 1024 * 1024 });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

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

// Independent reading of one side: raw lockfile, manifests, and the patch blob.
function inspect(upstream, revision) {
  const show = (path) => git(upstream, 'show', `${revision}:${path}`);
  const documents = parseAllDocuments(show('pnpm-lock.yaml').toString('utf8'));
  const lockfile = documents.at(-1).toJS();
  const patched = Object.entries(lockfile.patchedDependencies ?? {});
  assert.equal(patched.length, 1, `${revision}: one patchedDependencies entry`);
  const [selector, recorded] = patched[0];
  const hash = typeof recorded === 'string' ? recorded : recorded.hash;
  const keys = Object.keys(lockfile.snapshots).filter((key) =>
    key.startsWith('@changesets/apply-release-plan@'),
  );
  assert.equal(keys.length, 1, `${revision}: one apply-release-plan snapshot`);
  assert.ok(
    keys[0].includes(`(patch_hash=${hash})`),
    'snapshot carries the lockfile hash',
  );

  // Reverse reachability over the raw snapshots, by key, from the patched snapshot.
  const parents = new Map();
  for (const [key, snapshot] of Object.entries(lockfile.snapshots))
    for (const section of ['dependencies', 'optionalDependencies'])
      for (const [name, reference] of Object.entries(snapshot[section] ?? {})) {
        const target = reference.startsWith('npm:')
          ? reference.slice(4)
          : `${name}@${reference}`;
        parents.set(target, [...(parents.get(target) ?? []), key]);
      }
  const importers = [];
  for (const [importer, value] of Object.entries(lockfile.importers))
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'])
      for (const [name, entry] of Object.entries(value[section] ?? {}))
        importers.push({ importer, section, name, target: `${name}@${entry.version}` });
  const reached = new Map([[keys[0], [keys[0]]]]);
  const queue = [keys[0]];
  for (let index = 0; index < queue.length; index++)
    for (const parent of parents.get(queue[index]) ?? [])
      if (!reached.has(parent)) {
        reached.set(parent, [parent, ...reached.get(queue[index])]);
        queue.push(parent);
      }
  const consumers = importers
    .filter((entry) => reached.has(entry.target))
    .map((entry) => ({
      importer: entry.importer,
      section: entry.section,
      path: reached.get(entry.target),
    }));

  const blob = show(patchPath);
  const manifest = JSON.parse(show('package.json').toString('utf8'));
  let workspace = {};
  try {
    workspace = parse(show('pnpm-workspace.yaml').toString('utf8'));
  } catch {
    // pnpm 10 layout: the file has no patch settings.
  }
  return {
    revision,
    packageManager: manifest.packageManager,
    packageJsonPatchedDependencies: manifest.pnpm?.patchedDependencies ?? null,
    workspacePatchedDependencies: workspace.patchedDependencies ?? null,
    lockfileSelector: selector,
    lockfileEntry: recorded,
    lockfileHash: hash,
    snapshot: keys[0],
    patchBlob: git(upstream, 'rev-parse', `${revision}:${patchPath}`).toString().trim(),
    patchSha256: sha256(blob),
    patchBytes: blob.length,
    consumers,
  };
}

try {
  const upstream = process.argv[2]
    ? resolve(process.argv[2])
    : join(temporary, 'primitives');
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
  for (const revision of [base, head])
    assert.equal(
      git(upstream, 'rev-parse', `${revision}^{commit}`).toString().trim(),
      revision,
    );

  const report = JSON.parse(lockcone(upstream, 'explain', 'json'));
  const text = lockcone(upstream, 'diff', 'text');
  const independent = { base: inspect(upstream, base), head: inspect(upstream, head) };

  // Compare LockCone's evidence with the independent reading.
  assert.equal(report.base, base);
  assert.equal(report.head, head);
  assert.equal(report.patches.changes.length, 1);
  const [change] = report.patches.changes;
  assert.equal(change.selector.head, independent.head.lockfileSelector);
  for (const side of ['base', 'head']) {
    const seen = independent[side];
    assert.equal(change[side].file.sha256, seen.patchSha256);
    assert.equal(change[side].file.size, seen.patchBytes);
    assert.equal(change[side].file.gitBlob, seen.patchBlob);
    assert.equal(change[side].lockfile.hash, seen.lockfileHash);
    assert.equal(change[side].instances.length, 1);
    assert.equal(change[side].instances[0].id, seen.snapshot);
    assert.equal(change[side].instances[0].association, 'lockfile-confirmed');
    // Every importer that reaches the patched snapshot, and only those.
    const found = change[side].instances[0].consumers
      .map((item) => item.workspace)
      .sort();
    assert.deepEqual(
      found,
      [...new Set(seen.consumers.map((item) => item.importer))].sort(),
    );
    for (const item of change[side].instances[0].consumers) {
      const raw = seen.consumers.find((entry) => entry.importer === item.workspace);
      assert.equal(item.path.at(-1), seen.snapshot);
      assert.deepEqual(item.path.slice(1), raw.path);
    }
  }
  assert.deepEqual(change.events, [
    'source-changed',
    'content-changed',
    'lockfile-hash-changed',
    'lockfile-shape-changed',
  ]);
  assert.equal(change.base.declarations[0].source, 'package.json#pnpm');
  assert.equal(change.head.declarations[0].source, 'pnpm-workspace.yaml');
  assert.notEqual(independent.base.patchSha256, independent.head.patchSha256);

  const block = text.split('\n');
  const start = block.findIndex((line) => line.startsWith('Patch changes'));
  const excerpt = block
    .slice(
      start,
      block.findIndex((line, i) => i > start && line === ''),
    )
    .join('\n');
  writeFileSync(
    join(project, 'docs/acceptance/radix-primitives/evidence.json'),
    `${JSON.stringify(
      {
        repository,
        base,
        head,
        patchPath,
        lockcone: { command: 'lockcone explain --format json --base BASE --head HEAD' },
        independent,
        patches: report.patches,
        textExcerpt: excerpt.split('\n'),
        warnings: report.warnings,
        summary: report.summary,
      },
      null,
      2,
    )}\n`,
  );
  console.log('Patch evidence agrees with Git and the raw lockfile.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
