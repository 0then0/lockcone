import type { DependencyGraph } from './dependency-graph.js';

export interface Visit {
  root: string;
  parent: string | null;
  uncertain: boolean;
}

export function traverseAll(
  graph: DependencyGraph,
  roots: string[],
): Map<string, Visit[]> {
  const visits = new Map<string, Map<string, Visit>>();
  const queue: { id: string; visit: Visit }[] = [];
  for (const root of [...new Set(roots)].sort()) {
    const node = graph.nodes.get(root);
    if (!node) continue;
    const visit = { root, parent: null, uncertain: node.uncertain };
    visits.set(root, new Map([[root, visit]]));
    queue.push({ id: root, visit });
  }
  for (let index = 0; index < queue.length; index++) {
    const { id, visit } = queue[index]!;
    const node = graph.nodes.get(id)!;
    for (const edge of [...node.edges].sort((a, b) =>
      a.target.localeCompare(b.target),
    )) {
      const target = graph.nodes.get(edge.target);
      if (!target) continue;
      const uncertain = visit.uncertain || target.uncertain;
      const targetVisits = visits.get(target.id) ?? new Map<string, Visit>();
      const prior = targetVisits.get(visit.root);
      if (prior && (!prior.uncertain || uncertain)) continue;
      const next = { root: visit.root, parent: id, uncertain };
      targetVisits.set(visit.root, next);
      visits.set(target.id, targetVisits);
      queue.push({ id: target.id, visit: next });
    }
  }
  return new Map(
    [...visits].map(([id, nodeVisits]) => [
      id,
      [...nodeVisits.values()].sort(
        (a, b) =>
          Number(a.uncertain) - Number(b.uncertain) || a.root.localeCompare(b.root),
      ),
    ]),
  );
}

export function traverse(graph: DependencyGraph, roots: string[]): Map<string, Visit> {
  return new Map(
    [...traverseAll(graph, roots)].map(([id, visits]) => [id, visits[0]!]),
  );
}

export function dependencyPath(id: string, visits: Map<string, Visit>): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let current: string | null = id;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    path.push(current);
    current = visits.get(current)?.parent ?? null;
  }
  return path.reverse();
}

// Reverse reachability over the same edges as traverseAll. A node's `next` is the
// following hop toward the target on one shortest path; `depth` counts edges.
export interface ReverseVisit {
  depth: number;
  next: string | null;
}

export function reverseIndex(graph: DependencyGraph): Map<string, string[]> {
  const predecessors = new Map<string, Set<string>>();
  for (const node of graph.nodes.values()) {
    for (const edge of node.edges) {
      if (!graph.nodes.has(edge.target)) continue;
      const sources = predecessors.get(edge.target) ?? new Set<string>();
      sources.add(node.id);
      predecessors.set(edge.target, sources);
    }
  }
  return new Map(
    [...predecessors].map(([id, sources]) => [id, [...sources].sort()] as const),
  );
}

export function reverseVisits(
  index: Map<string, string[]>,
  target: string,
): Map<string, ReverseVisit> {
  const visits = new Map<string, ReverseVisit>([[target, { depth: 0, next: null }]]);
  const queue = [target];
  for (let position = 0; position < queue.length; position++) {
    const id = queue[position]!;
    const depth = visits.get(id)!.depth + 1;
    for (const source of index.get(id) ?? []) {
      if (visits.has(source)) continue;
      visits.set(source, { depth, next: id });
      queue.push(source);
    }
  }
  return visits;
}
