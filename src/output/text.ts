import type { Confidence, Report } from '../analysis/diff.js';
import { evidencePath } from '../analysis/diff.js';
import { sanitizeTerminalControls } from '../sanitize.js';

const headings: Record<Confidence, string> = {
  explained: 'Explained changes (reachable from changed root)',
  'partially-explained': 'Partially explained changes',
  unexplained: 'Outside dependency cone',
  unknown: 'Unknown resolution context',
};

export function renderText(report: Report): string {
  const lines = [`LockCone: ${report.base}..${report.head}`, '', 'Manifest changes:'];
  if (!report.manifestChanges.length) lines.push('  None.');
  for (const change of report.manifestChanges) {
    lines.push(
      `  ${change.manifest} [${change.section}] ${change.name}: ${change.before ?? '(absent)'} → ${change.after ?? '(absent)'}`,
    );
  }
  for (const confidence of Object.keys(headings) as Confidence[]) {
    const changes = report.changes.filter((change) => change.confidence === confidence);
    if (!changes.length) continue;
    lines.push('', `${headings[confidence]}:`);
    for (const change of changes) {
      const renderedMetadataDiffs = new Set<string>();
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
          for (const item of detail.metadataDiff) {
            const key = JSON.stringify(item);
            if (renderedMetadataDiffs.has(key)) continue;
            renderedMetadataDiffs.add(key);
            lines.push(
              `    ${detail.side}: metadata ${item.path}: ${item.before ?? '(absent)'} → ${item.after ?? '(absent)'}`,
            );
          }
        }
      }
      for (const evidence of change.evidence)
        lines.push(
          `    ${evidence.side}: ${evidencePath(report, evidence).join(' → ')}`,
        );
      if (!change.evidence.length)
        lines.push('    No path found from changed manifest dependencies.');
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
