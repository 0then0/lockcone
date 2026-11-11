import type { GraphNode } from '../graph/dependency-graph.js';
import { stable } from '../graph/dependency-graph.js';
import type { PnpmState } from '../pnpm/dependency-graph.js';
import { parseInstance } from '../pnpm/patches.js';
import type {
  BindingKind,
  ContextStatus,
  EdgeEvidence,
  PeerBinding,
  PeerNote,
} from '../pnpm/peers.js';
import {
  maxContextDepth,
  maxContextLength,
  maxContextSegments,
  PeerIndex,
} from '../pnpm/peers.js';
import type { WorkspaceConsumer } from './consumers.js';
import { ConsumerIndex, maxConsumersPerStart, maxStartsPerSide } from './consumers.js';

// Peer contexts of package instances whose name and version exist on both sides. The
// report states which providers the committed keys, metadata, and edges show. It does
// not state why pnpm chose them and never changes the classification of a group.

export const maxPeerChanges = 100;
export const maxInstancesPerChangeSide = 20;
export const maxCorrespondencesPerChange = 16;
export const maxEdgesPerCorrespondence = 5;

export type PeerEvent =
  | 'provider-added'
  | 'provider-removed'
  | 'provider-version-changed'
  | 'nested-context-changed'
  | 'evidence-changed'
  | 'instance-split'
  | 'instance-merged'
  | 'instance-added'
  | 'instance-removed'
  | 'context-unreadable'
  | 'patch-hash-changed';
export type Shape =
  | 'one-to-one'
  | 'split'
  | 'merge'
  | 'many-to-many'
  | 'added'
  | 'removed'
  | 'unlinked'
  | 'same-context';
// How a pair of instances is tied together. `same-holder`: an edge of one dependent
// that exists on both sides. `holder-rekeyed`: the dependent kept name and version but
// has another context itself. `holder-version-changed`: only the dependent's name is
// the same. `ambiguous`: the shared dependents point at several instances on a side.
// `unlinked`: equal name and version, no shared dependent edge. `same-context`: the
// context is identical on both sides and only what supports its bindings changed.
export type Support =
  | 'same-holder'
  | 'holder-rekeyed'
  | 'holder-version-changed'
  | 'ambiguous'
  | 'unlinked'
  | 'same-context';

export interface PeerInstance {
  id: string;
  name: string;
  version: string;
  // The peer suffix as written, without the instance's own patch_hash group.
  rawContext: string | null;
  patchHash: string | null;
  contextStatus: ContextStatus;
  problems: PeerNote[];
  // False when the same context exists on the other side too.
  changed: boolean;
  metadata: 'present' | 'missing';
  bindings: PeerBinding[];
  transitivePeerDependencies: string[];
  consumers: WorkspaceConsumer[];
  consumersOmitted: number;
  consumersNote: string | null;
}
export interface BindingChange {
  peer: string;
  change:
    | 'provider-added'
    | 'provider-removed'
    | 'provider-version-changed'
    | 'nested-context-changed'
    | 'evidence-changed';
  before: string | null;
  after: string | null;
  kind: { base: BindingKind | null; head: BindingKind | null };
  optional: boolean | null;
}
export interface SharedEdge {
  support: Exclude<Support, 'ambiguous' | 'unlinked' | 'same-context'>;
  alias: string;
  base: EdgeEvidence[];
  head: EdgeEvidence[];
  // False when the shared dependents point at several instances on a side.
  unique: boolean;
}
export interface Correspondence {
  base: string;
  head: string;
  support: Support;
  // True only for a pair that one dependent edge ties to exactly these two instances.
  established: boolean;
  edges: SharedEdge[];
  edgesOmitted: number;
  // Null when a context is unreadable on either side.
  bindingChanges: BindingChange[] | null;
  patchHash: { base: string | null; head: string | null };
}
export interface PeerContextChange {
  id: string;
  name: string;
  version: string;
  shape: Shape;
  ambiguous: boolean;
  events: PeerEvent[];
  base: PeerInstance[];
  head: PeerInstance[];
  instancesOmitted: { base: number; head: number };
  correspondences: Correspondence[];
  correspondencesOmitted: number;
  uncertainty: string[];
}
export interface PeerBindingReport {
  reportVersion: 1;
  // Constant: the section reports observations, never the resolver's reason.
  causality: 'not-established';
  changes: PeerContextChange[];
  changesOmitted: number;
  limits: {
    changes: number;
    instancesPerChangeSide: number;
    correspondencesPerChange: number;
    edgesPerCorrespondence: number;
    consumersPerInstance: number;
    consumerTraversalsPerSide: number;
    contextLength: number;
    contextDepth: number;
    contextSegments: number;
  };
  truncated: string[];
}

type SideName = 'base' | 'head';
// Shared dependent edges per candidate pair, or why there are none.
type Links = Map<string, SharedEdge[]> | 'same-context' | null;
type Tier = SharedEdge['support'];
interface Slot {
  tier: Tier;
  alias: string;
  targets: Set<string>;
  edges: EdgeEvidence[];
}
interface Group {
  name: string;
  version: string;
  // Context identity (without patch hashes) to the instance IDs that carry it.
  base: Map<string, string[]>;
  head: Map<string, string[]>;
}

class Side {
  readonly peers: PeerIndex;
  private consumerIndex: ConsumerIndex | undefined;

  constructor(readonly state: PnpmState) {
    this.peers = new PeerIndex(state.graph);
  }

  get omitted(): number {
    return this.consumerIndex?.omitted ?? 0;
  }

  view(id: string, changed: boolean): PeerInstance {
    const instance = this.peers.instance(id)!;
    this.consumerIndex ??= new ConsumerIndex(this.state.graph);
    const found = this.consumerIndex.find(id);
    return {
      id,
      name: instance.context.name,
      version: instance.context.version,
      rawContext: instance.context.raw,
      patchHash: instance.context.patchHash,
      contextStatus: instance.context.status,
      problems: instance.context.problems,
      changed,
      metadata: instance.metadata,
      bindings: instance.bindings,
      transitivePeerDependencies: instance.transitivePeerDependencies,
      consumers: found.consumers,
      consumersOmitted: found.omitted,
      consumersNote: found.note,
    };
  }

  // What the classification of bindings rests on, without instance-specific patch
  // hashes of the holder.
  signature(id: string): string {
    const instance = this.peers.instance(id);
    if (!instance) return '';
    return stable(
      instance.bindings.map((binding) => [
        binding.peer,
        binding.provider,
        binding.kind,
        binding.edge?.target ?? null,
      ]),
    );
  }
}

const groupKey = (name: string, version: string): string =>
  JSON.stringify([name, version]);

const unpatched = (id: string | undefined): string | null =>
  id === undefined ? null : (parseInstance(id)?.identity ?? id);

function bindingChanges(before: PeerBinding[], after: PeerBinding[]): BindingChange[] {
  const changes: BindingChange[] = [];
  const old = new Map(before.map((binding) => [binding.peer, binding]));
  const current = new Map(after.map((binding) => [binding.peer, binding]));
  // A context binding is what the key names. An unbound or own-dependency entry is a
  // declaration without a provider in the context.
  const provider = (binding: PeerBinding | undefined): string | null =>
    binding && binding.kind !== 'unbound' && binding.kind !== 'own-dependency'
      ? binding.provider
      : null;
  for (const peer of [...new Set([...old.keys(), ...current.keys()])].sort()) {
    const was = old.get(peer);
    const now = current.get(peer);
    const from = provider(was);
    let to = provider(now);
    // A provider that differs only in a patch hash is the same peer provider; the
    // patch report covers the patch.
    if (
      from !== null &&
      to !== null &&
      from !== to &&
      parseInstance(from)?.identity === parseInstance(to)?.identity
    )
      to = from;
    let change: BindingChange['change'] | undefined;
    // Without a provider in either context this is an ordinary dependency edge, which
    // the graph changes report.
    if (from === null && to === null) continue;
    if (from === null && to !== null) change = 'provider-added';
    else if (from !== null && to === null) change = 'provider-removed';
    else if (from !== null && to !== null && from !== to)
      change =
        was!.providerVersion === now!.providerVersion
          ? 'nested-context-changed'
          : 'provider-version-changed';
    else if (
      (was?.kind ?? null) !== (now?.kind ?? null) ||
      unpatched(was?.edge?.target) !== unpatched(now?.edge?.target)
    )
      change = 'evidence-changed';
    if (!change) continue;
    changes.push({
      peer,
      change,
      before: from,
      after: provider(now),
      kind: { base: was?.kind ?? null, head: now?.kind ?? null },
      optional: (now ?? was)?.declaration?.optional ?? null,
    });
  }
  return changes;
}

function bindingNotes(side: SideName, instance: PeerInstance): string[] {
  const reasons: string[] = [];
  for (const problem of instance.problems)
    reasons.push(`${side} ${instance.id}: ${problem.message}`);
  if (instance.metadata === 'missing' && instance.contextStatus === 'none')
    reasons.push(
      `${side} ${instance.id}: the lockfile has no packages entry, so peer declarations are unknown.`,
    );
  for (const binding of instance.bindings)
    if (binding.kind === 'unconfirmed' || binding.kind === 'conflicting')
      for (const note of binding.notes)
        reasons.push(`${side} ${instance.id} ${binding.peer}: ${note.message}`);
  return reasons;
}

export function comparePeerBindings(
  baseState: PnpmState,
  headState: PnpmState,
): PeerBindingReport {
  const sides = { base: new Side(baseState), head: new Side(headState) };
  const groups = new Map<string, Group>();
  const groupOf = new Map<string, Group>();
  for (const side of ['base', 'head'] as const) {
    // Instances are the package nodes with a snapshot, as in the patch report.
    for (const instance of sides[side].state.patches.instances.values()) {
      const key = groupKey(instance.name, instance.version);
      let group = groups.get(key);
      if (!group) {
        group = {
          name: instance.name,
          version: instance.version,
          base: new Map(),
          head: new Map(),
        };
        groups.set(key, group);
      }
      // A malformed key has no readable context, so it is the same instance only as
      // itself: its truncated identity must not coincide with a readable key.
      const identity =
        sides[side].peers.context(instance.id)?.status === 'malformed'
          ? instance.id
          : instance.identity;
      const ids = group[side].get(identity) ?? [];
      ids.push(instance.id);
      group[side].set(identity, ids);
    }
  }
  // Only packages whose name and version exist on both sides: a new or removed
  // version is a version change, which the graph changes report.
  const active = new Set<Group>();
  for (const group of groups.values()) {
    if (!group.base.size || !group.head.size) continue;
    const differs =
      [...group.base.keys()].some((identity) => !group.head.has(identity)) ||
      [...group.head.keys()].some((identity) => !group.base.has(identity));
    if (differs) active.add(group);
  }
  const identityOf = {
    base: new Map<string, string>(),
    head: new Map<string, string>(),
  };
  for (const side of ['base', 'head'] as const)
    for (const group of groups.values())
      for (const [identity, ids] of group[side])
        for (const id of ids) {
          identityOf[side].set(id, identity);
          if (active.has(group)) groupOf.set(`${side}:${id}`, group);
        }

  // Dependent edges into active groups, keyed so that the same dependent has the same
  // key on both sides. The key uses the most specific identity the two sides share.
  const rekeyed = (side: SideName, node: GraphNode): boolean => {
    const instance = sides[side].state.patches.instances.get(node.id);
    if (!instance) return false;
    const other = side === 'base' ? 'head' : 'base';
    const group = groups.get(groupKey(instance.name, instance.version));
    return [...(group?.[other].values() ?? [])]
      .flat()
      .some((id) => !sides[side].state.graph.nodes.has(id));
  };
  const slots = {
    base: new Map<Group, Map<string, Slot>>(),
    head: new Map<Group, Map<string, Slot>>(),
  };
  for (const side of ['base', 'head'] as const) {
    const other = side === 'base' ? 'head' : 'base';
    const nodes = [...sides[side].state.graph.nodes.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    for (const node of nodes) {
      if (node.kind === 'workspace') continue;
      let holder: { tier: Tier; key: string } | undefined;
      for (const edge of node.edges) {
        const group = groupOf.get(`${side}:${edge.target}`);
        if (!group) continue;
        if (!holder) {
          if (node.kind === 'dependency' || sides[other].state.graph.nodes.has(node.id))
            holder = { tier: 'same-holder', key: node.id };
          else {
            const instance = sides[side].state.patches.instances.get(node.id);
            if (!instance) break;
            holder = rekeyed(side, node)
              ? {
                  tier: 'holder-rekeyed',
                  key: groupKey(instance.name, instance.version),
                }
              : { tier: 'holder-version-changed', key: instance.name };
          }
        }
        const key = JSON.stringify([holder.tier, holder.key, edge.name]);
        const bySlot = slots[side].get(group) ?? new Map<string, Slot>();
        slots[side].set(group, bySlot);
        const slot = bySlot.get(key) ?? {
          tier: holder.tier,
          alias: edge.name,
          targets: new Set<string>(),
          edges: [],
        };
        bySlot.set(key, slot);
        slot.targets.add(identityOf[side].get(edge.target)!);
        slot.edges.push({
          holder: node.id,
          section: edge.kind,
          name: edge.name,
          target: edge.target,
        });
      }
    }
  }

  const changes: PeerContextChange[] = [];
  const truncated: string[] = [];
  const cap = <T>(items: T[]): T[] => items.slice(0, maxInstancesPerChangeSide);
  const tiers: Tier[] = ['same-holder', 'holder-rekeyed', 'holder-version-changed'];

  const emit = (group: Group, base: string[], head: string[], links: Links): void => {
    const sorted = { base: [...base].sort(), head: [...head].sort() };
    const idsOf = (side: SideName, identity: string): string[] =>
      [...(group[side].get(identity) ?? [])].sort();
    const uncertainty: string[] = [];
    const events = new Set<PeerEvent>();
    const views = { base: [] as PeerInstance[], head: [] as PeerInstance[] };
    const omitted = { base: 0, head: 0 };
    for (const side of ['base', 'head'] as const) {
      const other = side === 'base' ? 'head' : 'base';
      const ids = sorted[side].flatMap((identity) =>
        idsOf(side, identity).map((id) => ({ id, identity })),
      );
      omitted[side] = Math.max(0, ids.length - maxInstancesPerChangeSide);
      for (const { id, identity } of cap(ids)) {
        const view = sides[side].view(id, !group[other].has(identity));
        views[side].push(view);
        uncertainty.push(...bindingNotes(side, view));
        if (view.consumersNote)
          uncertainty.push(`${side} ${id}: ${view.consumersNote}`);
        if (view.contextStatus !== 'none' && view.contextStatus !== 'parsed')
          events.add('context-unreadable');
      }
      for (const identity of sorted[side])
        if (idsOf(side, identity).length > 1)
          uncertainty.push(
            `${side}: several instances share the context ${identity} and differ only in patch_hash; they are not told apart.`,
          );
      if (omitted[side])
        uncertainty.push(
          `${side}: ${omitted[side]} more instance(s) not listed after the limit of ${maxInstancesPerChangeSide}.`,
        );
    }

    // Candidate pairs. Without shared dependents every remaining combination is only
    // possible, never established.
    const pairs: { base: string; head: string; edges: SharedEdge[] }[] = [];
    if (links === 'same-context')
      pairs.push({ base: sorted.base[0]!, head: sorted.head[0]!, edges: [] });
    else if (links) {
      for (const [key, edges] of links) {
        const [from, to] = JSON.parse(key) as [string, string];
        if (from !== to) pairs.push({ base: from, head: to, edges });
      }
    } else
      for (const from of sorted.base)
        for (const to of sorted.head) pairs.push({ base: from, head: to, edges: [] });
    pairs.sort((a, b) => a.base.localeCompare(b.base) || a.head.localeCompare(b.head));

    let ambiguous = false;
    const correspondences: Correspondence[] = [];
    const listed = pairs.length <= maxCorrespondencesPerChange ? pairs : [];
    if (pairs.length > maxCorrespondencesPerChange) {
      ambiguous = true;
      uncertainty.push(
        `${pairs.length} possible correspondences exceed the limit of ${maxCorrespondencesPerChange}; none is listed, and no pair was chosen.`,
      );
    }
    for (const pair of listed) {
      const baseIds = idsOf('base', pair.base);
      const headIds = idsOf('head', pair.head);
      // Instances that share a context cannot be told apart: no ID is picked.
      if (baseIds.length !== 1 || headIds.length !== 1) {
        ambiguous = true;
        continue;
      }
      const before = views.base.find((view) => view.id === baseIds[0]);
      const after = views.head.find((view) => view.id === headIds[0]);
      if (!before || !after) continue;
      const unique = pair.edges.filter((edge) => edge.unique);
      const support: Support = !links
        ? 'unlinked'
        : links === 'same-context'
          ? 'same-context'
          : unique.length
            ? tiers.find((tier) => unique.some((edge) => edge.support === tier))!
            : 'ambiguous';
      const readable = [before, after].every(
        (view) => view.contextStatus === 'none' || view.contextStatus === 'parsed',
      );
      const diff = readable ? bindingChanges(before.bindings, after.bindings) : null;
      for (const item of diff ?? []) events.add(item.change);
      if (before.patchHash !== after.patchHash) events.add('patch-hash-changed');
      if (support === 'ambiguous' || support === 'unlinked') ambiguous = true;
      const ordered = [...pair.edges].sort(
        (a, b) =>
          Number(b.unique) - Number(a.unique) ||
          tiers.indexOf(a.support) - tiers.indexOf(b.support) ||
          a.alias.localeCompare(b.alias) ||
          stable(a.base).localeCompare(stable(b.base)),
      );
      correspondences.push({
        base: before.id,
        head: after.id,
        support,
        established: unique.length > 0 || support === 'same-context',
        edges: ordered.slice(0, maxEdgesPerCorrespondence),
        edgesOmitted: Math.max(0, ordered.length - maxEdgesPerCorrespondence),
        bindingChanges: diff,
        patchHash: { base: before.patchHash, head: after.patchHash },
      });
    }

    let shape: Shape;
    if (!sorted.head.length) shape = 'removed';
    else if (!sorted.base.length) shape = 'added';
    else if (!links) shape = 'unlinked';
    else if (links === 'same-context') shape = 'same-context';
    else if (sorted.base.length === 1 && sorted.head.length === 1) shape = 'one-to-one';
    else if (sorted.base.length === 1) shape = 'split';
    else if (sorted.head.length === 1) shape = 'merge';
    else shape = 'many-to-many';
    if (shape === 'split') events.add('instance-split');
    if (shape === 'merge') events.add('instance-merged');
    if (shape === 'added') events.add('instance-added');
    if (shape === 'removed') events.add('instance-removed');
    if (shape === 'unlinked') {
      // One instance on each side is still only a possible pair.
      ambiguous = true;
      uncertainty.push(
        'No dependent edge is shared by these instances; equal name and version do not establish which instance replaced which.',
      );
    }
    if (correspondences.some((item) => item.support === 'ambiguous'))
      uncertainty.push(
        'The shared dependents point at several instances on a side; the listed pairs are possible correspondences, not established ones.',
      );
    for (const item of correspondences)
      if (item.support === 'holder-version-changed')
        uncertainty.push(
          `${item.base} → ${item.head}: the dependent that ties the pair changed its version.`,
        );
    changes.push({
      id: JSON.stringify([group.name, group.version, sorted.base, sorted.head]),
      name: group.name,
      version: group.version,
      shape,
      ambiguous,
      events: [...events].sort(),
      base: views.base,
      head: views.head,
      instancesOmitted: omitted,
      correspondences,
      correspondencesOmitted: pairs.length - listed.length,
      uncertainty: [...new Set(uncertainty)],
    });
  };

  const ordered = [...groups.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
  );
  let found = 0;
  const bounded = (
    group: Group,
    base: string[],
    head: string[],
    links: Links,
  ): void => {
    if (found++ < maxPeerChanges) emit(group, base, head, links);
  };
  for (const group of ordered) {
    if (!group.base.size || !group.head.size) continue;
    // A context present on both sides: report only a change of what supports it.
    for (const identity of [...group.base.keys()].sort()) {
      const before = group.base.get(identity)!;
      const after = group.head.get(identity);
      if (after?.length !== 1 || before.length !== 1) continue;
      if (sides.base.signature(before[0]!) === sides.head.signature(after[0]!))
        continue;
      const diff = bindingChanges(
        sides.base.peers.instance(before[0]!)?.bindings ?? [],
        sides.head.peers.instance(after[0]!)?.bindings ?? [],
      );
      if (diff.length) bounded(group, [identity], [identity], 'same-context');
    }
    if (!active.has(group)) continue;
    // Link the contexts that one dependent slot holds on both sides.
    const links = new Map<string, SharedEdge[]>();
    const neighbours = new Map<string, Set<string>>();
    const connect = (a: string, b: string): void => {
      neighbours.set(a, (neighbours.get(a) ?? new Set()).add(b));
      neighbours.set(b, (neighbours.get(b) ?? new Set()).add(a));
    };
    // A context present on both sides is the same instance for this purpose, so a
    // change that moves dependents onto it reads as a merge, and off it as a split.
    for (const identity of group.base.keys())
      if (group.head.has(identity)) connect(`base:${identity}`, `head:${identity}`);
    const baseSlots = slots.base.get(group) ?? new Map<string, Slot>();
    const headSlots = slots.head.get(group) ?? new Map<string, Slot>();
    for (const key of [...baseSlots.keys()].sort()) {
      const before = baseSlots.get(key)!;
      const after = headSlots.get(key);
      if (!after) continue;
      const unique = before.targets.size === 1 && after.targets.size === 1;
      for (const from of [...before.targets].sort())
        for (const to of [...after.targets].sort()) {
          connect(`base:${from}`, `head:${to}`);
          const pair = JSON.stringify([from, to]);
          const edges = links.get(pair) ?? [];
          links.set(pair, edges);
          const byTarget = (side: SideName, slot: Slot, identity: string) =>
            slot.edges
              .filter((edge) => identityOf[side].get(edge.target) === identity)
              .sort((a, b) => a.holder.localeCompare(b.holder));
          edges.push({
            support: before.tier,
            alias: before.alias,
            base: byTarget('base', before, from),
            head: byTarget('head', after, to),
            unique,
          });
        }
    }
    const changed = {
      base: [...group.base.keys()].filter((identity) => !group.head.has(identity)),
      head: [...group.head.keys()].filter((identity) => !group.base.has(identity)),
    };
    const seen = new Set<string>();
    const unlinked = { base: [] as string[], head: [] as string[] };
    for (const side of ['base', 'head'] as const)
      for (const identity of changed[side].sort()) {
        const start = `${side}:${identity}`;
        if (seen.has(start)) continue;
        if (!neighbours.has(start)) {
          unlinked[side].push(identity);
          continue;
        }
        const component = { base: [] as string[], head: [] as string[] };
        const queue = [start];
        seen.add(start);
        for (let index = 0; index < queue.length; index++) {
          const current = queue[index]!;
          const cut = current.indexOf(':');
          component[current.slice(0, cut) as SideName].push(current.slice(cut + 1));
          for (const next of [...(neighbours.get(current) ?? [])].sort())
            if (!seen.has(next)) {
              seen.add(next);
              queue.push(next);
            }
        }
        const inside = new Map(
          [...links].filter(([key]) => {
            const [from, to] = JSON.parse(key) as [string, string];
            return component.base.includes(from) && component.head.includes(to);
          }),
        );
        bounded(group, component.base, component.head, inside);
      }
    if (unlinked.base.length && unlinked.head.length)
      bounded(group, unlinked.base, unlinked.head, null);
    else if (unlinked.base.length) bounded(group, unlinked.base, [], new Map());
    else if (unlinked.head.length) bounded(group, [], unlinked.head, new Map());
  }

  for (const side of ['base', 'head'] as const)
    if (sides[side].omitted)
      truncated.push(
        `${side}: consumers of ${sides[side].omitted} instance(s) were not traversed after the limit of ${maxStartsPerSide}.`,
      );
  const changesOmitted = Math.max(0, found - maxPeerChanges);
  if (changesOmitted)
    truncated.push(
      `${changesOmitted} more peer context change(s) not listed after the limit of ${maxPeerChanges}.`,
    );
  return {
    reportVersion: 1,
    causality: 'not-established',
    changes,
    changesOmitted,
    limits: {
      changes: maxPeerChanges,
      instancesPerChangeSide: maxInstancesPerChangeSide,
      correspondencesPerChange: maxCorrespondencesPerChange,
      edgesPerCorrespondence: maxEdgesPerCorrespondence,
      consumersPerInstance: maxConsumersPerStart,
      consumerTraversalsPerSide: maxStartsPerSide,
      contextLength: maxContextLength,
      contextDepth: maxContextDepth,
      contextSegments: maxContextSegments,
    },
    truncated,
  };
}
