import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { evidencePath } from '../src/analysis/diff.js';
import { explain, why } from '../src/analysis/explain.js';
import { dependencyId } from '../src/graph/dependency-graph.js';
import { renderJson } from '../src/output/json.js';
import { renderText } from '../src/output/text.js';
import {
  satisfiesRegistryRange,
  supportedRegistryRange,
} from '../src/pnpm/registry-range.js';
import { fixture, state } from './helpers.js';

const root = dependencyId('.', 'dependencies', 'a');
function catalogState(
  range: string,
  version: string,
  options: {
    reference?: string;
    workspace?: Record<string, unknown>;
    lock?: Record<string, unknown>;
    snapshots?: Record<string, unknown>;
    section?: string;
    snapshot?: boolean;
  } = {},
) {
  const section = options.section ?? 'dependencies';
  const reference = options.reference ?? 'catalog:prod';
  const catalog = reference.startsWith('catalog:')
    ? reference.slice(8).trim() || 'default'
    : 'prod';
  const repository = state(
    { [section]: { a: reference } },
    {
      '.':
        section === 'peerDependencies'
          ? {}
          : { [section]: { a: { specifier: reference, version } } },
    },
    options.snapshots ?? { [`a@${version}`]: {} },
    {
      ...(options.snapshot === false
        ? {}
        : {
            catalogs: {
              [catalog]: { a: { specifier: range, version: version.split('(')[0] } },
            },
          }),
      ...options.lock,
    },
  );
  repository.files.set(
    'pnpm-workspace.yaml',
    stringify(options.workspace ?? { catalogs: { [catalog]: { a: range } } }),
  );
  return repository;
}

describe('catalog declaration intent', () => {
  it.each(['catalog:', 'catalog:default', 'catalog:prod', 'catalog: prod '])(
    'explains %s without manifest edits',
    (reference) => {
      const base = catalogState('^1.0.0', '1.0.0', { reference });
      const head = catalogState('^1.1.0', '1.1.0', { reference });
      expect(base.files.get('package.json')).toBe(head.files.get('package.json'));
      const report = explain(base, head);
      expect(report.manifestChanges).toEqual([]);
      expect(report.warnings).toEqual([]);
      expect(report.summary.explained).toBe(2);
      expect(report.declarationChanges).toHaveLength(1);
      expect(report.declarationChanges[0]).toMatchObject({
        root,
        change: 'effective-range',
        traversal: true,
        before: {
          specifier: reference,
          effectiveRange: '^1.0.0',
          observedResolution: '1.0.0',
        },
        after: {
          specifier: reference,
          effectiveRange: '^1.1.0',
          observedResolution: '1.1.0',
        },
      });
      expect(report.catalogChanges[0]?.affectedDeclarations).toEqual({
        base: [root],
        head: [root],
      });
      const change = report.changes.find((item) => item.kind === 'package')!;
      expect(change.evidence.map((item) => evidencePath(report, item))).toEqual([
        [root, 'a@1.0.0'],
        [root, 'a@1.1.0'],
      ]);
    },
  );

  it('accepts the singular default catalog', () => {
    const base = catalogState('^1.0.0', '1.0.0', {
      reference: 'catalog:',
      workspace: { catalog: { a: '^1.0.0' } },
    });
    const head = catalogState('^1.1.0', '1.1.0', {
      reference: 'catalog:default',
      workspace: { catalog: { a: '^1.1.0' } },
    });
    expect(explain(base, head).summary.explained).toBe(2);
  });

  it.each(['dependencies', 'devDependencies', 'optionalDependencies'])(
    'uses catalog %s as independent roots',
    (section) => {
      expect(
        explain(
          catalogState('1.0.0', '1.0.0', { section }),
          catalogState('2.0.0', '2.0.0', { section }),
        ).summary.explained,
      ).toBe(2);
    },
  );

  it('retains catalog intent even when the observed resolution stays unchanged', () => {
    const report = explain(
      catalogState('^1.0.0', '1.1.0'),
      catalogState('^1.1.0', '1.1.0'),
    );
    expect(report.declarationChanges[0]?.change).toBe('effective-range');
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]?.kind).toBe('dependency');
    expect(report.changes[0]?.confidence).toBe('explained');
  });

  it('records declarations shadowed by optional dependencies without creating roots', () => {
    const build = (range: string) => {
      const repository = state(
        { dependencies: { a: 'catalog:prod' }, optionalDependencies: { a: '^2.0.0' } },
        {
          '.': {
            optionalDependencies: { a: { specifier: '^2.0.0', version: '2.0.0' } },
          },
        },
        { 'a@2.0.0': {} },
      );
      repository.files.set(
        'pnpm-workspace.yaml',
        stringify({ catalogs: { prod: { a: range } } }),
      );
      return repository;
    };
    const report = explain(build('^1.0.0'), build('^1.1.0'));
    expect(report.warnings).toEqual([]);
    expect(
      report.declarations.head.find((item) => item.section === 'dependencies'),
    ).toMatchObject({
      shadowedByOptional: true,
      observedResolution: null,
      effectiveRange: '^1.1.0',
    });
    expect(report.declarationChanges[0]?.traversal).toBe(false);
    expect(report.changes).toEqual([]);
  });

  it('shares an entry across importers while keeping each origin path', () => {
    const build = (version: string) => {
      const reference = 'catalog:prod';
      const importer = { dependencies: { a: { specifier: reference, version } } };
      const repository = state(
        { dependencies: { a: reference } },
        { '.': importer, 'packages/app': importer },
        { [`a@${version}`]: {} },
        { catalogs: { prod: { a: { specifier: `^${version}`, version } } } },
      );
      repository.files.set(
        'packages/app/package.json',
        JSON.stringify({ dependencies: { a: reference } }),
      );
      repository.files.set(
        'pnpm-workspace.yaml',
        stringify({
          packages: ['packages/*'],
          catalogs: { prod: { a: `^${version}` } },
        }),
      );
      return repository;
    };
    const report = explain(build('1.0.0'), build('1.1.0'));
    expect(report.summary.explained).toBe(3);
    expect(report.catalogChanges[0]?.affectedDeclarations.base).toHaveLength(2);
    expect(
      report.changes.find((item) => item.kind === 'package')?.evidence,
    ).toHaveLength(4);
    expect(why(report, 'a').declarationChanges).toHaveLength(2);
  });

  it('does not merge equal package names from distinct catalogs or explain unrelated churn', () => {
    const build = (version: string) => {
      const repository = state(
        { dependencies: { a: 'catalog:prod' }, devDependencies: { a: 'catalog:dev' } },
        {
          '.': {
            dependencies: { a: { specifier: 'catalog:prod', version } },
            devDependencies: {
              a: {
                specifier: 'catalog:dev',
                version: version === '1.0.0' ? '2.0.0' : '2.1.0',
              },
            },
          },
        },
        { [`a@${version}`]: {}, [`a@${version === '1.0.0' ? '2.0.0' : '2.1.0'}`]: {} },
      );
      repository.files.set(
        'pnpm-workspace.yaml',
        stringify({ catalogs: { prod: { a: `^${version}` }, dev: { a: '^2.0.0' } } }),
      );
      return repository;
    };
    const report = explain(build('1.0.0'), build('1.1.0'));
    expect(report.catalogChanges).toHaveLength(1);
    expect(report.catalogChanges[0]?.catalog).toBe('prod');
    expect(report.declarationChanges).toHaveLength(1);
    expect(report.changes.find((item) => item.kind === 'package')?.confidence).toBe(
      'partially-explained',
    );
    expect(
      report.changes.find((item) => item.scope === '.:devDependencies')?.confidence,
    ).toBe('unexplained');
  });

  it('does not create intent or uncertainty for unused supported entries', () => {
    const base = catalogState('^1.0.0', '1.0.0', {
      workspace: { catalogs: { prod: { a: '^1.0.0', unused: '^8.0.0' } } },
    });
    const head = catalogState('^1.0.0', '1.1.0', {
      workspace: { catalogs: { prod: { a: '^1.0.0', unused: '^9.0.0' } } },
    });
    const report = explain(base, head);
    expect(report.catalogChanges[0]?.affectedDeclarations).toEqual({
      base: [],
      head: [],
    });
    expect(report.declarationChanges).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.summary).toEqual({
      explained: 0,
      'partially-explained': 0,
      unexplained: 2,
      unknown: 0,
    });
  });

  it('tracks added and removed consumers through the appropriate graph', () => {
    const empty = state({}, { '.': {} }, {});
    empty.files.set('pnpm-workspace.yaml', 'catalogs:\n  prod:\n    a: ^1.0.0\n');
    const consumer = catalogState('^1.0.0', '1.0.0');
    for (const [base, head, side, change] of [
      [empty, consumer, 'head', 'added'],
      [consumer, empty, 'base', 'removed'],
    ] as const) {
      const report = explain(base, head);
      expect(report.summary.explained).toBe(2);
      expect(report.declarationChanges[0]?.change).toBe(change);
      expect(
        report.changes.every((item) =>
          item.evidence.every((evidence) => evidence.side === side),
        ),
      ).toBe(true);
    }
  });

  it.each([
    ['catalog:prod', 'catalog:dev'],
    ['catalog:', 'catalog:default'],
    ['^1.0.0', 'catalog:prod'],
    ['catalog:prod', '^1.0.0'],
  ])('records origin-only %s to %s without explaining churn', (before, after) => {
    const workspace = {
      catalogs: {
        prod: { a: '^1.0.0' },
        dev: { a: '^1.0.0' },
        default: { a: '^1.0.0' },
      },
    };
    const report = explain(
      catalogState('^1.0.0', '1.0.0', {
        reference: before,
        workspace,
        snapshot: false,
      }),
      catalogState('^1.0.0', '1.1.0', { reference: after, workspace, snapshot: false }),
    );
    expect(report.declarationChanges[0]).toMatchObject({
      change: 'origin',
      traversal: false,
    });
    expect(report.warnings).toEqual([]);
    expect(report.summary.explained).toBe(0);
    expect(report.changes.every((item) => item.evidence.length === 0)).toBe(true);
  });

  it('traverses a catalog transition that changes the effective range', () => {
    const workspace = { catalogs: { prod: { a: '^1.0.0' }, dev: { a: '^2.0.0' } } };
    const report = explain(
      catalogState('^1.0.0', '1.0.0', { workspace }),
      catalogState('^2.0.0', '2.0.0', { reference: 'catalog:dev', workspace }),
    );
    expect(report.catalogChanges).toEqual([]);
    expect(report.declarationChanges[0]?.change).toBe('effective-range');
    expect(report.summary.explained).toBe(2);
  });

  it('does not infer intent from catalog snapshot or importer resolution changes', () => {
    const report = explain(
      catalogState('^1.0.0', '1.0.0'),
      catalogState('^1.0.0', '1.1.0'),
    );
    expect(report.declarationChanges).toEqual([]);
    expect(report.catalogChanges).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.summary.unexplained).toBe(2);
  });

  it('allows missing optional catalog snapshots and still checks observed ranges', () => {
    const report = explain(
      catalogState('^1.0.0', '1.0.0', { snapshot: false }),
      catalogState('^1.1.0', '1.1.0', { snapshot: false }),
    );
    expect(report.warnings).toEqual([]);
    expect(report.summary.explained).toBe(2);
  });

  it('diagnoses a missing catalog entry without explaining observed packages', () => {
    const report = explain(
      catalogState('^1.0.0', '1.0.0'),
      catalogState('^1.1.0', '1.1.0', { workspace: { catalogs: { prod: {} } } }),
    );
    expect(report.warnings).toContain('Missing catalog entry: prod.a');
    expect(report.summary.explained).toBe(0);
    expect(report.declarations.head[0]?.effectiveRange).toBeNull();
  });

  it.each([
    'catalog: {a: ^1.0.0}\ncatalogs: {default: {a: ^1.0.0}}',
    'catalog: []',
    'catalogs: []',
    'catalogs: {prod: []}',
    'catalogs: {prod: {a: 123}}',
    'catalogs: {prod: {a: ^1.0.0, a: ^2.0.0}}',
    'catalogs: [',
  ])('rejects malformed or conflicting configuration: %s', (configuration) => {
    const repository = catalogState('^1.0.0', '1.0.0');
    repository.files.set('pnpm-workspace.yaml', configuration);
    expect(() => explain(repository, repository)).toThrow();
  });

  it.each([
    'workspace:*',
    'file:../a',
    'link:../a',
    'git+https://host/a',
    'https://host/a.tgz',
    'npm:real@^1.0.0',
    'catalog:other',
    'latest',
    '^1.0.0-beta.1',
  ])('diagnoses unsupported catalog value %s', (value) => {
    const report = explain(
      catalogState('^1.0.0', '1.0.0'),
      catalogState(value, '1.1.0'),
    );
    expect(report.warnings).toContain(`Unsupported catalog value: prod.a: ${value}`);
    expect(report.summary.explained).toBe(0);
  });

  it.each([
    { catalogs: { prod: { a: { specifier: '^9.0.0', version: '1.1.0' } } } },
    { catalogs: { prod: { a: { specifier: '^1.1.0', version: '1.2.0' } } } },
  ])('keeps conflicting lockfile evidence unknown', (lock) => {
    const report = explain(
      catalogState('^1.0.0', '1.0.0'),
      catalogState('^1.1.0', '1.1.0', { lock }),
    );
    expect(report.summary.unknown).toBe(2);
    expect(report.warnings.some((warning) => warning.includes('mismatch'))).toBe(true);
  });

  it('rejects malformed snapshot records', () => {
    const repository = catalogState('^1.0.0', '1.0.0', {
      lock: { catalogs: { prod: { a: { specifier: '^1.0.0' } } } },
    });
    expect(() => explain(repository, repository)).toThrow(
      'Invalid lockfile catalog snapshots',
    );
  });

  it('keeps an observed resolution outside the declared range unknown', () => {
    const report = explain(
      catalogState('^1.0.0', '1.0.0'),
      catalogState('^1.1.0', '2.0.0', { snapshot: false }),
    );
    expect(report.summary.unknown).toBe(2);
    expect(report.warnings.join('\n')).toContain('incompatible with declaration');
  });

  it.each([
    { overrides: { a: '1.1.0' } },
    { overrides: { a: 'catalog:prod' } },
    { patchedDependencies: { a: 'patches/a.patch' } },
    { unknownFutureInput: true },
  ])(
    'retains workspace configuration uncertainty alongside catalog intent: %j',
    (configuration) => {
      const report = explain(
        catalogState('^1.0.0', '1.0.0'),
        catalogState('^1.1.0', '1.1.0', {
          workspace: { catalogs: { prod: { a: '^1.1.0' } }, ...configuration },
        }),
      );
      expect(report.declarationChanges[0]?.change).toBe('effective-range');
      expect(report.warnings).toContain(
        'Workspace configuration changed; resolution effects are not modeled.',
      );
      expect(report.summary.unknown).toBe(2);
    },
  );

  it.each([
    { settings: { autoInstallPeers: false } },
    { unknownFutureInput: true },
    {
      catalogs: {
        prod: { a: { specifier: '^1.1.0', version: '1.1.0', future: true } },
      },
    },
  ])('retains other lockfile resolution inputs: %j', (lock) => {
    const report = explain(
      catalogState('^1.0.0', '1.0.0'),
      catalogState('^1.1.0', '1.1.0', { lock }),
    );
    expect(report.warnings).toContain('Lockfile resolution configuration changed.');
    expect(report.summary.unknown).toBe(2);
  });

  it('keeps changed hooks and missing graph edges uncertain', () => {
    const base = catalogState('^1.0.0', '1.0.0');
    const head = catalogState('^1.1.0', '1.1.0', {
      snapshots: { 'a@1.1.0': { dependencies: { missing: '1.0.0' } } },
    });
    head.files.set('.pnpmfile.cjs', 'throw new Error("never execute");');
    const report = explain(base, head);
    expect(report.warnings).toContain('Resolution input changed: .pnpmfile.cjs');
    expect(report.warnings.join('\n')).toContain('Unresolved dependency');
    expect(report.summary.unknown).toBe(2);
  });

  it('detects the changed meaning of unchanged catalog references in overrides', () => {
    const build = (version: string) =>
      catalogState(`^${version}`, version, {
        workspace: {
          catalogs: { prod: { a: `^${version}` } },
          overrides: { a: 'catalog:prod' },
        },
      });
    const report = explain(build('1.0.0'), build('1.1.0'));
    expect(report.warnings).toContain(
      'Changed catalog prod is referenced by unmodeled resolution configuration.',
    );
    expect(report.summary.unknown).toBe(2);
  });

  it('keeps unchanged hooks uncertain when used catalog declarations change', () => {
    const base = catalogState('^1.0.0', '1.0.0');
    const head = catalogState('^1.1.0', '1.1.0');
    for (const side of [base, head])
      side.files.set('.pnpmfile.cjs', '// never execute');
    const report = explain(base, head);
    expect(report.warnings).toContain(
      'Catalog changed while a pnpm hook is present; hook effects are not modeled.',
    );
    expect(report.summary.unknown).toBe(2);
  });

  it('does not create global uncertainty for an unused entry with an unchanged hook', () => {
    const base = catalogState('^1.0.0', '1.0.0');
    const head = catalogState('^1.0.0', '1.1.0', {
      workspace: { catalogs: { prod: { a: '^1.0.0', unused: '^9.0.0' } } },
    });
    for (const side of [base, head])
      side.files.set('.pnpmfile.cjs', '// never execute');
    const report = explain(base, head);
    expect(report.warnings).toEqual([]);
    expect(report.summary.unexplained).toBe(2);
  });

  it('does not inherit catalog development tools through workspace links', () => {
    const build = (reference: string, version: string) => {
      const repository = state(
        { dependencies: { ui: reference } },
        {
          '.': {
            dependencies: { ui: { specifier: reference, version: 'link:packages/ui' } },
          },
          'packages/ui': {
            devDependencies: { a: { specifier: 'catalog:dev', version } },
          },
        },
        { [`a@${version}`]: {} },
        { catalogs: { dev: { a: { specifier: '^1.0.0', version } } } },
      );
      repository.files.set(
        'pnpm-workspace.yaml',
        'packages: [packages/*]\ncatalogs:\n  dev:\n    a: ^1.0.0\n',
      );
      repository.files.set(
        'packages/ui/package.json',
        JSON.stringify({ name: 'ui', devDependencies: { a: 'catalog:dev' } }),
      );
      return repository;
    };
    const report = explain(
      build('workspace:*', '1.0.0'),
      build('workspace:^', '1.1.0'),
    );
    expect(report.warnings).toEqual([]);
    expect(
      report.changes
        .filter((change) => change.name === 'a')
        .every((change) => change.confidence === 'unexplained'),
    ).toBe(true);
  });

  it('never uses catalog peer declarations as runtime roots', () => {
    const report = explain(
      catalogState('^1.0.0', '1.0.0', { section: 'peerDependencies' }),
      catalogState('^1.1.0', '1.1.0', { section: 'peerDependencies' }),
    );
    expect(report.declarationChanges[0]?.traversal).toBe(false);
    expect(report.warnings).toContain('Workspace peer dependencies changed.');
    expect(
      report.changes.every(
        (item) => item.confidence === 'unknown' && item.evidence.length === 0,
      ),
    ).toBe(true);
  });

  it('preserves peer suffixes and uncertainty on catalog paths', () => {
    const report = explain(
      catalogState('^1.0.0', '1.0.0(peer@1.0.0)'),
      catalogState('^1.1.0', '1.1.0(peer@2.0.0)'),
    );
    expect(report.warnings).toEqual([]);
    expect(report.summary.unknown).toBe(2);
    expect(report.changes.find((item) => item.kind === 'package')?.after).toEqual([
      '1.1.0(peer@2.0.0)',
    ]);
  });

  it('traverses old removals and new additions and preserves edge/metadata-only changes', () => {
    const base = catalogState('^1.0.0', '1.1.0', {
      snapshots: {
        'a@1.1.0': { dependencies: { removed: '1.0.0', metadata: '1.0.0' } },
        'removed@1.0.0': {},
        'metadata@1.0.0': {},
      },
    });
    const head = catalogState('^1.1.0', '1.1.0', {
      snapshots: {
        'a@1.1.0': { dependencies: { added: '1.0.0', metadata: '1.0.0' } },
        'added@1.0.0': {},
        'metadata@1.0.0': {},
      },
      lock: {
        packages: {
          'a@1.1.0': {},
          'added@1.0.0': {},
          'metadata@1.0.0': { resolution: { integrity: 'changed' } },
        },
      },
    });
    const report = explain(base, head);
    expect(report.summary.explained).toBe(5);
    expect(
      report.changes.find((item) => item.name === 'removed')?.evidence[0]?.side,
    ).toBe('base');
    expect(
      report.changes.find((item) => item.name === 'added')?.evidence[0]?.side,
    ).toBe('head');
    expect(
      report.changes
        .find((item) => item.name === 'metadata')
        ?.details.flatMap((detail) => detail.metadataChanged),
    ).toContain('$.package.resolution.integrity');
    expect(
      report.changes
        .find((item) => item.kind === 'package' && item.name === 'a')
        ?.details.flatMap((detail) => detail.edgesRemoved)
        .map((edge) => edge.name),
    ).toContain('removed');
  });

  it('renders deterministic reports and preserves catalog evidence in why', () => {
    const base = catalogState('^1.0.0', '1.0.0', {
      workspace: {
        catalogs: { prod: { a: '^1.0.0' }, unused: { z: '^2.0.0', b: '*' } },
      },
    });
    const head = catalogState('^1.1.0', '1.1.0', {
      workspace: {
        catalogs: { unused: { b: '*', z: '^2.0.0' }, prod: { a: '^1.1.0' } },
      },
    });
    const report = explain(base, head);
    const reordered = { ...head, files: new Map([...head.files].reverse()) };
    const parsed = JSON.parse(
      JSON.stringify({
        lockfileVersion: '9.0',
        importers: {
          '.': { dependencies: { a: { specifier: 'catalog:prod', version: '1.1.0' } } },
        },
        packages: { 'a@1.1.0': {} },
        snapshots: { 'a@1.1.0': {} },
        catalogs: { prod: { a: { version: '1.1.0', specifier: '^1.1.0' } } },
      }),
    );
    reordered.files.set('pnpm-lock.yaml', stringify(parsed));
    expect(renderJson(explain(base, reordered))).toBe(renderJson(report));
    expect(JSON.parse(renderJson(report)).schemaVersion).toBe(4);
    const filtered = why(report, 'a');
    expect(filtered.catalogChanges).toHaveLength(1);
    const text = renderText(filtered);
    expect(text).toContain('prod.a: ^1.0.0 → ^1.1.0');
    expect(text).toContain('reference catalog:prod; effective declaration ^1.1.0');
    expect(text).toContain('observed resolution 1.1.0');
    expect(text).toContain('pnpm-workspace.yaml prod.a (^1.1.0) → dependency:');
    expect(text).toContain('Reachability is evidence, not proof of causality.');
  });

  it.each(['dependencies', 'devDependencies', 'optionalDependencies'])(
    'preserves resolution-only catalog context in why for %s without inventing intent',
    (section) => {
      const report = explain(
        catalogState('^1.0.0', '1.0.0', { section }),
        catalogState('^1.0.0', '1.1.0', { section }),
      );
      const filtered = why(report, 'a');
      expect(filtered.changes).toHaveLength(2);
      expect(filtered.summary).toEqual(report.summary);
      expect(filtered.summary.unexplained).toBe(2);
      expect(filtered.declarationChanges).toEqual([]);
      expect(filtered.catalogChanges).toEqual([]);
      expect(filtered.pathNodes).toEqual({});
      expect(filtered.changes.every((change) => change.evidence.length === 0)).toBe(
        true,
      );
      for (const [side, version] of [
        ['base', '1.0.0'],
        ['head', '1.1.0'],
      ] as const) {
        expect(JSON.parse(renderJson(filtered)).declarations[side]).toEqual([
          expect.objectContaining({
            section,
            name: 'a',
            specifier: 'catalog:prod',
            catalog: { name: 'prod', entry: 'a', file: 'pnpm-workspace.yaml' },
            effectiveRange: '^1.0.0',
            observedResolution: version,
          }),
        ]);
      }
      const text = renderText(filtered);
      expect(text).toContain('Catalog dependency context (no declaration intent):');
      expect(text).toContain('reference catalog:prod; effective declaration ^1.0.0');
      expect(text).toContain('origin pnpm-workspace.yaml prod.a');
      expect(text).toContain('observed resolution 1.0.0');
      expect(text).toContain('observed resolution 1.1.0');
      expect(text).not.toContain('Dependency declaration intent:');
      const unrelated = why(report, 'unrelated');
      expect(unrelated.declarations).toEqual({ base: [], head: [] });
      expect(renderText(unrelated)).not.toContain('catalog:prod');
    },
  );

  it('keeps paths and edge details stable when instance mappings are reordered', () => {
    const base = catalogState('^1.0.0', '1.0.0', {
      snapshots: {
        'a@1.0.0': { dependencies: { z: '1.0.0', b: '1.0.0' } },
        'z@1.0.0': {},
        'b@1.0.0': {},
      },
    });
    const head = catalogState('^1.1.0', '1.1.0', {
      snapshots: {
        'a@1.1.0': { dependencies: { z: '1.1.0', b: '1.1.0' } },
        'z@1.1.0': {},
        'b@1.1.0': {},
      },
    });
    const reverse = catalogState('^1.1.0', '1.1.0', {
      snapshots: {
        'b@1.1.0': {},
        'z@1.1.0': {},
        'a@1.1.0': { dependencies: { b: '1.1.0', z: '1.1.0' } },
      },
    });
    expect(renderJson(explain(base, head))).toBe(renderJson(explain(base, reverse)));
  });

  it('explains the unchanged upstream ni manifests without extending the cone to reverse edges', () => {
    const base = fixture('ni', 'base');
    const head = fixture('ni', 'head');
    expect(base.files.get('package.json')).toBe(head.files.get('package.json'));
    const report = explain(base, head);
    expect(report.manifestChanges).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.summary).toEqual({
      explained: 2,
      'partially-explained': 0,
      unexplained: 4,
      unknown: 0,
    });
    expect(report.declarationChanges).toHaveLength(1);
    expect(report.catalogChanges[0]).toMatchObject({
      catalog: 'prod',
      entry: 'package-manager-detector',
      before: '^1.6.0',
      after: '^1.7.0',
    });
    expect(
      report.changes
        .filter((change) => change.confidence === 'explained')
        .map((change) => change.name),
    ).toEqual(['package-manager-detector', 'package-manager-detector']);
  });
});

describe('bounded stable registry range contract', () => {
  it.each([
    ['^1.6.0', '1.7.0', true],
    ['^0.2.3', '0.3.0', false],
    ['^0.0.3', '0.0.4', false],
    ['~1.2', '1.3.0', false],
    ['1.x', '1.9.0', true],
    ['*', '42.0.0', true],
    ['>= 1.0.0 <2.0.0', '1.9.0', true],
    ['1.0.0 - 2.0', '2.0.99', true],
    ['^1.0.0 || >=3.0.0', '2.0.0', false],
    ['<=1.2', '1.2.99', true],
    ['>1.2', '1.2.99', false],
    ['^0', '0.9.0', true],
    ['^0.0', '0.0.9', true],
    ['=1.2.3', '1.2.3', true],
  ])('%s accepts %s: %s', (range, version, expected) => {
    expect(supportedRegistryRange(range)).toBe(true);
    expect(satisfiesRegistryRange(range, version)).toBe(expected);
  });
  it.each([
    '',
    'latest',
    'npm:a@1.0.0',
    '1.x.2',
    '^1.0.0-beta.1',
    '>=*',
    '01.2.3',
    '^1.0.0 ||',
  ])('does not guess about %s', (range) => {
    expect(supportedRegistryRange(range)).toBe(false);
    expect(satisfiesRegistryRange(range, '1.0.0')).toBeUndefined();
  });
});
