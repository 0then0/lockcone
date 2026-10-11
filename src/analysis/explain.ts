import type { RepositoryState } from '../git/repository.js';
import { buildPnpmState } from '../pnpm/dependency-graph.js';
import type { EvidencePathNode, Report } from './diff.js';
import { diff, summarize } from './diff.js';

export function explain(base: RepositoryState, head: RepositoryState): Report {
  return diff(buildPnpmState(base), buildPnpmState(head));
}

export function why(report: Report, name: string): Report {
  const changes = report.changes.filter((change) => change.name === name);
  const roots = new Set(
    changes.flatMap((change) => change.evidence.map((item) => item.root)),
  );
  for (const change of changes) {
    if (change.kind === 'dependency') {
      for (const root of [...change.changedNodes.base, ...change.changedNodes.head])
        roots.add(root);
    }
  }
  for (const change of report.declarationChanges) {
    if ((change.after ?? change.before)?.name === name) roots.add(change.root);
  }
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
  return {
    ...report,
    changes,
    manifestChanges: report.manifestChanges.filter((change) => roots.has(change.root)),
    declarations: {
      base: report.declarations.base.filter((item) => roots.has(item.root)),
      head: report.declarations.head.filter((item) => roots.has(item.root)),
    },
    declarationChanges: report.declarationChanges.filter((change) =>
      roots.has(change.root),
    ),
    catalogChanges: report.catalogChanges
      .filter((change) =>
        [...change.affectedDeclarations.base, ...change.affectedDeclarations.head].some(
          (root) => roots.has(root),
        ),
      )
      .map((change) => ({
        ...change,
        affectedDeclarations: {
          base: change.affectedDeclarations.base.filter((root) => roots.has(root)),
          head: change.affectedDeclarations.head.filter((root) => roots.has(root)),
        },
      })),
    pathNodes,
    summary: summarize(changes),
  };
}
