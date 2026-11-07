import type { GraphNode } from '../graph/dependency-graph.js';
import { stable } from '../graph/dependency-graph.js';
import type { Visit } from '../graph/traversal.js';
import type { PnpmState } from '../pnpm/dependency-graph.js';
import type {
  EdgeParent,
  EdgeRef,
  Observation,
  OverrideNote,
  OverrideRule,
  OverrideSource,
  OverrideValueKind,
  SelectorPart,
} from '../pnpm/overrides.js';
import {
  governingRule,
  isSupported,
  matchRule,
  observeValue,
  overrideEdges,
} from '../pnpm/overrides.js';
import type { PackageManagerEvidence, SourceStatus } from '../pnpm/patches.js';
import { parseInstance } from '../pnpm/patches.js';
import type { WorkspaceConsumer } from './consumers.js';
import { ConsumerIndex, maxConsumersPerStart, maxStartsPerSide } from './consumers.js';

export const maxEdgesPerRule = 100;

export type OverrideEvent =
  | 'declaration-added'
  | 'declaration-removed'
  | 'declaration-changed'
  | 'source-changed'
  | 'lockfile-record-added'
  | 'lockfile-record-removed'
  | 'lockfile-record-changed';
export type Consistency =
  | 'consistent'
  | 'record-differs'
  | 'record-missing'
  | 'record-without-declaration'
  | 'unsupported-declaration'
  | 'not-declared';
export type EdgeState =
  | 'governed'
  | 'shadowed'
  | 'ambiguous'
  | 'undecidable'
  | 'rule-absent'
  | 'peer';

export interface DeclarationEvidence {
  source: OverrideSource;
  sourceStatus: SourceStatus;
  value: unknown;
  valueKind: OverrideValueKind | null;
  supported: boolean;
  problems: string[];
}
export interface EdgeCounts {
  candidates: number;
  governed: number;
  shadowed: number;
  ambiguous: number;
  undecidable: number;
  peer: number;
  violating: number;
}
export interface OverrideSide {
  declaration: DeclarationEvidence | null;
  // The value recorded under this selector in the lockfile, when there is a record.
  lockfile: { value: unknown } | null;
  consistency: Consistency;
  edges: EdgeCounts;
}
export interface OverrideEdgeSide {
  holder: string;
  parent: EdgeParent;
  declared: string | null;
  target: string | null;
  targetVersion: string | null;
  state: EdgeState;
  observed: Observation | null;
  reasons: string[];
  consumers: WorkspaceConsumer[];
  consumersOmitted: number;
  consumersNote: string | null;
}
export interface OverrideEdge {
  alias: string;
  section: string;
  change: 'target-changed' | 'added' | 'removed';
  // `same-holder`: the instance that holds the edge exists on both sides. A holder that
  // changed too has other possible causes, so its edge is listed but not attributed.
  pairing: 'same-holder' | 'holder-changed' | null;
  // Whether an evidence path starts at this edge. `reasons` explains why it does not,
  // or why the path is uncertain.
  attributed: boolean;
  reasons: string[];
  base: OverrideEdgeSide | null;
  head: OverrideEdgeSide | null;
}
export interface OverrideChange {
  id: string;
  selector: string;
  parent: SelectorPart | null;
  target: SelectorPart | null;
  events: OverrideEvent[];
  base: OverrideSide | null;
  head: OverrideSide | null;
  // `complete`: declaration and lockfile record agree on both sides, every matching
  // edge was decided, and every governed edge resolves inside the value. Only then can
  // evidence paths raise a group's confidence. `root` names the evidence paths.
  attribution: { level: 'complete' | 'incomplete'; root: string; reasons: string[] };
  edges: OverrideEdge[];
  edgesOmitted: number;
  observations: OverrideNote[];
}
export interface OverrideReport {
  reportVersion: 1;
  pnpm: { base: PackageManagerEvidence; head: PackageManagerEvidence };
  notes: { base: OverrideNote[]; head: OverrideNote[] };
  changes: OverrideChange[];
  limits: {
    edgesPerRule: number;
    consumersPerEdge: number;
    edgeTraversalsPerSide: number;
  };
  truncated: string[];
}
export interface OverrideAnalysis {
  report: OverrideReport;
  warnings: string[];
  // Evidence paths that start at an affected edge, merged into the cone visits.
  visits: { base: Map<string, Visit[]>; head: Map<string, Visit[]> };
  // Per evidence root, the nodes that the governed edge itself changes: the dependent
  // that holds it and the package it resolves to. Other visited nodes lie beyond it.
  edgeNodes: { base: Map<string, Set<string>>; head: Map<string, Set<string>> };
}

export const overrideRoot = (selector: string): string =>
  `override:${JSON.stringify([selector])}`;

const sides = ['base', 'head'] as const;
type Side = (typeof sides)[number];

interface Candidate {
  edge: EdgeRef;
  state: EdgeState;
  observed: Observation | null;
  reasons: string[];
}

function sameValue(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function withoutAlias(node: GraphNode, alias: string): string {
  const metadata = node.metadata as { snapshot?: unknown } | null;
  let reduced: unknown = node.metadata;
  if (
    node.kind === 'package' &&
    metadata?.snapshot !== null &&
    typeof metadata?.snapshot === 'object'
  ) {
    const snapshot: Record<string, unknown> = { ...metadata.snapshot };
    for (const key of ['dependencies', 'optionalDependencies']) {
      const edges = snapshot[key];
      if (edges !== null && typeof edges === 'object')
        snapshot[key] = Object.fromEntries(
          Object.entries(edges).filter(([name]) => name !== alias),
        );
    }
    reduced = { ...metadata, snapshot };
  }
  return stable({
    name: node.name,
    // A dependency entry's version is its resolution, which is the edge itself.
    version: node.kind === 'dependency' ? null : node.version,
    metadata: reduced,
    edges: node.edges
      .filter((edge) => edge.name !== alias)
      .sort((a, b) => stable(a).localeCompare(stable(b))),
  });
}

class SideAnalysis {
  readonly edges: EdgeRef[];
  private readonly byAlias = new Map<string, EdgeRef[]>();
  private readonly governance = new Map<string, ReturnType<typeof governingRule>>();
  readonly consumers: ConsumerIndex;

  constructor(readonly state: PnpmState) {
    this.edges = overrideEdges({
      graph: state.graph,
      declarations: state.declarations,
      manifests: state.manifests,
    });
    for (const edge of this.edges) {
      const list = this.byAlias.get(edge.alias) ?? [];
      list.push(edge);
      this.byAlias.set(edge.alias, list);
    }
    this.consumers = new ConsumerIndex(state.graph);
  }

  governing(edge: EdgeRef): ReturnType<typeof governingRule> {
    let result = this.governance.get(edge.key);
    if (!result) {
      result = governingRule(edge, this.state.overrides);
      this.governance.set(edge.key, result);
    }
    return result;
  }

  candidates(definition: OverrideRule, selector: string): Candidate[] {
    const rule = this.state.overrides.effective.get(selector);
    const found: Candidate[] = [];
    for (const edge of this.byAlias.get(definition.target?.name ?? '') ?? []) {
      if (matchRule(definition, edge) === 'no') continue;
      if (!rule) {
        found.push({ edge, state: 'rule-absent', observed: null, reasons: [] });
        continue;
      }
      const verdict = this.governing(edge);
      if (verdict.status === 'governed' && verdict.rule.selector === selector) {
        found.push({
          edge,
          state: edge.peer ? 'peer' : 'governed',
          observed: edge.peer
            ? null
            : observeValue(rule, edge.alias, edge.target, this.state.graph),
          reasons: [],
        });
      } else if (verdict.status === 'governed') {
        found.push({
          edge,
          state: 'shadowed',
          observed: null,
          reasons: [`The rule ${verdict.rule.selector} governs this edge instead.`],
        });
      } else if (verdict.status === 'ambiguous') {
        found.push({
          edge,
          state: verdict.rules.some((item) => item.selector === selector)
            ? 'ambiguous'
            : 'shadowed',
          observed: null,
          reasons: [
            `Rules of equal priority match: ${verdict.rules.map((item) => item.selector).join(', ')}.`,
          ],
        });
      } else if (verdict.status === 'undecidable') {
        found.push({
          edge,
          state: 'undecidable',
          observed: null,
          reasons: verdict.reasons,
        });
      }
    }
    return found;
  }
}

function describeDeclaration(
  rule: OverrideRule | undefined,
): DeclarationEvidence | null {
  if (!rule) return null;
  return {
    source: rule.source,
    sourceStatus: rule.sourceStatus,
    value: rule.value,
    valueKind: rule.valueKind,
    supported: isSupported(rule),
    problems: rule.problems,
  };
}

function counts(candidates: Candidate[]): EdgeCounts {
  const total: EdgeCounts = {
    candidates: candidates.length,
    governed: 0,
    shadowed: 0,
    ambiguous: 0,
    undecidable: 0,
    peer: 0,
    violating: 0,
  };
  for (const item of candidates) {
    if (item.state === 'governed') {
      total.governed++;
      if (item.observed === 'violates') total.violating++;
    } else if (item.state === 'shadowed') total.shadowed++;
    else if (item.state === 'ambiguous') total.ambiguous++;
    else if (item.state === 'undecidable') total.undecidable++;
    else if (item.state === 'peer') total.peer++;
  }
  return total;
}

interface Pair {
  base: Candidate | null;
  head: Candidate | null;
  pairing: OverrideEdge['pairing'];
}

function pairCandidates(base: Candidate[], head: Candidate[]): Pair[] {
  const pairs: Pair[] = [];
  const headByKey = new Map(head.map((item) => [item.edge.key, item]));
  const matched = new Set<string>();
  const baseOnly: Candidate[] = [];
  for (const item of base) {
    const other = headByKey.get(item.edge.key);
    if (other) {
      pairs.push({ base: item, head: other, pairing: 'same-holder' });
      matched.add(item.edge.key);
    } else baseOnly.push(item);
  }
  const headOnly = head.filter((item) => !matched.has(item.edge.key));
  // A holder whose version changed is still the same dependent. Pair it only when the
  // match is unique; otherwise report an addition and a removal.
  const group = (item: Candidate): string =>
    JSON.stringify([
      item.edge.parent.kind,
      item.edge.importer ?? item.edge.parent.name ?? item.edge.parent.id,
      item.edge.alias,
      item.edge.section,
    ]);
  const count = (items: Candidate[], key: string): number =>
    items.filter((item) => group(item) === key).length;
  const taken = new Set<Candidate>();
  for (const item of baseOnly) {
    const key = group(item);
    if (count(baseOnly, key) !== 1 || count(headOnly, key) !== 1) continue;
    const other = headOnly.find((entry) => group(entry) === key)!;
    pairs.push({ base: item, head: other, pairing: 'holder-changed' });
    taken.add(item);
    taken.add(other);
  }
  for (const item of baseOnly)
    if (!taken.has(item)) pairs.push({ base: item, head: null, pairing: null });
  for (const item of headOnly)
    if (!taken.has(item)) pairs.push({ base: null, head: item, pairing: null });
  return pairs;
}

function targetVersion(target: string | null): string | null {
  return target === null ? null : (parseInstance(target)?.version ?? null);
}

export function compareOverrides(base: PnpmState, head: PnpmState): OverrideAnalysis {
  const states = { base, head };
  // Edge lists cost a pass over the graph, so they are built only for a changed rule.
  const built: Partial<Record<Side, SideAnalysis>> = {};
  const analysis = (side: Side): SideAnalysis => {
    built[side] ??= new SideAnalysis(states[side]);
    return built[side];
  };
  const warnings = new Set<string>();
  const truncated: string[] = [];
  const changes: OverrideChange[] = [];
  const visits = {
    base: new Map<string, Visit[]>(),
    head: new Map<string, Visit[]>(),
  };
  const edgeNodes = {
    base: new Map<string, Set<string>>(),
    head: new Map<string, Set<string>>(),
  };

  const selectors = new Set<string>();
  if (base.overrides.usable && head.overrides.usable) {
    for (const side of sides)
      for (const [selector, rule] of states[side].overrides.effective)
        if (isSupported(rule) || states[side].overrides.modeled.lockfile.has(selector))
          selectors.add(selector);
    for (const side of sides)
      for (const selector of states[side].overrides.modeled.lockfile)
        selectors.add(selector);
  }

  for (const selector of [...selectors].sort()) {
    const declared = {
      base: base.overrides.effective.get(selector),
      head: head.overrides.effective.get(selector),
    };
    const recorded = {
      base: base.overrides.lockfile.has(selector)
        ? base.overrides.lockfile.get(selector)
        : undefined,
      head: head.overrides.lockfile.has(selector)
        ? head.overrides.lockfile.get(selector)
        : undefined,
    };
    const hasRecord = {
      base: base.overrides.lockfile.has(selector),
      head: head.overrides.lockfile.has(selector),
    };
    const events: OverrideEvent[] = [];
    if (!declared.base && declared.head) events.push('declaration-added');
    else if (declared.base && !declared.head) events.push('declaration-removed');
    else if (declared.base && declared.head) {
      if (!sameValue(declared.base.value, declared.head.value))
        events.push('declaration-changed');
      if (declared.base.source !== declared.head.source) events.push('source-changed');
    }
    if (!hasRecord.base && hasRecord.head) events.push('lockfile-record-added');
    else if (hasRecord.base && !hasRecord.head) events.push('lockfile-record-removed');
    else if (
      hasRecord.base &&
      hasRecord.head &&
      !sameValue(recorded.base, recorded.head)
    )
      events.push('lockfile-record-changed');
    if (!events.length) continue;

    const definition = declared.head ?? declared.base;
    const reasons: string[] = [];
    const observations: OverrideNote[] = [];
    const note = (code: string, message: string): void => {
      observations.push({ code, message });
    };
    const warn = (side: Side, message: string): void => {
      warnings.add(`Override ${selector} (${side}): ${message}`);
      reasons.push(`${side}: ${message}`);
    };

    const found: Record<Side, Candidate[]> = { base: [], head: [] };
    if (definition?.target) {
      for (const side of sides)
        found[side] = analysis(side).candidates(definition, selector);
    }
    const sideReport: Record<Side, OverrideSide | null> = { base: null, head: null };
    for (const side of sides) {
      const rule = declared[side];
      const value = recorded[side];
      const present = hasRecord[side];
      let consistency: Consistency = 'not-declared';
      if (rule && !isSupported(rule)) {
        consistency = 'unsupported-declaration';
        warn(
          side,
          `the declaration is outside the supported model: ${rule.problems.join(' ')}`,
        );
      } else if (rule) {
        if (!present) {
          consistency = 'record-missing';
          warn(side, 'the lockfile has no record of this override.');
        } else if (value !== rule.value) {
          consistency = 'record-differs';
          warn(
            side,
            `the lockfile records ${JSON.stringify(value)}, but the declaration says ${JSON.stringify(rule.value)}.`,
          );
        } else consistency = 'consistent';
        const total = counts(found[side]);
        if (total.violating) {
          const example = found[side].find((item) => item.observed === 'violates')!;
          warn(
            side,
            `${total.violating} governed edge(s) resolve outside the value ${JSON.stringify(rule.value)}, for example ${example.edge.holder} -> ${example.edge.alias} resolves to ${example.edge.target ?? '(nothing)'}.`,
          );
        }
        const undecided = found[side].filter(
          (item) => item.state === 'governed' && item.observed === 'undecidable',
        );
        if (undecided.length)
          warn(
            side,
            `${undecided.length} governed edge(s) cannot be compared with the value, for example ${undecided[0]!.edge.holder} -> ${undecided[0]!.edge.alias}.`,
          );
        if (total.ambiguous)
          warn(side, `${total.ambiguous} edge(s) match rules of equal priority.`);
        if (total.undecidable) {
          const sample = found[side].find((item) => item.state === 'undecidable')!;
          warn(
            side,
            `${total.undecidable} edge(s) cannot be matched to this rule. ${sample.reasons[0] ?? ''}`.trim(),
          );
        }
      } else if (present) {
        consistency = 'record-without-declaration';
        warn(
          side,
          'the lockfile records this override, but no confirmed source declares it.',
        );
      }
      sideReport[side] =
        rule || present
          ? {
              declaration: describeDeclaration(rule),
              lockfile: present ? { value } : null,
              consistency,
              edges: counts(found[side]),
            }
          : null;
    }

    if (
      events.includes('lockfile-record-changed') &&
      !events.some((item) => item.startsWith('declaration-')) &&
      declared.base &&
      declared.head
    )
      note(
        'RECORD_CHANGED_DECLARATION_UNCHANGED',
        'Only the lockfile record changed; the declared value is identical on both sides.',
      );
    if (
      events.includes('declaration-changed') &&
      !events.includes('lockfile-record-changed')
    )
      note(
        'DECLARATION_CHANGED_RECORD_UNCHANGED',
        'The declared value changed, but the lockfile record did not.',
      );

    const pairs = pairCandidates(found.base, found.head).sort((a, b) =>
      (a.base ?? a.head)!.edge.key.localeCompare((b.base ?? b.head)!.edge.key),
    );
    const edges: OverrideEdge[] = [];
    let unchanged = 0;
    let peers = 0;
    // Edges whose evidence paths start at this rule, per side.
    const attributed: Record<Side, { holder: string; target: string }[]> = {
      base: [],
      head: [],
    };
    for (const pair of pairs) {
      const sample = pair.base ?? pair.head!;
      const sameTarget =
        pair.base !== null &&
        pair.head !== null &&
        pair.base.edge.target === pair.head.edge.target;
      if (sameTarget) {
        unchanged++;
        continue;
      }
      if (pair.base?.edge.peer || pair.head?.edge.peer) {
        peers++;
        continue;
      }
      const change: OverrideEdge['change'] =
        pair.base && pair.head ? 'target-changed' : pair.base ? 'removed' : 'added';
      const why: string[] = [];
      const caveats: string[] = [];
      let eligible = pair.pairing === 'same-holder' && change === 'target-changed';
      if (pair.pairing === 'holder-changed')
        why.push(
          'The dependent changed too, so the edge may have changed for another reason.',
        );
      else if (change !== 'target-changed')
        why.push('The edge exists on one side only.');
      for (const side of sides) {
        const candidate = pair[side];
        if (!candidate) continue;
        if (declared[side]) {
          if (candidate.state !== 'governed') {
            eligible = false;
            why.push(`${side}: the edge is ${candidate.state}.`);
          } else if (candidate.observed !== 'satisfies') {
            // Still attributed, but the rule is incomplete: the side-level warning
            // above marks every path from it uncertain.
            caveats.push(
              `${side}: the resolution does not fit the value (${candidate.observed}).`,
            );
          }
        } else if (candidate.state !== 'rule-absent') {
          eligible = false;
          why.push(`${side}: the edge is ${candidate.state}.`);
        } else if (analysis(side).governing(candidate.edge).status !== 'unmatched') {
          eligible = false;
          why.push(`${side}: another rule may govern the edge.`);
        }
      }
      if (eligible) {
        const holderBase = base.graph.nodes.get(pair.base!.edge.holder);
        const holderHead = head.graph.nodes.get(pair.head!.edge.holder);
        const targetBase = base.graph.nodes.get(pair.base!.edge.target ?? '');
        const targetHead = head.graph.nodes.get(pair.head!.edge.target ?? '');
        if (!holderBase || !holderHead || !targetBase || !targetHead) {
          eligible = false;
          why.push('An endpoint of the edge is missing from the graph.');
        } else if (
          withoutAlias(holderBase, sample.edge.alias) !==
          withoutAlias(holderHead, sample.edge.alias)
        ) {
          eligible = false;
          why.push('The dependent differs in more than this edge.');
        } else if (targetBase.kind !== 'package' || targetHead.kind !== 'package') {
          eligible = false;
          why.push('The edge does not resolve to a registry package on both sides.');
        }
      }
      if (eligible) {
        attributed.base.push({
          holder: pair.base!.edge.holder,
          target: pair.base!.edge.target!,
        });
        attributed.head.push({
          holder: pair.head!.edge.holder,
          target: pair.head!.edge.target!,
        });
      }
      const side = (
        candidate: Candidate | null,
        which: Side,
      ): OverrideEdgeSide | null => {
        if (!candidate) return null;
        const edge = candidate.edge;
        const result = analysis(which).consumers.find(
          edge.importer === null ? edge.parent.id : `workspace:${edge.importer}`,
          {
            tail: edge.target === null ? [] : [edge.target],
            ...(edge.importer === null ? {} : { declarer: edge.holder }),
          },
        );
        return {
          holder: edge.holder,
          parent: edge.parent,
          declared: edge.declared,
          target: edge.target,
          targetVersion: targetVersion(edge.target),
          state: candidate.state,
          observed: candidate.observed,
          reasons: candidate.reasons,
          consumers: result.consumers,
          consumersOmitted: result.omitted,
          consumersNote: result.note,
        };
      };
      edges.push({
        alias: sample.edge.alias,
        section: sample.edge.section,
        change,
        pairing: pair.pairing,
        attributed: eligible,
        reasons: eligible ? caveats : [...why, ...caveats],
        base: edges.length < maxEdgesPerRule ? side(pair.base, 'base') : null,
        head: edges.length < maxEdgesPerRule ? side(pair.head, 'head') : null,
      });
    }
    // Entries past the limit keep their summary but not their consumers.
    const shown = edges.slice(0, maxEdgesPerRule);
    const omitted = edges.length - shown.length;
    if (omitted)
      truncated.push(
        `${selector}: ${omitted} changed edge(s) were not listed after the limit of ${maxEdgesPerRule}.`,
      );
    if (unchanged)
      note(
        'UNCHANGED_EDGES',
        `${unchanged} governed edge(s) resolve to the same package on both sides.`,
      );
    if (peers)
      note(
        'PEER_EDGES_NOT_MODELED',
        `${peers} changed edge(s) come from peer dependencies; peer resolution is not modeled and they are not attributed.`,
      );
    const listed = shown.length;
    if (
      !listed &&
      (declared.base || declared.head) &&
      !pairs.some((pair) => pair.base || pair.head)
    )
      note('NO_MATCHING_EDGES', 'No edge in the committed graphs matches this rule.');
    else if (!listed && !peers)
      note(
        'NO_OBSERVED_GRAPH_CHANGE',
        'No matching edge resolves to a different package on the two sides.',
      );

    const complete = reasons.length === 0 && Boolean(declared.base || declared.head);
    const root = overrideRoot(selector);
    changes.push({
      id: JSON.stringify([selector]),
      selector,
      parent: definition?.parent ?? null,
      target: definition?.target ?? null,
      events,
      base: sideReport.base,
      head: sideReport.head,
      attribution: { level: complete ? 'complete' : 'incomplete', root, reasons },
      edges: shown,
      edgesOmitted: omitted,
      observations,
    });

    for (const side of sides) {
      const list = attributed[side];
      if (!list.length) continue;
      mergeVisits(visits[side], states[side], root, list, !complete);
      edgeNodes[side].set(
        root,
        new Set(list.flatMap((entry) => [entry.holder, entry.target])),
      );
    }
  }

  return {
    report: {
      reportVersion: 1,
      pnpm: {
        base: base.overrides.packageManager,
        head: head.overrides.packageManager,
      },
      notes: { base: base.overrides.notes, head: head.overrides.notes },
      changes,
      limits: {
        edgesPerRule: maxEdgesPerRule,
        consumersPerEdge: maxConsumersPerStart,
        edgeTraversalsPerSide: maxStartsPerSide,
      },
      truncated: [
        ...truncated,
        ...sides.flatMap((side) => {
          const skipped = built[side]?.consumers.omitted ?? 0;
          return skipped
            ? [
                `${side}: consumers of ${skipped} edge(s) were not traversed after the limit of ${maxStartsPerSide}.`,
              ]
            : [];
        }),
      ],
    },
    warnings: [...warnings].sort(),
    visits,
    edgeNodes,
  };
}

// The rule is evidence for the dependent that holds the edge and for the package the
// edge now (or before) resolved to. Everything further down is reachable from that
// package, but a matching rule does not show why those packages changed, so their
// paths are marked uncertain: shown, but never `explained`.
function mergeVisits(
  into: Map<string, Visit[]>,
  state: PnpmState,
  root: string,
  edges: { holder: string; target: string }[],
  incomplete: boolean,
): void {
  const local = new Map<string, Visit>();
  local.set(root, { root, parent: null, uncertain: false });
  const queue: string[] = [];
  const consider = (id: string, parent: string, uncertain: boolean): boolean => {
    const prior = local.get(id);
    if (prior && (!prior.uncertain || uncertain)) return false;
    local.set(id, { root, parent, uncertain });
    return true;
  };
  for (const { holder, target } of edges) {
    const holderNode = state.graph.nodes.get(holder)!;
    const targetNode = state.graph.nodes.get(target)!;
    const holderUncertain = incomplete || holderNode.uncertain;
    consider(holder, root, holderUncertain);
    if (consider(target, holder, local.get(holder)!.uncertain || targetNode.uncertain))
      queue.push(target);
  }
  for (let position = 0; position < queue.length; position++) {
    const id = queue[position]!;
    for (const edge of [...state.graph.nodes.get(id)!.edges].sort((a, b) =>
      a.target.localeCompare(b.target),
    )) {
      if (!state.graph.nodes.has(edge.target)) continue;
      if (consider(edge.target, id, true)) queue.push(edge.target);
    }
  }
  for (const [id, visit] of local) {
    const list = into.get(id) ?? [];
    list.push(visit);
    into.set(id, list);
  }
}
