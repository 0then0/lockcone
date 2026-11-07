import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { Report } from '../src/analysis/diff.js';
import { evidencePath } from '../src/analysis/diff.js';
import { explain, why } from '../src/analysis/explain.js';
import type { RepositoryState } from '../src/git/repository.js';
import { dependencyId } from '../src/graph/dependency-graph.js';
import { renderJson } from '../src/output/json.js';
import { renderText } from '../src/output/text.js';
import { buildPnpmState } from '../src/pnpm/dependency-graph.js';
import {
  governingRule,
  matchRule,
  overrideEdges,
  parseOverrideSelector,
} from '../src/pnpm/overrides.js';
import { rangesIntersect, satisfiesRegistryRange } from '../src/pnpm/registry-range.js';

// These repositories are hand-built. A real pnpm run would query a registry, which the
// analysis never does, so the lockfiles contain only what the cases need.

interface Dependency {
  specifier: string;
  version: string;
}
interface Project {
  dir: string;
  name?: string;
  version?: string;
  dependencies?: Record<string, Dependency>;
  devDependencies?: Record<string, Dependency>;
}
interface Setup {
  // The packageManager field. Null omits it.
  pm?: string | null | undefined;
  // Where the overrides are declared. Defaults to the source pnpm 11 reads.
  source?: 'workspace' | 'pnpm' | 'resolutions' | undefined;
  overrides?: Record<string, unknown> | undefined;
  // The lockfile record. Defaults to the declaration.
  record?: Record<string, unknown> | null | undefined;
  projects: Project[];
  snapshots: Record<string, { dependencies?: Record<string, string> }>;
  workspace?: Record<string, unknown>;
  files?: Record<string, string> | undefined;
}

const dependencySections = ['dependencies', 'devDependencies'] as const;

function world(setup: Setup): RepositoryState {
  const pm = setup.pm === undefined ? 'pnpm@11.28.9' : setup.pm;
  const source = setup.source ?? 'workspace';
  const files = new Map<string, string>();
  const importers: Record<string, unknown> = {};
  const workspace: Record<string, unknown> = { ...setup.workspace };
  for (const project of setup.projects) {
    const manifest: Record<string, unknown> = {
      name: project.name,
      version: project.version,
    };
    const importer: Record<string, unknown> = {};
    for (const section of dependencySections) {
      const entries = project[section];
      if (!entries) continue;
      manifest[section] = Object.fromEntries(
        Object.entries(entries).map(([name, item]) => [name, item.specifier]),
      );
      importer[section] = entries;
    }
    if (project.dir === '.') {
      if (pm !== null) manifest.packageManager = pm;
      if (setup.overrides && source === 'pnpm')
        manifest.pnpm = { overrides: setup.overrides };
      if (setup.overrides && source === 'resolutions')
        manifest.resolutions = setup.overrides;
    }
    importers[project.dir] = importer;
    files.set(
      project.dir === '.' ? 'package.json' : `${project.dir}/package.json`,
      JSON.stringify(manifest),
    );
  }
  if (setup.projects.some((project) => project.dir !== '.'))
    workspace.packages = ['.', 'packages/*'];
  if (setup.overrides && source === 'workspace') workspace.overrides = setup.overrides;
  if (Object.keys(workspace).length)
    files.set('pnpm-workspace.yaml', stringify(workspace));
  const record =
    setup.record === undefined ? setup.overrides : (setup.record ?? undefined);
  files.set(
    'pnpm-lock.yaml',
    stringify({
      lockfileVersion: '9.0',
      ...(record && Object.keys(record).length ? { overrides: record } : {}),
      importers,
      packages: Object.fromEntries(
        Object.keys(setup.snapshots).map((key) => [key.split('(')[0], {}]),
      ),
      snapshots: Object.fromEntries(
        Object.entries(setup.snapshots).map(([key, value]) => [
          key,
          value.dependencies ? { dependencies: value.dependencies } : {},
        ]),
      ),
    }),
  );
  for (const [path, content] of Object.entries(setup.files ?? {}))
    files.set(path, content);
  return { revision: 'fixture', files };
}

const root = (dependencies: Record<string, Dependency>): Project => ({
  dir: '.',
  name: 'root',
  version: '1.0.0',
  dependencies,
});
const dep = (version: string, specifier = version): Dependency => ({
  specifier,
  version,
});

function overrideChange(report: Report, selector: string) {
  const change = report.overrides.changes.find((item) => item.selector === selector);
  if (!change) throw new Error(`No override change for ${selector}`);
  return change;
}
function group(report: Report, name: string, kind = 'package') {
  return report.changes.find((item) => item.name === name && item.kind === kind);
}

// root -> wrap -> a -> leaf, and packages/app -> a. `other` is unrelated to every rule.
function chain(options: {
  leaf: string;
  other?: string;
  overrides?: Record<string, unknown> | undefined;
  record?: Record<string, unknown> | null | undefined;
  pm?: string | null | undefined;
  source?: Setup['source'];
  files?: Record<string, string> | undefined;
}): RepositoryState {
  const other = options.other ?? '1.0.0';
  return world({
    pm: options.pm,
    source: options.source,
    overrides: options.overrides,
    record: options.record,
    files: options.files,
    projects: [
      root({ wrap: dep('1.0.0'), other: dep(other, '^1.0.0') }),
      {
        dir: 'packages/app',
        name: 'app',
        version: '1.0.0',
        dependencies: { a: dep('1.0.0') },
      },
    ],
    snapshots: {
      'wrap@1.0.0': { dependencies: { a: '1.0.0' } },
      'a@1.0.0': { dependencies: { leaf: options.leaf } },
      [`leaf@${options.leaf}`]: {},
      [`other@${other}`]: {},
    },
  });
}

describe('global override', () => {
  const base = chain({ leaf: '1.0.0' });
  const head = chain({
    leaf: '2.0.0',
    other: '1.1.0',
    overrides: { leaf: '2.0.0' },
  });
  const report = explain(base, head);

  it('links the rule to the changed edge and to every workspace consumer', () => {
    const change = overrideChange(report, 'leaf');
    expect(change.events).toEqual(['declaration-added', 'lockfile-record-added']);
    expect(change.base).toBeNull();
    expect(change.head).toMatchObject({
      declaration: {
        source: 'pnpm-workspace.yaml',
        sourceStatus: 'active',
        value: '2.0.0',
        valueKind: 'exact',
        supported: true,
      },
      lockfile: { value: '2.0.0' },
      consistency: 'consistent',
    });
    expect(change.attribution.level).toBe('complete');
    expect(change.edges).toHaveLength(1);
    const edge = change.edges[0]!;
    expect(edge).toMatchObject({
      alias: 'leaf',
      change: 'target-changed',
      pairing: 'same-holder',
      attributed: true,
    });
    expect(edge.base).toMatchObject({ target: 'leaf@1.0.0', state: 'rule-absent' });
    expect(edge.head).toMatchObject({
      target: 'leaf@2.0.0',
      state: 'governed',
      observed: 'satisfies',
    });
    expect(
      edge.head!.consumers.map((item) => [item.workspace, item.relation, item.path]),
    ).toEqual([
      [
        'packages/app',
        'direct',
        [dependencyId('packages/app', 'dependencies', 'a'), 'a@1.0.0', 'leaf@2.0.0'],
      ],
      [
        '.',
        'transitive',
        [
          dependencyId('.', 'dependencies', 'wrap'),
          'wrap@1.0.0',
          'a@1.0.0',
          'leaf@2.0.0',
        ],
      ],
    ]);
  });

  it('lifts the global warnings and explains only what the edge supports', () => {
    expect(report.warnings).toEqual([]);
    const leaf = group(report, 'leaf')!;
    expect(leaf.confidence).toBe('explained');
    const evidence = leaf.evidence.find((item) => item.side === 'head')!;
    expect(evidence.via).toEqual({
      kind: 'override',
      selector: 'leaf',
      attribution: 'complete',
      reach: 'edge',
    });
    expect(evidencePath(report, evidence)).toEqual([
      evidence.root,
      'a@1.0.0',
      'leaf@2.0.0',
    ]);
    // The dependent changed only at the governed edge.
    expect(group(report, 'a')!.confidence).toBe('explained');
    // An update in the same lockfile that no rule or declaration reaches.
    expect(group(report, 'other')!.confidence).toBe('unexplained');
    expect(report.summary.unknown).toBe(0);
  });

  it('prints the rule, its edge, and the consumer path', () => {
    const brief = renderText(report);
    expect(brief).toContain('Override changes');
    expect(brief).toContain('leaf: declaration-added, lockfile-record-added');
    expect(brief).toContain('a@1.0.0 leaf: leaf@1.0.0 → leaf@2.0.0 (target-changed)');
    expect(brief).toContain(
      'consumer head: packages/app (app): direct via dependencies',
    );
    expect(brief).toContain('consumer head: . (root): transitive via dependencies');
    expect(brief).toContain('override leaf (complete) → a@1.0.0 → leaf@2.0.0');
    expect(brief).not.toContain('path dependency:');
    expect(renderText(report, { detail: true })).toContain(
      `path ${dependencyId('.', 'dependencies', 'wrap')} → wrap@1.0.0 → a@1.0.0 → leaf@2.0.0`,
    );
  });

  it('keeps the JSON schema and carries its own report version', () => {
    const parsed = JSON.parse(renderJson(report)) as Report;
    expect(parsed.schemaVersion).toBe(4);
    expect(parsed.overrides.reportVersion).toBe(1);
    expect(parsed.overrides.changes[0]!.edges[0]!.head!.consumers).toHaveLength(2);
    expect(
      parsed.changes.some((item) =>
        item.evidence.some((entry) => entry.via?.kind === 'override'),
      ),
    ).toBe(true);
    // Evidence of ordinary declarations carries no `via` field at all.
    expect(
      JSON.stringify(
        explain(chain({ leaf: '1.0.0' }), chain({ leaf: '1.0.0', other: '1.1.0' })),
      ),
    ).not.toContain('"via"');
    expect(JSON.parse(JSON.stringify(report.overrides))).toEqual(report.overrides);
  });

  it('keeps the overrides of `why` for the named package only', () => {
    expect(why(report, 'leaf').overrides.changes).toHaveLength(1);
    expect(why(report, 'a').overrides.changes).toHaveLength(1);
    expect(why(report, 'other').overrides.changes).toEqual([]);
  });
});

// root has no dependency on the leaf; a and b both depend on it.
function pair(options: {
  leafOfA: string;
  leafOfB?: string;
  overrides?: Record<string, unknown> | undefined;
  scope?: boolean;
}): RepositoryState {
  const prefix = options.scope ? '@scope/' : '';
  const a = `${prefix}a`;
  const b = `${prefix}b`;
  const leaf = `${prefix}leaf`;
  const leafOfB = options.leafOfB ?? '1.0.0';
  return world({
    overrides: options.overrides,
    projects: [root({ [a]: dep('1.0.0'), [b]: dep('1.0.0') })],
    snapshots: {
      [`${a}@1.0.0`]: { dependencies: { [leaf]: options.leafOfA } },
      [`${b}@1.0.0`]: { dependencies: { [leaf]: leafOfB } },
      [`${leaf}@${options.leafOfA}`]: {},
      ...(leafOfB === options.leafOfA ? {} : { [`${leaf}@${leafOfB}`]: {} }),
    },
  });
}

describe.each([
  { label: 'unscoped names', scope: false },
  { label: 'scoped names', scope: true },
])('parent>child override with $label', ({ scope }) => {
  const prefix = scope ? '@scope/' : '';
  const selector = `${prefix}a>${prefix}leaf`;
  const report = explain(
    pair({ leafOfA: '1.0.0', scope }),
    pair({ leafOfA: '2.0.0', scope, overrides: { [selector]: '2.0.0' } }),
  );

  it('explains the matching edge and leaves the parallel version of the other parent', () => {
    expect(report.warnings).toEqual([]);
    const change = overrideChange(report, selector);
    expect(change.parent).toEqual({ name: `${prefix}a`, range: null });
    expect(change.target).toEqual({ name: `${prefix}leaf`, range: null });
    expect(change.edges.map((edge) => edge.head!.parent.id)).toEqual([
      `${prefix}a@1.0.0`,
    ]);
    expect(change.head!.edges).toMatchObject({ candidates: 1, governed: 1 });
    expect(change.attribution.level).toBe('complete');
    const leaf = group(report, `${prefix}leaf`)!;
    expect(leaf.before).toEqual(['1.0.0']);
    expect(leaf.after).toEqual(['1.0.0', '2.0.0']);
    expect(leaf.changedNodes).toEqual({ base: [], head: [`${prefix}leaf@2.0.0`] });
    expect(leaf.confidence).toBe('explained');
    expect(group(report, `${prefix}a`)!.confidence).toBe('explained');
    // b keeps its own version and does not appear anywhere.
    expect(group(report, `${prefix}b`)).toBeUndefined();
    expect(JSON.stringify(change)).not.toContain(`${prefix}b@1.0.0`);
  });
});

describe('packages beyond the governed edge', () => {
  const build = (leaf: string, deep: string, overrides?: Record<string, unknown>) =>
    world({
      overrides,
      projects: [root({ a: dep('1.0.0') })],
      snapshots: {
        'a@1.0.0': { dependencies: { leaf } },
        [`leaf@${leaf}`]: { dependencies: { deep } },
        [`deep@${deep}`]: {},
      },
    });
  const report = explain(
    build('1.0.0', '1.0.0'),
    build('2.0.0', '1.1.0', { leaf: '2.0.0' }),
  );

  it('shows the path but does not claim the rule caused the update', () => {
    expect(report.warnings).toEqual([]);
    expect(group(report, 'leaf')!.confidence).toBe('explained');
    const deep = group(report, 'deep')!;
    expect(deep.confidence).toBe('unknown');
    const evidence = deep.evidence.find((item) => item.side === 'head')!;
    expect(evidence.via).toMatchObject({ selector: 'leaf', reach: 'beyond-edge' });
    expect(evidencePath(report, evidence).slice(1)).toEqual([
      'a@1.0.0',
      'leaf@2.0.0',
      'deep@1.1.0',
    ]);
    expect(renderText(report)).toContain(
      'Reachable only beyond the governed edge: the rule does not show why this package changed.',
    );
  });
});

describe('adding, changing, and removing a rule', () => {
  const build = (leaf: string, overrides?: Record<string, unknown>) =>
    chain({ leaf, overrides });

  it('reports a changed value and keeps the old target as base evidence', () => {
    const report = explain(
      build('2.0.0', { leaf: '2.0.0' }),
      build('3.0.0', { leaf: '3.0.0' }),
    );
    const change = overrideChange(report, 'leaf');
    expect(change.events).toEqual(['declaration-changed', 'lockfile-record-changed']);
    expect(change.base!.declaration!.value).toBe('2.0.0');
    expect(change.head!.declaration!.value).toBe('3.0.0');
    expect(change.edges[0]).toMatchObject({ attributed: true });
    expect(change.edges[0]!.base).toMatchObject({
      target: 'leaf@2.0.0',
      state: 'governed',
    });
    expect(report.warnings).toEqual([]);
    expect(group(report, 'leaf')!.confidence).toBe('explained');
    const sides = group(report, 'leaf')!.evidence.map((item) => item.side);
    expect(sides).toEqual(['base', 'head']);
  });

  it('explains the return to the natural resolution when a rule is removed', () => {
    const report = explain(build('2.0.0', { leaf: '2.0.0' }), build('1.0.0'));
    const change = overrideChange(report, 'leaf');
    expect(change.events).toEqual(['declaration-removed', 'lockfile-record-removed']);
    expect(change.head).toBeNull();
    expect(change.edges[0]).toMatchObject({
      change: 'target-changed',
      attributed: true,
    });
    expect(report.warnings).toEqual([]);
    expect(group(report, 'leaf')!.confidence).toBe('explained');
  });

  it('accepts a stable range as the value', () => {
    const report = explain(build('1.0.0'), build('1.4.0', { leaf: '^1.2.0' }));
    const change = overrideChange(report, 'leaf');
    expect(change.head!.declaration!.valueKind).toBe('range');
    expect(change.edges[0]!.head!.observed).toBe('satisfies');
    expect(report.warnings).toEqual([]);
  });

  it('does not list an unchanged rule', () => {
    const same = build('2.0.0', { leaf: '2.0.0' });
    const report = explain(same, same);
    expect(report.overrides.changes).toEqual([]);
    expect(report.changes).toEqual([]);
  });
});

describe('dependents that change with the rule', () => {
  it('lists an edge whose dependent changed but does not attribute it', () => {
    const build = (
      version: string,
      leaf: string,
      overrides?: Record<string, unknown>,
    ) =>
      world({
        overrides,
        projects: [root({ a: dep(version, '^1.0.0') })],
        snapshots: {
          [`a@${version}`]: { dependencies: { leaf } },
          [`leaf@${leaf}`]: {},
        },
      });
    const report = explain(
      build('1.0.0', '1.0.0'),
      build('1.1.0', '2.0.0', { leaf: '2.0.0' }),
    );
    const edge = overrideChange(report, 'leaf').edges[0]!;
    expect(edge).toMatchObject({
      pairing: 'holder-changed',
      change: 'target-changed',
      attributed: false,
    });
    expect(edge.reasons.join(' ')).toContain('dependent changed too');
    expect(edge.base!.target).toBe('leaf@1.0.0');
    expect(edge.head!.target).toBe('leaf@2.0.0');
    // The bump of `a` is a declaration change of its own; the rule explains nothing here.
    expect(group(report, 'leaf')!.evidence).toEqual([]);
    expect(group(report, 'leaf')!.confidence).toBe('unexplained');
  });

  it('leaves a changed dependent unattributed when more than the edge differs', () => {
    const build = (
      leaf: string,
      integrity: string,
      overrides?: Record<string, unknown>,
    ) => {
      const repository = chain({ leaf, overrides });
      repository.files.set(
        'pnpm-lock.yaml',
        repository.files
          .get('pnpm-lock.yaml')!
          .replace('a@1.0.0: {}', `a@1.0.0: {resolution: {integrity: ${integrity}}}`),
      );
      return repository;
    };
    const report = explain(
      build('1.0.0', 'old'),
      build('2.0.0', 'new', { leaf: '2.0.0' }),
    );
    const edge = overrideChange(report, 'leaf').edges[0]!;
    expect(edge.attributed).toBe(false);
    expect(edge.reasons.join(' ')).toContain('differs in more than this edge');
    expect(group(report, 'a')!.evidence).toEqual([]);
  });
});

describe('selector ranges apply to the declaration, not to the resolved version', () => {
  const importerWorld = (
    declared: string,
    version: string,
    overrides?: Record<string, unknown>,
  ) =>
    world({
      overrides,
      projects: [root({ leaf: dep(version, declared) })],
      snapshots: { [`leaf@${version}`]: {} },
    });

  it.each([
    // The selector range intersects the declared range.
    ['leaf@^1', '^1.2.0', true],
    ['leaf@^1', '>=1.5.0 <3', true],
    ['leaf@>=1.0.0 <2.0.0', '^1.9.0', true],
    // Boundaries: the upper bound is exclusive for caret and x-ranges.
    ['leaf@^1', '2.0.0', false],
    ['leaf@^1', '^2.0.0', false],
    ['leaf@>=1.0.0 <2.0.0', '2.0.0', false],
    ['leaf@1.2.x', '1.3.0', false],
    ['leaf@1.2.x', '~1.2.3', true],
    // Equal text always matches; a protocol never does.
    ['leaf@^1', 'workspace:^1.0.0', false],
  ])('%s against the declaration %s: governed=%s', (selector, declared, governed) => {
    const state = buildPnpmState(
      importerWorld(declared, '1.0.0', { [selector]: '1.0.0' }),
    );
    const [edge] = overrideEdges(state).filter((item) => item.alias === 'leaf');
    const rule = state.overrides.effective.get(selector)!;
    expect(matchRule(rule, edge!)).toBe(governed ? 'yes' : 'no');
  });

  it('does not decide a range selector from the resolved version', () => {
    // leaf resolves to 1.5.0, yet the declaration ^2 lies outside the selector range.
    const base = importerWorld('^2.0.0', '2.0.0');
    const head = importerWorld('^2.0.0', '2.0.0', { 'leaf@^1': '1.5.0' });
    const report = explain(base, head);
    const change = overrideChange(report, 'leaf@^1');
    expect(change.head!.edges).toMatchObject({ candidates: 0, governed: 0 });
    expect(change.edges).toEqual([]);
    expect(change.observations.map((item) => item.code)).toContain('NO_MATCHING_EDGES');
  });

  it('cannot test a range selector on a package dependency', () => {
    const build = (leaf: string, overrides?: Record<string, unknown>) =>
      world({
        overrides,
        projects: [root({ a: dep('1.0.0') })],
        snapshots: { 'a@1.0.0': { dependencies: { leaf } }, [`leaf@${leaf}`]: {} },
      });
    const report = explain(build('1.0.0'), build('1.5.0', { 'leaf@^1': '1.5.0' }));
    const change = overrideChange(report, 'leaf@^1');
    expect(change.attribution.level).toBe('incomplete');
    expect(change.head!.edges).toMatchObject({ governed: 0, undecidable: 1 });
    expect(change.edges[0]!.head!.reasons[0]).toContain('not recorded in the lockfile');
    expect(report.warnings.join('\n')).toContain('cannot be matched to this rule');
    expect(report.summary.unknown).toBe(report.changes.length);
    expect(group(report, 'leaf')!.evidence).toEqual([]);
  });

  it('applies the parent version range to the parent version', () => {
    // The importer aliases both versions of `a` through npm: specifiers.
    const state = buildPnpmState(
      world({
        overrides: { 'a@^1>leaf': '2.0.0', 'a@>=1.5.0 <2.0.0>leaf': '2.0.0' },
        projects: [
          root({
            one: dep('a@1.9.9', 'npm:a@1.9.9'),
            two: dep('a@2.0.0', 'npm:a@2.0.0'),
          }),
        ],
        snapshots: {
          'a@1.9.9': { dependencies: { leaf: '1.0.0' } },
          'a@2.0.0': { dependencies: { leaf: '1.0.0' } },
          'leaf@1.0.0': {},
        },
      }),
    );
    const edges = overrideEdges(state).filter((edge) => edge.alias === 'leaf');
    const matches = (selector: string): string[] =>
      edges
        .filter(
          (edge) => matchRule(state.overrides.effective.get(selector)!, edge) === 'yes',
        )
        .map((edge) => edge.parent.id);
    expect(matches('a@^1>leaf')).toEqual(['a@1.9.9']);
    expect(matches('a@>=1.5.0 <2.0.0>leaf')).toEqual(['a@1.9.9']);
  });
});

describe('selector syntax', () => {
  it.each([
    ['leaf', null, { name: 'leaf', range: null }],
    ['@scope/leaf', null, { name: '@scope/leaf', range: null }],
    ['@scope/leaf@^1.2.0', null, { name: '@scope/leaf', range: '^1.2.0' }],
    ['a>leaf', { name: 'a', range: null }, { name: 'leaf', range: null }],
    [
      '@s/a@1.0.0>@s/leaf@^2',
      { name: '@s/a', range: '1.0.0' },
      { name: '@s/leaf', range: '^2' },
    ],
    // A `>` inside a range is not the parent delimiter.
    ['leaf@>=1.0.0', null, { name: 'leaf', range: '>=1.0.0' }],
    ['leaf@1.0.0 || >=2.0.0', null, { name: 'leaf', range: '1.0.0 || >=2.0.0' }],
    [
      'a@>=1.0.0 <2.0.0>leaf',
      { name: 'a', range: '>=1.0.0 <2.0.0' },
      { name: 'leaf', range: null },
    ],
  ])('parses %s', (selector, parent, target) => {
    expect(parseOverrideSelector(selector)).toEqual({ parent, target, problems: [] });
  });

  it.each([
    ['leaf@', 'empty range'],
    ['leaf@latest', 'not a supported'],
    ['a>b>c', 'supported package name'],
    [' leaf', 'surrounding whitespace'],
    ['', 'supported package name'],
  ])('keeps %j outside the model', (selector, problem) => {
    expect(parseOverrideSelector(selector).problems.join(' ')).toContain(problem);
  });
});

describe('rules outside the model keep their uncertainty', () => {
  it.each([
    ['link target', 'link:../leaf'],
    ['removal', '-'],
    ['tag', 'latest'],
    ['prerelease version', '2.0.0-beta.1'],
    ['npm alias', 'npm:other@2.0.0'],
    ['catalog reference', 'catalog:prod'],
    ['dependency reference', '$leaf'],
  ])('does not attribute a %s', (_label, value) => {
    const report = explain(
      chain({ leaf: '1.0.0' }),
      chain({ leaf: '2.0.0', overrides: { leaf: value } }),
    );
    expect(report.overrides.changes).toEqual([]);
    expect(report.warnings).toContain(
      'Workspace configuration changed; resolution effects are not modeled.',
    );
    expect(report.summary.unknown).toBe(report.changes.length);
    expect(group(report, 'leaf')!.evidence).toEqual([]);
  });

  it('keeps an unmodeled rule next to a modeled one', () => {
    const report = explain(
      chain({ leaf: '1.0.0' }),
      chain({
        leaf: '2.0.0',
        overrides: { leaf: '2.0.0', unrelated: 'link:../x' },
      }),
    );
    // The modeled rule is complete, but the unmodeled one keeps every group unknown.
    expect(overrideChange(report, 'leaf').attribution.level).toBe('complete');
    expect(report.overrides.changes.map((item) => item.selector)).toEqual(['leaf']);
    expect(report.warnings).toContain(
      'Workspace configuration changed; resolution effects are not modeled.',
    );
    expect(report.summary.unknown).toBe(report.changes.length);
    expect(group(report, 'leaf')!.evidence).not.toEqual([]);
  });

  it('does not decide an edge that an unsupported rule for the same package may govern', () => {
    const report = explain(
      chain({ leaf: '1.0.0' }),
      chain({
        leaf: '2.0.0',
        overrides: { leaf: '2.0.0', 'leaf@latest': '3.0.0' },
      }),
    );
    const change = overrideChange(report, 'leaf');
    expect(change.attribution.level).toBe('incomplete');
    expect(change.head!.edges).toMatchObject({ governed: 0, undecidable: 1 });
    expect(report.warnings.join('\n')).toContain('cannot be matched to this rule');
    expect(group(report, 'leaf')!.confidence).toBe('unknown');
  });

  it('keeps a catalog reference in an unrelated rule conservative', () => {
    const withCatalog = (version: string) =>
      chain({
        leaf: '2.0.0',
        overrides: { leaf: '2.0.0', other: 'catalog:prod' },
        files: {
          'pnpm-workspace.yaml': stringify({
            packages: ['.', 'packages/*'],
            overrides: { leaf: '2.0.0', other: 'catalog:prod' },
            catalogs: { prod: { other: version } },
          }),
        },
      });
    const report = explain(withCatalog('1.0.0'), withCatalog('1.1.0'));
    expect(report.warnings).toContain(
      'Changed catalog prod is referenced by unmodeled resolution configuration.',
    );
  });

  it('keeps hooks and other resolution inputs as global warnings', () => {
    const head = chain({ leaf: '2.0.0', overrides: { leaf: '2.0.0' } });
    head.files.set('.pnpmfile.cjs', 'throw new Error("never execute");');
    const report = explain(chain({ leaf: '1.0.0' }), head);
    expect(overrideChange(report, 'leaf').attribution.level).toBe('complete');
    expect(report.warnings).toEqual(['Resolution input changed: .pnpmfile.cjs']);
    expect(group(report, 'leaf')!.confidence).toBe('unknown');
    expect(group(report, 'leaf')!.evidence).not.toEqual([]);
    const other = chain({ leaf: '2.0.0', overrides: { leaf: '2.0.0' } });
    other.files.set(
      'pnpm-workspace.yaml',
      stringify({
        packages: ['.', 'packages/*'],
        overrides: { leaf: '2.0.0' },
        packageExtensions: { a: { dependencies: { x: '1' } } },
      }),
    );
    expect(explain(chain({ leaf: '1.0.0' }), other).warnings).toContain(
      'Workspace configuration changed; resolution effects are not modeled.',
    );
  });
});

describe('declaration, lockfile record, and graph disagree', () => {
  it('reports a changed value that the lockfile edges do not follow', () => {
    // Declared and recorded 2.0.0, but the committed graph still resolves 1.0.0.
    const report = explain(
      chain({ leaf: '1.0.0' }),
      chain({ leaf: '1.0.0', overrides: { leaf: '2.0.0' } }),
    );
    const change = overrideChange(report, 'leaf');
    expect(change.events).toEqual(['declaration-added', 'lockfile-record-added']);
    expect(change.head!.edges).toMatchObject({ governed: 1, violating: 1 });
    expect(change.attribution.level).toBe('incomplete');
    expect(report.warnings.join('\n')).toContain('resolve outside the value "2.0.0"');
    expect(report.changes).toEqual([]);
  });

  it('keeps a declaration change without a graph change visible and consistent', () => {
    const build = (value: string) =>
      chain({ leaf: '1.4.0', overrides: { leaf: value } });
    const report = explain(build('^1.2.0'), build('^1.3.0'));
    const change = overrideChange(report, 'leaf');
    expect(change.events).toEqual(['declaration-changed', 'lockfile-record-changed']);
    expect(change.edges).toEqual([]);
    expect(change.observations.map((item) => item.code)).toContain(
      'NO_OBSERVED_GRAPH_CHANGE',
    );
    expect(change.attribution.level).toBe('complete');
    expect(report.warnings).toEqual([]);
    expect(report.changes).toEqual([]);
  });

  it('separates a changed declaration from an unchanged lockfile record', () => {
    const report = explain(
      chain({ leaf: '2.0.0', overrides: { leaf: '2.0.0' } }),
      chain({ leaf: '2.0.0', overrides: { leaf: '3.0.0' }, record: { leaf: '2.0.0' } }),
    );
    const change = overrideChange(report, 'leaf');
    expect(change.events).toEqual(['declaration-changed']);
    expect(change.head!.consistency).toBe('record-differs');
    expect(change.observations.map((item) => item.code)).toContain(
      'DECLARATION_CHANGED_RECORD_UNCHANGED',
    );
    expect(report.warnings.join('\n')).toContain(
      'the lockfile records "2.0.0", but the declaration says "3.0.0"',
    );
  });

  it('separates a record-only change from a declaration change', () => {
    // The declaration is 2.0.0 on both sides; only the stale record catches up.
    const build = (leaf: string, record: string) =>
      chain({
        leaf,
        overrides: { leaf: '2.0.0' },
        record: { leaf: record },
      });
    const report = explain(build('1.0.0', '1.0.0'), build('2.0.0', '2.0.0'));
    const change = overrideChange(report, 'leaf');
    expect(change.events).toEqual(['lockfile-record-changed']);
    expect(change.base!.consistency).toBe('record-differs');
    expect(change.head!.consistency).toBe('consistent');
    expect(change.attribution.level).toBe('incomplete');
    expect(change.observations.map((item) => item.code)).toContain(
      'RECORD_CHANGED_DECLARATION_UNCHANGED',
    );
    expect(report.warnings.join('\n')).toContain('Override leaf (base)');
    expect(report.warnings.join('\n')).not.toContain('Override leaf (head)');
    // The paths are still shown, but nothing is promoted above unknown.
    expect(report.summary.explained).toBe(0);
    const leaf = group(report, 'leaf')!;
    expect(leaf.confidence).toBe('unknown');
    expect(leaf.evidence).not.toEqual([]);
    expect(leaf.evidence.every((item) => item.via?.attribution === 'incomplete')).toBe(
      true,
    );
  });

  it('does not explain a rule that the lockfile never recorded', () => {
    const report = explain(
      chain({ leaf: '1.0.0' }),
      chain({ leaf: '2.0.0', overrides: { leaf: '2.0.0' }, record: null }),
    );
    expect(overrideChange(report, 'leaf').head!.consistency).toBe('record-missing');
    expect(report.warnings.join('\n')).toContain('the lockfile has no record');
    expect(report.summary.unknown).toBe(report.changes.length);
  });

  it('keeps overlapping rules of equal priority ambiguous', () => {
    const importerWorld = (version: string, overrides?: Record<string, unknown>) =>
      world({
        overrides,
        projects: [root({ leaf: dep(version, '^1.0.0') })],
        snapshots: { [`leaf@${version}`]: {} },
      });
    const report = explain(
      importerWorld('1.0.0'),
      importerWorld('1.5.0', { leaf: '1.5.0', 'leaf@^1': '1.5.0' }),
    );
    expect(overrideChange(report, 'leaf').head!.edges).toMatchObject({ ambiguous: 1 });
    expect(overrideChange(report, 'leaf@^1').head!.edges).toMatchObject({
      ambiguous: 1,
    });
    expect(report.warnings.join('\n')).toContain('rules of equal priority');
    expect(group(report, 'leaf', 'dependency')!.confidence).toBe('unknown');
  });

  it('prefers a parent-scoped rule over a generic one', () => {
    const state = buildPnpmState(
      pair({ leafOfA: '2.0.0', overrides: { leaf: '3.0.0', 'a>leaf': '2.0.0' } }),
    );
    const edges = overrideEdges(state).filter((edge) => edge.alias === 'leaf');
    const verdicts = Object.fromEntries(
      edges.map((edge) => {
        const verdict = governingRule(edge, state.overrides);
        return [
          edge.parent.id,
          verdict.status === 'governed' ? verdict.rule.selector : verdict.status,
        ];
      }),
    );
    expect(verdicts).toEqual({ 'a@1.0.0': 'a>leaf', 'b@1.0.0': 'leaf' });
  });
});

describe('configuration source follows packageManager', () => {
  const run = (options: { pm: string | null; source: Setup['source'] }): Report =>
    explain(
      chain({ leaf: '1.0.0', pm: options.pm, source: options.source }),
      chain({
        leaf: '2.0.0',
        pm: options.pm,
        source: options.source,
        overrides: { leaf: '2.0.0' },
      }),
    );

  it.each([
    ['pnpm@11.28.9', 'workspace', 'pnpm-workspace.yaml'],
    ['pnpm@12.5.1', 'workspace', 'pnpm-workspace.yaml'],
    ['pnpm@10.34.9', 'pnpm', 'package.json#pnpm'],
    ['pnpm@10.34.9', 'resolutions', 'package.json#resolutions'],
    ['pnpm@9.0.0', 'pnpm', 'package.json#pnpm'],
  ] as const)('reads %s from %s', (pm, source, expected) => {
    const report = run({ pm, source });
    expect(overrideChange(report, 'leaf').head!.declaration).toMatchObject({
      source: expected,
      sourceStatus: 'active',
    });
    expect(report.warnings).toEqual([]);
    expect(group(report, 'leaf')!.confidence).toBe('explained');
  });

  it.each([
    ['pnpm@11.28.9', 'pnpm', 'inactive'],
    ['pnpm@12.5.1', 'resolutions', 'inactive'],
    ['pnpm@10.34.9', 'workspace', 'unverified'],
    [null, 'workspace', 'unverified'],
    [null, 'pnpm', 'unverified'],
  ] as const)('does not attribute %s from %s (%s)', (pm, source, status) => {
    const report = run({ pm, source });
    expect(report.overrides.changes).toEqual([]);
    expect(report.overrides.notes.head.map((item) => item.code)).toContain(
      status === 'inactive'
        ? 'INACTIVE_DECLARATION_SOURCE'
        : 'UNVERIFIED_DECLARATION_SOURCE',
    );
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.summary.unknown).toBe(report.changes.length);
  });

  it('lets pnpm.overrides win over resolutions on pnpm 10', () => {
    const build = (leaf: string) => {
      const repository = chain({ leaf, pm: 'pnpm@10.34.9', source: 'pnpm' });
      return repository;
    };
    const head = build('2.0.0');
    const manifest = JSON.parse(head.files.get('package.json')!) as Record<
      string,
      unknown
    >;
    manifest.pnpm = { overrides: { leaf: '2.0.0' } };
    manifest.resolutions = { leaf: '9.9.9' };
    head.files.set('package.json', JSON.stringify(manifest));
    head.files.set(
      'pnpm-lock.yaml',
      `${head.files.get('pnpm-lock.yaml')}overrides:\n  leaf: 2.0.0\n`,
    );
    const state = buildPnpmState(head);
    expect(state.overrides.effective.get('leaf')).toMatchObject({
      source: 'package.json#pnpm',
      value: '2.0.0',
    });
    expect(
      state.overrides.rules.find((rule) => rule.source === 'package.json#resolutions'),
    ).toMatchObject({ shadowed: true });
  });

  it('does not attribute when an unconfirmed source also declares overrides', () => {
    const head = chain({
      leaf: '2.0.0',
      overrides: { leaf: '2.0.0' },
      pm: 'pnpm@10.34.9',
      source: 'pnpm',
    });
    head.files.set('pnpm-workspace.yaml', stringify({ overrides: { leaf: '2.0.0' } }));
    const report = explain(
      chain({ leaf: '1.0.0', pm: 'pnpm@10.34.9', source: 'pnpm' }),
      head,
    );
    expect(report.overrides.changes).toEqual([]);
    expect(report.overrides.notes.head.map((item) => item.code)).toContain(
      'UNVERIFIED_SOURCE_BLOCKS_ATTRIBUTION',
    );
    expect(report.warnings.length).toBeGreaterThan(0);
  });

  it('does not attribute when packageConfigs declare project overrides', () => {
    const head = chain({ leaf: '2.0.0', overrides: { leaf: '2.0.0' } });
    head.files.set(
      'pnpm-workspace.yaml',
      stringify({
        packages: ['.', 'packages/*'],
        overrides: { leaf: '2.0.0' },
        packageConfigs: { app: { overrides: { leaf: '3.0.0' } } },
      }),
    );
    const report = explain(chain({ leaf: '1.0.0' }), head);
    expect(report.overrides.changes).toEqual([]);
    expect(report.warnings.length).toBeGreaterThan(0);
  });
});

describe('unmodeled configuration next to a modeled rule', () => {
  it('keeps a changed unmodeled field of the pnpm manifest field', () => {
    const head = chain({
      leaf: '2.0.0',
      overrides: { leaf: '2.0.0' },
      pm: 'pnpm@10.34.9',
      source: 'pnpm',
    });
    const manifest = JSON.parse(head.files.get('package.json')!) as {
      pnpm: Record<string, unknown>;
    };
    manifest.pnpm.patchedDependencies = { x: 'patches/x.patch' };
    head.files.set('package.json', JSON.stringify(manifest));
    const report = explain(
      chain({ leaf: '1.0.0', pm: 'pnpm@10.34.9', source: 'pnpm' }),
      head,
    );
    expect(report.warnings).toContain(
      'Unmodeled manifest resolution input changed: . pnpm',
    );
    expect(overrideChange(report, 'leaf').attribution.level).toBe('complete');
    expect(report.summary.unknown).toBe(report.changes.length);
  });

  it('removes only the modeled rule from the manifest comparison', () => {
    const report = explain(
      chain({ leaf: '1.0.0', pm: 'pnpm@10.34.9', source: 'pnpm' }),
      chain({
        leaf: '2.0.0',
        overrides: { leaf: '2.0.0' },
        pm: 'pnpm@10.34.9',
        source: 'pnpm',
      }),
    );
    expect(report.warnings).toEqual([]);
    expect(report.summary.unknown).toBe(0);
  });

  it('prints and serializes deterministically', () => {
    const build = () =>
      explain(
        chain({ leaf: '1.0.0' }),
        chain({ leaf: '2.0.0', overrides: { leaf: '2.0.0' } }),
      );
    expect(renderJson(build())).toBe(renderJson(build()));
    expect(renderText(build(), { detail: true })).toBe(
      renderText(build(), { detail: true }),
    );
  });
});

describe('limits', () => {
  const dependents = Array.from(
    { length: 105 },
    (_, index) => `p${String(index).padStart(3, '0')}`,
  );
  const build = (leaf: string, overrides?: Record<string, unknown>) =>
    world({
      overrides,
      projects: [
        root(Object.fromEntries(dependents.map((name) => [name, dep('1.0.0')]))),
      ],
      snapshots: {
        ...Object.fromEntries(
          dependents.map((name) => [`${name}@1.0.0`, { dependencies: { leaf } }]),
        ),
        [`leaf@${leaf}`]: {},
      },
    });
  const report = explain(build('1.0.0'), build('2.0.0', { leaf: '2.0.0' }));

  it('lists at most 100 edges per rule and says what it left out', () => {
    const change = overrideChange(report, 'leaf');
    expect(change.edges).toHaveLength(100);
    expect(change.edgesOmitted).toBe(5);
    expect(report.overrides.truncated.join('\n')).toContain(
      '5 changed edge(s) were not listed',
    );
    expect(change.head!.edges.governed).toBe(105);
  });

  it('still attributes the edges it did not list', () => {
    expect(report.warnings).toEqual([]);
    expect(group(report, 'p104')!.confidence).toBe('explained');
    expect(group(report, 'leaf')!.confidence).toBe('explained');
  });
});

describe('edges are matched by the declared name, not by the target package', () => {
  const build = (aliased: string, overrides?: Record<string, unknown>) =>
    world({
      overrides,
      projects: [root({ a: dep('1.0.0') })],
      snapshots: {
        // `alias` is an npm alias of the real package `leaf`.
        'a@1.0.0': { dependencies: { alias: `leaf@${aliased}` } },
        [`leaf@${aliased}`]: {},
      },
    });

  it('does not govern an alias edge through the name of the package behind it', () => {
    const report = explain(build('1.0.0'), build('2.0.0', { leaf: '2.0.0' }));
    const change = overrideChange(report, 'leaf');
    expect(change.head!.edges.candidates).toBe(0);
    expect(change.edges).toEqual([]);
    expect(group(report, 'leaf')!.evidence).toEqual([]);
  });

  it('governs an edge under its alias name', () => {
    const report = explain(build('1.0.0'), build('2.0.0', { alias: '2.0.0' }));
    const change = overrideChange(report, 'alias');
    // The value replaces the alias with a registry package of the same name, so a
    // resolution to a differently named package does not fit it.
    expect(change.head!.edges).toMatchObject({ candidates: 1, violating: 1 });
    expect(change.attribution.level).toBe('incomplete');
  });
});

describe('importer dependencies', () => {
  it('attributes a changed direct dependency to the rule and names its workspace', () => {
    const build = (version: string, overrides?: Record<string, unknown>) =>
      world({
        overrides,
        projects: [
          root({}),
          {
            dir: 'packages/app',
            name: 'app',
            version: '1.0.0',
            dependencies: { leaf: dep(version, '^1.0.0') },
          },
        ],
        snapshots: { [`leaf@${version}`]: {} },
      });
    const report = explain(build('1.0.0'), build('1.5.0', { leaf: '1.5.0' }));
    const edge = overrideChange(report, 'leaf').edges[0]!;
    expect(edge.head!.consumers).toEqual([
      expect.objectContaining({
        workspace: 'packages/app',
        name: 'app',
        relation: 'direct',
        path: [dependencyId('packages/app', 'dependencies', 'leaf'), 'leaf@1.5.0'],
      }),
    ]);
    expect(group(report, 'leaf', 'dependency')!.confidence).toBe('explained');
    expect(group(report, 'leaf')!.confidence).toBe('explained');
    expect(report.warnings).toEqual([]);
  });
});

describe('range intersection', () => {
  it.each([
    ['^1.0.0', '1.5.0', true],
    ['^1.0.0', '^2.0.0', false],
    ['>=1.0.0 <2.0.0', '2.0.0', false],
    ['>1.0.0', '<1.0.1', true],
    ['>=1.0.0', '<1.0.0', false],
    ['>=1.0.0', '<=1.0.0', true],
    ['1.2.x', '1.3.0', false],
    ['1.x', '>=1.9.0', true],
    ['^1 || ^3', '>=2.0.0 <3.0.0', false],
    ['^1 || ^3', '^3.1.0', true],
    ['1.2.3 - 2.3.4', '2.3.4', true],
    ['1.2.3 - 2.3.4', '>2.3.4', false],
    ['1.2.3 - 2.3.4', '>2.3.3', true],
    ['*', '^9.0.0', true],
    ['^0.2.3', '0.2.9', true],
    ['^0.2.3', '0.3.0', false],
    ['~1.2.3', '1.3.0', false],
  ])('intersects(%s, %s) = %s', (left, right, expected) => {
    expect(rangesIntersect(left, right)).toBe(expected);
    expect(rangesIntersect(right, left)).toBe(expected);
  });

  it('stays undefined outside the supported syntax', () => {
    expect(rangesIntersect('latest', '^1')).toBeUndefined();
    expect(rangesIntersect('^1', 'npm:x@1')).toBeUndefined();
    expect(rangesIntersect('1.0.0-beta.1', '^1')).toBeUndefined();
  });

  it('agrees with the satisfaction predicate on a version grid', () => {
    const ranges = [
      '^1.2.3',
      '~1.2.3',
      '>=1.2.0 <1.4.0',
      '<2',
      '>1.2',
      '1.x',
      '0.x',
      '^0.0.3',
      '1.2.3 - 1.4',
      '^1 || ^3',
      '*',
    ];
    const grid: string[] = [];
    for (let major = 0; major < 4; major++)
      for (let minor = 0; minor < 6; minor++)
        for (let patch = 0; patch < 5; patch++) grid.push(`${major}.${minor}.${patch}`);
    for (const left of ranges)
      for (const right of ranges) {
        const shared = grid.some(
          (version) =>
            satisfiesRegistryRange(left, version) === true &&
            satisfiesRegistryRange(right, version) === true,
        );
        // A shared version proves intersection. Without one, the ranges may still touch
        // between grid points, which is why the check runs one way only.
        if (shared)
          expect(rangesIntersect(left, right), `${left} ∩ ${right}`).toBe(true);
      }
  });
});
