import type { Confidence, Report } from '../analysis/diff.js';
import { evidencePath } from '../analysis/diff.js';
import type { Declaration } from '../pnpm/catalogs.js';
import { sanitizeTerminalControls } from '../sanitize.js';

const headings: Record<Confidence, string> = {
  explained: 'Explained changes (reachable from changed root)',
  'partially-explained': 'Partially explained changes',
  unexplained: 'Outside dependency cone',
  unknown: 'Unknown resolution context',
};

function declarationLines(entry: Declaration | null, side: 'base' | 'head'): string[] {
  if (!entry) return [`    ${side}: (absent)`];
  const origin = entry.catalog
    ? `pnpm-workspace.yaml ${entry.catalog.name}.${entry.catalog.entry}`
    : 'manifest';
  return [
    `    ${side}: reference ${entry.specifier}; effective declaration ${entry.effectiveRange ?? '(unavailable)'}; origin ${origin}; observed resolution ${entry.observedResolution ?? '(absent)'}`,
    ...entry.uncertainty.map((message) => `      Uncertainty: ${message}`),
  ];
}

export function renderText(report: Report): string {
  const lines = [`LockCone: ${report.base}..${report.head}`, '', 'Manifest changes:'];
  if (!report.manifestChanges.length) lines.push('  None.');
  for (const change of report.manifestChanges) {
    lines.push(
      `  ${change.manifest} [${change.section}] ${change.name}: ${change.before ?? '(absent)'} → ${change.after ?? '(absent)'}`,
    );
  }
  if (report.catalogChanges.length) {
    lines.push('', 'Catalog entry changes (pnpm-workspace.yaml):');
    for (const change of report.catalogChanges) {
      lines.push(
        `  ${change.catalog}.${change.entry}: ${change.before ?? '(absent)'} → ${change.after ?? '(absent)'}`,
      );
      for (const side of ['base', 'head'] as const)
        lines.push(
          `    ${side} affected declarations: ${change.affectedDeclarations[side].join(', ') || '(unused)'}`,
        );
      for (const message of change.uncertainty)
        lines.push(`    Uncertainty: ${message}`);
    }
  }
  if (report.declarationChanges.length) {
    lines.push('', 'Dependency declaration intent:');
    for (const change of report.declarationChanges) {
      const declaration = (change.after ?? change.before)!;
      lines.push(
        `  ${declaration.importer} [${declaration.section}] ${declaration.name}: ${change.change}${change.traversal ? '' : ' (no traversal root)'}`,
      );
      for (const side of ['base', 'head'] as const) {
        const entry = side === 'base' ? change.before : change.after;
        lines.push(...declarationLines(entry, side));
      }
    }
  }
  const intentRoots = new Set(report.declarationChanges.map((change) => change.root));
  const contextRoots = new Set(
    report.changes
      .filter((change) => change.kind === 'dependency')
      .flatMap((change) => [...change.changedNodes.base, ...change.changedNodes.head]),
  );
  const context = new Map(
    [...report.declarations.base, ...report.declarations.head]
      .filter(
        (entry) =>
          entry.catalog && contextRoots.has(entry.root) && !intentRoots.has(entry.root),
      )
      .map((entry) => [entry.root, entry]),
  );
  if (context.size) {
    lines.push('', 'Catalog dependency context (no declaration intent):');
    for (const entry of context.values()) {
      lines.push(`  ${entry.importer} [${entry.section}] ${entry.name}:`);
      for (const side of ['base', 'head'] as const) {
        lines.push(
          ...declarationLines(
            report.declarations[side].find((item) => item.root === entry.root) ?? null,
            side,
          ),
        );
      }
    }
  }
  for (const confidence of Object.keys(headings) as Confidence[]) {
    const changes = report.changes.filter((change) => change.confidence === confidence);
    if (!changes.length) continue;
    lines.push('', `${headings[confidence]}:`);
    for (const change of changes) {
      lines.push(
        `  ${change.name} [${change.kind}${change.scope ? ` ${change.scope}` : ''}]: ${change.before.join(', ') || '(absent)'} → ${change.after.join(', ') || '(absent)'}`,
      );
      lines.push(`    ${change.reason}`);
      for (const detail of change.details) {
        for (const edge of detail.edgesRemoved) {
          lines.push(
            `    ${detail.side}: ${detail.node} -- ${edge.kind}.${edge.name} -> ${edge.target} (removed)`,
          );
        }
        for (const edge of detail.edgesAdded) {
          lines.push(
            `    ${detail.side}: ${detail.node} -- ${edge.kind}.${edge.name} -> ${edge.target} (added)`,
          );
        }
        if (detail.metadataChanged.length) {
          lines.push(
            `    ${detail.side}: metadata changed: ${detail.metadataChanged.join(', ')}`,
          );
        }
        if (detail.metadataDiff.length) {
          const sameNodePair = change.details.some(
            (other) => other.side !== detail.side && other.node === detail.node,
          );
          const singleVersionPair =
            change.before.length === 1 &&
            change.after.length === 1 &&
            change.changedNodes.base.length === 1 &&
            change.changedNodes.head.length === 1 &&
            change.changedNodes.base[0] !== change.changedNodes.head[0];
          if (detail.side === 'head' && (sameNodePair || singleVersionPair)) continue;
          for (const item of detail.metadataDiff) {
            const nodeLabel =
              singleVersionPair && change.changedNodes.base[0] === detail.node
                ? `${change.changedNodes.base[0]} → ${change.changedNodes.head[0]}`
                : detail.node;
            lines.push(
              `    ${detail.side}: metadata [${nodeLabel}] ${item.path}: ${item.before ?? '(absent)'} → ${item.after ?? '(absent)'}`,
            );
          }
        }
      }
      for (const evidence of change.evidence) {
        const declaration = report.declarations[evidence.side].find(
          (item) => item.root === evidence.root,
        );
        const origin = declaration?.catalog
          ? `pnpm-workspace.yaml ${declaration.catalog.name}.${declaration.catalog.entry} (${declaration.effectiveRange}) → `
          : '';
        lines.push(
          `    ${evidence.side}: ${origin}${evidencePath(report, evidence).join(' → ')}`,
        );
      }
      if (!change.evidence.length)
        lines.push('    No path found from changed dependency declarations.');
      if (change.possibleExplanations.length)
        lines.push(
          `    Possible explanations (not verified): ${change.possibleExplanations.join('; ')}.`,
        );
    }
  }
  if (!report.changes.length) lines.push('', 'No matching graph changes.');
  if (report.warnings.length)
    lines.push(
      '',
      'Analysis limitations:',
      ...report.warnings.map((warning) => `  ${warning}`),
    );
  lines.push(
    '',
    'Summary (change groups, including importer resolutions and workspaces):',
  );
  for (const [confidence, count] of Object.entries(report.summary))
    lines.push(`  ${confidence}: ${count}`);
  lines.push(
    '',
    'Reachability is evidence, not proof of causality. Unexplained changes are not automatically errors.',
  );
  // Repository-controlled strings must not emit terminal control sequences.
  return lines.map((line) => sanitizeTerminalControls(line)).join('\n');
}
