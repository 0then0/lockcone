import type { PatchFile, RepositoryState } from '../git/repository.js';
import { normalizePatchPath, patchFile } from '../git/repository.js';
import type { DependencyGraph } from '../graph/dependency-graph.js';
import type { Manifest } from '../manifests/package-json.js';
import type { Lockfile } from './lockfile-parser.js';
import { satisfiesRegistryRange, supportedRegistryRange } from './registry-range.js';

// Patch metadata as committed. Nothing here applies a patch, replays pnpm's
// patch selection against the registry, or claims that an install succeeded.

export type SelectorKind = 'exact' | 'range' | 'name' | 'unsupported';
export interface Selector {
  text: string;
  kind: SelectorKind;
  name: string | null;
  spec: string | null;
  problem: string | null;
}
export type SourceName = 'pnpm-workspace.yaml' | 'package.json#pnpm';
export type SourceStatus = 'active' | 'inactive' | 'unverified';
export interface PatchNote {
  code: string;
  message: string;
}
export interface PackageManagerEvidence {
  declared: string | null;
  major: number | null;
}
export interface PatchDeclaration {
  selector: Selector;
  source: SourceName;
  sourceStatus: SourceStatus;
  reference: unknown;
  path: string | null;
  problem: string | null;
  file: PatchFile | null;
}
export interface LockfilePatchEntry {
  selector: Selector;
  shape: 'hash' | 'object' | 'unrecognized';
  // Opaque pnpm value. LockCone does not assume which algorithm produced it.
  hash: string | null;
  path: string | null;
  file: PatchFile | null;
}
export interface PatchInstance {
  id: string;
  name: string;
  version: string;
  patchHash: string | null;
  peerContext: string | null;
  // Name, version, and peer context without patch hashes: a patch change keeps it.
  identity: string;
  problem: string | null;
}
export type Association = 'lockfile-confirmed' | 'selector-applicable' | 'unknown';
export interface PatchLink {
  selector: string;
  instance: string;
  association: Association;
  reasons: string[];
}
export interface UnlinkedInstance {
  instance: string;
  patchHash: string | null;
  reasons: string[];
}
export interface PatchSubject {
  selector: Selector;
  declarations: PatchDeclaration[];
  lockfile: LockfilePatchEntry | null;
  notes: PatchNote[];
  links: PatchLink[];
}
export interface PatchState {
  packageManager: PackageManagerEvidence;
  subjects: Map<string, PatchSubject>;
  instances: Map<string, PatchInstance>;
  unlinked: UnlinkedInstance[];
  notes: PatchNote[];
}

const tiers: Record<SelectorKind, number> = {
  exact: 0,
  range: 1,
  name: 2,
  unsupported: 3,
};

export function parseSelector(text: string): Selector {
  const at = text.indexOf('@', text.startsWith('@') ? 1 : 0);
  const name = at < 0 ? text : text.slice(0, at);
  const spec = at < 0 ? null : text.slice(at + 1);
  const unsupported = (problem: string): Selector => ({
    text,
    kind: 'unsupported',
    name: /^(?:@[^/@\s]+\/)?[^/@\s]+$/.test(name) ? name : null,
    spec,
    problem,
  });
  if (!/^(?:@[^/@\s]+\/)?[^/@\s]+$/.test(name))
    return unsupported('The selector does not start with a package name.');
  if (spec === null) return { text, kind: 'name', name, spec, problem: null };
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(spec))
    return { text, kind: 'exact', name, spec, problem: null };
  if (supportedRegistryRange(spec))
    return { text, kind: 'range', name, spec, problem: null };
  return unsupported(
    'The selector version is neither an exact version nor a supported registry range.',
  );
}

// undefined means the selector's reach cannot be decided from supported syntax.
export function applies(
  selector: Selector,
  instance: PatchInstance,
): boolean | undefined {
  if (selector.name !== instance.name) return false;
  if (selector.kind === 'name') return true;
  if (selector.kind === 'exact') return selector.spec === instance.version;
  if (selector.kind === 'range')
    return satisfiesRegistryRange(selector.spec!, instance.version);
  return undefined;
}

export function parseInstance(id: string): PatchInstance | undefined {
  const open = id.indexOf('(');
  const base = open < 0 ? id : id.slice(0, open);
  const separator = base.indexOf('@', base.startsWith('@') ? 1 : 0);
  if (separator <= 0) return undefined;
  const name = base.slice(0, separator);
  const version = base.slice(separator + 1);
  const groups: string[] = [];
  let problem: string | null = null;
  let depth = 0;
  let start = 0;
  for (let index = open < 0 ? id.length : open; index < id.length; index++) {
    const character = id[index];
    if (character === '(') {
      if (depth === 0) start = index + 1;
      depth++;
    } else if (character === ')') {
      depth--;
      if (depth < 0) break;
      if (depth === 0) groups.push(id.slice(start, index));
    } else if (depth === 0) {
      problem = 'The package key has text outside its parenthesized contexts.';
    }
  }
  if (depth !== 0) problem = 'The package key has unbalanced parentheses.';
  const hashes = groups.filter((group) => group.startsWith('patch_hash='));
  if (hashes.length > 1) problem = 'The package key has several patch_hash contexts.';
  const peers = groups.filter((group) => !group.startsWith('patch_hash='));
  const peerContext = peers.length ? peers.map((group) => `(${group})`).join('') : null;
  return {
    id,
    name,
    version,
    patchHash: hashes.length === 1 ? hashes[0]!.slice('patch_hash='.length) : null,
    peerContext,
    identity: `${name}@${version}${(peerContext ?? '').replace(/\(patch_hash=[^()]*\)/g, '')}`,
    problem,
  };
}

export function parsePackageManager(
  manifest: Manifest | undefined,
): PackageManagerEvidence {
  const declared =
    typeof manifest?.packageManager === 'string' ? manifest.packageManager : null;
  const match = declared === null ? null : /^pnpm@(\d+)\./.exec(declared);
  return { declared, major: match ? Number(match[1]) : null };
}

// Observed with pnpm 10.34.9, 11.28.9, and 12.5.1: 11 and 12 ignore the legacy
// package.json field and read the workspace file; 10 reads both. Without a pnpm
// declaration or for older 10.x releases the source stays unverified.
function sourceStatus(
  source: SourceName,
  packageManager: PackageManagerEvidence,
): { status: SourceStatus; note: string | null } {
  const { major, declared } = packageManager;
  if (major === null)
    return {
      status: 'unverified',
      note: `packageManager ${declared === null ? 'is not declared' : `(${declared}) is not a pnpm version`}; the configuration source cannot be confirmed.`,
    };
  if (source === 'pnpm-workspace.yaml')
    return major >= 11
      ? { status: 'active', note: null }
      : {
          status: 'unverified',
          note: `LockCone verified pnpm-workspace.yaml patch settings only for pnpm 10.34.9 and 11 or later; packageManager declares ${declared}.`,
        };
  return major <= 10
    ? { status: 'active', note: null }
    : {
        status: 'inactive',
        note: `pnpm ${major} does not read the package.json pnpm field; packageManager declares ${declared}.`,
      };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fileProblem(file: PatchFile | null, label: string): PatchNote | undefined {
  if (!file) return undefined;
  if (file.status === 'missing')
    return {
      code: 'PATCH_FILE_MISSING',
      message: `${label} is missing from the commit.`,
    };
  if (file.status === 'unsupported')
    return {
      code: 'PATCH_FILE_UNSUPPORTED',
      message: `${label} cannot be read: ${file.reason}.`,
    };
  if (file.status === 'oversized')
    return {
      code: 'PATCH_FILE_OVERSIZED',
      message: `${label} is ${file.size} bytes; its content was not read and only its Git blob ID is compared.`,
    };
  return undefined;
}

export function buildPatchState(input: {
  repository: RepositoryState;
  lockfile: Lockfile;
  workspace: Record<string, unknown>;
  manifests: Map<string, Manifest>;
  graph: DependencyGraph;
}): PatchState {
  const { repository, lockfile, workspace, manifests, graph } = input;
  const packageManager = parsePackageManager(manifests.get('.'));
  const notes: PatchNote[] = [];
  const declarations: PatchDeclaration[] = [];
  const entries: LockfilePatchEntry[] = [];

  const sources: [SourceName, unknown][] = [
    ['pnpm-workspace.yaml', workspace.patchedDependencies],
    [
      'package.json#pnpm',
      isRecord(manifests.get('.')?.pnpm)
        ? (manifests.get('.')!.pnpm as Record<string, unknown>).patchedDependencies
        : undefined,
    ],
  ];
  for (const [source, value] of sources) {
    if (value === undefined || value === null) continue;
    if (!isRecord(value)) {
      notes.push({
        code: 'UNRECOGNIZED_DECLARATIONS',
        message: `${source} patchedDependencies is not a mapping.`,
      });
      continue;
    }
    const { status } = sourceStatus(source, packageManager);
    for (const [key, reference] of Object.entries(value)) {
      const path = typeof reference === 'string' ? normalizePatchPath(reference) : null;
      declarations.push({
        selector: parseSelector(key),
        source,
        sourceStatus: status,
        reference,
        path,
        problem: path === null ? 'The patch reference is not a string.' : null,
        file: path === null ? null : patchFile(repository, path),
      });
    }
  }

  const recorded = lockfile.patchedDependencies;
  if (recorded !== undefined && recorded !== null) {
    if (!isRecord(recorded))
      notes.push({
        code: 'UNRECOGNIZED_LOCKFILE_METADATA',
        message: 'The lockfile patchedDependencies value is not a mapping.',
      });
    else
      for (const [key, value] of Object.entries(recorded)) {
        let entry: LockfilePatchEntry = {
          selector: parseSelector(key),
          shape: 'unrecognized',
          hash: null,
          path: null,
          file: null,
        };
        if (typeof value === 'string') entry = { ...entry, shape: 'hash', hash: value };
        else if (isRecord(value) && typeof value.hash === 'string') {
          const path =
            typeof value.path === 'string' ? normalizePatchPath(value.path) : null;
          entry = {
            ...entry,
            shape: 'object',
            hash: value.hash,
            path,
            file: path === null ? null : patchFile(repository, path),
          };
        }
        entries.push(entry);
      }
  }

  const subjects = new Map<string, PatchSubject>();
  const subject = (selector: Selector): PatchSubject => {
    let existing = subjects.get(selector.text);
    if (!existing) {
      existing = { selector, declarations: [], lockfile: null, notes: [], links: [] };
      subjects.set(selector.text, existing);
    }
    return existing;
  };
  for (const declaration of declarations)
    subject(declaration.selector).declarations.push(declaration);
  for (const entry of entries) subject(entry.selector).lockfile = entry;

  for (const item of subjects.values()) {
    const note = (code: string, message: string): void => {
      item.notes.push({ code, message });
    };
    if (item.selector.problem)
      note('UNSUPPORTED_SELECTOR', `${item.selector.text}: ${item.selector.problem}`);
    const live = item.declarations.filter((entry) => entry.sourceStatus !== 'inactive');
    for (const declaration of item.declarations) {
      const status = sourceStatus(declaration.source, packageManager);
      if (status.note)
        note(
          declaration.sourceStatus === 'inactive'
            ? 'INACTIVE_DECLARATION_SOURCE'
            : 'UNVERIFIED_DECLARATION_SOURCE',
          `${declaration.source}: ${status.note}`,
        );
      if (declaration.problem)
        note('UNSUPPORTED_PATCH_PATH', `${declaration.source}: ${declaration.problem}`);
      const fileNote = fileProblem(
        declaration.file,
        `Patch file ${declaration.path} (${declaration.source})`,
      );
      if (fileNote) note(fileNote.code, fileNote.message);
    }
    if (new Set(live.map((entry) => entry.path ?? String(entry.reference))).size > 1)
      note(
        'CONFLICTING_DECLARATIONS',
        'Sources that pnpm may read declare different patch files for this selector.',
      );
    if (item.lockfile) {
      if (item.lockfile.shape === 'unrecognized')
        note(
          'UNRECOGNIZED_LOCKFILE_METADATA',
          'The lockfile entry is neither a hash string nor an object with a hash.',
        );
      const fileNote = fileProblem(
        item.lockfile.file,
        `Lockfile patch path ${item.lockfile.path}`,
      );
      if (fileNote) note(fileNote.code, fileNote.message);
      if (!live.length && !item.declarations.length)
        note(
          'LOCKFILE_ENTRY_WITHOUT_DECLARATION',
          'The lockfile records this selector, but no supported configuration declares it.',
        );
      else if (!live.length)
        note(
          'LOCKFILE_ENTRY_WITHOUT_DECLARATION',
          'The lockfile records this selector, but only sources ignored by the declared pnpm version declare it.',
        );
      if (
        item.lockfile.path !== null &&
        live.length &&
        live.every((entry) => entry.path !== item.lockfile!.path)
      )
        note(
          'LOCKFILE_PATH_DIFFERS_FROM_DECLARATION',
          `The lockfile path ${item.lockfile.path} differs from the declared path.`,
        );
    } else if (live.length) {
      note(
        'DECLARED_WITHOUT_LOCKFILE_ENTRY',
        'The selector is declared, but the lockfile has no patchedDependencies entry for it.',
      );
    }
  }

  // Instances and selector association. Selectors are indexed by package name so
  // each instance is compared only with candidates for that package.
  const instances = new Map<string, PatchInstance>();
  const byName = new Map<string, PatchSubject[]>();
  const byHash = new Map<string, PatchSubject[]>();
  for (const item of subjects.values()) {
    const pool =
      item.lockfile !== null ||
      item.declarations.some((entry) => entry.sourceStatus !== 'inactive');
    if (!pool) continue;
    if (item.selector.name !== null) {
      const list = byName.get(item.selector.name) ?? [];
      list.push(item);
      byName.set(item.selector.name, list);
    }
    if (item.lockfile?.hash) {
      const list = byHash.get(item.lockfile.hash) ?? [];
      list.push(item);
      byHash.set(item.lockfile.hash, list);
    }
  }
  const unlinked: UnlinkedInstance[] = [];
  const conflicted = (item: PatchSubject): boolean =>
    item.notes.some((entry) => entry.code === 'CONFLICTING_DECLARATIONS');
  for (const node of [...graph.nodes.values()].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const metadata = node.metadata as { snapshot?: unknown } | null;
    if (node.kind !== 'package' || metadata?.snapshot === undefined) continue;
    const instance = parseInstance(node.id);
    if (!instance) continue;
    instances.set(instance.id, instance);
    const link = (
      item: PatchSubject,
      association: Association,
      ...reasons: string[]
    ): void => {
      if (conflicted(item) && association !== 'unknown') {
        association = 'unknown';
        reasons.push('The selector has conflicting declarations.');
      }
      item.links.push({
        selector: item.selector.text,
        instance: instance.id,
        association,
        reasons,
      });
    };
    if (instance.problem) {
      if (instance.patchHash !== null || instance.id.includes('patch_hash'))
        unlinked.push({
          instance: instance.id,
          patchHash: instance.patchHash,
          reasons: [instance.problem],
        });
      continue;
    }

    const named = byName.get(instance.name) ?? [];
    const matching = named.filter((item) => applies(item.selector, instance) === true);
    const undecided = named.filter(
      (item) => applies(item.selector, instance) === undefined,
    );
    const best = (candidates: PatchSubject[]): PatchSubject[] => {
      const tier = Math.min(...candidates.map((item) => tiers[item.selector.kind]));
      return candidates.filter((item) => tiers[item.selector.kind] === tier);
    };
    const undecidedReason = (item: PatchSubject): string =>
      item.selector.kind === 'unsupported'
        ? 'The selector is unsupported, so its reach cannot be decided.'
        : `The selector cannot be evaluated for version ${instance.version}.`;

    if (instance.patchHash !== null) {
      const recorded = byHash.get(instance.patchHash) ?? [];
      const fits = recorded.filter((item) => matching.includes(item));
      if (fits.length) {
        const top = best(fits);
        const stronger = matching.filter(
          (item) => tiers[item.selector.kind] < tiers[top[0]!.selector.kind],
        );
        if (top.length === 1 && !stronger.length)
          link(
            top[0]!,
            'lockfile-confirmed',
            'The instance patch_hash equals the lockfile entry for this selector.',
          );
        else
          for (const item of top)
            link(
              item,
              'unknown',
              top.length > 1
                ? 'Several selectors with this lockfile hash apply with equal priority.'
                : `A higher-priority selector also applies: ${stronger.map((s) => s.selector.text).join(', ')}.`,
            );
      } else if (recorded.length) {
        for (const item of recorded)
          link(
            item,
            'unknown',
            applies(item.selector, instance) === undefined
              ? undecidedReason(item)
              : 'The lockfile entry has the instance patch_hash, but its selector does not match the instance.',
          );
      } else if (matching.length) {
        for (const item of best(matching))
          link(
            item,
            'unknown',
            'The instance patch_hash is absent from the lockfile patchedDependencies.',
          );
      } else {
        unlinked.push({
          instance: instance.id,
          patchHash: instance.patchHash,
          reasons: ['No patch selector or lockfile entry matches this patch_hash.'],
        });
      }
      for (const item of undecided)
        if (!recorded.includes(item)) link(item, 'unknown', undecidedReason(item));
      continue;
    }
    if (matching.length) {
      const top = best(matching);
      for (const item of top)
        link(
          item,
          top.length === 1 ? 'selector-applicable' : 'unknown',
          top.length === 1
            ? 'The selector matches, but the lockfile instance has no patch_hash, so application is unconfirmed.'
            : 'Several selectors of equal priority match this instance; pnpm rejects overlapping ranges.',
        );
    }
    for (const item of undecided) link(item, 'unknown', undecidedReason(item));
  }
  return { packageManager, subjects, instances, unlinked, notes };
}
