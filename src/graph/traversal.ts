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
