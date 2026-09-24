import type { RepositoryState } from '../git/repository.js';
import { buildPnpmState } from '../pnpm/dependency-graph.js';
import type { EvidencePathNode, Report } from './diff.js';
import { diff, summarize } from './diff.js';

export function explain(base: RepositoryState, head: RepositoryState): Report {
  return diff(buildPnpmState(base), buildPnpmState(head));
}

export function why(report: Report, name: string): Report {
  const changes = report.changes.filter((change) => change.name === name);
  const pathNodes: Report['pathNodes'] = {};
  for (const change of changes) {
    for (const evidence of change.evidence) {
      let current: string | null = evidence.pathId;
      while (current !== null && !pathNodes[current]) {
        const node: EvidencePathNode | undefined = report.pathNodes[current];
        if (!node) break;
        pathNodes[current] = node;
        current = node.parent;
      }
    }
  }
  return { ...report, changes, pathNodes, summary: summarize(changes) };
}
