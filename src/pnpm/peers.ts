import type { DependencyGraph, GraphNode } from '../graph/dependency-graph.js';
import { parseInstance } from './patches.js';

// Peer contexts as committed in snapshot keys. Nothing here resolves a peer, checks a
// range, or reconstructs a provider that the lockfile does not name.

// pnpm replaces a peer suffix longer than 1000 characters with a hash, so real keys stay
// far below these limits. They bound the work on a hostile or damaged lockfile.
export const maxContextLength = 4096;
export const maxContextDepth = 16;
export const maxContextSegments = 256;
export const maxInheritedEdges = 10;

export interface PeerNote {
  code: string;
  message: string;
}
export interface PeerSegment {
  // The text between the parentheses, as written.
  raw: string;
  name: string;
  version: string;
  // The snapshot key that the segment names: name, version, and its own contexts.
  provider: string;
  patchHash: string | null;
  nested: PeerSegment[];
}
export type ContextStatus = 'none' | 'parsed' | 'opaque' | 'malformed' | 'limit';
export interface PeerContext {
  id: string;
  name: string;
  version: string;
  // Name, version, and peer context without patch hashes, as in the patch report.
  identity: string;
  patchHash: string | null;
  // The peer suffix as written, without the instance's own patch_hash group.
  raw: string | null;
  status: ContextStatus;
  segments: PeerSegment[];
  // Groups that are neither `name@version` nor `patch_hash=`, such as a hashed suffix.
  opaque: string[];
  problems: PeerNote[];
}

interface Frame {
  start: number;
  headEnd: number;
  children: Parsed[];
}
type Parsed =
  | { kind: 'peer'; segment: PeerSegment; opaque: boolean }
  | { kind: 'patch'; hash: string }
  | { kind: 'opaque'; raw: string };

const packageName = /^(?:@[^/@\s()]+\/)?[^/@\s()]+$/;

// Reads the nested parenthesized groups of a snapshot key with an explicit stack. The
// structure decides where a segment ends; `@` and `(` are never searched for across it.
export function parsePeerContext(id: string): PeerContext | undefined {
  const instance = parseInstance(id);
  if (!instance) return undefined;
  const context: PeerContext = {
    id,
    name: instance.name,
    version: instance.version,
    identity: instance.identity,
    patchHash: instance.patchHash,
    raw: null,
    status: 'none',
    segments: [],
    opaque: [],
    problems: [],
  };
  const open = id.indexOf('(');
  if (open < 0) return context;
  const suffix = id.slice(open);
  const fail = (status: ContextStatus, code: string, message: string): PeerContext => ({
    ...context,
    // Kept as written: an unreadable suffix has no separable patch_hash group.
    raw: suffix,
    status,
    segments: [],
    problems: [{ code, message }],
  });
  if (suffix.length > maxContextLength)
    return fail(
      'limit',
      'CONTEXT_TOO_LONG',
      `The context has ${suffix.length} characters; at most ${maxContextLength} are read.`,
    );

  const roots: Parsed[] = [];
  const stack: Frame[] = [];
  let groups = 0;
  const malformed = (message: string): PeerContext =>
    fail('malformed', 'MALFORMED_CONTEXT', message);
  for (let index = 0; index < suffix.length; index++) {
    const character = suffix[index];
    const frame = stack.at(-1);
    if (character === '(') {
      if (stack.length >= maxContextDepth)
        return fail(
          'limit',
          'CONTEXT_TOO_DEEP',
          `The context nests deeper than ${maxContextDepth} levels.`,
        );
      if (++groups > maxContextSegments)
        return fail(
          'limit',
          'CONTEXT_TOO_LARGE',
          `The context has more than ${maxContextSegments} groups.`,
        );
      if (frame && frame.headEnd < 0) frame.headEnd = index;
      stack.push({ start: index + 1, headEnd: -1, children: [] });
    } else if (character === ')') {
      const closed = stack.pop();
      if (!closed) return malformed('The package key has unbalanced parentheses.');
      const parsed = group(
        suffix.slice(closed.start, index),
        suffix.slice(closed.start, closed.headEnd < 0 ? index : closed.headEnd),
        closed.children,
      );
      if (typeof parsed === 'string') return malformed(parsed);
      (stack.at(-1)?.children ?? roots).push(parsed);
    } else if (!frame) {
      return malformed('The package key has text outside its parenthesized contexts.');
    } else if (frame.headEnd >= 0) {
      return malformed('A context group has text after a nested group.');
    }
  }
  if (stack.length) return malformed('The package key has unbalanced parentheses.');
  if (roots.filter((item) => item.kind === 'patch').length > 1)
    return malformed('The package key has several patch_hash contexts.');

  for (const item of roots) {
    if (item.kind === 'peer') {
      context.segments.push(item.segment);
      if (item.opaque) context.opaque.push(item.segment.raw);
    } else if (item.kind === 'opaque') context.opaque.push(item.raw);
  }
  const duplicate = duplicateName(context.segments);
  if (duplicate)
    return malformed(`The context names the peer ${duplicate} more than once.`);
  context.raw = instance.peerContext;
  if (context.opaque.length) {
    context.status = 'opaque';
    context.problems.push({
      code: 'OPAQUE_CONTEXT',
      message: `The context has a group that is not name@version: ${context.opaque.map((item) => `(${item})`).join(', ')}. Its providers are not readable from the key.`,
    });
  } else if (context.segments.length) context.status = 'parsed';
  return context;
}

function group(raw: string, head: string, children: Parsed[]): Parsed | string {
  if (head.startsWith('patch_hash=')) {
    if (children.length) return 'A patch_hash group has a nested group.';
    return { kind: 'patch', hash: head.slice('patch_hash='.length) };
  }
  const separator = head.indexOf('@', head.startsWith('@') ? 1 : 0);
  const name = separator <= 0 ? '' : head.slice(0, separator);
  const version = separator <= 0 ? '' : head.slice(separator + 1);
  if (!packageName.test(name) || !version || /\s/.test(version)) {
    if (children.length) return 'A group without a package name has a nested group.';
    return { kind: 'opaque', raw };
  }
  const patches = children.filter((item) => item.kind === 'patch');
  if (patches.length > 1) return 'A context group has several patch_hash contexts.';
  const nested = children.flatMap((item) =>
    item.kind === 'peer' ? [item.segment] : [],
  );
  const duplicate = duplicateName(nested);
  if (duplicate) return `A nested context names the peer ${duplicate} more than once.`;
  return {
    kind: 'peer',
    segment: {
      raw,
      name,
      version,
      provider: raw,
      patchHash: patches[0]?.kind === 'patch' ? patches[0].hash : null,
      nested,
    },
    opaque: children.some(
      (item) => item.kind === 'opaque' || (item.kind === 'peer' && item.opaque),
    ),
  };
}

function duplicateName(segments: PeerSegment[]): string | undefined {
  const seen = new Set<string>();
  for (const segment of segments) {
    if (seen.has(segment.name)) return segment.name;
    seen.add(segment.name);
  }
  return undefined;
}

// `direct`: the package declares the peer, the key names a provider, and a snapshot
// edge of that name points at the same instance.
// `transitive`: the package does not declare the peer; a dependency edge leads to an
// instance whose own context names the same provider.
// `unconfirmed`: the key names a provider that metadata and edges do not support.
// `conflicting`: the declared peer's edge points at another instance than the key.
// `unbound`: declared, but neither the key nor an edge names a provider.
// `own-dependency`: declared and resolved by an edge that the key does not carry, so
// it is an ordinary dependency edge and not part of the instance's context.
export type BindingKind =
  | 'direct'
  | 'transitive'
  | 'unconfirmed'
  | 'conflicting'
  | 'unbound'
  | 'own-dependency';
export interface EdgeEvidence {
  holder: string;
  section: string;
  name: string;
  target: string;
}
export interface PeerBinding {
  peer: string;
  // The provider named by the key, or by the edge for `own-dependency`.
  provider: string | null;
  providerVersion: string | null;
  // The provider's own contexts, as written inside the segment.
  nestedContext: string | null;
  kind: BindingKind;
  // `packages` entry and range of the peer declaration, when the package declares it.
  declaration: { package: string; range: string; optional: boolean } | null;
  // The snapshot edge of the peer's name on this instance.
  edge: EdgeEvidence | null;
  // Dependency edges whose target carries the same provider in its own context.
  inheritedThrough: EdgeEvidence[];
  inheritedOmitted: number;
  // Whether the snapshot lists the peer under transitivePeerDependencies.
  listedTransitive: boolean;
  notes: PeerNote[];
}
export interface InstancePeers {
  context: PeerContext;
  metadata: 'present' | 'missing';
  snapshot: 'present' | 'missing';
  bindings: PeerBinding[];
  transitivePeerDependencies: string[];
}

interface Metadata {
  package?: {
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: unknown;
  };
  snapshot?: { transitivePeerDependencies?: string[] };
}

function optionalPeer(meta: unknown, name: string): boolean {
  if (meta === null || typeof meta !== 'object') return false;
  const entry = (meta as Record<string, unknown>)[name];
  return (
    entry !== null &&
    typeof entry === 'object' &&
    (entry as { optional?: unknown }).optional === true
  );
}

function carries(segments: PeerSegment[], provider: string): boolean {
  // Iterative: the parser already bounded depth and size.
  const queue = [...segments];
  for (let index = 0; index < queue.length; index++) {
    const segment = queue[index]!;
    if (segment.provider === provider) return true;
    queue.push(...segment.nested);
  }
  return false;
}

export class PeerIndex {
  private contexts = new Map<string, PeerContext | undefined>();
  private instances = new Map<string, InstancePeers | undefined>();

  constructor(readonly graph: DependencyGraph) {}

  context(id: string): PeerContext | undefined {
    if (!this.contexts.has(id)) this.contexts.set(id, parsePeerContext(id));
    return this.contexts.get(id);
  }

  instance(id: string): InstancePeers | undefined {
    if (!this.instances.has(id)) this.instances.set(id, this.build(id));
    return this.instances.get(id);
  }

  private hasSnapshot(id: string): boolean {
    const node = this.graph.nodes.get(id);
    return (
      node?.kind === 'package' && (node.metadata as Metadata)?.snapshot !== undefined
    );
  }

  private build(id: string): InstancePeers | undefined {
    const node = this.graph.nodes.get(id);
    const context = this.context(id);
    if (!context || node?.kind !== 'package') return undefined;
    const metadata = node.metadata as Metadata;
    const declared = metadata.package?.peerDependencies ?? {};
    const listed = metadata.snapshot?.transitivePeerDependencies ?? [];
    const base = `${context.name}@${context.version}`;
    const result: InstancePeers = {
      context,
      metadata: metadata.package ? 'present' : 'missing',
      snapshot: metadata.snapshot ? 'present' : 'missing',
      bindings: [],
      transitivePeerDependencies: [...listed].sort(),
    };
    // An unreadable context gives no bindings: a partial reading would look complete.
    if (context.status !== 'none' && context.status !== 'parsed') return result;

    const declaration = (peer: string): PeerBinding['declaration'] =>
      Object.hasOwn(declared, peer)
        ? {
            package: base,
            range: declared[peer]!,
            optional: optionalPeer(metadata.package?.peerDependenciesMeta, peer),
          }
        : null;
    const edgesNamed = (peer: string): EdgeEvidence[] =>
      node.edges
        .filter((edge) => edge.name === peer)
        .map((edge) => ({
          holder: id,
          section: edge.kind,
          name: edge.name,
          target: edge.target,
        }))
        .sort((a, b) => a.target.localeCompare(b.target));

    for (const segment of context.segments) {
      const notes: PeerNote[] = [];
      const note = (code: string, message: string): void => {
        notes.push({ code, message });
      };
      const declares = declaration(segment.name);
      const edges = edgesNamed(segment.name);
      const matching = edges.find((edge) => edge.target === segment.provider);
      const inherited = this.inherited(node, segment);
      const providerPresent = this.hasSnapshot(segment.provider);
      let kind: BindingKind;
      if (!metadata.package) {
        kind = 'unconfirmed';
        note(
          'METADATA_MISSING',
          `The lockfile has no packages entry for ${base}, so the peer declaration cannot be read.`,
        );
      } else if (declares) {
        if (matching) kind = 'direct';
        else if (edges.length) {
          kind = 'conflicting';
          note(
            'SUFFIX_EDGE_MISMATCH',
            `The key names ${segment.provider}, but the ${segment.name} edge points at ${edges.map((edge) => edge.target).join(', ')}.`,
          );
        } else {
          kind = 'unconfirmed';
          note(
            'NO_PROVIDER_EDGE',
            `The key names ${segment.provider}, but the snapshot has no ${segment.name} edge.`,
          );
        }
      } else if (inherited.length) {
        kind = 'transitive';
        if (!listed.includes(segment.name))
          note(
            'NOT_LISTED_TRANSITIVE',
            `The snapshot does not list ${segment.name} under transitivePeerDependencies.`,
          );
      } else {
        kind = 'unconfirmed';
        note(
          'NOT_DECLARED_NOT_INHERITED',
          `${base} does not declare the peer ${segment.name}, and no dependency edge leads to an instance whose context names ${segment.provider}.`,
        );
      }
      if (!providerPresent) {
        // Nothing can be compared with a provider that the lockfile does not hold.
        kind = 'unconfirmed';
        notes.length = 0;
        note(
          'PROVIDER_SNAPSHOT_MISSING',
          `The lockfile has no snapshot for ${segment.provider}.`,
        );
      }
      result.bindings.push({
        peer: segment.name,
        provider: segment.provider,
        providerVersion: segment.version,
        nestedContext: segment.nested.length
          ? segment.provider.slice(segment.provider.indexOf('('))
          : null,
        kind,
        declaration: declares,
        edge: matching ?? (edges.length === 1 ? edges[0]! : null),
        inheritedThrough: inherited.slice(0, maxInheritedEdges),
        inheritedOmitted: Math.max(0, inherited.length - maxInheritedEdges),
        listedTransitive: listed.includes(segment.name),
        notes,
      });
    }
    const named = new Set(context.segments.map((segment) => segment.name));
    for (const peer of Object.keys(declared).sort()) {
      if (named.has(peer)) continue;
      const edges = edgesNamed(peer);
      const single = edges.length === 1 ? edges[0]! : null;
      const target = single ? this.context(single.target) : undefined;
      result.bindings.push({
        peer,
        provider: single?.target ?? null,
        providerVersion: target?.version ?? null,
        nestedContext: target?.raw ?? null,
        kind: edges.length ? 'own-dependency' : 'unbound',
        declaration: declaration(peer),
        edge: single,
        inheritedThrough: [],
        inheritedOmitted: 0,
        listedTransitive: listed.includes(peer),
        notes:
          edges.length > 1
            ? [
                {
                  code: 'SEVERAL_EDGES',
                  message: `Several ${peer} edges exist: ${edges.map((edge) => edge.target).join(', ')}.`,
                },
              ]
            : [],
      });
    }
    result.bindings.sort((a, b) => a.peer.localeCompare(b.peer));
    return result;
  }

  private inherited(node: GraphNode, segment: PeerSegment): EdgeEvidence[] {
    const found: EdgeEvidence[] = [];
    for (const edge of node.edges) {
      if (!this.hasSnapshot(edge.target)) continue;
      const target = this.context(edge.target);
      if (target?.status !== 'parsed' || !carries(target.segments, segment.provider))
        continue;
      found.push({
        holder: node.id,
        section: edge.kind,
        name: edge.name,
        target: edge.target,
      });
    }
    return found.sort(
      (a, b) => a.name.localeCompare(b.name) || a.target.localeCompare(b.target),
    );
  }
}
