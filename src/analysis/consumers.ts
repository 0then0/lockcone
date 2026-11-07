import type { DependencyGraph } from '../graph/dependency-graph.js';
import { reverseIndex, reverseVisits } from '../graph/traversal.js';
import { parseInstance } from '../pnpm/patches.js';

// Limits keep reverse traversal linear in the graph for each reported start node.
export const maxStartsPerSide = 100;
export const maxConsumersPerStart = 50;

export interface WorkspaceConsumer {
  workspace: string;
  name: string | null;
  relation: 'direct' | 'transitive';
  section: string;
  path: string[];
  uncertain: boolean;
  uncertainty: string[];
}
export interface ConsumerResult {
  consumers: WorkspaceConsumer[];
  omitted: number;
  note: string | null;
}

export function nodeUncertainty(graph: DependencyGraph, id: string): string[] {
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

// Workspace importers that reach a node, one shortest path per importer. The graph is
// the one the dependency cones use: runtime and optional edges of linked workspaces are
// inherited, development dependencies are not.
export class ConsumerIndex {
  private reverse: Map<string, string[]> | undefined;
  private reached = new Map<string, ReturnType<typeof reverseVisits>>();
  private traversed = 0;
  omitted = 0;

  constructor(readonly graph: DependencyGraph) {}

  // `tail` is appended to every path. `declarer` names the workspace dependency entry
  // that itself holds the examined edge: that workspace is the only direct consumer
  // and the importers that reach it through links are transitive.
  find(
    start: string,
    options: { tail?: string[]; declarer?: string } = {},
  ): ConsumerResult {
    const graph = this.graph;
    // Every call counts toward the limit, as before the cache existed, so the patch
    // report truncates exactly where it did. The cache only saves the traversal.
    if (this.traversed >= maxStartsPerSide) {
      this.omitted++;
      return {
        consumers: [],
        omitted: 0,
        note: `Consumers were not traversed: more than ${maxStartsPerSide} instances on this side.`,
      };
    }
    this.reverse ??= reverseIndex(graph);
    const tail = options.tail ?? [];
    this.traversed++;
    let visits = this.reached.get(start);
    if (!visits) {
      visits = reverseVisits(this.reverse, start);
      this.reached.set(start, visits);
    }
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
    const describe = (
      workspace: string,
      id: string,
      relation: WorkspaceConsumer['relation'],
      path: string[],
    ): WorkspaceConsumer => {
      const node = graph.nodes.get(id)!;
      const owner = graph.nodes.get(`workspace:${workspace}`);
      return {
        workspace,
        name: owner?.name ?? null,
        relation,
        section: node.scope.slice(node.scope.lastIndexOf(':') + 1),
        path,
        uncertain: path.some((hop) => graph.nodes.get(hop)?.uncertain),
        uncertainty: [...new Set(path.flatMap((hop) => nodeUncertainty(graph, hop)))],
      };
    };
    const all = [...best].map(([workspace, { id, depth }]) => {
      const path: string[] = [];
      for (let at: string | null = id; at !== null; at = visits.get(at)!.next)
        path.push(at);
      return describe(
        workspace,
        id,
        depth === 1 && options.declarer === undefined ? 'direct' : 'transitive',
        [
          ...path,
          ...(options.declarer === undefined ? [] : [options.declarer]),
          ...tail,
        ],
      );
    });
    if (options.declarer !== undefined) {
      const node = graph.nodes.get(options.declarer);
      if (node?.kind === 'dependency') {
        const workspace = node.scope.slice(0, node.scope.lastIndexOf(':'));
        // The declaring importer reaches its own edge directly.
        const index = all.findIndex((item) => item.workspace === workspace);
        if (index >= 0) all.splice(index, 1);
        all.push(describe(workspace, node.id, 'direct', [node.id, ...tail]));
      }
    }
    all.sort(
      (a, b) =>
        Number(a.relation === 'transitive') - Number(b.relation === 'transitive') ||
        a.path.length - b.path.length ||
        a.workspace.localeCompare(b.workspace),
    );
    return {
      consumers: all.slice(0, maxConsumersPerStart),
      omitted: Math.max(0, all.length - maxConsumersPerStart),
      note: null,
    };
  }
}
