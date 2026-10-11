// Metadata-only upstream acceptance. Requires an existing LockCone build and
// development dependencies; never installs or runs anything from ni.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { explain } from '../dist/analysis/explain.js';
import { readRepository } from '../dist/git/repository.js';
import { buildPnpmState } from '../dist/pnpm/dependency-graph.js';

const project = fileURLToPath(new URL('../', import.meta.url));
const repository = 'https://github.com/antfu-collective/ni.git';
const base = 'a8da02adf4f6168a2b3cf7dbd30d24c5cbfbf186';
const head = '0e9a94e76f28666161245da8bdf48c2b892f69ef';
const baselineRevision = '440cdae7345b2aab7e3fd84b0ad5a318c3a98673';
const temporary = mkdtempSync(join(tmpdir(), 'lockcone-catalog-acceptance-'));
const output = join(project, 'docs/acceptance/ni');
const commands = [];
const checksum = (value) => createHash('sha256').update(value).digest('hex');
function run(command, args, options = {}) {
  commands.push({ command, args, cwd: options.cwd ?? project });
  return execFileSync(command, args, { cwd: project, ...options });
}
function save(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
function sourceHashes(directory) {
  const files = ['package.json', 'pnpm-lock.yaml', 'tsconfig.json'];
  function walk(path) {
    for (const entry of readdirSync(join(directory, path), { withFileTypes: true })) {
      const child = `${path}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else files.push(child);
    }
  }
  walk('src');
  return Object.fromEntries(
    files.sort().map((path) => [path, checksum(readFileSync(join(directory, path)))]),
  );
}

try {
  const upstream = process.argv[2] ? resolve(process.argv[2]) : join(temporary, 'ni');
  if (!process.argv[2]) run('git', ['clone', '--no-checkout', repository, upstream]);
  const states = {};
  const inputs = {};
  for (const [side, revision] of [
    ['base', base],
    ['head', head],
  ]) {
    const state = await readRepository(upstream, revision);
    assert.equal(state.revision, revision);
    states[side] = state;
    inputs[side] = { revision, files: {} };
    for (const [path, source] of [...state.files].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const fixture = `tests/fixtures/ni/${side}/${path}`;
      save(join(project, fixture), source);
      inputs[side].files[path] = {
        fixture,
        gitBlob: run('git', ['rev-parse', `${revision}:${path}`], { cwd: upstream })
          .toString()
          .trim(),
        sha256: checksum(source),
      };
    }
  }
  assert.equal(
    states.base.files.get('package.json'),
    states.head.files.get('package.json'),
  );
  for (const [side, range, version] of [
    ['base', '^1.6.0', '1.6.0'],
    ['head', '^1.7.0', '1.7.0'],
  ]) {
    const parsed = buildPnpmState(states[side]);
    assert.equal(
      parsed.manifests.get('.').dependencies['package-manager-detector'],
      'catalog:prod',
    );
    assert.equal(parsed.catalogs.prod['package-manager-detector'], range);
    assert.equal(
      parsed.lockfile.importers['.'].dependencies['package-manager-detector'].version,
      version,
    );
  }
  const baseline = join(temporary, 'baseline');
  mkdirSync(baseline);
  const archive = run('git', ['archive', baselineRevision]);
  run('tar', ['-x', '-C', baseline], { input: archive });
  symlinkSync(join(project, 'node_modules'), join(baseline, 'node_modules'), 'dir');
  run(process.execPath, [
    join(project, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(baseline, 'tsconfig.json'),
  ]);
  const baselineExplain = (
    await import(pathToFileURL(join(baseline, 'dist/analysis/explain.js')))
  ).explain;
  const nonCatalogResults = {};
  for (const name of ['upgrade', 'workspace', 'peer']) {
    const paths = [
      'package.json',
      'pnpm-lock.yaml',
      ...(name === 'workspace'
        ? [
            'pnpm-workspace.yaml',
            'packages/app/package.json',
            'packages/ui/package.json',
          ]
        : []),
    ];
    const fixtureState = (side) => ({
      revision: side,
      files: new Map(
        paths.map((path) => [
          path,
          readFileSync(join(project, 'tests/fixtures', name, side, path), 'utf8'),
        ]),
      ),
    });
    const before = fixtureState('base');
    const after = fixtureState('head');
    const oldReport = baselineExplain(before, after);
    const newReport = explain(before, after);
    assert.deepEqual(newReport.summary, oldReport.summary);
    assert.deepEqual(newReport.warnings, oldReport.warnings);
    const evidence = (report) =>
      report.changes.map(
        ({ kind, name, scope, confidence, reason, changedNodes, evidence }) => ({
          kind,
          name,
          scope,
          confidence,
          reason,
          changedNodes,
          evidence,
        }),
      );
    assert.deepEqual(evidence(newReport), evidence(oldReport));
    assert.deepEqual(newReport.pathNodes, oldReport.pathNodes);
    nonCatalogResults[name] = {
      summary: newReport.summary,
      classificationAndEvidenceEqual: true,
    };
  }
  const analyzers = {};
  for (const [name, directory] of [
    ['baseline', baseline],
    ['v0.2', project],
  ]) {
    const cli = join(directory, 'dist/cli/index.js');
    const version = run(process.execPath, [cli, '--version']).toString().trim();
    assert.equal(version, name === 'baseline' ? '0.1.0' : '0.2.0');
    analyzers[name] = {
      version,
      sourceRevision: name === 'baseline' ? baselineRevision : null,
      sourceSHA256: sourceHashes(directory),
    };
    for (const format of ['json', 'text']) {
      const report = run(process.execPath, [
        cli,
        'diff',
        '--cwd',
        upstream,
        '--base',
        base,
        '--head',
        head,
        '--format',
        format,
      ]);
      save(join(output, `${name}.${format === 'json' ? 'json' : 'txt'}`), report);
    }
  }
  const before = JSON.parse(readFileSync(join(output, 'baseline.json')));
  const after = JSON.parse(readFileSync(join(output, 'v0.2.json')));
  assert.deepEqual(before.summary, {
    explained: 0,
    'partially-explained': 0,
    unexplained: 0,
    unknown: 6,
  });
  assert.deepEqual(after.summary, {
    explained: 2,
    'partially-explained': 0,
    unexplained: 4,
    unknown: 0,
  });
  assert.equal(after.warnings.length, 0);
  const reportSHA256 = Object.fromEntries(
    ['baseline.json', 'baseline.txt', 'v0.2.json', 'v0.2.txt'].map((path) => [
      path,
      checksum(readFileSync(join(output, path))),
    ]),
  );
  const commandPaths = {
    '<project>': 'LockCone checkout root',
    '<temporary>': 'Temporary clone/build directory created by the script',
    '<upstream>': 'Local ni repository containing both input commits',
    '<node>': 'Node.js executable used for this run',
  };
  const portablePaths = [
    [process.execPath, '<node>'],
    [upstream, '<upstream>'],
    [temporary, '<temporary>'],
    [project.replace(/\/$/, ''), '<project>'],
  ].sort(([a], [b]) => b.length - a.length);
  const portable = (value) => {
    for (const [path, placeholder] of portablePaths)
      value = value.replaceAll(path, placeholder);
    return value;
  };
  save(
    join(output, 'provenance.json'),
    `${JSON.stringify(
      {
        repository,
        base,
        head,
        inputs,
        analyzers,
        nodeVersion: process.version,
        packageManager: JSON.parse(readFileSync(join(project, 'package.json')))
          .packageManager,
        commandPaths,
        commands: commands.map(({ command, args, cwd }) => ({
          command: portable(command),
          args: args.map(portable),
          cwd: portable(cwd),
        })),
        reportSHA256,
        results: { baseline: before.summary, 'v0.2': after.summary },
        nonCatalogResults,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    JSON.stringify({ baseline: before.summary, 'v0.2': after.summary }, null, 2),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
