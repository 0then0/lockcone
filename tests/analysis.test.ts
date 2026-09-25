import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evidencePath } from '../src/analysis/diff.js';
import { explain, why } from '../src/analysis/explain.js';
import { configuredPatches } from '../src/git/repository.js';
import { dependencyId, workspaceId } from '../src/graph/dependency-graph.js';
import { dependencyPath, traverse } from '../src/graph/traversal.js';
import { renderJson } from '../src/output/json.js';
import { renderText } from '../src/output/text.js';
import { buildPnpmState } from '../src/pnpm/dependency-graph.js';
import { parseLockfile } from '../src/pnpm/lockfile-parser.js';
import { fixture, state } from './helpers.js';

describe('dependency cone analysis', () => {
  it('explains direct, transitive and optional upgrades, but not unrelated packages', () => {
    const report = explain(fixture('upgrade', 'base'), fixture('upgrade', 'head'));
    expect(report.warnings).toEqual([]);
    for (const name of ['vitest', 'vite', 'esbuild']) {
      const change = report.changes.find(
        (item) => item.kind === 'package' && item.name === name,
      )!;
      expect(change.confidence).toBe('explained');
      expect(change.evidence.map((item) => item.side)).toEqual(['base', 'head']);
    }
    expect(
      report.changes.find((item) => item.kind === 'package' && item.name === 'aws-sdk')
        ?.reason,
    ).toBe('UNEXPLAINED_BY_MANIFEST_CHANGE');
    const filtered = why(report, 'esbuild');
    expect(evidencePath(filtered, filtered.changes[0]!.evidence[1]!)).toEqual([
      dependencyId('.', 'devDependencies', 'vitest'),
      'vitest@4.1.11',
      'vite@7.0.1',
      'esbuild@0.25.9',
    ]);
  });

  it('reads workspace manifests and follows workspace links', () => {
    const base = fixture('workspace', 'base');
    const head = fixture('workspace', 'head');
    const report = explain(base, head);
    expect(report.warnings).toEqual([]);
    expect(
      report.changes.find((item) => item.name === 'paint' && item.kind === 'package')
        ?.confidence,
    ).toBe('explained');
    expect(
      report.manifestChanges.some(
        (item) => item.section === 'workspace' && item.name === 'ui',
      ),
    ).toBe(true);
    const graph = buildPnpmState(head).graph;
    const root = dependencyId('packages/app', 'dependencies', 'ui');
    const path = dependencyPath('paint@1.1.0', traverse(graph, [root]));
    expect(path).toEqual([
      root,
      workspaceId('packages/ui'),
      dependencyId('packages/ui', 'dependencies', 'paint'),
      'paint@1.1.0',
    ]);
  });

  it('reports peer context changes as unknown', () => {
    const report = explain(fixture('peer', 'base'), fixture('peer', 'head'));
    expect(
      report.changes.find((item) => item.kind === 'package' && item.name === 'plugin')
        ?.confidence,
    ).toBe('unknown');
    expect(
      report.changes.find(
        (item) => item.kind === 'dependency' && item.name === 'plugin',
      )?.confidence,
    ).toBe('unknown');
  });

  it('does not turn a project version bump into dependency intent', () => {
    const build = (version: string, resolution: string) =>
      state(
        { name: 'app', version, dependencies: { a: '^1.0.0' } },
        { '.': { dependencies: { a: { specifier: '^1.0.0', version: resolution } } } },
        { [`a@${resolution}`]: {} },
      );
    const report = explain(build('1.0.0', '1.0.0'), build('1.1.0', '1.1.0'));
    expect(report.changes.find((item) => item.name === 'app')?.confidence).toBe(
      'explained',
    );
    expect(
      report.changes
        .filter((item) => item.name === 'a')
        .every((item) => item.confidence === 'unexplained'),
    ).toBe(true);
  });

  it('excludes workspace development tools from a consuming package cone', () => {
    const base = fixture('workspace', 'base');
    const head = fixture('workspace', 'head');
    for (const side of [base, head]) {
      const version = side === base ? '1.0.0' : '1.1.0';
      side.files.set(
        'packages/ui/package.json',
        JSON.stringify({
          name: 'ui',
          version: '1.0.0',
          devDependencies: { paint: '^1.0.0' },
        }),
      );
      side.files.set(
        'pnpm-lock.yaml',
        side.files
          .get('pnpm-lock.yaml')!
          .replace(`paint: {specifier: ${version}`, 'paint: {specifier: ^1.0.0')
          .replace(
            '  packages/ui:\n    dependencies:',
            '  packages/ui:\n    devDependencies:',
          ),
      );
    }
    head.files.set(
      'packages/app/package.json',
      '{"name":"app","dependencies":{"ui":"workspace:^"}}',
    );
    head.files.set(
      'pnpm-lock.yaml',
      head.files.get('pnpm-lock.yaml')!.replace('workspace:*', 'workspace:^'),
    );
    const report = explain(base, head);
    expect(report.warnings).toEqual([]);
    expect(
      report.changes
        .filter((item) => item.name === 'paint')
        .every((item) => item.confidence === 'unexplained'),
    ).toBe(true);
  });

  it('reads the real pnpm-generated project lockfile including its environment document', () => {
    const files = new Map(
      ['package.json', 'pnpm-lock.yaml'].map((path) => [
        path,
        readFileSync(path, 'utf8'),
      ]),
    );
    const repository = { revision: 'self', files };
    const parsed = buildPnpmState(repository);
    expect(parsed.lockfile.environment).toBeDefined();
    expect(parsed.graph.nodes.has('commander@15.0.0')).toBe(true);
    expect(parsed.graph.warnings).toEqual([]);
    expect(explain(repository, repository).changes).toEqual([]);
  });

  it('warns if the environment changes and rejects unrelated YAML documents', () => {
    const base = fixture('upgrade', 'base');
    const head = fixture('upgrade', 'head');
    const environment =
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    packageManagerDependencies:\n      pnpm: {specifier: '12.5.1', version: '12.5.1'}\n---\n";
    base.files.set('pnpm-lock.yaml', environment + base.files.get('pnpm-lock.yaml'));
    head.files.set(
      'pnpm-lock.yaml',
      environment.replaceAll('12.5.1', '12.6.0') + head.files.get('pnpm-lock.yaml'),
    );
    expect(
      explain(base, head).changes.every((item) => item.confidence === 'unknown'),
    ).toBe(true);
    expect(() =>
      parseLockfile(
        "lockfileVersion: '9.0'\nimporters: {}\n---\nlockfileVersion: '9.0'\nimporters: {}\n",
      ),
    ).toThrow('environment document');
  });

  it('retains new workspace manifests and reports a missing lockfile importer', () => {
    const base = state({}, { '.': {} }, {});
    base.files.set('pnpm-workspace.yaml', "packages: ['packages/**']\n");
    const head = { ...base, files: new Map(base.files) };
    head.files.set(
      'packages/new/package.json',
      JSON.stringify({
        name: 'new-package',
        version: '1.0.0',
        dependencies: { added: '^1.0.0' },
      }),
    );
    const report = explain(base, head);
    expect(report.manifestChanges).toContainEqual(
      expect.objectContaining({
        manifest: 'packages/new/package.json',
        section: 'dependencies',
        name: 'added',
        before: null,
        after: '^1.0.0',
      }),
    );
    expect(report.warnings).toContain(
      'Manifest/lockfile mismatch: packages/new/package.json has no importer.',
    );
    expect(
      report.changes.some(
        (change) => change.kind === 'dependency' && change.name === 'added',
      ),
    ).toBe(true);
    expect(report.changes.find((change) => change.name === 'added')?.confidence).toBe(
      'unknown',
    );
  });

  it('ignores unconfigured patch files and fixture hooks when classifying changes', () => {
    const base = fixture('upgrade', 'base');
    const head = fixture('upgrade', 'head');
    head.files.set('docs/examples/demo.patch', 'documentation only');
    for (const side of [base, head])
      side.files.set('tests/fixtures/hook/.pnpmfile.cjs', 'not executed');
    const report = explain(base, head);
    expect(report.summary.unknown).toBe(0);
    expect(report.summary.explained).toBe(4);
    expect(report.warnings).toEqual([]);
  });

  it('marks only configured patch changes as uncertain', () => {
    const build = (contents: string) => {
      const repository = state(
        { dependencies: { a: '1.0.0' } },
        {
          '.': { dependencies: { a: { specifier: '1.0.0', version: '1.0.0' } } },
        },
        { 'a@1.0.0': {} },
        { patchedDependencies: { 'a@1.0.0': 'patch-hash' } },
      );
      repository.files.set(
        'pnpm-workspace.yaml',
        'patchedDependencies:\n  a@1.0.0: patches/a.patch\n',
      );
      repository.files.set('patches/a.patch', contents);
      return repository;
    };
    const report = explain(build('before'), build('after'));
    expect(report.warnings).toContain('Resolution input changed: patches/a.patch');
    expect(report.changes.every((change) => change.confidence === 'unknown')).toBe(
      true,
    );
  });

  it('marks configured patch files missing on either side as unknown', () => {
    const build = (version: string) => {
      const repository = state(
        { dependencies: { a: version } },
        { '.': { dependencies: { a: { specifier: version, version } } } },
        { [`a@${version}`]: {} },
      );
      repository.files.set(
        'pnpm-workspace.yaml',
        'patchedDependencies:\n  a@1.0.0: ./patches/a.patch\n',
      );
      return repository;
    };
    const report = explain(build('1.0.0'), build('2.0.0'));
    expect(report.warnings).toContain(
      'Configured patch file is missing: patches/a.patch',
    );
    expect(report.changes.find((change) => change.name === 'a')?.confidence).toBe(
      'unknown',
    );
  });

  it('finds patch paths in pnpm 10 lockfiles and pnpm 11+ workspace config', () => {
    expect(
      configuredPatches(
        new Map([
          [
            'pnpm-lock.yaml',
            "lockfileVersion: '9.0'\npatchedDependencies:\n  a@1.0.0:\n    hash: abc\n    path: ./patches/a.patch\n",
          ],
        ]),
      ),
    ).toEqual(new Set(['patches/a.patch']));
    expect(
      configuredPatches(
        new Map([
          [
            'pnpm-lock.yaml',
            "lockfileVersion: '9.0'\npatchedDependencies:\n  a@1.0.0: abc\n",
          ],
          [
            'pnpm-workspace.yaml',
            'patchedDependencies:\n  a@1.0.0: ./patches/a.patch\n',
          ],
        ]),
      ),
    ).toEqual(new Set(['patches/a.patch']));
  });

  it('does not make changes unknown because unchanged overrides are present', () => {
    const base = fixture('upgrade', 'base');
    const head = fixture('upgrade', 'head');
    for (const repository of [base, head]) {
      repository.files.set(
        'pnpm-workspace.yaml',
        'overrides:\n  unused-package: 1.0.0\n',
      );
      repository.files.set(
        'pnpm-lock.yaml',
        `${repository.files.get('pnpm-lock.yaml')}\noverrides:\n  unused-package: 1.0.0\n`,
      );
    }
    const report = explain(base, head);
    expect(report.warnings).toEqual([]);
    expect(report.summary).toEqual({
      explained: 4,
      'partially-explained': 0,
      unexplained: 2,
      unknown: 0,
    });
  });

  it('marks a graph change unknown when a configured patch file changes', () => {
    const build = (integrity: string, patch: string) => {
      const repository = state(
        { dependencies: { a: '1.0.0' } },
        { '.': { dependencies: { a: { specifier: '1.0.0', version: '1.0.0' } } } },
        { 'a@1.0.0': {} },
        { patchedDependencies: { 'a@1.0.0': 'patch-hash' } },
      );
      repository.files.set(
        'pnpm-workspace.yaml',
        'patchedDependencies:\n  a@1.0.0: patches/a.patch\n',
      );
      repository.files.set('patches/a.patch', patch);
      repository.files.set(
        'pnpm-lock.yaml',
        repository.files
          .get('pnpm-lock.yaml')!
          .replace('a@1.0.0: {}', `a@1.0.0: {resolution: {integrity: ${integrity}}}`),
      );
      return repository;
    };
    const report = explain(build('before', 'before'), build('after', 'after'));
    expect(report.warnings).toContain('Resolution input changed: patches/a.patch');
    expect(report.changes.find((item) => item.kind === 'package')?.confidence).toBe(
      'unknown',
    );
  });

  it('reports no changes for identical states and ignores YAML key order', () => {
    const base = fixture('upgrade', 'base');
    expect(explain(base, base).changes).toEqual([]);
    const head = { ...base, files: new Map(base.files) };
    head.files.set(
      'package.json',
      JSON.stringify({
        dependencies: { 'aws-sdk': '^2.0.0' },
        private: true,
        devDependencies: { vitest: '4.1.10' },
        name: 'demo',
      }),
    );
    expect(explain(base, head).changes).toEqual([]);
  });

  it('uses the base cone for a removed dependency tree', () => {
    const base = state(
      { dependencies: { a: '1.0.0' } },
      { '.': { dependencies: { a: { specifier: '1.0.0', version: '1.0.0' } } } },
      { 'a@1.0.0': { dependencies: { b: '1.0.0' } }, 'b@1.0.0': {} },
    );
    const report = explain(base, state({}, { '.': {} }, {}));
    expect(report.changes.every((item) => item.confidence === 'explained')).toBe(true);
    expect(report.changes.find((item) => item.name === 'b')?.change).toBe('removed');
    expect(report.changes.find((item) => item.name === 'b')?.evidence[0]?.side).toBe(
      'base',
    );
  });

  it('does not infer intent from lockfile-only upgrades', () => {
    const build = (version: string) =>
      state(
        { dependencies: { a: '^1.0.0' } },
        { '.': { dependencies: { a: { specifier: '^1.0.0', version } } } },
        { [`a@${version}`]: {} },
      );
    const report = explain(build('1.0.0'), build('1.1.0'));
    expect(report.manifestChanges).toEqual([]);
    expect(report.changes.every((item) => item.confidence === 'unexplained')).toBe(
      true,
    );
  });

  it('keeps separate installed versions and reports partial reachability', () => {
    const build = (version: string, b: string, otherB: string) =>
      state(
        { dependencies: { a: version, other: '1.0.0' } },
        {
          '.': {
            dependencies: {
              a: { specifier: version, version },
              other: { specifier: '1.0.0', version: '1.0.0' },
            },
          },
        },
        {
          [`a@${version}`]: { dependencies: { b } },
          'other@1.0.0': { dependencies: { b: otherB } },
          [`b@${b}`]: {},
          [`b@${otherB}`]: {},
        },
      );
    const report = explain(
      build('1.0.0', '1.0.0', '2.0.0'),
      build('1.1.0', '1.1.0', '2.1.0'),
    );
    const change = report.changes.find((item) => item.name === 'b')!;
    expect(change.confidence).toBe('partially-explained');
    expect(change.evidence.map((item) => item.node)).toEqual(['b@1.0.0', 'b@1.1.0']);
    expect(
      report.changes.find((item) => item.name === 'other' && item.kind === 'package')
        ?.confidence,
    ).toBe('unexplained');
  });

  it('detects same-version metadata and edge changes', () => {
    const base = state(
      {},
      { '.': {} },
      { 'a@1.0.0': { dependencies: { b: '1.0.0' } }, 'b@1.0.0': {} },
    );
    const head = state(
      {},
      { '.': {} },
      {
        'a@1.0.0': { dependencies: { c: '1.0.0' } },
        'b@1.0.0': {},
        'c@1.0.0': {},
      },
      {
        packages: {
          'a@1.0.0': { resolution: { integrity: 'changed' } },
          'b@1.0.0': {},
          'c@1.0.0': {},
        },
      },
    );
    const report = explain(base, head);
    const change = report.changes.find(
      (item) => item.name === 'a' && item.kind === 'package',
    )!;
    expect(change).toMatchObject({
      name: 'a',
      confidence: 'unexplained',
      before: ['1.0.0'],
      after: ['1.0.0'],
    });
    expect(
      change.details.find((detail) => detail.side === 'base')?.edgesRemoved,
    ).toContainEqual({ name: 'b', kind: 'dependencies', target: 'b@1.0.0' });
    expect(
      change.details.find((detail) => detail.side === 'head')?.edgesAdded,
    ).toContainEqual({ name: 'c', kind: 'dependencies', target: 'c@1.0.0' });
    expect(
      change.details.find((detail) => detail.side === 'head')?.metadataChanged,
    ).toContain('$.package.resolution.integrity');
    expect(change.details.flatMap((detail) => detail.metadataChanged)).not.toContain(
      '$.snapshot.dependencies',
    );
  });

  it('does not claim metadata fields changed when a new package version has the same value', () => {
    const build = (version: string) =>
      state(
        { dependencies: { a: version } },
        { '.': { dependencies: { a: { specifier: version, version } } } },
        { [`a@${version}`]: {} },
        { packages: { [`a@${version}`]: { resolution: { integrity: 'same' } } } },
      );
    const report = explain(build('1.0.0'), build('2.0.0'));
    const change = report.changes.find((item) => item.kind === 'package');
    expect(change?.details.every((detail) => detail.metadataChanged.length === 0)).toBe(
      true,
    );
    expect(change?.details.flatMap((detail) => detail.metadataDiff)).toEqual([]);
  });

  it('shows integrity values across a package version change', () => {
    const build = (version: string, integrity: string) =>
      state(
        { dependencies: { a: version } },
        { '.': { dependencies: { a: { specifier: version, version } } } },
        { [`a@${version}`]: {} },
        { packages: { [`a@${version}`]: { resolution: { integrity } } } },
      );
    const change = explain(
      build('1.0.0', 'old-hash'),
      build('2.0.0', 'new-hash'),
    ).changes.find((item) => item.kind === 'package')!;
    expect(
      change.details.find((detail) => detail.side === 'head')?.metadataDiff,
    ).toContainEqual({
      path: '$.package.resolution.integrity',
      before: '"old-hash"',
      after: '"new-hash"',
    });
    expect(
      renderText({
        schemaVersion: 3,
        base: 'base',
        head: 'head',
        manifestChanges: [],
        changes: [change],
        pathNodes: {},
        warnings: [],
        summary: { explained: 0, 'partially-explained': 0, unexplained: 0, unknown: 1 },
      }),
    ).toContain('$.package.resolution.integrity: "old-hash" → "new-hash"');
  });

  it('marks unresolved references and unsupported configuration as unknown', () => {
    const base = fixture('upgrade', 'base');
    const head = fixture('upgrade', 'head');
    head.files.set('pnpm-workspace.yaml', 'catalog:\n  vite: 7.0.1\n');
    const report = explain(base, head);
    expect(report.changes.every((item) => item.confidence === 'unknown')).toBe(true);
    expect(report.warnings).toContain(
      'Workspace configuration changed; resolution effects are not modeled.',
    );
    head.files.delete('pnpm-workspace.yaml');
    head.files.set(
      'pnpm-lock.yaml',
      head.files
        .get('pnpm-lock.yaml')!
        .replace('dependencies: {vite: 7.0.1}', 'dependencies: {vite: 9.0.0}'),
    );
    expect(
      explain(base, head).warnings.some((item) =>
        item.includes('Unresolved dependency'),
      ),
    ).toBe(true);
  });

  it('supports scoped npm aliases without merging alias names with real identities', () => {
    const build = (version: string) =>
      state(
        { dependencies: { alias: `npm:@scope/real@${version}` } },
        {
          '.': {
            dependencies: {
              alias: {
                specifier: `npm:@scope/real@${version}`,
                version: `@scope/real@${version}`,
              },
            },
          },
        },
        { [`@scope/real@${version}`]: {} },
      );
    expect(
      explain(build('1.0.0'), build('1.1.0')).changes.find(
        (item) => item.name === '@scope/real',
      )?.confidence,
    ).toBe('explained');
  });

  it('terminates for cycles and preserves valid paths', () => {
    const graph = buildPnpmState(
      state(
        { dependencies: { a: '1.0.0' } },
        { '.': { dependencies: { a: { specifier: '1.0.0', version: '1.0.0' } } } },
        {
          'a@1.0.0': { dependencies: { b: '1.0.0' } },
          'b@1.0.0': { dependencies: { a: '1.0.0' } },
        },
      ),
    ).graph;
    const root = dependencyId('.', 'dependencies', 'a');
    expect(dependencyPath('b@1.0.0', traverse(graph, [root]))).toEqual([
      root,
      'a@1.0.0',
      'b@1.0.0',
    ]);
  });

  it('rejects malformed and unsupported lockfiles', () => {
    expect(() => parseLockfile('lockfileVersion: 6\nimporters: {}')).toThrow(
      'Unsupported pnpm',
    );
    expect(() => parseLockfile('lockfileVersion: 9\nlockfileVersion: 9')).toThrow();
    expect(() => parseLockfile('lockfileVersion: 9\nimporters: []')).toThrow();
  });

  it('renders consistent text and JSON and filters why results', () => {
    const full = explain(fixture('upgrade', 'base'), fixture('upgrade', 'head'));
    const report = why(full, 'aws-sdk');
    expect(report.summary.unexplained).toBe(2);
    expect(report.manifestChanges).toEqual([]);
    expect(why(full, 'vite').manifestChanges.map((change) => change.name)).toEqual([
      'vitest',
    ]);
    expect(JSON.parse(renderJson(report))).toEqual(report);
    expect(renderText(report)).toContain('UNEXPLAINED_BY_MANIFEST_CHANGE');
    expect(renderText(report)).toContain('No path found');
    expect(renderText(report)).toContain('\n');
    expect(why(report, 'missing').changes).toEqual([]);
  });

  it('stores paths as a shared graph instead of copying every prefix', () => {
    const count = 250;
    const build = (version: string) => {
      const snapshots = Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `p${index}@${version}`,
          index + 1 < count ? { dependencies: { [`p${index + 1}`]: version } } : {},
        ]),
      );
      return state(
        { dependencies: { p0: version } },
        {
          '.': { dependencies: { p0: { specifier: version, version } } },
        },
        snapshots,
      );
    };
    const report = explain(build('1.0.0'), build('2.0.0'));
    expect(Object.keys(report.pathNodes)).toHaveLength(2 * (count + 1));
    expect(JSON.stringify(report).length).toBeLessThan(500_000);
    const terminal = report.changes.find((change) => change.name === `p${count - 1}`)!;
    expect(evidencePath(report, terminal.evidence[1]!)).toHaveLength(count + 1);
  });
});
