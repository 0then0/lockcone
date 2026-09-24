import type { DependencyGraph } from './dependency-graph.js';

export interface Visit {
  root: string;
  parent: string | null;
  uncertain: boolean;
}

export function traverse(graph: DependencyGraph, roots: string[]): Map<string, Visit> {
  const visits = new Map<string, Visit>();
  const queue: string[] = [];
  for (const root of [...new Set(roots)].sort()) {
    const node = graph.nodes.get(root);
    if (!node) continue;
    visits.set(root, { root, parent: null, uncertain: node.uncertain });
    queue.push(root);
  }
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    const visit = visits.get(id)!;
    const node = graph.nodes.get(id)!;
    for (const edge of [...node.edges].sort((a, b) =>
      a.target.localeCompare(b.target),
    )) {
      const target = graph.nodes.get(edge.target);
      if (!target) continue;
      const uncertain = visit.uncertain || target.uncertain;
      const prior = visits.get(target.id);
      if (prior && (!prior.uncertain || uncertain)) continue;
      visits.set(target.id, { root: visit.root, parent: id, uncertain });
      queue.push(target.id);
    }
  }
  return visits;
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
