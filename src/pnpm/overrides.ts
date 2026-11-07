import type { DependencyGraph } from '../graph/dependency-graph.js';
import type { Manifest } from '../manifests/package-json.js';
import type { Declaration } from './catalogs.js';
import type { Lockfile } from './lockfile-parser.js';
import type { PackageManagerEvidence, SourceStatus } from './patches.js';
import { parseInstance, parsePackageManager } from './patches.js';
import {
  rangesIntersect,
  satisfiesRegistryRange,
  supportedRegistryRange,
} from './registry-range.js';

// pnpm overrides as committed. Nothing here resolves a version, queries a registry,
// or replays pnpm: a rule is matched to dependency edges that the committed graph
// already contains, using the matching code of pnpm 9.0.0, 10.34.9, 11.28.9, and 12.5.1
// (hooks/read-package-hook createVersionsOverrider, config/parse-overrides, and the
// Rust equivalents in pnpm 12).

export type OverrideSource =
  | 'pnpm-workspace.yaml'
  | 'package.json#pnpm'
  | 'package.json#resolutions';
export type OverrideValueKind = 'exact' | 'range';
export interface SelectorPart {
  name: string;
  // Absent when the selector names the package only.
  range: string | null;
}
export interface OverrideNote {
  code: string;
  message: string;
}
export interface OverrideRule {
  selector: string;
  source: OverrideSource;
  sourceStatus: SourceStatus;
  value: unknown;
  // The selector has a `parent>child` form, even when its parent half cannot be read.
  scoped: boolean;
  parent: SelectorPart | null;
  target: SelectorPart | null;
  valueKind: OverrideValueKind | null;
  // Why the rule is outside the supported model. Empty for a supported rule.
  problems: string[];
  // A source with higher precedence declares the same selector.
  shadowed: boolean;
}
export interface OverrideState {
  packageManager: PackageManagerEvidence;
  rules: OverrideRule[];
  // Rules of sources the declared pnpm reads, after precedence.
  effective: Map<string, OverrideRule>;
  // Rules of sources LockCone cannot confirm; they might govern any matching edge.
  unverified: OverrideRule[];
  // The top-level `overrides` map of the lockfile.
  lockfile: Map<string, unknown>;
  notes: OverrideNote[];
  // False when the configuration cannot be interpreted as one rule set, so no rule is
  // attributed and the conservative global comparison stays in force.
  usable: boolean;
  // Entries that the override report interprets. Only these leave the global
  // configuration comparison.
  modeled: {
    workspace: Set<string>;
    manifestPnpm: Set<string>;
    manifestResolutions: Set<string>;
    lockfile: Set<string>;
  };
}

const delimiter = /[^ |@]>/;
const packageName = /^(?:@[A-Za-z0-9][A-Za-z0-9._-]*\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/;
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePart(text: string): {
  part: SelectorPart | null;
  problem: string | null;
} {
  const at = text.indexOf('@', 1);
  const name = at < 0 ? text : text.slice(0, at);
  const range = at < 0 ? null : text.slice(at + 1);
  if (!packageName.test(name))
    return {
      part: null,
      problem: `"${text}" does not start with a supported package name.`,
    };
  if (range === null) return { part: { name, range: null }, problem: null };
  if (range === '')
    return {
      part: { name, range: null },
      problem: `"${text}" has an empty range, which selects a convergence override.`,
    };
  if (!supportedRegistryRange(range))
    return {
      part: { name, range: null },
      problem: `The range "${range}" is not a supported stable registry range.`,
    };
  return { part: { name, range }, problem: null };
}

// The same split as pnpm: `parent>child`, where the `>` is not part of a range.
export function parseOverrideSelector(selector: string): {
  parent: SelectorPart | null;
  target: SelectorPart | null;
  problems: string[];
} {
  const problems: string[] = [];
  const text = selector.trim();
  if (text !== selector)
    problems.push(
      'The selector has surrounding whitespace, which pnpm versions treat differently.',
    );
  const found = text.search(delimiter);
  if (found < 0) {
    const target = parsePart(text);
    if (target.problem) problems.push(target.problem);
    return { parent: null, target: target.part, problems };
  }
  const parent = parsePart(text.slice(0, found + 1));
  const target = parsePart(text.slice(found + 2));
  if (parent.problem) problems.push(parent.problem);
  if (target.problem) problems.push(target.problem);
  return { parent: parent.part, target: target.part, problems };
}

function classifyValue(value: unknown): {
  kind: OverrideValueKind | null;
  problem: string | null;
} {
  if (typeof value !== 'string')
    return { kind: null, problem: 'The value is not a string.' };
  if (exactVersion.test(value)) return { kind: 'exact', problem: null };
  if (supportedRegistryRange(value)) return { kind: 'range', problem: null };
  return {
    kind: null,
    problem: `The value "${value}" is not an exact stable version or a supported registry range.`,
  };
}

export function isSupported(rule: OverrideRule): boolean {
  return rule.problems.length === 0 && rule.target !== null && rule.valueKind !== null;
}

// Verified in the sources of pnpm 9.0.0, 10.34.9, 11.28.9, and 12.5.1. pnpm 9 and 10
// read `pnpm.overrides` and the Yarn-compatible `resolutions` of the root manifest; 11
// and 12 read only pnpm-workspace.yaml. pnpm 10.34.9 also reads the workspace file,
// but LockCone treats it like the patch settings: unverified before pnpm 11.
function sourceStatus(source: OverrideSource, packageManager: PackageManagerEvidence) {
  const { major, declared } = packageManager;
  if (major === null)
    return {
      status: 'unverified' as const,
      note: `packageManager ${declared === null ? 'is not declared' : `(${declared}) is not a pnpm version`}; the configuration source cannot be confirmed.`,
    };
  if (source === 'pnpm-workspace.yaml')
    return major >= 11
      ? { status: 'active' as const, note: null }
      : {
          status: 'unverified' as const,
          note: `LockCone verified pnpm-workspace.yaml overrides only for pnpm 11 or later; packageManager declares ${declared}.`,
        };
  return major <= 10
    ? { status: 'active' as const, note: null }
    : {
        status: 'inactive' as const,
        note: `pnpm ${major} does not read ${source === 'package.json#pnpm' ? 'the package.json pnpm field' : 'resolutions'}; packageManager declares ${declared}.`,
      };
}

function makeRule(
  selector: string,
  value: unknown,
  source: OverrideSource,
  sourceStatusValue: SourceStatus,
): OverrideRule {
  const parsed = parseOverrideSelector(selector);
  const kind = classifyValue(value);
  return {
    selector,
    source,
    sourceStatus: sourceStatusValue,
    value,
    scoped: delimiter.test(selector.trim()),
    parent: parsed.parent,
    target: parsed.target,
    valueKind: kind.kind,
    problems: [...parsed.problems, ...(kind.problem ? [kind.problem] : [])],
    shadowed: false,
  };
}

function mentionsOverrides(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value))
    return value.some((item) => mentionsOverrides(item, depth + 1));
  return Object.entries(value).some(
    ([key, item]) => key === 'overrides' || mentionsOverrides(item, depth + 1),
  );
}

export function buildOverrideState(input: {
  lockfile: Lockfile;
  workspace: Record<string, unknown>;
  manifests: Map<string, Manifest>;
}): OverrideState {
  const { lockfile, workspace, manifests } = input;
  const root = manifests.get('.');
  const packageManager = parsePackageManager(root);
  const notes: OverrideNote[] = [];
  let usable = true;
  const rules: OverrideRule[] = [];

  const sources: [OverrideSource, unknown][] = [
    ['pnpm-workspace.yaml', workspace.overrides],
    [
      'package.json#pnpm',
      isRecord(root?.pnpm)
        ? (root.pnpm as Record<string, unknown>).overrides
        : undefined,
    ],
    [
      'package.json#resolutions',
      (root as Record<string, unknown> | undefined)?.resolutions,
    ],
  ];
  for (const [source, value] of sources) {
    if (value === undefined || value === null) continue;
    if (!isRecord(value)) {
      notes.push({
        code: 'UNRECOGNIZED_DECLARATIONS',
        message: `${source} overrides is not a mapping.`,
      });
      usable = false;
      continue;
    }
    const { status, note } = sourceStatus(source, packageManager);
    if (note && Object.keys(value).length)
      notes.push({
        code:
          status === 'inactive'
            ? 'INACTIVE_DECLARATION_SOURCE'
            : 'UNVERIFIED_DECLARATION_SOURCE',
        message: `${source}: ${note}`,
      });
    for (const [selector, entry] of Object.entries(value))
      rules.push(makeRule(selector, entry, source, status));
  }

  // pnpm 9 and 10 merge `{...resolutions, ...pnpm.overrides}`: pnpm.overrides wins.
  const higher = new Set(
    rules
      .filter(
        (rule) => rule.source === 'package.json#pnpm' && rule.sourceStatus === 'active',
      )
      .map((rule) => rule.selector),
  );
  for (const rule of rules)
    if (
      rule.source === 'package.json#resolutions' &&
      rule.sourceStatus === 'active' &&
      higher.has(rule.selector)
    )
      rule.shadowed = true;

  const effective = new Map<string, OverrideRule>();
  for (const rule of rules)
    if (rule.sourceStatus === 'active' && !rule.shadowed)
      effective.set(rule.selector, rule);
  const unverified = rules.filter((rule) => rule.sourceStatus === 'unverified');
  if (unverified.length) {
    usable = false;
    notes.push({
      code: 'UNVERIFIED_SOURCE_BLOCKS_ATTRIBUTION',
      message:
        'A configuration source that LockCone cannot confirm declares overrides, so it may replace or extend the confirmed rules. No override is attributed.',
    });
  }
  if (mentionsOverrides(workspace.packageConfigs)) {
    usable = false;
    notes.push({
      code: 'PACKAGE_CONFIGS_OVERRIDES',
      message:
        'pnpm-workspace.yaml packageConfigs declares overrides, which replace the workspace-wide map for some projects. They are not modeled, so no override is attributed.',
    });
  }

  const recorded = new Map<string, unknown>();
  let lockfileReadable = true;
  const raw = lockfile.overrides;
  if (raw !== undefined && raw !== null) {
    if (!isRecord(raw)) {
      lockfileReadable = false;
      notes.push({
        code: 'UNRECOGNIZED_LOCKFILE_METADATA',
        message: 'The lockfile overrides value is not a mapping.',
      });
    } else
      for (const [selector, entry] of Object.entries(raw))
        recorded.set(selector, entry);
  }

  const modeled: OverrideState['modeled'] = {
    workspace: new Set(),
    manifestPnpm: new Set(),
    manifestResolutions: new Set(),
    lockfile: new Set(),
  };
  if (usable) {
    for (const rule of rules) {
      if (rule.sourceStatus !== 'active') continue;
      if (!rule.shadowed && !isSupported(rule)) continue;
      const bucket =
        rule.source === 'pnpm-workspace.yaml'
          ? modeled.workspace
          : rule.source === 'package.json#pnpm'
            ? modeled.manifestPnpm
            : modeled.manifestResolutions;
      bucket.add(rule.selector);
      if (!rule.shadowed && lockfileReadable) modeled.lockfile.add(rule.selector);
    }
  }
  return {
    packageManager,
    rules,
    effective,
    unverified,
    lockfile: recorded,
    notes,
    usable,
    modeled,
  };
}

// ---------------------------------------------------------------------------
// Dependency edges and the rules that govern them.

export interface EdgeParent {
  id: string;
  kind: 'package' | 'workspace';
  name: string | null;
  version: string | null;
}
export interface EdgeRef {
  // Identifies the edge on one side: the node that holds it and the dependency alias.
  key: string;
  // The graph node whose edge list contains the edge: a package, or the dependency
  // entry of an importer.
  holder: string;
  parent: EdgeParent;
  importer: string | null;
  alias: string;
  section: string;
  // The specifier the importer manifest declares. Unknown for package dependencies,
  // because a lockfile records the resolved reference but not the declared range.
  declared: string | null;
  target: string | null;
  peer: boolean;
}

function parentVersion(version: string): string | null {
  return version === '' ? null : version;
}

export function overrideEdges(input: {
  graph: DependencyGraph;
  declarations: Map<string, Declaration>;
  manifests: Map<string, Manifest>;
}): EdgeRef[] {
  const { graph, declarations, manifests } = input;
  const edges: EdgeRef[] = [];
  for (const declaration of declarations.values()) {
    if (declaration.section === 'peerDependencies' || declaration.shadowedByOptional)
      continue;
    const holder = graph.nodes.get(declaration.root);
    if (!holder) continue;
    const manifest = manifests.get(declaration.importer);
    edges.push({
      key: JSON.stringify([declaration.root, declaration.name]),
      holder: declaration.root,
      parent: {
        id: `workspace:${declaration.importer}`,
        kind: 'workspace',
        name: manifest?.name ?? null,
        version: manifest?.version ?? null,
      },
      importer: declaration.importer,
      alias: declaration.name,
      section: declaration.section,
      // A catalog reference is resolved later than the override hook can be proven
      // to read it, so the declared text is not used.
      declared: declaration.source === 'catalog' ? null : declaration.specifier,
      target: holder.edges[0]?.target ?? null,
      peer: false,
    });
  }
  for (const node of graph.nodes.values()) {
    const metadata = node.metadata as {
      snapshot?: unknown;
      package?: { peerDependencies?: Record<string, string> };
    } | null;
    if (node.kind !== 'package' || metadata?.snapshot === undefined) continue;
    const instance = parseInstance(node.id);
    if (!instance) continue;
    for (const edge of node.edges)
      edges.push({
        key: JSON.stringify([node.id, edge.name]),
        holder: node.id,
        parent: {
          id: node.id,
          kind: 'package',
          name: instance.name,
          version: parentVersion(instance.version),
        },
        importer: null,
        alias: edge.name,
        section: edge.kind,
        declared: null,
        target: edge.target,
        peer: Object.hasOwn(metadata?.package?.peerDependencies ?? {}, edge.name),
      });
  }
  return edges.sort((a, b) => a.key.localeCompare(b.key));
}

export type Match = 'yes' | 'no' | 'maybe';

// pnpm: `range === declared`, or both parse as semver ranges and intersect. A range
// that is not a registry range at all (a protocol such as `workspace:`) never does.
function declaredIntersects(range: string, declared: string): boolean | undefined {
  if (range === declared) return true;
  const result = rangesIntersect(range, declared);
  if (result !== undefined) return result;
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(declared) ? false : undefined;
}

export function matchRule(rule: OverrideRule, edge: EdgeRef): Match {
  const target = rule.target;
  if (!target) return 'maybe';
  if (target.name !== edge.alias) return 'no';
  if (rule.scoped && !rule.parent) return 'maybe';
  let result: Match = 'yes';
  if (rule.parent) {
    if (edge.parent.name === null || rule.parent.name !== edge.parent.name) return 'no';
    if (rule.parent.range !== null) {
      const fits =
        edge.parent.version === null
          ? undefined
          : satisfiesRegistryRange(rule.parent.range, edge.parent.version);
      if (fits === false) return 'no';
      if (fits === undefined) result = 'maybe';
    }
  }
  if (target.range !== null) {
    // The range restricts the declaration, not the resolved version.
    const fits =
      edge.declared === null
        ? undefined
        : declaredIntersects(target.range, edge.declared);
    if (fits === false) return 'no';
    if (fits === undefined) result = 'maybe';
  }
  return result;
}

export type Governance =
  | { status: 'unmatched' }
  | { status: 'governed'; rule: OverrideRule }
  | { status: 'ambiguous'; rules: OverrideRule[] }
  | { status: 'undecidable'; rules: OverrideRule[]; reasons: string[] };

// pnpm picks the most specific matching parent-scoped rule, and a generic rule only
// when no parent-scoped rule matches. Several rules of one tier are not resolved here.
export function governingRule(
  edge: EdgeRef,
  state: Pick<OverrideState, 'effective' | 'unverified'>,
): Governance {
  const tiers = [
    { yes: [] as OverrideRule[], uncertain: [] as OverrideRule[] },
    { yes: [] as OverrideRule[], uncertain: [] as OverrideRule[] },
  ];
  const reasons = new Set<string>();
  for (const rule of [...state.effective.values(), ...state.unverified]) {
    const match = matchRule(rule, edge);
    if (match === 'no') continue;
    const tier = tiers[rule.scoped ? 0 : 1]!;
    if (!isSupported(rule) || rule.sourceStatus !== 'active') {
      tier.uncertain.push(rule);
      reasons.add(`The rule ${rule.selector} is outside the supported model.`);
    } else if (match === 'maybe') {
      tier.uncertain.push(rule);
      reasons.add(
        rule.target?.range !== null && edge.declared === null
          ? `The declared range of ${edge.alias} is not recorded in the lockfile, so the selector range of ${rule.selector} cannot be tested.`
          : `The rule ${rule.selector} cannot be decided from supported syntax.`,
      );
    } else tier.yes.push(rule);
  }
  for (const tier of tiers) {
    if (tier.uncertain.length)
      return {
        status: 'undecidable',
        rules: [...tier.yes, ...tier.uncertain],
        reasons: [...reasons],
      };
    if (tier.yes.length === 1) return { status: 'governed', rule: tier.yes[0]! };
    if (tier.yes.length > 1) return { status: 'ambiguous', rules: tier.yes };
  }
  return { status: 'unmatched' };
}

export type Observation = 'satisfies' | 'violates' | 'undecidable';

// Whether the committed resolution of an edge fits a rule's value. An exact value must
// equal the version; a range must contain it.
export function observeValue(
  rule: OverrideRule,
  alias: string,
  target: string | null,
  graph: DependencyGraph,
): Observation {
  if (target === null || typeof rule.value !== 'string') return 'undecidable';
  const node = graph.nodes.get(target);
  if (!node) return 'undecidable';
  // The value replaces the declaration, so the edge must resolve to the package of
  // the alias itself rather than to a workspace link or a differently named package.
  if (node.kind !== 'package') return 'violates';
  const instance = parseInstance(node.id);
  if (!instance) return 'undecidable';
  if (instance.name !== alias) return 'violates';
  if (rule.valueKind === 'exact')
    return instance.version === rule.value ? 'satisfies' : 'violates';
  const fits = satisfiesRegistryRange(rule.value, instance.version);
  return fits === undefined ? 'undecidable' : fits ? 'satisfies' : 'violates';
}
