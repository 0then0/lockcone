import type { Confidence, Report } from '../analysis/diff.js';
import { evidencePath } from '../analysis/diff.js';
import type {
  OverrideChange,
  OverrideEdge,
  OverrideEdgeSide,
  OverrideSide,
} from '../analysis/overrides.js';
import type {
  FileEvidence,
  InstanceEvidence,
  PatchChange,
  PatchSide,
} from '../analysis/patches.js';
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

const shortHash = (value: string): string =>
  value.replace(/patch_hash=([0-9a-f]{12})[0-9a-f]+/g, 'patch_hash=$1…');

function fileLine(file: FileEvidence | null): string {
  if (!file) return '(no file reference)';
  if (file.status === 'present')
    return `${file.path}: sha256 ${file.sha256}, ${file.size} bytes`;
  if (file.status === 'oversized')
    return `${file.path}: not read (${file.size} bytes), Git blob ${file.gitBlob}`;
  return `${file.path}: ${file.reason ?? file.status}`;
}

function instanceLine(instance: InstanceEvidence, detail: boolean): string {
  const id = detail ? instance.id : shortHash(instance.id);
  const counterpart =
    instance.counterpart === null
      ? 'no counterpart with the same name, version, and peer context'
      : `counterpart ${detail ? instance.counterpart : shortHash(instance.counterpart)}`;
  return `${id} [${instance.association}; ${counterpart}]`;
}

function patchLines(change: PatchChange, detail: boolean): string[] {
  const selectors =
    change.selector.base === change.selector.head
      ? change.selector.head
      : `${change.selector.base ?? '(absent)'} → ${change.selector.head ?? '(absent)'}`;
  const lines = [`  ${selectors}: ${change.events.join(', ')}`];
  const sides = [
    ['base', change.base],
    ['head', change.head],
  ] as const;
  const declared = (side: PatchSide | null): string =>
    side?.declarations.length
      ? side.declarations
          .map(
            (item) =>
              `${item.source} → ${JSON.stringify(item.reference)}${item.sourceStatus === 'active' ? '' : ` (${item.sourceStatus} source)`}`,
          )
          .join('; ')
      : '(no declaration)';
  for (const [label, side] of sides)
    lines.push(`    ${label} declaration: ${declared(side)}`);
  lines.push(`    patch bytes: ${change.content.status}`);
  for (const [label, side] of sides)
    if (side?.file) lines.push(`      ${label}: ${fileLine(side.file)}`);
  for (const [label, side] of sides)
    lines.push(
      `    ${label} lockfile metadata: ${
        side?.lockfile
          ? `hash ${side.lockfile.hash ?? '(unrecognized)'} (algorithm unconfirmed)${side.lockfile.path ? `, path ${side.lockfile.path}` : ''}`
          : '(no entry)'
      }`,
    );
  for (const [label, side] of sides) {
    if (!side) continue;
    lines.push(
      `    ${label} instances: ${side.instances.length ? '' : '(none linked)'}${side.instancesOmitted ? ` (+${side.instancesOmitted} not listed)` : ''}`.trimEnd(),
    );
    for (const instance of side.instances) {
      lines.push(`      ${instanceLine(instance, detail)}`);
      for (const reason of instance.reasons) lines.push(`        ${reason}`);
    }
  }
  const consumers = sides.flatMap(([label, side]) =>
    (side?.instances ?? []).flatMap((instance) =>
      instance.consumers.map((consumer) => ({ label, instance, consumer })),
    ),
  );
  if (consumers.length || sides.some(([, side]) => side?.instances.length)) {
    lines.push(
      '    Workspace consumers (graph reachability, not runtime usage or proof of application):',
    );
    if (!consumers.length) lines.push('      (none reach a linked instance)');
    for (const { label, instance, consumer } of consumers) {
      const owner =
        consumer.name && consumer.name !== consumer.workspace
          ? ` (${consumer.name})`
          : '';
      lines.push(
        `      ${label}: ${consumer.workspace}${owner}: ${consumer.relation} consumer via ${consumer.section}; link ${consumer.basis}${consumer.uncertain ? (detail ? '; uncertain' : '; uncertain (reasons: explain)') : ''}`,
      );
      if (detail) {
        lines.push(`        instance ${instance.id}`);
        lines.push(`        path ${consumer.path.join(' → ')}`);
        for (const reason of consumer.uncertainty)
          lines.push(`        Uncertainty: ${reason}`);
      }
    }
    for (const [label, side] of sides)
      for (const instance of side?.instances ?? []) {
        if (instance.consumersOmitted)
          lines.push(
            `      ${label}: ${instance.consumersOmitted} more consumers of ${shortHash(instance.id)} not listed`,
          );
        if (instance.consumersNote)
          lines.push(`      ${label}: ${instance.consumersNote}`);
      }
  }
  for (const item of change.observations)
    lines.push(`    Observation: ${item.message}`);
  for (const [label, side] of sides)
    for (const item of side?.notes ?? [])
      lines.push(`    ${label} note: ${item.message}`);
  return lines;
}

function selectorLabel(change: OverrideChange): string {
  const part = (item: { name: string; range: string | null } | null): string =>
    item
      ? `${item.name}${item.range === null ? '' : `@${item.range}`}`
      : '(unreadable)';
  return change.parent
    ? `${part(change.parent)} > ${part(change.target)}`
    : part(change.target);
}

function overrideSideLines(label: string, side: OverrideSide | null): string[] {
  const declaration = side?.declaration;
  const lines = [
    `    ${label} declaration: ${
      declaration
        ? `${declaration.source} → ${JSON.stringify(declaration.value)}${declaration.supported ? ` (${declaration.valueKind})` : ' (outside the supported model)'}${declaration.sourceStatus === 'active' ? '' : ` (${declaration.sourceStatus} source)`}`
        : '(none)'
    }`,
    `    ${label} lockfile record: ${side?.lockfile ? JSON.stringify(side.lockfile.value) : '(none)'}`,
  ];
  if (side && side.consistency !== 'consistent' && side.consistency !== 'not-declared')
    lines.push(`      ${label} consistency: ${side.consistency}`);
  return lines;
}

function overrideEdgeLines(edge: OverrideEdge, detail: boolean): string[] {
  const sample = (edge.head ?? edge.base)!;
  const holder =
    sample.parent.kind === 'workspace'
      ? `${sample.parent.id.slice('workspace:'.length)} [${edge.section}]`
      : sample.parent.id;
  const target = (side: OverrideEdgeSide | null): string =>
    side?.target === undefined || side === null
      ? '(absent)'
      : (side.target ?? '(unresolved)');
  const lines = [
    `      ${holder} ${edge.alias}: ${target(edge.base)} → ${target(edge.head)} (${edge.change}${edge.pairing === 'holder-changed' ? ', dependent changed' : ''})`,
  ];
  if (edge.attributed) {
    lines.push('        Evidence path starts at this edge.');
    for (const reason of edge.reasons) lines.push(`        Uncertainty: ${reason}`);
  } else
    lines.push(
      `        Not attributed: ${edge.reasons.join(' ') || 'see attribution'}`,
    );
  for (const [label, side] of [
    ['base', edge.base],
    ['head', edge.head],
  ] as const) {
    if (!side) continue;
    lines.push(
      `        ${label}: ${side.state}${side.observed ? `; resolution ${side.observed} the value` : ''}${side.declared === null ? '' : `; declared ${side.declared}`}`,
    );
    for (const reason of side.reasons) lines.push(`          ${reason}`);
    for (const consumer of side.consumers) {
      const owner =
        consumer.name && consumer.name !== consumer.workspace
          ? ` (${consumer.name})`
          : '';
      lines.push(
        `          consumer ${label}: ${consumer.workspace}${owner}: ${consumer.relation} via ${consumer.section}${consumer.uncertain ? (detail ? '; uncertain' : '; uncertain (reasons: explain)') : ''}`,
      );
      if (detail) {
        lines.push(`            path ${consumer.path.join(' → ')}`);
        for (const reason of consumer.uncertainty)
          lines.push(`            Uncertainty: ${reason}`);
      }
    }
    if (side.consumersOmitted)
      lines.push(`          ${side.consumersOmitted} more consumers not listed`);
    if (side.consumersNote) lines.push(`          ${side.consumersNote}`);
  }
  return lines;
}

function overrideLines(change: OverrideChange, detail: boolean): string[] {
  const lines = [`  ${selectorLabel(change)}: ${change.events.join(', ')}`];
  lines.push(`    selector: ${change.selector}`);
  lines.push(...overrideSideLines('base', change.base));
  lines.push(...overrideSideLines('head', change.head));
  lines.push(
    `    attribution: ${change.attribution.level}${change.attribution.level === 'complete' ? '' : ' (kept uncertain)'}`,
  );
  for (const reason of change.attribution.reasons)
    lines.push(`      Uncertainty: ${reason}`);
  if (change.edges.length) {
    lines.push(
      '    Affected edges (committed graph; reachability, not proof that the rule caused every update):',
    );
    for (const edge of change.edges) lines.push(...overrideEdgeLines(edge, detail));
  }
  if (change.edgesOmitted)
    lines.push(`    ${change.edgesOmitted} more edges not listed`);
  for (const item of change.observations)
    lines.push(`    Observation: ${item.message}`);
  return lines;
}

export function renderText(report: Report, options: { detail?: boolean } = {}): string {
  const detail = options.detail ?? false;
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
  const patches = report.patches;
  if (
    patches.changes.length ||
    patches.unlinked.base.length ||
    patches.unlinked.head.length ||
    patches.truncated.length
  ) {
    lines.push(
      '',
      'Patch changes (committed bytes and metadata only; nothing is applied or installed):',
    );
    for (const change of patches.changes) lines.push(...patchLines(change, detail));
    if (!patches.changes.length) lines.push('  None.');
    for (const side of ['base', 'head'] as const)
      for (const item of patches.unlinked[side])
        lines.push(
          `  ${side}: patched instance ${shortHash(item.instance)} has no matching selector: ${item.reasons.join(' ')}`,
        );
    for (const message of patches.truncated) lines.push(`  ${message}`);
  }
  const overrides = report.overrides;
  if (overrides.changes.length || overrides.truncated.length) {
    lines.push(
      '',
      'Override changes (declarations, lockfile records, and committed edges only; nothing is resolved or installed):',
    );
    for (const change of overrides.changes)
      lines.push(...overrideLines(change, detail));
    for (const message of overrides.truncated) lines.push(`  ${message}`);
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
        const path = evidencePath(report, evidence);
        if (evidence.via && path[0] === evidence.root)
          path[0] = `override ${evidence.via.selector} (${evidence.via.attribution})`;
        lines.push(`    ${evidence.side}: ${origin}${path.join(' → ')}`);
        if (evidence.via?.reach === 'beyond-edge')
          lines.push(
            '      Reachable only beyond the governed edge: the rule does not show why this package changed.',
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
