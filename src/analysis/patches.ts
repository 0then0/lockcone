import type { PatchFile } from '../git/repository.js';
import { sameFileBytes } from '../git/repository.js';
import type { DependencyGraph } from '../graph/dependency-graph.js';
import { reverseIndex, reverseVisits } from '../graph/traversal.js';
import type { PnpmState } from '../pnpm/dependency-graph.js';
import type {
  Association,
  PackageManagerEvidence,
  PatchDeclaration,
  PatchNote,
  PatchSubject,
  Selector,
  SourceName,
  SourceStatus,
} from '../pnpm/patches.js';
import { parseInstance } from '../pnpm/patches.js';

// Limits keep reverse traversal linear in the graph for each reported instance.
export const maxInstancesPerSide = 100;
export const maxConsumersPerInstance = 50;

export type PatchEvent =
  | 'declaration-added'
  | 'declaration-removed'
  | 'selector-changed'
  | 'source-changed'
  | 'path-changed'
  | 'content-changed'
  | 'lockfile-entry-added'
  | 'lockfile-entry-removed'
  | 'lockfile-hash-changed'
  | 'lockfile-path-changed'
  | 'lockfile-shape-changed'
  | 'input-unavailable';

export interface FileEvidence {
  path: string | null;
  status: PatchFile['status'] | 'not-read';
  sha256: string | null;
  size: number | null;
  gitBlob: string | null;
  reason: string | null;
}
export interface DeclarationEvidence {
  source: SourceName;
  sourceStatus: SourceStatus;
  reference: unknown;
  path: string | null;
  problem: string | null;
}
export interface LockfileEvidence {
  hash: string | null;
  hashAlgorithm: 'unconfirmed';
  path: string | null;
  shape: 'hash' | 'object' | 'unrecognized';
}
export interface ConsumerEvidence {
  workspace: string;
  name: string | null;
  relation: 'direct' | 'transitive';
  // How the instance was tied to the patch; reachability alone is not that tie.
  basis: Association;
  section: string;
  path: string[];
  uncertain: boolean;
  uncertainty: string[];
}
export interface InstanceEvidence {
  id: string;
  name: string;
  version: string;
  peerContext: string | null;
  patchHash: string | null;
  association: Association;
  reasons: string[];
  // The instance with the same name, version, and peer context on the other side.
  counterpart: string | null;
  consumers: ConsumerEvidence[];
  consumersOmitted: number;
  consumersNote: string | null;
}
export interface PatchSide {
  declarations: DeclarationEvidence[];
  file: FileEvidence | null;
  lockfile: LockfileEvidence | null;
  instances: InstanceEvidence[];
  instancesOmitted: number;
  notes: PatchNote[];
}
export interface PatchChange {
  id: string;
  name: string | null;
  selector: { base: string | null; head: string | null };
  selectorKind: { base: Selector['kind'] | null; head: Selector['kind'] | null };
  events: PatchEvent[];
  content: {
    status: 'changed' | 'identical' | 'one-sided' | 'unavailable' | 'no-file-reference';
    basis: 'sha256' | 'git-blob' | null;
  };
  base: PatchSide | null;
  head: PatchSide | null;
  observations: PatchNote[];
}
export interface PatchReport {
  reportVersion: 1;
  pnpm: { base: PackageManagerEvidence; head: PackageManagerEvidence };
  notes: { base: PatchNote[]; head: PatchNote[] };
  changes: PatchChange[];
  // Instances that carry a patch_hash but match no selector or lockfile entry.
  unlinked: {
    base: PnpmState['patches']['unlinked'];
    head: PnpmState['patches']['unlinked'];
  };
  limits: { instancesPerSide: number; consumersPerInstance: number };
  truncated: string[];
}

function fileEvidence(
  path: string | null,
  file: PatchFile | null,
): FileEvidence | null {
  if (path === null) return null;
  if (!file)
    return {
      path,
      status: 'not-read',
      sha256: null,
      size: null,
      gitBlob: null,
      reason: null,
    };
  return {
    path,
    status: file.status,
    sha256: file.status === 'present' ? file.sha256 : null,
    size: file.status === 'present' || file.status === 'oversized' ? file.size : null,
    gitBlob:
      file.status === 'present' || file.status === 'oversized' ? file.blob : null,
    reason: file.status === 'unsupported' ? file.reason : null,
  };
}

interface Effective {
  reference: string | null;
  path: string | null;
  file: PatchFile | null;
  conflict: boolean;
}

// Declarations that pnpm may read win over ones the declared pnpm ignores. Only the
// lockfile's own path (pnpm 10 shape) is used when nothing is declared.
function effective(item: PatchSubject | null): Effective | null {
  if (!item) return null;
  const live = item.declarations.filter((entry) => entry.sourceStatus !== 'inactive');
  const pool = live.length ? live : item.declarations;
  if (pool.length) {
    const first = pool[0]!;
    return {
      reference: typeof first.reference === 'string' ? first.reference : null,
      path: first.path,
      file: first.file,
      conflict: new Set(pool.map((entry) => entry.path)).size > 1,
    };
  }
  if (item.lockfile?.path)
    return {
      reference: item.lockfile.path,
      path: item.lockfile.path,
      file: item.lockfile.file,
      conflict: false,
    };
  return null;
}

function nodeUncertainty(graph: DependencyGraph, id: string): string[] {
  const node = graph.nodes.get(id);
  if (!node?.uncertain) return [];
  if (node.kind === 'workspace')
    return [`${id}: the workspace declares peer dependencies`];
  if (node.kind === 'dependency')
    return [
      `${id}: the dependency entry is marked uncertain (a declaration issue or an uncertain resolved package)`,
    ];
  const instance = parseInstance(id);
  const metadata = node.metadata as {
    package?: { peerDependencies?: Record<string, string> };
    snapshot?: { transitivePeerDependencies?: string[] };
  };
  const reasons: string[] = [];
  if (instance?.peerContext) reasons.push(`peer context ${instance.peerContext}`);
  if (Object.keys(metadata?.package?.peerDependencies ?? {}).length)
    reasons.push('the package declares peer dependencies');
  if (metadata?.snapshot?.transitivePeerDependencies?.length)
    reasons.push('the snapshot lists transitive peer dependencies');
  if (metadata?.snapshot === undefined) reasons.push('the package has no snapshot');
  if (instance?.patchHash && !reasons.length)
    reasons.push(
      'the patch_hash suffix is treated as resolution context by the existing classifier',
    );
  if (!reasons.length) reasons.push('the package key carries a resolution context');
  return reasons.map((reason) => `${id}: ${reason}`);
}

class Side {
  private reverse: Map<string, string[]> | undefined;
  private traversed = 0;
  private identities: Map<string, string | null> | undefined;
  omitted = 0;

  constructor(readonly state: PnpmState) {}

  identity(identity: string): string | null {
    if (!this.identities) {
      this.identities = new Map();
      // An identity shared by several instances pairs with none of them.
      for (const instance of this.state.patches.instances.values())
        this.identities.set(
          instance.identity,
          this.identities.has(instance.identity) ? null : instance.id,
        );
    }
    return this.identities.get(identity) ?? null;
  }

  consumers(
    instance: string,
    basis: Association,
  ): Pick<InstanceEvidence, 'consumers' | 'consumersOmitted' | 'consumersNote'> {
    const graph = this.state.graph;
    if (this.traversed >= maxInstancesPerSide) {
      this.omitted++;
      return {
        consumers: [],
        consumersOmitted: 0,
        consumersNote: `Consumers were not traversed: more than ${maxInstancesPerSide} instances on this side.`,
      };
    }
    this.traversed++;
    this.reverse ??= reverseIndex(graph);
    const visits = reverseVisits(this.reverse, instance);
    // One shortest path per consuming workspace importer.
    const best = new Map<string, { id: string; depth: number }>();
    for (const [id, visit] of visits) {
      const node = graph.nodes.get(id);
      if (node?.kind !== 'dependency') continue;
      const cut = node.scope.lastIndexOf(':');
      const workspace = node.scope.slice(0, cut);
      const current = best.get(workspace);
      if (
        !current ||
        visit.depth < current.depth ||
        (visit.depth === current.depth && id < current.id)
      )
        best.set(workspace, { id, depth: visit.depth });
    }
    const all = [...best]
      .map(([workspace, { id, depth }]) => {
        const path: string[] = [];
        for (let at: string | null = id; at !== null; at = visits.get(at)!.next)
          path.push(at);
        const node = graph.nodes.get(id)!;
        const uncertainty = [
          ...new Set(path.flatMap((hop) => nodeUncertainty(graph, hop))),
        ];
        const owner = graph.nodes.get(`workspace:${workspace}`);
        return {
          workspace,
          name: owner?.name ?? null,
          relation: depth === 1 ? ('direct' as const) : ('transitive' as const),
          basis,
          section: node.scope.slice(node.scope.lastIndexOf(':') + 1),
          path,
          uncertain: path.some((hop) => graph.nodes.get(hop)?.uncertain),
          uncertainty,
        };
      })
      .sort(
        (a, b) =>
          Number(a.relation === 'transitive') - Number(b.relation === 'transitive') ||
          a.path.length - b.path.length ||
          a.workspace.localeCompare(b.workspace),
      );
    return {
      consumers: all.slice(0, maxConsumersPerInstance),
      consumersOmitted: Math.max(0, all.length - maxConsumersPerInstance),
      consumersNote: null,
    };
  }

  view(item: PatchSubject | null, other: Side): PatchSide | null {
    if (!item) return null;
    const links = [...item.links].sort((a, b) => a.instance.localeCompare(b.instance));
    const shown = links.slice(0, maxInstancesPerSide);
    const instances = shown.map((link): InstanceEvidence => {
      const instance = this.state.patches.instances.get(link.instance)!;
      return {
        id: instance.id,
        name: instance.name,
        version: instance.version,
        peerContext: instance.peerContext,
        patchHash: instance.patchHash,
        association: link.association,
        reasons: link.reasons,
        counterpart: other.identity(instance.identity),
        ...this.consumers(instance.id, link.association),
      };
    });
    const live = effective(item);
    return {
      declarations: item.declarations.map(
        (entry: PatchDeclaration): DeclarationEvidence => ({
          source: entry.source,
          sourceStatus: entry.sourceStatus,
          reference: entry.reference,
          path: entry.path,
          problem: entry.problem,
        }),
      ),
      file: live ? fileEvidence(live.path, live.file) : null,
      lockfile: item.lockfile
        ? {
            hash: item.lockfile.hash,
            hashAlgorithm: 'unconfirmed',
            path: item.lockfile.path,
            shape: item.lockfile.shape,
          }
        : null,
      instances,
      instancesOmitted: links.length - shown.length,
      notes: item.notes,
    };
  }
}

function pair(
  base: Map<string, PatchSubject>,
  head: Map<string, PatchSubject>,
): [PatchSubject | null, PatchSubject | null][] {
  const pairs: [PatchSubject | null, PatchSubject | null][] = [];
  const removed: PatchSubject[] = [];
  const added: PatchSubject[] = [];
  for (const key of [...new Set([...base.keys(), ...head.keys()])].sort()) {
    const before = base.get(key) ?? null;
    const after = head.get(key) ?? null;
    if (before && after) pairs.push([before, after]);
    else if (before) removed.push(before);
    else if (after) added.push(after);
  }
  // A selector edit keeps the referenced file. Pair only an unambiguous one-to-one match.
  const pathOf = (item: PatchSubject): string | null => effective(item)?.path ?? null;
  const count = (items: PatchSubject[], path: string): number =>
    items.filter((item) => pathOf(item) === path).length;
  const taken = new Set<PatchSubject>();
  for (const before of removed) {
    const path = pathOf(before);
    if (path === null || count(removed, path) !== 1 || count(added, path) !== 1)
      continue;
    const after = added.find((item) => pathOf(item) === path)!;
    pairs.push([before, after]);
    taken.add(before);
    taken.add(after);
  }
  for (const item of [...removed, ...added])
    if (!taken.has(item))
      pairs.push(removed.includes(item) ? [item, null] : [null, item]);
  return pairs;
}

export function patchReport(baseState: PnpmState, headState: PnpmState): PatchReport {
  const base = new Side(baseState);
  const head = new Side(headState);
  const changes: PatchChange[] = [];
  for (const [before, after] of pair(
    baseState.patches.subjects,
    headState.patches.subjects,
  )) {
    const events: PatchEvent[] = [];
    const observations: PatchNote[] = [];
    const observe = (code: string, message: string): void => {
      observations.push({ code, message });
    };
    const previous = effective(before);
    const current = effective(after);
    const declared = {
      base: Boolean(before?.declarations.length),
      head: Boolean(after?.declarations.length),
    };
    if (!declared.base && declared.head) events.push('declaration-added');
    if (declared.base && !declared.head) events.push('declaration-removed');
    if (before && after && before.selector.text !== after.selector.text)
      events.push('selector-changed');
    if (declared.base && declared.head) {
      const sources = (item: PatchSubject): string =>
        [...new Set(item.declarations.map((entry) => entry.source))].sort().join(',');
      if (sources(before!) !== sources(after!)) events.push('source-changed');
      if (previous?.reference !== current?.reference) {
        events.push('path-changed');
        if (previous?.path === current?.path)
          observe(
            'PATH_SPELLING_ONLY',
            'The reference text changed, but both spellings normalize to the same path.',
          );
      }
    }

    let content: PatchChange['content'] = { status: 'no-file-reference', basis: null };
    if (previous?.file && current?.file) {
      const same = sameFileBytes(previous.file, current.file);
      if (previous.conflict || current.conflict) {
        content = { status: 'unavailable', basis: null };
        observe(
          'CONFLICTING_DECLARATIONS',
          'Conflicting declarations: no single patch file can be compared.',
        );
      } else if (same === undefined) {
        content = { status: 'unavailable', basis: null };
      } else {
        const blobs =
          'blob' in previous.file &&
          'blob' in current.file &&
          previous.file.blob !== null &&
          current.file.blob !== null;
        content = {
          status: same ? 'identical' : 'changed',
          basis: blobs ? 'git-blob' : 'sha256',
        };
        if (!same) events.push('content-changed');
      }
    } else if (previous?.file || current?.file) {
      content = { status: 'one-sided', basis: null };
    } else if (previous || current) {
      content = { status: 'unavailable', basis: null };
    }
    const unavailable = (entry: Effective | null): boolean =>
      entry !== null &&
      (entry.file === null ||
        entry.file.status === 'missing' ||
        entry.file.status === 'unsupported');
    if (
      unavailable(previous) ||
      unavailable(current) ||
      (content.status === 'unavailable' &&
        previous &&
        current &&
        !previous.conflict &&
        !current.conflict)
    ) {
      events.push('input-unavailable');
      content = { status: 'unavailable', basis: null };
    }

    const was = before?.lockfile ?? null;
    const now = after?.lockfile ?? null;
    if (!was && now) events.push('lockfile-entry-added');
    else if (was && !now) events.push('lockfile-entry-removed');
    else if (was && now) {
      if (was.hash !== now.hash) events.push('lockfile-hash-changed');
      if (was.shape !== now.shape) events.push('lockfile-shape-changed');
      else if (was.shape === 'object' && was.path !== now.path)
        events.push('lockfile-path-changed');
    }
    // Independent signals are compared, never merged into one "changed" verdict.
    if (content.status === 'changed' && was?.hash && was.hash === now?.hash)
      observe(
        'CONTENT_CHANGED_LOCKFILE_HASH_UNCHANGED',
        'Patch file bytes differ, but the lockfile hash is identical on both sides. pnpm may hash normalized content, so this does not show whether an install would succeed.',
      );
    if (
      content.status === 'identical' &&
      was?.hash &&
      now?.hash &&
      was.hash !== now.hash
    )
      observe(
        'LOCKFILE_HASH_CHANGED_CONTENT_IDENTICAL',
        'The lockfile hash differs, but the patch file bytes are identical. A pnpm version or format change can alter the recorded hash.',
      );
    if (content.status === 'changed' && declared.head && !now)
      observe(
        'CONTENT_CHANGED_LOCKFILE_ENTRY_ABSENT',
        'Patch file bytes changed, but the head lockfile has no entry for this selector.',
      );
    if (!events.length) continue;

    const item = after ?? before!;
    changes.push({
      id: JSON.stringify([before?.selector.text ?? null, after?.selector.text ?? null]),
      name: item.selector.name,
      selector: {
        base: before?.selector.text ?? null,
        head: after?.selector.text ?? null,
      },
      selectorKind: {
        base: before?.selector.kind ?? null,
        head: after?.selector.kind ?? null,
      },
      events: [...new Set(events)],
      content,
      base: base.view(before, head),
      head: head.view(after, base),
      observations,
    });
  }
  changes.sort((a, b) => a.id.localeCompare(b.id));
  const truncated: string[] = [];
  for (const [label, side] of [
    ['base', base],
    ['head', head],
  ] as const)
    if (side.omitted)
      truncated.push(
        `${label}: consumers of ${side.omitted} instance(s) were not traversed after the limit of ${maxInstancesPerSide}.`,
      );
  const cap = <T>(items: T[]): T[] => items.slice(0, maxInstancesPerSide);
  return {
    reportVersion: 1,
    pnpm: {
      base: baseState.patches.packageManager,
      head: headState.patches.packageManager,
    },
    notes: { base: baseState.patches.notes, head: headState.patches.notes },
    changes,
    unlinked: {
      base: cap(baseState.patches.unlinked),
      head: cap(headState.patches.unlinked),
    },
    limits: {
      instancesPerSide: maxInstancesPerSide,
      consumersPerInstance: maxConsumersPerInstance,
    },
    truncated,
  };
}
