import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { explain, why } from '../src/analysis/explain.js';
import type { PatchChange, PatchReport } from '../src/analysis/patches.js';
import { maxConsumersPerInstance } from '../src/analysis/patches.js';
import type { RepositoryState } from '../src/git/repository.js';
import { parsePatchBatch, readRepository } from '../src/git/repository.js';
import { reverseIndex, reverseVisits, traverse } from '../src/graph/traversal.js';
import { renderText } from '../src/output/text.js';
import { buildPnpmState } from '../src/pnpm/dependency-graph.js';
import { applies, parseInstance, parseSelector } from '../src/pnpm/patches.js';
import { fixture } from './helpers.js';

const patchFixture = (name: string) => ({
  base: fixture(`patches/${name}`, 'base'),
  head: fixture(`patches/${name}`, 'head'),
});
const fixtureFile = (name: string, side: string, path: string): Buffer =>
  readFileSync(
    fileURLToPath(
      new URL(`./fixtures/patches/${name}/${side}/${path}`, import.meta.url),
    ),
  );
const sha256 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');
const only = (report: PatchReport, selector: string): PatchChange => {
  const change = report.changes.find((item) => item.selector.head === selector);
  if (!change) throw new Error(`No patch change for ${selector}`);
  return change;
};
const consumers = (change: PatchChange, side: 'base' | 'head'): string[] =>
  change[side]!.instances.flatMap((instance) =>
    instance.consumers.map((item) => `${item.workspace}:${item.relation}`),
  );
const short = (value: string): string => value.replace(/[0-9a-f]{40,}/g, 'HASH');

// A synthetic committed state for ambiguity and failure cases. Fixtures that need
// a real pnpm release live under tests/fixtures/patches.
interface Synthetic {
  manifest?: Record<string, unknown>;
  workspace?: string;
  lockfilePatched?: unknown;
  dependencies: Record<string, { specifier: string; version: string }>;
  snapshots: string[];
  files?: Record<string, string>;
}
function synthetic(options: Synthetic): RepositoryState {
  const dependencies = Object.fromEntries(
    Object.entries(options.dependencies).map(([name, value]) => [
      name,
      value.specifier,
    ]),
  );
  const repository: RepositoryState = {
    revision: 'synthetic',
    files: new Map([
      ['package.json', JSON.stringify({ dependencies, ...options.manifest })],
      [
        'pnpm-lock.yaml',
        stringify({
          lockfileVersion: '9.0',
          ...(options.lockfilePatched === undefined
            ? {}
            : { patchedDependencies: options.lockfilePatched }),
          importers: { '.': { dependencies: options.dependencies } },
          packages: Object.fromEntries(
            options.snapshots.map((key) => [key.split('(')[0], {}]),
          ),
          snapshots: Object.fromEntries(options.snapshots.map((key) => [key, {}])),
        }),
      ],
    ]),
  };
  if (options.workspace) repository.files.set('pnpm-workspace.yaml', options.workspace);
  for (const [path, content] of Object.entries(options.files ?? {}))
    repository.files.set(path, content);
  return repository;
}
const hashA = 'a'.repeat(64);
const hashB = 'b'.repeat(64);
const hashC = 'c'.repeat(64);
const a100 = { specifier: '1.0.0', version: '1.0.0' };
const patchedA = (hash: string) => ({
  specifier: '1.0.0',
  version: `1.0.0(patch_hash=${hash})`,
});

describe('selectors and package keys', () => {
  it.each([
    ['ms', 'name', 'ms'],
    ['ms@2.1.3', 'exact', 'ms'],
    ['@types/ms@2.1.0', 'exact', '@types/ms'],
    ['@scope/pkg', 'name', '@scope/pkg'],
    ['is-number@^6.0.0', 'range', 'is-number'],
    ['foo@>=2.0.0 <2.2.0 || >2.8.0', 'range', 'foo'],
    ['foo@latest', 'unsupported', 'foo'],
    ['foo@', 'unsupported', 'foo'],
    ['foo@npm:bar@1.0.0', 'unsupported', 'foo'],
    ['@types', 'unsupported', null],
  ])('classifies %s as %s', (text, kind, name) => {
    expect(parseSelector(text)).toMatchObject({ kind, name });
  });

  it('matches versions only through supported selector syntax', () => {
    const instance = parseInstance('is-number@6.0.0(patch_hash=abc)')!;
    expect(applies(parseSelector('is-number@^6.0.0'), instance)).toBe(true);
    expect(applies(parseSelector('is-number@^7.0.0'), instance)).toBe(false);
    expect(applies(parseSelector('is-number@6.0.0'), instance)).toBe(true);
    expect(applies(parseSelector('is-number@latest'), instance)).toBeUndefined();
    expect(applies(parseSelector('is-number-2'), instance)).toBe(false);
    const prerelease = parseInstance('is-number@6.0.0-beta.1')!;
    expect(applies(parseSelector('is-number@^6.0.0'), prerelease)).toBeUndefined();
  });

  it('separates the patch hash from peer contexts without pairing different peers', () => {
    const left = parseInstance(
      'use-sync-external-store@1.2.0(patch_hash=aa)(react@17.0.2)',
    )!;
    const right = parseInstance(
      'use-sync-external-store@1.2.0(patch_hash=bb)(react@17.0.2)',
    )!;
    const other = parseInstance(
      'use-sync-external-store@1.2.0(patch_hash=aa)(react@18.3.1)',
    )!;
    expect(left).toMatchObject({ patchHash: 'aa', peerContext: '(react@17.0.2)' });
    expect(left.identity).toBe(right.identity);
    expect(left.identity).not.toBe(other.identity);
    expect(parseInstance('x@1.0.0(react@18.3.1(patch_hash=cc))')).toMatchObject({
      patchHash: null,
      identity: 'x@1.0.0(react@18.3.1)',
    });
    expect(parseInstance('x@1.0.0(patch_hash=a)(patch_hash=b)')?.problem).toBeTruthy();
    expect(parseInstance('x@1.0.0(patch_hash=a')?.problem).toBeTruthy();
  });
});

describe('patch changes from pnpm-generated fixtures', () => {
  it('reports a content change to an unchanged version and keeps B out of the cone', () => {
    const { base, head } = patchFixture('content-change');
    const report = explain(base, head);
    const change = only(report.patches, 'is-odd@3.0.1');
    expect(change.events).toEqual(['content-changed', 'lockfile-hash-changed']);
    expect(change.content).toEqual({ status: 'changed', basis: 'sha256' });
    // The reported digests equal an independent hash of the committed bytes.
    const path = 'patches/is-odd@3.0.1.patch';
    expect(change.base!.file).toMatchObject({
      path,
      status: 'present',
      sha256: sha256(fixtureFile('content-change', 'base', path)),
    });
    expect(change.head!.file!.sha256).toBe(
      sha256(fixtureFile('content-change', 'head', path)),
    );
    expect(change.base!.declarations[0]).toMatchObject({
      source: 'pnpm-workspace.yaml',
      sourceStatus: 'active',
      reference: path,
    });
    expect(change.base!.lockfile).toMatchObject({
      hashAlgorithm: 'unconfirmed',
      shape: 'hash',
    });
    expect(change.base!.lockfile!.hash).not.toBe(change.head!.lockfile!.hash);

    for (const side of ['base', 'head'] as const) {
      const [instance] = change[side]!.instances;
      expect(change[side]!.instances).toHaveLength(1);
      expect(instance).toMatchObject({
        name: 'is-odd',
        version: '3.0.1',
        association: 'lockfile-confirmed',
        patchHash: change[side]!.lockfile!.hash,
      });
      expect(instance!.consumers).toHaveLength(1);
      expect(instance!.consumers[0]).toMatchObject({
        workspace: 'packages/a',
        relation: 'direct',
        basis: 'lockfile-confirmed',
        section: 'dependencies',
        path: [`dependency:["packages/a","dependencies","is-odd"]`, instance!.id],
      });
    }
    // The independent cone of ms is not claimed.
    const json = JSON.stringify(report.patches);
    expect(json).not.toContain('packages/b');
    expect(json).not.toContain('"ms');
    expect(report.changes.some((item) => item.name === 'ms')).toBe(false);

    // The conservative classification is unchanged: nothing becomes explained.
    expect(report.warnings).toContain(
      'Resolution input changed: patches/is-odd@3.0.1.patch',
    );
    expect(report.summary).toEqual({
      explained: 0,
      'partially-explained': 0,
      unexplained: 0,
      unknown: 2,
    });
    expect(report.changes.every((item) => item.confidence === 'unknown')).toBe(true);
  });

  it('pairs patched instances only by name, version, and peer context', () => {
    const { base, head } = patchFixture('content-change');
    const change = only(explain(base, head).patches, 'is-odd@3.0.1');
    expect(change.base!.instances[0]!.counterpart).toBe(change.head!.instances[0]!.id);
    expect(change.head!.instances[0]!.counterpart).toBe(change.base!.instances[0]!.id);
  });

  it('reports a path-only change with identical bytes as its own event', () => {
    const { base, head } = patchFixture('path-only');
    const change = only(explain(base, head).patches, 'is-odd@3.0.1');
    expect(change.events).toEqual(['path-changed']);
    expect(change.content.status).toBe('identical');
    expect(change.base!.file!.path).toBe('patches/is-odd.patch');
    expect(change.head!.file!.path).toBe('patches/odd/is-odd.patch');
    expect(change.base!.file!.sha256).toBe(change.head!.file!.sha256);
    expect(change.base!.lockfile!.hash).toBe(change.head!.lockfile!.hash);
  });

  it('reports declarations being added and removed, in either direction', () => {
    const { base, head } = patchFixture('declaration-added');
    const added = only(explain(base, head).patches, 'is-odd@3.0.1');
    expect(added.events).toEqual(['declaration-added', 'lockfile-entry-added']);
    expect(added.base).toBeNull();
    expect(added.content.status).toBe('one-sided');
    // The unpatched instance of the same name, version, and peer context.
    expect(added.head!.instances[0]!.counterpart).toBe('is-odd@3.0.1');
    const removed = explain(head, base).patches.changes[0]!;
    expect(removed.events).toEqual(['declaration-removed', 'lockfile-entry-removed']);
    expect(removed.selector).toEqual({ base: 'is-odd@3.0.1', head: null });
    expect(removed.head).toBeNull();
    expect(removed.base!.instances[0]).toMatchObject({
      association: 'lockfile-confirmed',
    });
  });

  it('shows byte changes that the lockfile hash does not record', () => {
    const { base, head } = patchFixture('line-endings');
    const change = only(explain(base, head).patches, 'is-odd@3.0.1');
    expect(change.events).toEqual(['content-changed']);
    expect(change.base!.lockfile!.hash).toBe(change.head!.lockfile!.hash);
    expect(change.observations.map((item) => item.code)).toEqual([
      'CONTENT_CHANGED_LOCKFILE_HASH_UNCHANGED',
    ]);
    // Exact bytes: no line-ending normalization.
    expect(change.head!.file!.size).toBe(
      change.base!.file!.size! +
        fixtureFile('line-endings', 'base', 'patches/is-odd.patch')
          .toString()
          .split('\n').length -
        1,
    );
    expect(change.head!.file!.sha256).toBe(
      sha256(fixtureFile('line-endings', 'head', 'patches/is-odd.patch')),
    );
    const text = renderText(explain(base, head));
    expect(text).toContain('lockfile hash is identical');
    expect(text).not.toContain('diff --git');
  });

  it('keeps lockfile-only metadata changes apart from content changes', () => {
    const { base, head } = patchFixture('line-endings');
    const lockfile = head.files.get('pnpm-lock.yaml')!;
    const hash = /patchedDependencies:\n {2}is-odd@3.0.1: ([0-9a-f]{64})/.exec(
      lockfile,
    )![1]!;
    head.files.set('pnpm-lock.yaml', lockfile.replaceAll(hash, hashA));
    head.files.set('patches/is-odd.patch', base.files.get('patches/is-odd.patch')!);
    const change = only(explain(base, head).patches, 'is-odd@3.0.1');
    expect(change.events).toEqual(['lockfile-hash-changed']);
    expect(change.content.status).toBe('identical');
    expect(change.observations[0]!.code).toBe(
      'LOCKFILE_HASH_CHANGED_CONTENT_IDENTICAL',
    );
    expect(change.head!.instances[0]!.association).toBe('lockfile-confirmed');
  });

  it('keeps every peer context and version as a separate instance', () => {
    const peers = patchFixture('peers');
    const peerChange = only(
      explain(peers.base, peers.head).patches,
      'use-sync-external-store@1.2.0',
    );
    expect(peerChange.head!.instances.map((item) => item.peerContext)).toEqual([
      '(react@17.0.2)',
      '(react@18.3.1)',
    ]);
    expect(consumers(peerChange, 'head')).toEqual([
      'packages/a:direct',
      'packages/b:direct',
    ]);
    for (const instance of peerChange.head!.instances) {
      expect(instance.counterpart).toContain(instance.peerContext!);
      expect(instance.consumers[0]!.uncertain).toBe(true);
      expect(instance.consumers[0]!.uncertainty.join(' ')).toContain('peer context');
    }

    const multi = patchFixture('multi-version');
    const patches = explain(multi.base, multi.head).patches;
    const ms = only(patches, 'ms');
    expect(ms.selectorKind.head).toBe('name');
    expect(ms.head!.instances.map((item) => item.version)).toEqual(['2.0.0', '2.1.3']);
    expect(consumers(ms, 'head')).toEqual(['packages/c:direct', 'packages/b:direct']);
    const scoped = only(patches, '@types/ms@2.1.0');
    expect(scoped.name).toBe('@types/ms');
    expect(scoped.head!.instances).toHaveLength(1);
    expect(scoped.head!.instances[0]!.consumers[0]!.workspace).toBe('packages/b');
  });

  it('lists each consumer of a shared dependency once, through workspace links', () => {
    const { base, head } = patchFixture('shared');
    const change = only(explain(base, head).patches, 'is-number@^6.0.0');
    expect(change.selectorKind.head).toBe('range');
    const [instance] = change.head!.instances;
    expect(instance!.consumers.map((item) => item.workspace).sort()).toEqual([
      'packages/a',
      'packages/d',
      'packages/e',
    ]);
    expect(instance!.consumers.every((item) => item.relation === 'transitive')).toBe(
      true,
    );
    const viaLink = instance!.consumers.find(
      (item) => item.workspace === 'packages/e',
    )!;
    expect(viaLink.path.map(short)).toEqual([
      'dependency:["packages/e","dependencies","a"]',
      'workspace:packages/a',
      'dependency:["packages/a","dependencies","is-odd"]',
      'is-odd@3.0.1',
      'is-number@6.0.0(patch_hash=HASH)',
    ]);
  });

  it('agrees with the forward traversal used for dependency cones', () => {
    for (const name of ['shared', 'peers', 'multi-version']) {
      const state = buildPnpmState(patchFixture(name).head);
      const index = reverseIndex(state.graph);
      for (const instance of state.patches.instances.values()) {
        const reverse = new Set(
          [...reverseVisits(index, instance.id).keys()]
            .map((id) => state.graph.nodes.get(id))
            .filter((node) => node?.kind === 'dependency')
            .map((node) => node!.scope.slice(0, node!.scope.lastIndexOf(':'))),
        );
        const forward = new Set<string>();
        for (const importer of state.manifests.keys()) {
          const roots = [...state.graph.nodes.values()]
            .filter((node) => node.scope.startsWith(`${importer}:`))
            .map((node) => node.id);
          if (traverse(state.graph, roots).has(instance.id)) forward.add(importer);
        }
        expect(reverse).toEqual(forward);
      }
    }
  });

  it('reads pnpm 10 package.json configuration and the { hash, path } lockfile shape', () => {
    const { base, head } = patchFixture('pnpm10');
    const report = explain(base, head);
    const change = only(report.patches, 'is-odd@3.0.1');
    expect(change.events).toEqual(['content-changed', 'lockfile-hash-changed']);
    expect(change.base!.declarations[0]).toMatchObject({
      source: 'package.json#pnpm',
      sourceStatus: 'active',
    });
    expect(change.base!.lockfile).toMatchObject({
      shape: 'object',
      path: 'patches/is-odd@3.0.1.patch',
    });
    expect(change.base!.notes).toEqual([]);
    expect(change.head!.instances[0]!.association).toBe('lockfile-confirmed');
  });

  it('does not treat the legacy package.json field as active for pnpm 11', () => {
    const { base, head } = patchFixture('pnpm10');
    for (const side of [base, head])
      side.files.set(
        'package.json',
        side.files.get('package.json')!.replace('pnpm@10.34.9', 'pnpm@11.28.9'),
      );
    const change = only(explain(base, head).patches, 'is-odd@3.0.1');
    expect(change.head!.declarations[0]).toMatchObject({ sourceStatus: 'inactive' });
    expect(change.head!.notes.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        'INACTIVE_DECLARATION_SOURCE',
        'LOCKFILE_ENTRY_WITHOUT_DECLARATION',
      ]),
    );
    // The lockfile still ties the instance to the selector.
    expect(change.head!.instances[0]!.association).toBe('lockfile-confirmed');
  });

  it('leaves the configuration source unverified without a pnpm declaration', () => {
    const { base, head } = patchFixture('content-change');
    for (const side of [base, head])
      side.files.set(
        'package.json',
        JSON.stringify({
          ...JSON.parse(side.files.get('package.json')!),
          packageManager: undefined,
        }),
      );
    const change = only(explain(base, head).patches, 'is-odd@3.0.1');
    expect(change.head!.declarations[0]!.sourceStatus).toBe('unverified');
    expect(change.head!.notes.map((item) => item.code)).toContain(
      'UNVERIFIED_DECLARATION_SOURCE',
    );
  });
});

describe('patch association edge cases', () => {
  it('keeps an unsupported selector unknown with its reason', () => {
    const head = synthetic({
      workspace: 'patchedDependencies:\n  a@latest: patches/a.patch\n',
      dependencies: { a: a100 },
      snapshots: ['a@1.0.0'],
      files: { 'patches/a.patch': 'x' },
    });
    const base = synthetic({ dependencies: { a: a100 }, snapshots: ['a@1.0.0'] });
    const change = explain(base, head).patches.changes[0]!;
    expect(change.selectorKind.head).toBe('unsupported');
    expect(change.head!.instances[0]).toMatchObject({ association: 'unknown' });
    expect(change.head!.instances[0]!.reasons.join(' ')).toContain('unsupported');
    expect(change.head!.notes.map((item) => item.code)).toContain(
      'UNSUPPORTED_SELECTOR',
    );
  });

  it('reports a missing, unreadable, or escaping patch input instead of dropping it', () => {
    const base = synthetic({ dependencies: { a: a100 }, snapshots: ['a@1.0.0'] });
    const head = synthetic({
      workspace:
        'patchedDependencies:\n  a@1.0.0: patches/gone.patch\n  b: ../outside.patch\n  c: /etc/passwd\n',
      dependencies: { a: a100 },
      snapshots: ['a@1.0.0'],
    });
    const report = explain(base, head);
    const gone = only(report.patches, 'a@1.0.0');
    expect(gone.events).toContain('input-unavailable');
    expect(gone.content.status).toBe('unavailable');
    expect(gone.head!.file).toMatchObject({
      path: 'patches/gone.patch',
      status: 'missing',
    });
    for (const selector of ['b', 'c']) {
      const change = only(report.patches, selector);
      expect(change.events).toContain('input-unavailable');
      expect(change.head!.file).toMatchObject({ status: 'unsupported' });
    }
    expect(report.warnings).toContain(
      'Configured patch file is missing: patches/gone.patch',
    );
    expect(report.warnings).toContain(
      'Configured patch file is unsupported: ../outside.patch (the path leaves the repository)',
    );
  });

  it('keeps declaration and lockfile disagreements as observations', () => {
    const base = synthetic({ dependencies: { a: a100 }, snapshots: ['a@1.0.0'] });
    const head = synthetic({
      workspace: 'patchedDependencies:\n  a@1.0.0: patches/a.patch\n',
      lockfilePatched: { 'a@1.0.0': { hash: hashA, path: 'patches/other.patch' } },
      dependencies: { a: patchedA(hashB) },
      snapshots: [`a@1.0.0(patch_hash=${hashB})`],
      files: { 'patches/a.patch': 'x' },
    });
    const change = explain(base, head).patches.changes[0]!;
    expect(change.head!.notes.map((item) => item.code)).toContain(
      'LOCKFILE_PATH_DIFFERS_FROM_DECLARATION',
    );
    // The instance hash matches no lockfile entry, so it is not confirmed.
    expect(change.head!.instances[0]).toMatchObject({ association: 'unknown' });
    expect(change.head!.instances[0]!.reasons.join(' ')).toContain(
      'absent from the lockfile',
    );
  });

  it('marks a declared selector without a lockfile hash as applicable, not applied', () => {
    const base = synthetic({ dependencies: { a: a100 }, snapshots: ['a@1.0.0'] });
    const head = synthetic({
      workspace: 'patchedDependencies:\n  a@^1.0.0: patches/a.patch\n',
      dependencies: { a: a100 },
      snapshots: ['a@1.0.0'],
      files: { 'patches/a.patch': 'x' },
    });
    const change = explain(base, head).patches.changes[0]!;
    expect(change.head!.instances[0]).toMatchObject({
      association: 'selector-applicable',
    });
    expect(change.head!.instances[0]!.consumers[0]).toMatchObject({
      basis: 'selector-applicable',
      relation: 'direct',
    });
    expect(change.head!.notes.map((item) => item.code)).toContain(
      'DECLARED_WITHOUT_LOCKFILE_ENTRY',
    );
  });

  it('prefers exact over name selectors but refuses to choose between overlapping ranges', () => {
    const files = { 'patches/a.patch': 'x', 'patches/b.patch': 'y' };
    const base = synthetic({ dependencies: { a: a100 }, snapshots: ['a@1.0.0'] });
    const priority = synthetic({
      workspace:
        'patchedDependencies:\n  a@1.0.0: patches/a.patch\n  a: patches/a.patch\n',
      lockfilePatched: { 'a@1.0.0': hashA, a: hashA },
      dependencies: { a: patchedA(hashA) },
      snapshots: [`a@1.0.0(patch_hash=${hashA})`, 'a@2.0.0'],
      files,
    });
    const report = explain(base, priority).patches;
    expect(only(report, 'a@1.0.0').head!.instances[0]).toMatchObject({
      association: 'lockfile-confirmed',
    });
    // The name-only selector is not linked to the instance the exact one wins.
    expect(only(report, 'a').head!.instances.map((item) => item.version)).toEqual([
      '2.0.0',
    ]);
    expect(only(report, 'a').head!.instances[0]!.association).toBe(
      'selector-applicable',
    );

    const overlap = synthetic({
      workspace:
        'patchedDependencies:\n  a@^1.0.0: patches/a.patch\n  a@>=1.0.0: patches/b.patch\n',
      dependencies: { a: a100 },
      snapshots: ['a@1.0.0'],
      files,
    });
    const ranges = explain(base, overlap).patches.changes;
    expect(ranges).toHaveLength(2);
    for (const change of ranges) {
      expect(change.head!.instances[0]!.association).toBe('unknown');
      expect(change.head!.instances[0]!.reasons.join(' ')).toContain('equal priority');
    }
  });

  it('does not link equal hashes by name alone or invent a selector for stray patches', () => {
    const base = synthetic({ dependencies: { a: a100 }, snapshots: ['a@1.0.0'] });
    const head = synthetic({
      lockfilePatched: { 'a@2.0.0': hashA },
      dependencies: { a: patchedA(hashA) },
      snapshots: [`a@1.0.0(patch_hash=${hashA})`],
    });
    const report = explain(base, head).patches;
    const stray = only(report, 'a@2.0.0');
    expect(stray.head!.instances[0]).toMatchObject({ association: 'unknown' });
    expect(stray.head!.instances[0]!.reasons.join(' ')).toContain('does not match');
    const orphan = explain(
      base,
      synthetic({
        dependencies: { a: patchedA(hashC) },
        snapshots: [`a@1.0.0(patch_hash=${hashC})`],
      }),
    ).patches;
    expect(orphan.changes).toEqual([]);
    expect(orphan.unlinked.head[0]).toMatchObject({ patchHash: hashC });
  });

  it('pairs a selector edit that keeps the same file and splits an ambiguous one', () => {
    const files = { 'patches/a.patch': 'x' };
    const build = (selector: string) =>
      synthetic({
        workspace: `patchedDependencies:\n  ${selector}: patches/a.patch\n`,
        lockfilePatched: { [selector]: sha256('x') },
        dependencies: { a: patchedA(sha256('x')) },
        snapshots: [`a@1.0.0(patch_hash=${sha256('x')})`],
        files,
      });
    const report = explain(build('a@1.0.0'), build('a@^1.0.0')).patches;
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]).toMatchObject({
      selector: { base: 'a@1.0.0', head: 'a@^1.0.0' },
      events: ['selector-changed'],
    });
    expect(report.changes[0]!.content.status).toBe('identical');
  });

  it('reports lockfile-only metadata without inventing a file comparison', () => {
    const build = (hash: string) =>
      synthetic({
        lockfilePatched: { 'a@1.0.0': hash },
        dependencies: { a: patchedA(hash) },
        snapshots: [`a@1.0.0(patch_hash=${hash})`],
      });
    const change = explain(build(hashA), build(hashB)).patches.changes[0]!;
    expect(change.events).toEqual(['lockfile-hash-changed']);
    expect(change.content).toEqual({ status: 'no-file-reference', basis: null });
    expect(change.head!.notes.map((item) => item.code)).toContain(
      'LOCKFILE_ENTRY_WITHOUT_DECLARATION',
    );
    expect(change.head!.instances[0]!.association).toBe('lockfile-confirmed');
  });

  it('treats empty patch settings as no patches', () => {
    const base = synthetic({ dependencies: { a: a100 }, snapshots: ['a@1.0.0'] });
    const head = synthetic({
      workspace: 'patchedDependencies:\n',
      lockfilePatched: null,
      dependencies: { a: a100 },
      snapshots: ['a@1.0.0'],
    });
    const report = explain(base, head).patches;
    expect(report.changes).toEqual([]);
    expect(report.notes).toEqual({ base: [], head: [] });
  });

  it('does not pair an instance with an ambiguous counterpart', () => {
    const base = synthetic({
      dependencies: { a: a100 },
      snapshots: ['a@1.0.0', `a@1.0.0(patch_hash=${hashA})`],
    });
    const head = synthetic({
      workspace: 'patchedDependencies:\n  a@1.0.0: patches/a.patch\n',
      lockfilePatched: { 'a@1.0.0': hashB },
      dependencies: { a: patchedA(hashB) },
      snapshots: [`a@1.0.0(patch_hash=${hashB})`],
      files: { 'patches/a.patch': 'x' },
    });
    const change = explain(base, head).patches.changes[0]!;
    expect(change.head!.instances[0]!.counterpart).toBeNull();
  });

  it('limits consumers per instance and says how many were omitted', () => {
    const count = maxConsumersPerInstance + 10;
    const importers = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `packages/p${String(index).padStart(3, '0')}`,
        { dependencies: { a: { specifier: '1.0.0', version: '1.0.0' } } },
      ]),
    );
    const build = (patched: boolean): RepositoryState => {
      const files = new Map<string, string>([
        ['package.json', JSON.stringify({ name: 'root' })],
        [
          'pnpm-workspace.yaml',
          `packages:\n  - packages/*\n${patched ? 'patchedDependencies:\n  a: patches/a.patch\n' : ''}`,
        ],
        [
          'pnpm-lock.yaml',
          stringify({
            lockfileVersion: '9.0',
            importers: { '.': {}, ...importers },
            packages: { 'a@1.0.0': {} },
            snapshots: { 'a@1.0.0': {} },
          }),
        ],
        ['patches/a.patch', 'x'],
      ]);
      for (const path of Object.keys(importers))
        files.set(
          `${path}/package.json`,
          JSON.stringify({ name: path.split('/')[1], dependencies: { a: '1.0.0' } }),
        );
      return { revision: 'many', files };
    };
    const change = explain(build(false), build(true)).patches.changes[0]!;
    const [instance] = change.head!.instances;
    expect(instance!.consumers).toHaveLength(maxConsumersPerInstance);
    expect(instance!.consumersOmitted).toBe(10);
    expect(renderText(explain(build(false), build(true)))).toContain(
      '10 more consumers',
    );
  });

  it('does not let a consumer inherit a workspace development dependency', () => {
    const lockfile = {
      lockfileVersion: '9.0',
      importers: {
        '.': {},
        'packages/app': {
          dependencies: { lib: { specifier: 'workspace:*', version: 'link:../lib' } },
        },
        'packages/lib': {
          devDependencies: { a: { specifier: '1.0.0', version: '1.0.0' } },
        },
      },
      packages: { 'a@1.0.0': {} },
      snapshots: { 'a@1.0.0': {} },
    };
    const build = (patched: boolean): RepositoryState => ({
      revision: 'workspace',
      files: new Map([
        ['package.json', JSON.stringify({ name: 'root' })],
        [
          'pnpm-workspace.yaml',
          `packages:\n  - packages/*\n${patched ? 'patchedDependencies:\n  a: patches/a.patch\n' : ''}`,
        ],
        ['pnpm-lock.yaml', stringify(lockfile)],
        [
          'packages/app/package.json',
          JSON.stringify({ name: 'app', dependencies: { lib: 'workspace:*' } }),
        ],
        [
          'packages/lib/package.json',
          JSON.stringify({ name: 'lib', devDependencies: { a: '1.0.0' } }),
        ],
        ['patches/a.patch', 'x'],
      ]),
    });
    const change = explain(build(false), build(true)).patches.changes[0]!;
    expect(consumers(change, 'head')).toEqual(['packages/lib:direct']);
    expect(change.head!.instances[0]!.consumers[0]!.section).toBe('devDependencies');
  });
});

describe('patch bytes', () => {
  it('hashes exact bytes and skips oversized blobs without losing sync', async () => {
    const invalidA = Buffer.from([0x61, 0xff, 0x62]);
    const invalidB = Buffer.from([0x61, 0xfe, 0x62]);
    const big = Buffer.alloc(32, 0x41);
    const parts: Buffer[] = [];
    for (const [oid, content] of [
      ['oid-a', invalidA],
      ['oid-big', big],
      ['oid-b', invalidB],
    ] as const)
      parts.push(
        Buffer.from(`${oid} blob ${content.length}\n`),
        content,
        Buffer.from('\n'),
      );
    const output = Buffer.concat(parts);
    async function* chunks(): AsyncGenerator<Buffer> {
      for (let offset = 0; offset < output.length; offset += 7)
        yield output.subarray(offset, offset + 7);
    }
    const files = await parsePatchBatch(
      [
        { object: 'oid-a', path: 'a' },
        { object: 'oid-big', path: 'big' },
        { object: 'oid-b', path: 'b' },
      ],
      chunks(),
      16,
    );
    expect(files.get('a')).toEqual({
      status: 'present',
      blob: 'oid-a',
      size: 3,
      sha256: sha256(invalidA),
    });
    // Decoding both as UTF-8 would give the same text; the bytes differ.
    expect(invalidA.toString('utf8')).toBe(invalidB.toString('utf8'));
    expect(files.get('b')).toMatchObject({ sha256: sha256(invalidB) });
    expect(files.get('big')).toEqual({
      status: 'oversized',
      blob: 'oid-big',
      size: 32,
    });
  });
});

describe('committed Git snapshots', () => {
  const directories: string[] = [];
  afterAll(() => {
    for (const directory of directories)
      rmSync(directory, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd, encoding: 'utf8' },
    );
  function repository(): string {
    const directory = mkdtempSync(join(tmpdir(), 'lockcone-patches-'));
    directories.push(directory);
    git(directory, 'init', '-q');
    return directory;
  }
  const write = (root: string, path: string, content: string | Buffer): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const lockfile = (hash: string): string =>
    stringify({
      lockfileVersion: '9.0',
      patchedDependencies: { 'a@1.0.0': hash },
      importers: {
        '.': {
          dependencies: {
            a: { specifier: '1.0.0', version: `1.0.0(patch_hash=${hash})` },
          },
        },
      },
      packages: { 'a@1.0.0': {} },
      snapshots: { [`a@1.0.0(patch_hash=${hash})`]: {} },
    });

  it('compares committed blobs and ignores working copy edits', async () => {
    const root = repository();
    write(
      root,
      'package.json',
      JSON.stringify({ name: 'root', dependencies: { a: '1.0.0' } }),
    );
    write(
      root,
      'pnpm-workspace.yaml',
      'patchedDependencies:\n  a@1.0.0: patches/a.patch\n',
    );
    write(root, 'patches/a.patch', 'one\r\n');
    write(root, 'pnpm-lock.yaml', lockfile(hashA));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'base');
    write(root, 'patches/a.patch', 'two\n');
    git(root, 'commit', '-q', '-am', 'head');
    // Uncommitted edits, a new untracked patch, and a changed workspace file.
    write(root, 'patches/a.patch', 'working copy only\n');
    write(
      root,
      'pnpm-workspace.yaml',
      'patchedDependencies:\n  a@1.0.0: patches/elsewhere.patch\n',
    );

    const report = explain(
      await readRepository(root, 'HEAD~1'),
      await readRepository(root, 'HEAD'),
    );
    const change = only(report.patches, 'a@1.0.0');
    expect(change.events).toEqual(['content-changed']);
    expect(change.content.basis).toBe('git-blob');
    expect(change.base!.file).toMatchObject({ sha256: sha256('one\r\n') });
    expect(change.head!.file).toMatchObject({ sha256: sha256('two\n') });
    expect(change.base!.file!.gitBlob).toBe(
      git(root, 'rev-parse', 'HEAD~1:patches/a.patch').trim(),
    );
    expect(change.head!.declarations[0]!.reference).toBe('patches/a.patch');
  });

  it('does not follow symlinks, submodules, or paths outside the snapshot', async () => {
    const root = repository();
    write(
      root,
      'package.json',
      JSON.stringify({ name: 'root', dependencies: { a: '1.0.0' } }),
    );
    write(
      root,
      'pnpm-workspace.yaml',
      'patchedDependencies:\n  a@1.0.0: patches/link.patch\n  b: patches/sub.patch\n  c: ../escape.patch\n  d: link-dir/real.patch\n',
    );
    write(root, 'pnpm-lock.yaml', lockfile(hashA));
    write(root, 'outside/real.patch', 'secret\n');
    mkdirSync(join(root, 'patches'), { recursive: true });
    symlinkSync('../outside/real.patch', join(root, 'patches/link.patch'));
    symlinkSync('outside', join(root, 'link-dir'));
    git(root, 'add', '-A');
    git(
      root,
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${'1'.repeat(40)},patches/sub.patch`,
    );
    git(root, 'commit', '-q', '-m', 'snapshot');
    const state = await readRepository(root, 'HEAD');
    expect(state.patchFiles!.get('patches/link.patch')).toMatchObject({
      status: 'unsupported',
      reason: expect.stringContaining('symlink'),
    });
    expect(state.patchFiles!.get('patches/sub.patch')).toMatchObject({
      status: 'unsupported',
      reason: expect.stringContaining('submodule'),
    });
    expect(state.patchFiles!.get('../escape.patch')).toMatchObject({
      status: 'unsupported',
    });
    // A path through a symlinked directory is not a committed file.
    expect(state.patchFiles!.get('link-dir/real.patch')).toEqual({ status: 'missing' });
    expect(JSON.stringify([...state.patchFiles!])).not.toContain('secret');
    const report = explain(state, state);
    expect(report.patches.changes.map((item) => item.events)).toEqual(
      Array(4).fill(['input-unavailable']),
    );
    expect(report.warnings).toContain(
      'Configured patch file is unsupported: patches/link.patch (the path is a symlink)',
    );
  });

  it('compares oversized patch files by Git blob ID', async () => {
    const root = repository();
    write(
      root,
      'package.json',
      JSON.stringify({ name: 'root', dependencies: { a: '1.0.0' } }),
    );
    write(
      root,
      'pnpm-workspace.yaml',
      'patchedDependencies:\n  a@1.0.0: patches/a.patch\n',
    );
    write(root, 'pnpm-lock.yaml', lockfile(hashA));
    write(root, 'patches/a.patch', Buffer.alloc(9 * 1024 * 1024, 0x41));
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'one');
    write(root, 'patches/a.patch', Buffer.alloc(9 * 1024 * 1024, 0x42));
    git(root, 'commit', '-q', '-am', 'two');
    const one = await readRepository(root, 'HEAD~1');
    const two = await readRepository(root, 'HEAD');
    expect(one.patchFiles!.get('patches/a.patch')).toMatchObject({
      status: 'oversized',
    });
    const change = only(explain(one, two).patches, 'a@1.0.0');
    expect(change.events).toEqual(['content-changed']);
    expect(change.content.basis).toBe('git-blob');
    expect(change.base!.file).toMatchObject({ status: 'oversized', sha256: null });
    expect(change.base!.notes.map((item) => item.code)).toContain(
      'PATCH_FILE_OVERSIZED',
    );
    expect(explain(one, one).patches.changes).toEqual([]);
  });
});

describe('reports', () => {
  it('prints a brief and a detailed view of the same evidence', () => {
    const { base, head } = patchFixture('shared');
    const report = explain(base, head);
    const brief = renderText(report);
    const detail = renderText(report, { detail: true });
    expect(brief).toContain('Patch changes');
    expect(brief).toContain('is-number@^6.0.0: content-changed, lockfile-hash-changed');
    expect(brief).toContain('packages/e (e): transitive consumer via dependencies');
    expect(brief).toContain('not runtime usage');
    expect(brief).not.toContain('path dependency:');
    expect(detail).toContain(
      'path dependency:["packages/e","dependencies","a"] → workspace:packages/a',
    );
    // Patch contents are never printed.
    expect(detail).not.toContain('diff --git');
    expect(detail).not.toContain('patch two');
  });

  it('filters patch changes in why and is JSON round-trippable', () => {
    const { base, head } = patchFixture('multi-version');
    const full = explain(base, head);
    expect(full.patches.changes.map((item) => item.selector.head)).toEqual([
      '@types/ms@2.1.0',
      'ms',
    ]);
    const scoped = why(full, '@types/ms');
    expect(scoped.patches.changes.map((item) => item.selector.head)).toEqual([
      '@types/ms@2.1.0',
    ]);
    expect(why(full, 'is-odd').patches.changes).toEqual([]);
    const stray = explain(
      synthetic({ dependencies: { a: a100 }, snapshots: ['a@1.0.0'] }),
      synthetic({
        dependencies: { a: patchedA(hashC) },
        snapshots: [`a@1.0.0(patch_hash=${hashC})`],
      }),
    );
    expect(why(stray, 'a').patches.unlinked.head).toHaveLength(1);
    expect(why(stray, 'b').patches.unlinked.head).toEqual([]);
    expect(JSON.parse(JSON.stringify(full.patches))).toEqual(full.patches);
    expect(full.schemaVersion).toBe(4);
    expect(full.patches.reportVersion).toBe(1);
  });

  it('leaves reports without patch changes unchanged in text and warnings', () => {
    const report = explain(fixture('upgrade', 'base'), fixture('upgrade', 'head'));
    expect(report.patches.changes).toEqual([]);
    expect(report.patches.unlinked).toEqual({ base: [], head: [] });
    expect(renderText(report)).not.toContain('Patch changes');
  });

  it('keeps pre-0.3 fields of the catalog case study identical', () => {
    const root = fileURLToPath(new URL('../docs/acceptance/ni/', import.meta.url));
    const expected = JSON.parse(readFileSync(join(root, 'v0.2.json'), 'utf8'));
    const { patches, overrides, peerBindings, ...actual } = explain(
      fixture('ni', 'base'),
      fixture('ni', 'head'),
    );
    expect(patches.changes).toEqual([]);
    expect(overrides.changes).toEqual([]);
    expect(peerBindings.changes).toEqual([]);
    expect({
      ...JSON.parse(JSON.stringify(actual)),
      base: expected.base,
      head: expected.head,
    }).toEqual(expected);
  });
});
