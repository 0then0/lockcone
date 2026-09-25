import { configuredPatches, resolutionFiles } from '../git/repository.js';
import type { GraphNode, NodeKind } from '../graph/dependency-graph.js';
import { fingerprint, stable } from '../graph/dependency-graph.js';
import { traverse } from '../graph/traversal.js';
import type { PnpmState } from '../pnpm/dependency-graph.js';
import type { ManifestChange } from './cone.js';
import { manifestChanges } from './cone.js';

export type Confidence =
  | 'explained'
  | 'partially-explained'
  | 'unexplained'
  | 'unknown';
export interface Evidence {
  side: 'base' | 'head';
  node: string;
  root: string;
  pathId: string;
}
export interface EvidencePathNode {
  side: 'base' | 'head';
  node: string;
  parent: string | null;
}
export interface NodeDetails {
  side: 'base' | 'head';
  node: string;
  edgesAdded: GraphNode['edges'];
  edgesRemoved: GraphNode['edges'];
  metadataChanged: string[];
  metadataDiff: { path: string; before: string | null; after: string | null }[];
}
export interface Change {
  name: string;
  kind: NodeKind;
  scope: string;
  change: 'added' | 'removed' | 'updated';
  before: string[];
  after: string[];
  changedNodes: { base: string[]; head: string[] };
  details: NodeDetails[];
  confidence: Confidence;
  reason: string;
  evidence: Evidence[];
  possibleExplanations: string[];
}
export interface Report {
  schemaVersion: 3;
  base: string;
  head: string;
  manifestChanges: ManifestChange[];
  changes: Change[];
  pathNodes: Record<string, EvidencePathNode>;
  warnings: string[];
  summary: Record<Confidence, number>;
}

function metadataFields(value: unknown, prefix = '$'): Map<string, string> {
  if (Array.isArray(value)) return new Map([[prefix, stable(value)]]);
  if (value !== null && typeof value === 'object') {
    const fields = new Map<string, string>();
    const entries = Object.entries(value);
    if (!entries.length) return new Map([[prefix, stable(value)]]);
    for (const [key, child] of entries) {
      for (const [path, detail] of metadataFields(
        child,
        prefix ? `${prefix}.${key}` : key,
      )) {
        fields.set(path, detail);
      }
    }
    return fields;
  }
  return new Map([[prefix, stable(value)]]);
}

function detailMetadata(node: GraphNode): unknown {
  if (
    node.kind !== 'package' ||
    node.metadata === null ||
    typeof node.metadata !== 'object'
  )
    return node.metadata;
  const metadata = node.metadata as Record<string, unknown>;
  const snapshot = metadata.snapshot;
  const withoutEdges =
    snapshot !== null && typeof snapshot === 'object'
      ? Object.fromEntries(
          Object.entries(snapshot).filter(
            ([key]) => key !== 'dependencies' && key !== 'optionalDependencies',
          ),
        )
      : snapshot;
  const compact = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.length ? value.map(compact) : undefined;
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value)
        .map(([key, child]) => [key, compact(child)] as const)
        .filter(([, child]) => child !== undefined);
      return entries.length ? Object.fromEntries(entries) : undefined;
    }
    return value;
  };
  return compact({ ...metadata, snapshot: withoutEdges });
}

function nodeDetails(
  node: GraphNode,
  side: 'base' | 'head',
  counterpart?: GraphNode,
): NodeDetails {
  const edgeKey = (edge: GraphNode['edges'][number]): string => stable(edge);
  const currentEdges = new Map(node.edges.map((edge) => [edgeKey(edge), edge]));
  const counterpartEdges = new Set(counterpart?.edges.map(edgeKey) ?? []);
  const currentMetadata = metadataFields(detailMetadata(node));
  const previousMetadata = counterpart
    ? metadataFields(detailMetadata(counterpart))
    : new Map<string, string>();
  const metadataChanged = counterpart
    ? [...new Set([...currentMetadata.keys(), ...previousMetadata.keys()])]
        .filter((path) => currentMetadata.get(path) !== previousMetadata.get(path))
        .sort()
    : [];
  const metadataDiff = [
    ...new Set([...currentMetadata.keys(), ...previousMetadata.keys()]),
  ]
    .filter((path) => currentMetadata.get(path) !== previousMetadata.get(path))
    .sort()
    .map((path) => ({
      path,
      before:
        side === 'base'
          ? (currentMetadata.get(path) ?? null)
          : (previousMetadata.get(path) ?? null),
      after:
        side === 'base'
          ? (previousMetadata.get(path) ?? null)
          : (currentMetadata.get(path) ?? null),
    }));
  return {
    side,
    node: node.id,
    edgesAdded:
      side === 'head'
        ? [...currentEdges]
            .filter(([key]) => !counterpartEdges.has(key))
            .map(([, edge]) => edge)
        : [],
    edgesRemoved:
      side === 'base'
        ? [...currentEdges]
            .filter(([key]) => !counterpartEdges.has(key))
            .map(([, edge]) => edge)
        : [],
    metadataChanged,
    metadataDiff,
  };
}

export function evidencePath(report: Report, evidence: Evidence): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | null = evidence.pathId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const entry: EvidencePathNode | undefined = report.pathNodes[current];
    if (!entry) break;
    path.push(entry.node);
    current = entry.parent;
  }
  return path.reverse();
}

function groupNodes(nodes: Map<string, GraphNode>): Map<string, GraphNode[]> {
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes.values()) {
    const key = JSON.stringify([node.kind, node.scope, node.name]);
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }
  return groups;
}

export function summarize(changes: Change[]): Report['summary'] {
  const summary: Report['summary'] = {
    explained: 0,
    'partially-explained': 0,
    unexplained: 0,
    unknown: 0,
  };
  for (const change of changes) summary[change.confidence]++;
  return summary;
}

export function diff(base: PnpmState, head: PnpmState): Report {
  const intent = manifestChanges(base, head);
  const roots = intent
    .filter(
      (change) =>
        change.section !== 'workspace' && change.section !== 'peerDependencies',
    )
    .map((change) => change.root);
  const visits = {
    base: traverse(base.graph, roots),
    head: traverse(head.graph, roots),
  };
  // Identity/version edits explain the workspace record itself, not upgrades of
  // unchanged dependency declarations. Do not expand them into dependency cones.
  for (const change of intent.filter((item) => item.section === 'workspace')) {
    for (const side of ['base', 'head'] as const) {
      const node = (side === 'base' ? base : head).graph.nodes.get(change.root);
      if (node && !visits[side].has(change.root))
        visits[side].set(change.root, {
          root: change.root,
          parent: null,
          uncertain: node.uncertain,
        });
    }
  }
  const warnings = new Set([...base.graph.warnings, ...head.graph.warnings]);
  if (stable(base.workspace) !== stable(head.workspace))
    warnings.add(
      'Workspace configuration changed; resolution effects are not modeled.',
    );
  const configuration = (state: PnpmState): unknown =>
    Object.fromEntries(
      Object.entries(state.lockfile).filter(
        ([key]) =>
          !['importers', 'packages', 'snapshots', 'lockfileVersion'].includes(key),
      ),
    );
  if (stable(configuration(base)) !== stable(configuration(head)))
    warnings.add('Lockfile resolution configuration changed.');
  for (const path of new Set([...base.files.keys(), ...head.files.keys()])) {
    if (resolutionFiles.has(path) && base.files.get(path) !== head.files.get(path)) {
      warnings.add(`Resolution input changed: ${path}`);
    }
  }
  const basePatches = configuredPatches(base.files);
  const headPatches = configuredPatches(head.files);
  for (const path of new Set([...basePatches, ...headPatches])) {
    if (
      (basePatches.has(path) && !base.files.has(path)) ||
      (headPatches.has(path) && !head.files.has(path))
    )
      warnings.add(`Configured patch file is missing: ${path}`);
    else if (
      basePatches.has(path) !== headPatches.has(path) ||
      base.files.get(path) !== head.files.get(path)
    )
      warnings.add(`Resolution input changed: ${path}`);
  }
  if (intent.some((change) => change.section === 'peerDependencies'))
    warnings.add('Workspace peer dependencies changed.');
  for (const path of new Set([...base.manifests.keys(), ...head.manifests.keys()])) {
    for (const field of [
      'packageManager',
      'engines',
      'devEngines',
      'os',
      'cpu',
      'libc',
      'dependenciesMeta',
      'pnpm',
    ]) {
      if (
        stable(base.manifests.get(path)?.[field]) !==
        stable(head.manifests.get(path)?.[field])
      ) {
        warnings.add(`Unmodeled manifest resolution input changed: ${path} ${field}`);
      }
    }
  }
  const groups = {
    base: groupNodes(base.graph.nodes),
    head: groupNodes(head.graph.nodes),
  };
  const changes: Change[] = [];
  const pathNodes: Report['pathNodes'] = {};
  for (const key of [
    ...new Set([...groups.base.keys(), ...groups.head.keys()]),
  ].sort()) {
    const oldNodes = groups.base.get(key) ?? [];
    const newNodes = groups.head.get(key) ?? [];
    const changed = {
      base: oldNodes.filter((node) => {
        const other = head.graph.nodes.get(node.id);
        return !other || fingerprint(node) !== fingerprint(other);
      }),
      head: newNodes.filter((node) => {
        const other = base.graph.nodes.get(node.id);
        return !other || fingerprint(node) !== fingerprint(other);
      }),
    };
    const total = changed.base.length + changed.head.length;
    if (!total) continue;
    const node = newNodes[0] ?? oldNodes[0]!;
    const evidence: Evidence[] = [];
    const details: NodeDetails[] = [];
    let uncertain = warnings.size > 0;
    for (const side of ['base', 'head'] as const) {
      for (const item of changed[side]) {
        const visit = visits[side].get(item.id);
        const counterparts = side === 'base' ? newNodes : oldNodes;
        const counterpart =
          (side === 'base' ? head : base).graph.nodes.get(item.id) ??
          (oldNodes.length === 1 && newNodes.length === 1
            ? counterparts[0]
            : undefined);
        details.push(nodeDetails(item, side, counterpart));
        uncertain ||= item.uncertain || Boolean(visit?.uncertain);
        if (visit) {
          const pathId = JSON.stringify([side, item.id]);
          let current: string | null = item.id;
          while (current !== null) {
            const id = JSON.stringify([side, current]);
            if (pathNodes[id]) break;
            const currentVisit = visits[side].get(current);
            if (!currentVisit) break;
            pathNodes[id] = {
              side,
              node: current,
              parent:
                currentVisit.parent === null
                  ? null
                  : JSON.stringify([side, currentVisit.parent]),
            };
            current = currentVisit.parent;
          }
          evidence.push({ side, node: item.id, root: visit.root, pathId });
        }
      }
    }
    const confidence: Confidence = uncertain
      ? 'unknown'
      : evidence.length === total
        ? 'explained'
        : evidence.length > 0
          ? 'partially-explained'
          : 'unexplained';
    changes.push({
      name: node.name,
      kind: node.kind,
      scope: node.scope,
      change: !oldNodes.length ? 'added' : !newNodes.length ? 'removed' : 'updated',
      before: oldNodes.map((item) => item.version).sort(),
      after: newNodes.map((item) => item.version).sort(),
      changedNodes: {
        base: changed.base.map((item) => item.id).sort(),
        head: changed.head.map((item) => item.id).sort(),
      },
      details,
      confidence,
      reason:
        confidence === 'explained'
          ? 'REACHABLE_FROM_CHANGED_ROOT'
          : confidence === 'partially-explained'
            ? 'SOME_CHANGED_INSTANCES_OUTSIDE_CONE'
            : confidence === 'unexplained'
              ? 'UNEXPLAINED_BY_MANIFEST_CHANGE'
              : 'RESOLUTION_CONTEXT_NOT_FULLY_MODELED',
      evidence,
      possibleExplanations:
        confidence === 'explained'
          ? []
          : [
              'resolver update or deduplication',
              'peer dependency resolution',
              'lockfile regeneration differences',
            ],
    });
  }
  return {
    schemaVersion: 3,
    base: base.revision,
    head: head.revision,
    manifestChanges: intent,
    changes,
    pathNodes,
    warnings: [...warnings].sort(),
    summary: summarize(changes),
  };
}
