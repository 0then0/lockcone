import type { PnpmState } from '../pnpm/dependency-graph.js';
import { isHttpUrl, packageIdentity } from '../pnpm/dependency-graph.js';
import { parseSelector } from '../pnpm/patches.js';
import type { ConsumerResult } from './consumers.js';
import { ConsumerIndex } from './consumers.js';

interface TarballIntegritySide {
  instances: (ConsumerResult & { id: string })[];
  coverage: 'recorded' | 'partial';
  notes: string[];
}

export interface TarballIntegrityLoss {
  name: string;
  packageKey: string;
  tarball: string;
  integrity: { before: string; after: null };
  base: TarballIntegritySide;
  head: TarballIntegritySide;
}

export interface TarballIntegrityReport {
  reportVersion: 1;
  changes: TarballIntegrityLoss[];
}

function tarballResolution(
  value: unknown,
): (Record<string, unknown> & { tarball: string }) | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const resolution = value as Record<string, unknown>;
  if (
    resolution.type === undefined &&
    (resolution.gitHosted === undefined || resolution.gitHosted === false) &&
    isHttpUrl(resolution.tarball)
  )
    return resolution as Record<string, unknown> & { tarball: string };
  return undefined;
}

const digestBytes = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };

function isIntegrity(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]{1,88}={0,2})$/.exec(value);
  if (!match) return false;
  const digest = match[2]!;
  const bytes = Buffer.from(digest, 'base64');
  return (
    bytes.length === digestBytes[match[1] as keyof typeof digestBytes] &&
    bytes.toString('base64') === digest
  );
}

function consumerLookup(state: PnpmState): (key: string) => TarballIntegritySide {
  const snapshots = new Map<string, string[]>();
  for (const node of state.graph.nodes.values()) {
    if (node.packageKey === undefined) continue;
    const ids = snapshots.get(node.packageKey) ?? [];
    ids.push(node.id);
    snapshots.set(node.packageKey, ids);
  }
  const index = new ConsumerIndex(state.graph);
  return (key) => {
    const instances = (snapshots.get(key) ?? []).sort().map((id) => ({
      id,
      ...index.find(id),
    }));
    const notes: string[] = [];
    if (!instances.length) notes.push('No snapshot is linked to this package entry.');
    if (state.graph.incomplete)
      notes.push('The dependency graph is incomplete. See analysis limitations.');
    return {
      instances,
      coverage:
        notes.length || instances.some((instance) => instance.omitted || instance.note)
          ? 'partial'
          : 'recorded',
      notes,
    };
  };
}

export function compareTarballIntegrity(
  base: PnpmState,
  head: PnpmState,
): TarballIntegrityReport {
  const changes: TarballIntegrityLoss[] = [];
  let baseConsumers: ReturnType<typeof consumerLookup> | undefined;
  let headConsumers: ReturnType<typeof consumerLookup> | undefined;

  for (const packageKey of Object.keys(base.lockfile.packages).sort()) {
    if (!Object.hasOwn(head.lockfile.packages, packageKey)) continue;
    const before = tarballResolution(base.lockfile.packages[packageKey]!.resolution);
    const after = tarballResolution(head.lockfile.packages[packageKey]!.resolution);
    if (
      !before ||
      !after ||
      before.tarball !== after.tarball ||
      !isIntegrity(before.integrity) ||
      Object.hasOwn(after, 'integrity')
    )
      continue;
    const identity = packageIdentity(packageKey);
    if (!identity || !/^(?:@[^/@\s()]+\/)?[^/@\s()]+$/.test(identity.name)) continue;
    if (!isHttpUrl(identity.version) && parseSelector(packageKey).kind !== 'exact')
      continue;

    baseConsumers ??= consumerLookup(base);
    headConsumers ??= consumerLookup(head);
    changes.push({
      name: identity.name,
      packageKey,
      tarball: before.tarball,
      integrity: { before: before.integrity, after: null },
      base: baseConsumers(packageKey),
      head: headConsumers(packageKey),
    });
  }
  return { reportVersion: 1, changes };
}
