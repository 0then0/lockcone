import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { Report } from '../src/analysis/diff.js';
import { explain, why } from '../src/analysis/explain.js';
import {
  maxCorrespondencesPerChange,
  maxPeerChanges,
  type PeerContextChange,
} from '../src/analysis/peers.js';
import type { RepositoryState } from '../src/git/repository.js';
import { renderJson } from '../src/output/json.js';
import { renderText } from '../src/output/text.js';
import { buildPnpmState } from '../src/pnpm/dependency-graph.js';
import {
  maxContextDepth,
  maxContextLength,
  PeerIndex,
  parsePeerContext,
} from '../src/pnpm/peers.js';
import { fixture } from './helpers.js';

// Hand-built repositories: each holds only what a case needs. The pnpm-generated
// lockfiles of the upstream case are under tests/fixtures/peers.

interface Package {
  peers?: Record<string, string>;
  optional?: string[];
}
interface Snapshot {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  transitivePeerDependencies?: string[];
}
interface Project {
  dir: string;
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
interface Setup {
  projects: Project[];
  // Metadata by `name@version`. Every snapshot gets an entry unless listed in `bare`.
  packages?: Record<string, Package>;
  bare?: string[];
  snapshots: Record<string, Snapshot>;
}

const baseKey = (key: string): string => key.split('(')[0]!;

function world(setup: Setup): RepositoryState {
  const files = new Map<string, string>();
  const importers: Record<string, unknown> = {};
  for (const project of setup.projects) {
    const manifest: Record<string, unknown> = {
      name: project.name ?? (project.dir === '.' ? 'root' : project.dir),
      version: '1.0.0',
    };
    const importer: Record<string, unknown> = {};
    for (const section of ['dependencies', 'devDependencies'] as const) {
      const entries = project[section];
      if (!entries) continue;
      const specifier = (version: string): string =>
        version.startsWith('link:') ? 'workspace:*' : baseKey(version);
      manifest[section] = Object.fromEntries(
        Object.entries(entries).map(([name, version]) => [name, specifier(version)]),
      );
      importer[section] = Object.fromEntries(
        Object.entries(entries).map(([name, version]) => [
          name,
          { specifier: specifier(version), version },
        ]),
      );
    }
    importers[project.dir] = importer;
    files.set(
      project.dir === '.' ? 'package.json' : `${project.dir}/package.json`,
      JSON.stringify(manifest),
    );
  }
  if (setup.projects.some((project) => project.dir !== '.'))
    files.set('pnpm-workspace.yaml', stringify({ packages: ['.', 'packages/*'] }));
  const packages: Record<string, unknown> = {};
  for (const key of Object.keys(setup.snapshots)) {
    const name = baseKey(key);
    if (setup.bare?.includes(name)) continue;
    const entry = setup.packages?.[name] ?? {};
    packages[name] = {
      ...(entry.peers ? { peerDependencies: entry.peers } : {}),
      ...(entry.optional
        ? {
            peerDependenciesMeta: Object.fromEntries(
              entry.optional.map((peer) => [peer, { optional: true }]),
            ),
          }
        : {}),
    };
  }
  files.set(
    'pnpm-lock.yaml',
    stringify({
      lockfileVersion: '9.0',
      importers,
      packages,
      snapshots: setup.snapshots,
    }),
  );
  return { revision: 'fixture', files };
}

const react = { 'react@17.0.0': {}, 'react@18.0.0': {}, 'react@19.0.0': {} };
const lib: Record<string, Package> = { 'lib@1.0.0': { peers: { react: '*' } } };
const bound = (version: string): Record<string, Snapshot> => ({
  [`lib@1.0.0(react@${version})`]: { dependencies: { react: version } },
});

function only(report: Report, name: string): PeerContextChange {
  const found = report.peerBindings.changes.filter((change) => change.name === name);
  expect(found).toHaveLength(1);
  return found[0]!;
}

// The root depends on lib, whose react peer is bound to `version` or left unbound.
function single(version: string | null, extra: Partial<Setup> = {}): RepositoryState {
  return world({
    projects: [
      {
        dir: '.',
        dependencies: {
          lib: version === null ? '1.0.0' : `1.0.0(react@${version})`,
          ...(version === null ? {} : { react: version }),
        },
      },
    ],
    packages: lib,
    snapshots: {
      ...(version === null ? { 'lib@1.0.0': {} } : bound(version)),
      ...react,
    },
    ...extra,
  });
}

describe('context parser', () => {
  it('reads nested and scoped contexts by structure', () => {
    const context = parsePeerContext(
      '@scope/plugin@1.0.0(@scope/core@2.0.0(@types/node@20.1.0)(terser@5.0.0))(vite@8.0.0)',
    )!;
    expect(context).toMatchObject({
      name: '@scope/plugin',
      version: '1.0.0',
      status: 'parsed',
      raw: '(@scope/core@2.0.0(@types/node@20.1.0)(terser@5.0.0))(vite@8.0.0)',
    });
    expect(context.segments.map((segment) => segment.provider)).toEqual([
      '@scope/core@2.0.0(@types/node@20.1.0)(terser@5.0.0)',
      'vite@8.0.0',
    ]);
    expect(context.segments[0]!.nested.map((segment) => segment.name)).toEqual([
      '@types/node',
      'terser',
    ]);
  });

  it('keeps a patch hash apart from the peers at every level', () => {
    const context = parsePeerContext(
      'lib@1.0.0(patch_hash=abc)(react@18.0.0(patch_hash=def))',
    )!;
    expect(context).toMatchObject({
      patchHash: 'abc',
      raw: '(react@18.0.0(patch_hash=def))',
    });
    expect(context.segments[0]).toMatchObject({
      name: 'react',
      version: '18.0.0',
      patchHash: 'def',
      provider: 'react@18.0.0(patch_hash=def)',
    });
  });

  it.each([
    ['lib@1.0.0(0f3a9c5d2b7e4a61)', 'opaque'],
    ['lib@1.0.0(react@18.0.0(0f3a9c5d2b7e4a61))', 'opaque'],
    ['lib@1.0.0(react@18.0.0', 'malformed'],
    ['lib@1.0.0(react@18.0.0))', 'malformed'],
    ['lib@1.0.0(react@18.0.0)x', 'malformed'],
    ['lib@1.0.0(react@18.0.0(a@1.0.0)x)', 'malformed'],
    ['lib@1.0.0(react@17.0.0)(react@18.0.0)', 'malformed'],
    ['lib@1.0.0(patch_hash=a)(patch_hash=b)', 'malformed'],
    [`lib@1.0.0${'(a@1.0.0'.repeat(maxContextDepth + 1)}`, 'limit'],
    [`lib@1.0.0(react@${'1'.repeat(maxContextLength)})`, 'limit'],
    [`lib@1.0.0${'(a@1.0.0)'.repeat(300)}`, 'limit'],
  ])('reports %s as %s without guessing providers', (id, status) => {
    const context = parsePeerContext(id)!;
    expect(context.status).toBe(status);
    expect(context.problems).toHaveLength(1);
    // The parsed part of an opaque key stays as evidence. Other failures keep none.
    if (status !== 'opaque') expect(context.segments).toEqual([]);
  });

  it('accepts the deepest supported nesting', () => {
    const id = `lib@1.0.0${'(a@1.0.0'.repeat(maxContextDepth)}${')'.repeat(maxContextDepth)}`;
    expect(parsePeerContext(id)!.status).toBe('parsed');
  });
});

describe('a direct peer provider', () => {
  it('reports an added provider with its declaration, edge, and consumer path', () => {
    const report = explain(single(null), single('18.0.0'));
    const change = only(report, 'lib');
    expect(change).toMatchObject({
      version: '1.0.0',
      shape: 'one-to-one',
      ambiguous: false,
      events: ['provider-added'],
      uncertainty: [],
    });
    expect(change.correspondences).toEqual([
      expect.objectContaining({
        base: 'lib@1.0.0',
        head: 'lib@1.0.0(react@18.0.0)',
        support: 'same-holder',
        established: true,
        bindingChanges: [
          {
            peer: 'react',
            change: 'provider-added',
            before: null,
            after: 'react@18.0.0',
            kind: { base: 'unbound', head: 'direct' },
            optional: false,
          },
        ],
      }),
    ]);
    expect(change.base[0]!.bindings).toEqual([
      expect.objectContaining({ peer: 'react', kind: 'unbound', provider: null }),
    ]);
    expect(change.head[0]!.bindings).toEqual([
      expect.objectContaining({
        peer: 'react',
        kind: 'direct',
        provider: 'react@18.0.0',
        declaration: { package: 'lib@1.0.0', range: '*', optional: false },
        edge: {
          holder: 'lib@1.0.0(react@18.0.0)',
          section: 'dependencies',
          name: 'react',
          target: 'react@18.0.0',
        },
      }),
    ]);
    expect(change.head[0]!.consumers).toEqual([
      expect.objectContaining({
        workspace: '.',
        relation: 'direct',
        section: 'dependencies',
        path: ['dependency:[".","dependencies","lib"]', 'lib@1.0.0(react@18.0.0)'],
      }),
    ]);
  });

  it('reports a removed provider and a provider version change', () => {
    expect(only(explain(single('18.0.0'), single(null)), 'lib').events).toEqual([
      'provider-removed',
    ]);
    const change = only(explain(single('17.0.0'), single('18.0.0')), 'lib');
    expect(change.events).toEqual(['provider-version-changed']);
    expect(change.correspondences[0]!.bindingChanges).toEqual([
      expect.objectContaining({ before: 'react@17.0.0', after: 'react@18.0.0' }),
    ]);
  });

  it('does not raise the classification of the groups it describes', () => {
    const report = explain(single('17.0.0'), single('18.0.0'));
    // The react declaration changed and reaches lib, and the binding is confirmed.
    expect(only(report, 'lib').correspondences[0]!.established).toBe(true);
    const group = report.changes.find(
      (item) => item.name === 'lib' && item.kind === 'package',
    )!;
    expect(group.confidence).toBe('unknown');
    expect(group.reason).toBe('RESOLUTION_CONTEXT_NOT_FULLY_MODELED');
    expect(report.warnings).toEqual([]);
    expect(report.peerBindings.causality).toBe('not-established');
  });

  it('reports nothing for identical inputs', () => {
    const report = explain(single('18.0.0'), single('18.0.0'));
    expect(report.peerBindings.changes).toEqual([]);
    expect(renderText(report)).not.toContain('Peer context changes');
  });
});

describe('optional, nested, and transitive contexts', () => {
  const debug: Record<string, Package> = {
    'debug@4.0.0': { peers: { 'supports-color': '*' }, optional: ['supports-color'] },
  };
  const wrapped = (color: string | null): RepositoryState => {
    const suffix = color === null ? '' : `(supports-color@${color})`;
    return world({
      projects: [{ dir: '.', devDependencies: { runner: `1.0.0${suffix}` } }],
      packages: debug,
      snapshots: {
        [`runner@1.0.0${suffix}`]: {
          dependencies: { debug: `4.0.0${suffix}` },
          ...(color === null ? {} : { transitivePeerDependencies: ['supports-color'] }),
        },
        [`debug@4.0.0${suffix}`]:
          color === null ? {} : { optionalDependencies: { 'supports-color': color } },
        'supports-color@7.0.0': {},
      },
    });
  };

  it('shows an optional peer appearing while every version stays the same', () => {
    const report = explain(wrapped(null), wrapped('7.0.0'));
    expect(only(report, 'debug').correspondences[0]).toMatchObject({
      base: 'debug@4.0.0',
      head: 'debug@4.0.0(supports-color@7.0.0)',
      // The dependent runner has another context too, so it is matched by name and version.
      support: 'holder-rekeyed',
      established: true,
      bindingChanges: [
        expect.objectContaining({
          change: 'provider-added',
          kind: { base: 'unbound', head: 'direct' },
          optional: true,
        }),
      ],
    });
    for (const group of report.changes) expect(group.confidence).toBe('unknown');
  });

  it('separates an inherited context from a direct binding', () => {
    const report = explain(wrapped(null), wrapped('7.0.0'));
    const runner = only(report, 'runner');
    expect(runner.correspondences[0]!.support).toBe('same-holder');
    expect(runner.head[0]!.bindings).toEqual([
      expect.objectContaining({
        peer: 'supports-color',
        kind: 'transitive',
        declaration: null,
        edge: null,
        listedTransitive: true,
        inheritedThrough: [
          {
            holder: 'runner@1.0.0(supports-color@7.0.0)',
            section: 'dependencies',
            name: 'debug',
            target: 'debug@4.0.0(supports-color@7.0.0)',
          },
        ],
      }),
    ]);
    const text = renderText(why(report, 'runner'), { detail: true });
    expect(text).toContain('transitive context, inherited through a dependency');
    expect(text).toContain(
      'head declaration: (the package does not declare this peer)',
    );
    expect(text).toContain(
      'head inherited through: runner@1.0.0(supports-color@7.0.0) -- dependencies.debug -> debug@4.0.0(supports-color@7.0.0)',
    );
  });

  it('reports a change that is only in the nested part of a scoped provider', () => {
    const state = (node: string): RepositoryState =>
      world({
        projects: [
          {
            dir: '.',
            dependencies: { plugin: `1.0.0(@scope/core@2.0.0(@types/node@${node}))` },
          },
        ],
        packages: {
          'plugin@1.0.0': { peers: { '@scope/core': '^2.0.0' } },
          '@scope/core@2.0.0': {
            peers: { '@types/node': '*' },
            optional: ['@types/node'],
          },
        },
        snapshots: {
          [`plugin@1.0.0(@scope/core@2.0.0(@types/node@${node}))`]: {
            dependencies: { '@scope/core': `2.0.0(@types/node@${node})` },
            transitivePeerDependencies: ['@types/node'],
          },
          [`@scope/core@2.0.0(@types/node@${node})`]: {
            optionalDependencies: { '@types/node': node },
          },
          [`@types/node@${node}`]: {},
        },
      });
    const report = explain(state('20.0.0'), state('22.0.0'));
    expect(only(report, 'plugin').correspondences[0]!.bindingChanges).toEqual([
      {
        peer: '@scope/core',
        change: 'nested-context-changed',
        before: '@scope/core@2.0.0(@types/node@20.0.0)',
        after: '@scope/core@2.0.0(@types/node@22.0.0)',
        kind: { base: 'direct', head: 'direct' },
        optional: false,
      },
    ]);
    expect(only(report, '@scope/core').events).toEqual(['provider-version-changed']);
    // `why` on a provider keeps the contexts that name it.
    expect(
      why(report, '@scope/core').peerBindings.changes.map((change) => change.name),
    ).toEqual(['@scope/core', 'plugin']);
    expect(why(report, 'unrelated').peerBindings.changes).toEqual([]);
  });
});

describe('evidence that does not support the key', () => {
  const state = (snapshot: Snapshot, extra: Partial<Setup> = {}): RepositoryState =>
    world({
      projects: [{ dir: '.', dependencies: { lib: '1.0.0(react@18.0.0)' } }],
      packages: lib,
      snapshots: { 'lib@1.0.0(react@18.0.0)': snapshot, ...react },
      ...extra,
    });
  const kindOf = (report: Report) =>
    only(report, 'lib').head[0]!.bindings.map((binding) => [
      binding.kind,
      binding.notes.map((note) => note.code),
    ]);

  it('leaves a provider that no edge confirms unconfirmed', () => {
    const report = explain(single(null), state({}));
    expect(kindOf(report)).toEqual([['unconfirmed', ['NO_PROVIDER_EDGE']]]);
    expect(only(report, 'lib').uncertainty).toEqual([
      'head lib@1.0.0(react@18.0.0) react: The key names react@18.0.0, but the snapshot has no react edge.',
    ]);
  });

  it('keeps a contradiction between the key and the edge', () => {
    const report = explain(single(null), state({ dependencies: { react: '17.0.0' } }));
    expect(kindOf(report)).toEqual([['conflicting', ['SUFFIX_EDGE_MISMATCH']]]);
    expect(only(report, 'lib').head[0]!.bindings[0]!.edge?.target).toBe('react@17.0.0');
  });

  it('reports a context that stays the same while its edge changes', () => {
    const report = explain(
      state({ dependencies: { react: '18.0.0' } }),
      state({ dependencies: { react: '17.0.0' } }),
    );
    expect(only(report, 'lib')).toMatchObject({
      shape: 'same-context',
      events: ['evidence-changed'],
      correspondences: [
        expect.objectContaining({
          support: 'same-context',
          bindingChanges: [
            expect.objectContaining({
              change: 'evidence-changed',
              before: 'react@18.0.0',
              after: 'react@18.0.0',
              kind: { base: 'direct', head: 'conflicting' },
            }),
          ],
        }),
      ],
    });
  });

  it('does not treat a name in the key as a binding without a declaration', () => {
    const report = explain(
      single(null, { packages: {} }),
      state({ dependencies: { react: '18.0.0' } }, { packages: {} }),
    );
    expect(kindOf(report)).toEqual([['unconfirmed', ['NOT_DECLARED_NOT_INHERITED']]]);
  });

  it('does not assume a declaration when package metadata is missing', () => {
    const report = explain(
      single(null),
      state({ dependencies: { react: '18.0.0' } }, { bare: ['lib@1.0.0'] }),
    );
    expect(kindOf(report)).toEqual([['unconfirmed', ['METADATA_MISSING']]]);
  });

  it('does not confirm a provider whose snapshot is missing', () => {
    const head = world({
      projects: [{ dir: '.', dependencies: { lib: '1.0.0(react@18.0.0)' } }],
      packages: lib,
      snapshots: { 'lib@1.0.0(react@18.0.0)': { dependencies: { react: '18.0.0' } } },
    });
    const report = explain(single(null), head);
    expect(kindOf(report)).toEqual([['unconfirmed', ['PROVIDER_SNAPSHOT_MISSING']]]);
    expect(report.warnings).toContain(
      'Unresolved dependency: snapshot: react -> 18.0.0',
    );
  });

  it.each([
    ['lib@1.0.0(0f3a9c5d2b7e4a61)', 'opaque', 'not name@version'],
    ['lib@1.0.0(react@18.0.0', 'malformed', 'unbalanced parentheses'],
  ])('compares no bindings for %s', (key, status, reason) => {
    const head = world({
      projects: [{ dir: '.', dependencies: { lib: key.slice('lib@'.length) } }],
      packages: lib,
      snapshots: { [key]: { dependencies: { react: '18.0.0' } }, ...react },
    });
    const report = explain(single('17.0.0'), head);
    const change = only(report, 'lib');
    expect(change.events).toEqual(['context-unreadable']);
    expect(change.head[0]).toMatchObject({
      id: key,
      contextStatus: status,
      bindings: [],
    });
    expect(change.correspondences[0]!.bindingChanges).toBeNull();
    expect(change.uncertainty.join(' ')).toContain(reason);
    expect(renderText(report)).toContain(
      '(a context is unreadable; bindings are not compared)',
    );
  });
});

describe('a malformed key next to a readable one', () => {
  const keyed = (key: string): RepositoryState =>
    world({
      projects: [{ dir: '.', dependencies: { lib: key.slice('lib@'.length) } }],
      packages: lib,
      snapshots: { [key]: {}, ...react },
    });

  it.each([
    ['lib@1.0.0', 'lib@1.0.0(react@18.0.0'],
    ['lib@1.0.0(react@18.0.0)', 'lib@1.0.0(react@18.0.0)x'],
  ])('does not take %s and %s for the same context', (readable, damaged) => {
    for (const [base, head] of [
      [readable, damaged],
      [damaged, readable],
    ] as const) {
      const change = only(explain(keyed(base), keyed(head)), 'lib');
      expect(change).toMatchObject({
        shape: 'one-to-one',
        events: ['context-unreadable'],
      });
      expect(change.correspondences[0]).toMatchObject({
        base,
        head,
        bindingChanges: null,
      });
      const view = base === damaged ? change.base[0]! : change.head[0]!;
      // The suffix is kept exactly as the lockfile has it.
      expect(view).toMatchObject({
        contextStatus: 'malformed',
        changed: true,
        rawContext: damaged.slice('lib@1.0.0'.length),
      });
    }
  });
});

describe('patch hashes next to a peer context', () => {
  const patched = (hash: string, version: string): RepositoryState =>
    world({
      projects: [
        {
          dir: '.',
          dependencies: { lib: `1.0.0(patch_hash=${hash})(react@${version})` },
        },
      ],
      packages: lib,
      snapshots: {
        [`lib@1.0.0(patch_hash=${hash})(react@${version})`]: {
          dependencies: { react: version },
        },
        ...react,
      },
    });

  it('reports the peer change and notes the patch hash', () => {
    const change = only(
      explain(patched('aa', '17.0.0'), patched('bb', '18.0.0')),
      'lib',
    );
    expect(change.events).toEqual(['patch-hash-changed', 'provider-version-changed']);
    expect(change.correspondences[0]!.patchHash).toEqual({ base: 'aa', head: 'bb' });
    expect(change.head[0]).toMatchObject({
      rawContext: '(react@18.0.0)',
      patchHash: 'bb',
    });
  });

  it('does not report a patch-only change as a peer context change', () => {
    const report = explain(patched('aa', '18.0.0'), patched('bb', '18.0.0'));
    expect(report.peerBindings.changes).toEqual([]);
  });

  it('does not report a patched provider as another provider', () => {
    const state = (hash: string): RepositoryState =>
      world({
        projects: [
          {
            dir: '.',
            dependencies: { lib: `1.0.0(react@18.0.0(patch_hash=${hash}))` },
          },
        ],
        packages: lib,
        snapshots: {
          [`lib@1.0.0(react@18.0.0(patch_hash=${hash}))`]: {
            dependencies: { react: `18.0.0(patch_hash=${hash})` },
          },
          [`react@18.0.0(patch_hash=${hash})`]: {},
        },
      });
    expect(
      new PeerIndex(buildPnpmState(state('aa')).graph).instance(
        'lib@1.0.0(react@18.0.0(patch_hash=aa))',
      )!.bindings[0],
    ).toMatchObject({ kind: 'direct', provider: 'react@18.0.0(patch_hash=aa)' });
    expect(explain(state('aa'), state('bb')).peerBindings.changes).toEqual([]);
  });
});

describe('correspondence between several instances', () => {
  // Workspaces a and b each depend on lib with their own react.
  const pair = (a: string, b: string): RepositoryState =>
    world({
      projects: [
        { dir: '.' },
        { dir: 'packages/a', dependencies: { lib: `1.0.0(react@${a})` } },
        { dir: 'packages/b', dependencies: { lib: `1.0.0(react@${b})` } },
      ],
      packages: lib,
      snapshots: { ...bound(a), ...bound(b), ...react },
    });

  it('pairs parallel instances through the dependent that holds each of them', () => {
    const report = explain(pair('17.0.0', '18.0.0'), pair('17.0.0', '19.0.0'));
    const change = only(report, 'lib');
    expect(change).toMatchObject({ shape: 'one-to-one', ambiguous: false });
    expect(change.base.map((instance) => instance.id)).toEqual([
      'lib@1.0.0(react@18.0.0)',
    ]);
    expect(change.correspondences[0]).toMatchObject({
      head: 'lib@1.0.0(react@19.0.0)',
      support: 'same-holder',
    });
    expect(change.head[0]!.consumers.map((consumer) => consumer.workspace)).toEqual([
      'packages/b',
    ]);
  });

  it('reports a split and a merge with the dependent that moved', () => {
    const split = only(
      explain(pair('17.0.0', '17.0.0'), pair('17.0.0', '18.0.0')),
      'lib',
    );
    expect(split).toMatchObject({
      shape: 'split',
      ambiguous: false,
      events: ['instance-split', 'provider-version-changed'],
    });
    expect(split.head.map((instance) => [instance.id, instance.changed])).toEqual([
      ['lib@1.0.0(react@17.0.0)', false],
      ['lib@1.0.0(react@18.0.0)', true],
    ]);
    expect(split.correspondences).toEqual([
      expect.objectContaining({
        base: 'lib@1.0.0(react@17.0.0)',
        head: 'lib@1.0.0(react@18.0.0)',
        established: true,
        edges: [
          expect.objectContaining({
            base: [
              expect.objectContaining({
                holder: 'dependency:["packages/b","dependencies","lib"]',
              }),
            ],
          }),
        ],
      }),
    ]);
    const merge = only(
      explain(pair('17.0.0', '18.0.0'), pair('17.0.0', '17.0.0')),
      'lib',
    );
    expect(merge).toMatchObject({
      shape: 'merge',
      ambiguous: false,
      events: ['instance-merged', 'provider-version-changed'],
    });
    // The instance that took over is used by both workspaces.
    expect(merge.head[0]!.consumers.map((consumer) => consumer.workspace)).toEqual([
      'packages/a',
      'packages/b',
    ]);
  });

  // Two wrap instances each hold their own lib, and all of them change context, so the
  // wrap dependents can only be matched by name and version.
  const wrappers = (versions: string[], order = versions): RepositoryState => {
    const snapshots: Record<string, Snapshot> = {};
    for (const version of order) {
      snapshots[`wrap@1.0.0(react@${version})`] = {
        dependencies: { lib: `1.0.0(react@${version})` },
        transitivePeerDependencies: ['react'],
      };
      snapshots[`lib@1.0.0(react@${version})`] = { dependencies: { react: version } };
      snapshots[`react@${version}`] = {};
    }
    return world({
      projects: [
        { dir: '.' },
        ...versions.map((version, index) => ({
          dir: `packages/p${index}`,
          dependencies: { wrap: `1.0.0(react@${version})` },
        })),
      ],
      packages: lib,
      snapshots,
    });
  };

  it('lists every possible pair when the dependents do not single one out', () => {
    const base = wrappers(['17.0.0', '18.0.0']);
    const head = wrappers(['17.1.0', '19.0.0']);
    const report = explain(base, head);
    const change = only(report, 'lib');
    expect(change).toMatchObject({ shape: 'many-to-many', ambiguous: true });
    expect(
      change.correspondences.map((item) => [
        item.base,
        item.head,
        item.support,
        item.established,
      ]),
    ).toEqual([
      ['lib@1.0.0(react@17.0.0)', 'lib@1.0.0(react@17.1.0)', 'ambiguous', false],
      ['lib@1.0.0(react@17.0.0)', 'lib@1.0.0(react@19.0.0)', 'ambiguous', false],
      ['lib@1.0.0(react@18.0.0)', 'lib@1.0.0(react@17.1.0)', 'ambiguous', false],
      ['lib@1.0.0(react@18.0.0)', 'lib@1.0.0(react@19.0.0)', 'ambiguous', false],
    ]);
    expect(change.uncertainty).toContain(
      'The shared dependents point at several instances on a side; the listed pairs are possible correspondences, not established ones.',
    );
    expect(renderText(report)).toContain(
      'lib@1.0.0(react@17.0.0) → lib@1.0.0(react@19.0.0) [possible; ambiguous]',
    );
    // The wrap instances themselves are held by workspace entries and pair exactly.
    expect(
      report.peerBindings.changes
        .filter((item) => item.name === 'wrap')
        .map((item) => [
          item.shape,
          item.correspondences[0]!.base,
          item.correspondences[0]!.head,
          item.correspondences[0]!.support,
        ]),
    ).toEqual([
      [
        'one-to-one',
        'wrap@1.0.0(react@17.0.0)',
        'wrap@1.0.0(react@17.1.0)',
        'same-holder',
      ],
      [
        'one-to-one',
        'wrap@1.0.0(react@18.0.0)',
        'wrap@1.0.0(react@19.0.0)',
        'same-holder',
      ],
    ]);
    // Neither the order of the lockfile keys nor of the importers selects a pair.
    const reordered = explain(
      wrappers(['17.0.0', '18.0.0'], ['18.0.0', '17.0.0']),
      wrappers(['17.1.0', '19.0.0'], ['19.0.0', '17.1.0']),
    );
    expect(renderJson(reordered)).toBe(renderJson(report));
    expect(renderText(reordered, { detail: true })).toBe(
      renderText(report, { detail: true }),
    );
  });

  it('lists no pair at all once the possibilities exceed the limit', () => {
    const versions = (major: number): string[] =>
      Array.from({ length: 5 }, (_, index) => `${major}.${index}.0`);
    const change = only(explain(wrappers(versions(17)), wrappers(versions(18))), 'lib');
    expect(25).toBeGreaterThan(maxCorrespondencesPerChange);
    expect(change).toMatchObject({
      ambiguous: true,
      correspondences: [],
      correspondencesOmitted: 25,
    });
    expect(change.base).toHaveLength(5);
    expect(change.uncertainty).toContain(
      '25 possible correspondences exceed the limit of 16; none is listed, and no pair was chosen.',
    );
  });

  it('does not pair instances by name and version when no dependent is shared', () => {
    const state = (holder: string, version: string): RepositoryState =>
      world({
        projects: [{ dir: '.', dependencies: { [holder]: '1.0.0' } }],
        packages: lib,
        snapshots: {
          [`${holder}@1.0.0`]: { dependencies: { lib: `1.0.0(react@${version})` } },
          ...bound(version),
          ...react,
        },
      });
    const change = only(explain(state('old', '17.0.0'), state('new', '18.0.0')), 'lib');
    expect(change).toMatchObject({ shape: 'unlinked', ambiguous: true });
    expect(change.correspondences).toEqual([
      expect.objectContaining({ support: 'unlinked', established: false, edges: [] }),
    ]);
    expect(change.uncertainty).toContain(
      'No dependent edge is shared by these instances; equal name and version do not establish which instance replaced which.',
    );
  });

  it('marks a pair that only a dependent with a new version ties together', () => {
    const state = (holder: string, version: string): RepositoryState =>
      world({
        projects: [{ dir: '.', dependencies: { holder } }],
        packages: lib,
        snapshots: {
          [`holder@${holder}`]: { dependencies: { lib: `1.0.0(react@${version})` } },
          ...bound(version),
          ...react,
        },
      });
    const change = only(
      explain(state('1.0.0', '17.0.0'), state('2.0.0', '18.0.0')),
      'lib',
    );
    expect(change.correspondences[0]).toMatchObject({
      support: 'holder-version-changed',
      established: true,
    });
    expect(change.uncertainty).toEqual([
      'lib@1.0.0(react@17.0.0) → lib@1.0.0(react@18.0.0): the dependent that ties the pair changed its version.',
    ]);
  });

  it('lists a parallel instance that appears or disappears on its own', () => {
    const state = (extra: boolean): RepositoryState =>
      world({
        projects: [
          { dir: '.' },
          { dir: 'packages/a', dependencies: { lib: '1.0.0(react@17.0.0)' } },
          ...(extra
            ? [{ dir: 'packages/b', dependencies: { lib: '1.0.0(react@18.0.0)' } }]
            : []),
        ],
        packages: lib,
        snapshots: { ...bound('17.0.0'), ...(extra ? bound('18.0.0') : {}), ...react },
      });
    const added = only(explain(state(false), state(true)), 'lib');
    expect(added).toMatchObject({
      shape: 'added',
      events: ['instance-added'],
      base: [],
    });
    expect(added.head[0]!.bindings[0]).toMatchObject({ kind: 'direct' });
    expect(renderText(explain(state(false), state(true)))).toContain(
      'head only: lib@1.0.0(react@18.0.0)',
    );
    expect(only(explain(state(true), state(false)), 'lib').shape).toBe('removed');
  });

  it('leaves a version change to the graph changes', () => {
    const state = (version: string, peer: string): RepositoryState =>
      world({
        projects: [{ dir: '.', dependencies: { lib: `${version}(react@${peer})` } }],
        packages: { [`lib@${version}`]: { peers: { react: '*' } } },
        snapshots: {
          [`lib@${version}(react@${peer})`]: { dependencies: { react: peer } },
          ...react,
        },
      });
    const report = explain(state('1.0.0', '17.0.0'), state('1.1.0', '18.0.0'));
    expect(report.peerBindings.changes).toEqual([]);
    expect(report.changes.some((item) => item.name === 'lib')).toBe(true);
  });
});

describe('workspace consumers', () => {
  // app links ui. ui uses lib at runtime and devlib for development.
  const state = (version: string): RepositoryState =>
    world({
      projects: [
        { dir: '.' },
        { dir: 'packages/app', dependencies: { ui: 'link:../ui' } },
        {
          dir: 'packages/ui',
          dependencies: { lib: `1.0.0(react@${version})` },
          devDependencies: { devlib: `1.0.0(react@${version})` },
        },
      ],
      packages: { ...lib, 'devlib@1.0.0': { peers: { react: '*' } } },
      snapshots: {
        ...bound(version),
        [`devlib@1.0.0(react@${version})`]: { dependencies: { react: version } },
        ...react,
      },
    });

  it('inherits runtime dependencies through a workspace link, not development ones', () => {
    const report = explain(state('17.0.0'), state('18.0.0'));
    expect(
      only(report, 'lib').head[0]!.consumers.map((consumer) => [
        consumer.workspace,
        consumer.relation,
        consumer.section,
        consumer.path,
      ]),
    ).toEqual([
      [
        'packages/ui',
        'direct',
        'dependencies',
        ['dependency:["packages/ui","dependencies","lib"]', 'lib@1.0.0(react@18.0.0)'],
      ],
      [
        'packages/app',
        'transitive',
        'dependencies',
        [
          'dependency:["packages/app","dependencies","ui"]',
          'workspace:packages/ui',
          'dependency:["packages/ui","dependencies","lib"]',
          'lib@1.0.0(react@18.0.0)',
        ],
      ],
    ]);
    expect(
      only(report, 'devlib').head[0]!.consumers.map((consumer) => [
        consumer.workspace,
        consumer.section,
      ]),
    ).toEqual([['packages/ui', 'devDependencies']]);
    const text = renderText(why(report, 'lib'), { detail: true });
    expect(text).toContain(
      'head: packages/app: transitive consumer via dependencies of lib@1.0.0(react@18.0.0); uncertain',
    );
    expect(text).toContain(
      'path dependency:["packages/app","dependencies","ui"] → workspace:packages/ui → dependency:["packages/ui","dependencies","lib"] → lib@1.0.0(react@18.0.0)',
    );
    expect(text).not.toContain('devlib');
  });
});

describe('limits on the report', () => {
  it('lists the first changes and counts the rest', () => {
    const state = (version: string): RepositoryState => {
      const names = Array.from(
        { length: maxPeerChanges + 1 },
        (_, index) => `p${String(index).padStart(3, '0')}`,
      );
      return world({
        projects: [
          {
            dir: '.',
            dependencies: Object.fromEntries(
              names.map((name) => [name, `1.0.0(react@${version})`]),
            ),
          },
        ],
        packages: Object.fromEntries(
          names.map((name) => [`${name}@1.0.0`, { peers: { react: '*' } }]),
        ),
        snapshots: {
          ...Object.fromEntries(
            names.map((name) => [
              `${name}@1.0.0(react@${version})`,
              { dependencies: { react: version } },
            ]),
          ),
          ...react,
        },
      });
    };
    const { peerBindings } = explain(state('17.0.0'), state('18.0.0'));
    expect(peerBindings.changes).toHaveLength(maxPeerChanges);
    expect(peerBindings.changes.at(-1)!.name).toBe('p099');
    expect(peerBindings.changesOmitted).toBe(1);
    expect(peerBindings.truncated).toEqual([
      '1 more peer context change(s) not listed after the limit of 100.',
    ]);
  });
});

describe('pnpm 12.4.1 lockfiles of pnpm/pnpm#14895', () => {
  const pass1 = fixture('peers/pnpm-14895', 'pass1');
  const pass2 = fixture('peers/pnpm-14895', 'pass2');
  const report = explain(pass1, pass2);

  it('shows the optional peer attached to debug at an unchanged version', () => {
    expect(report.peerBindings.changes.map((change) => change.name)).toEqual([
      'debug',
      'vite-plugin-node',
    ]);
    const debug = only(report, 'debug');
    expect(debug).toMatchObject({
      version: '4.4.3',
      shape: 'one-to-one',
      ambiguous: false,
      events: ['provider-added'],
    });
    expect(debug.correspondences[0]).toMatchObject({
      base: 'debug@4.4.3',
      head: 'debug@4.4.3(supports-color@7.2.0)',
      support: 'holder-rekeyed',
      bindingChanges: [
        {
          peer: 'supports-color',
          change: 'provider-added',
          before: null,
          after: 'supports-color@7.2.0',
          kind: { base: 'unbound', head: 'direct' },
          optional: true,
        },
      ],
    });
    expect(debug.head[0]!.bindings[0]).toMatchObject({
      declaration: { package: 'debug@4.4.3', range: '*', optional: true },
      edge: {
        holder: 'debug@4.4.3(supports-color@7.2.0)',
        section: 'optionalDependencies',
        name: 'supports-color',
        target: 'supports-color@7.2.0',
      },
    });
    expect(debug.head[0]!.consumers[0]!.path).toEqual([
      'dependency:[".","devDependencies","vite-plugin-node"]',
      'vite-plugin-node@8.0.0(supports-color@7.2.0)(vite@8.3.7)',
      'debug@4.4.3(supports-color@7.2.0)',
    ]);
  });

  it('shows the context that vite-plugin-node inherits, next to its own vite peer', () => {
    const plugin = only(report, 'vite-plugin-node');
    expect(plugin.correspondences[0]).toMatchObject({
      base: 'vite-plugin-node@8.0.0(vite@8.3.7)',
      head: 'vite-plugin-node@8.0.0(supports-color@7.2.0)(vite@8.3.7)',
      support: 'same-holder',
      bindingChanges: [
        expect.objectContaining({
          peer: 'supports-color',
          change: 'provider-added',
          kind: { base: null, head: 'transitive' },
          optional: null,
        }),
      ],
    });
    expect(
      plugin.head[0]!.bindings.map((binding) => [binding.peer, binding.kind]),
    ).toEqual([
      ['@swc/core', 'unbound'],
      ['supports-color', 'transitive'],
      ['vite', 'direct'],
    ]);
    expect(plugin.head[0]!.consumers[0]).toMatchObject({
      workspace: '.',
      relation: 'direct',
      section: 'devDependencies',
    });
  });

  it('keeps every group unknown and adds no warning', () => {
    expect(report.summary).toEqual({
      explained: 0,
      'partially-explained': 0,
      unexplained: 0,
      unknown: 3,
    });
    expect(report.warnings).toEqual([]);
    expect(report.schemaVersion).toBe(4);
    expect(report.peerBindings.reportVersion).toBe(1);
  });

  it('prints a compact diff and the evidence in why', () => {
    const text = renderText(report);
    expect(text).toContain(
      [
        '  debug@4.4.3: provider-added (one-to-one)',
        '    debug@4.4.3 → debug@4.4.3(supports-color@7.2.0) [holder-rekeyed]',
        '      supports-color: (no provider) → supports-color@7.2.0 (provider-added; head: direct optional peer, declaration and edge agree)',
      ].join('\n'),
    );
    // Unchanged bindings such as vite stay out of the text.
    expect(text).not.toContain('      vite:');
    const detail = renderText(why(report, 'debug'), { detail: true });
    expect(detail).toContain(
      'head declaration: debug@4.4.3 peerDependencies.supports-color "*" (optional)',
    );
    expect(detail).toContain(
      'head edge: debug@4.4.3(supports-color@7.2.0) -- optionalDependencies.supports-color -> supports-color@7.2.0',
    );
    expect(detail).not.toContain('vite-plugin-node@8.0.0: provider-added');
    expect(JSON.parse(renderJson(report)).peerBindings).toEqual(
      JSON.parse(JSON.stringify(report.peerBindings)),
    );
  });

  it('reports the removed provider and a merge across the first, drifted pass', () => {
    const first = explain(fixture('peers/pnpm-14895', 'initial'), pass1);
    expect(only(first, 'debug').correspondences[0]!.bindingChanges).toEqual([
      expect.objectContaining({
        change: 'provider-removed',
        before: 'supports-color@8.1.1',
        after: null,
      }),
    ]);
    expect(only(first, 'vite-plugin-node').correspondences[0]!.bindingChanges).toEqual([
      expect.objectContaining({ peer: 'supports-color', change: 'provider-removed' }),
      expect.objectContaining({
        peer: 'vite',
        change: 'provider-version-changed',
        before: 'vite@8.3.0(@types/node@26.5.1)(terser@5.51.2)',
        after: 'vite@8.3.7',
      }),
    ]);
    // ajv-formats had two contexts and keeps one of them.
    expect(only(first, 'ajv-formats')).toMatchObject({
      shape: 'merge',
      events: ['instance-merged', 'provider-version-changed'],
    });
  });

  it('agrees with a direct reading of the classified bindings', () => {
    const index = new PeerIndex(buildPnpmState(pass2).graph);
    const snapshot = pass2.files.get('pnpm-lock.yaml')!;
    expect(snapshot).toContain(
      '  debug@4.4.3(supports-color@7.2.0):\n    dependencies:\n      ms: 2.1.3\n    optionalDependencies:\n      supports-color: 7.2.0\n',
    );
    expect(index.instance('debug@4.4.3(supports-color@7.2.0)')!.bindings).toHaveLength(
      1,
    );
    expect(index.instance('vite@8.3.7')!.context.status).toBe('none');
  });
});
