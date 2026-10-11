import { z } from 'zod';
import { stable } from '../graph/dependency-graph.js';
import type { Lockfile } from './lockfile-parser.js';
import { satisfiesRegistryRange, supportedRegistryRange } from './registry-range.js';

const entries = z.record(z.string(), z.string());
export type Catalogs = Record<string, Record<string, string>>;
export interface Declaration {
  root: string;
  importer: string;
  section: string;
  name: string;
  specifier: string;
  source: 'manifest' | 'catalog';
  catalog: { name: string; entry: string; file: 'pnpm-workspace.yaml' } | null;
  effectiveRange: string | null;
  observedResolution: string | null;
  catalogSnapshot: { specifier: string; version: string } | null;
  uncertainty: string[];
  shadowedByOptional: boolean;
}

export function catalogName(specifier: string): string | undefined {
  if (!specifier.startsWith('catalog:')) return undefined;
  return specifier.slice('catalog:'.length).trim() || 'default';
}

export function parseCatalogs(workspace: Record<string, unknown>): Catalogs {
  try {
    const named =
      workspace.catalogs === undefined
        ? {}
        : z.record(z.string(), entries).parse(workspace.catalogs);
    const defaultCatalog =
      workspace.catalog === undefined ? undefined : entries.parse(workspace.catalog);
    if (defaultCatalog !== undefined && named.default !== undefined)
      throw new Error(
        'The default catalog is defined in both catalog and catalogs.default.',
      );
    return defaultCatalog === undefined ? named : { ...named, default: defaultCatalog };
  } catch (error) {
    throw new Error(`Invalid pnpm-workspace.yaml catalogs: ${String(error)}`);
  }
}

const snapshots = z.record(
  z.string(),
  z.record(
    z.string(),
    z
      .object({
        specifier: z.string(),
        version: z.string(),
      })
      .passthrough(),
  ),
);
export type CatalogSnapshots = z.infer<typeof snapshots>;
export function parseCatalogSnapshots(lockfile: Lockfile): CatalogSnapshots {
  try {
    return lockfile.catalogs === undefined ? {} : snapshots.parse(lockfile.catalogs);
  } catch (error) {
    throw new Error(`Invalid lockfile catalog snapshots: ${String(error)}`);
  }
}

export function declaration(
  root: string,
  importer: string,
  section: string,
  name: string,
  specifier: string,
  catalogs: Catalogs,
  snapshots: CatalogSnapshots,
  resolved?: { specifier: string; version: string },
  shadowedByOptional = false,
): Declaration {
  const selected = catalogName(specifier);
  const effectiveRange =
    selected === undefined ? specifier : (catalogs[selected]?.[name] ?? null);
  const snapshot = selected === undefined ? undefined : snapshots[selected]?.[name];
  const uncertainty: string[] = [];
  if (
    !shadowedByOptional &&
    section !== 'peerDependencies' &&
    (!resolved || resolved.specifier !== specifier)
  )
    uncertainty.push(`Manifest/lockfile mismatch: ${importer} ${section}.${name}`);
  if (selected !== undefined) {
    if (effectiveRange === null)
      uncertainty.push(`Missing catalog entry: ${selected}.${name}`);
    else if (!supportedRegistryRange(effectiveRange))
      uncertainty.push(
        `Unsupported catalog value: ${selected}.${name}: ${effectiveRange}`,
      );
    if (snapshot && snapshot.specifier !== effectiveRange)
      uncertainty.push(`Catalog snapshot/declaration mismatch: ${selected}.${name}`);
    if (
      snapshot &&
      effectiveRange !== null &&
      supportedRegistryRange(effectiveRange) &&
      satisfiesRegistryRange(effectiveRange, snapshot.version) !== true
    )
      uncertainty.push(
        `Catalog snapshot resolution incompatible with declaration: ${selected}.${name}: ${snapshot.version}`,
      );
    // pnpm catalog snapshots cache the base resolution; importer versions can
    // additionally carry a peer context. Missing snapshots are not assumed invalid.
    if (!shadowedByOptional && section !== 'peerDependencies') {
      if (snapshot && resolved && resolved.version.split('(')[0] !== snapshot.version)
        uncertainty.push(
          `Catalog snapshot/importer resolution mismatch: ${importer} ${section}.${name}`,
        );
      if (
        resolved &&
        effectiveRange !== null &&
        supportedRegistryRange(effectiveRange) &&
        satisfiesRegistryRange(effectiveRange, resolved.version.split('(')[0]!) !== true
      )
        uncertainty.push(
          `Catalog importer resolution incompatible with declaration: ${importer} ${section}.${name}: ${resolved.version}`,
        );
    }
  }
  if (section === 'peerDependencies')
    uncertainty.push('Peer declaration; peer resolution is not modeled.');
  if (shadowedByOptional)
    uncertainty.push(
      'Shadowed by optionalDependencies; no separate importer resolution or traversal root.',
    );
  return {
    root,
    importer,
    section,
    name,
    specifier,
    source: selected === undefined ? 'manifest' : 'catalog',
    catalog:
      selected === undefined
        ? null
        : { name: selected, entry: name, file: 'pnpm-workspace.yaml' },
    effectiveRange,
    observedResolution: resolved?.version ?? null,
    catalogSnapshot: snapshot
      ? { specifier: snapshot.specifier, version: snapshot.version }
      : null,
    uncertainty,
    shadowedByOptional,
  };
}

// Only modeled entries are removed from the global configuration comparison.
// Other fields and unsupported values retain the existing conservative behavior.
export function workspaceResolutionInputs(workspace: Record<string, unknown>): unknown {
  const remaining: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(workspace)) {
    if (key === 'catalog') {
      const unsupported = Object.fromEntries(
        Object.entries(value as Record<string, string>).filter(
          ([, range]) => !supportedRegistryRange(range),
        ),
      );
      if (Object.keys(unsupported).length) remaining[key] = unsupported;
    } else if (key === 'catalogs') {
      const unsupported = Object.fromEntries(
        Object.entries(value as Catalogs)
          .map(
            ([name, entries]) =>
              [
                name,
                Object.fromEntries(
                  Object.entries(entries).filter(
                    ([, range]) => !supportedRegistryRange(range),
                  ),
                ),
              ] as const,
          )
          .filter(([, entries]) => Object.keys(entries).length),
      );
      if (Object.keys(unsupported).length) remaining[key] = unsupported;
    } else remaining[key] = value;
  }
  return remaining;
}

export function unmodeledCatalogSnapshots(
  catalogs: Catalogs,
  snapshots: CatalogSnapshots,
): unknown {
  return Object.fromEntries(
    Object.entries(snapshots)
      .map(
        ([name, entries]) =>
          [
            name,
            Object.fromEntries(
              Object.entries(entries).filter(([entry, snapshot]) => {
                const range = catalogs[name]?.[entry];
                return (
                  range === undefined ||
                  range !== snapshot.specifier ||
                  satisfiesRegistryRange(range, snapshot.version) !== true ||
                  stable(Object.keys(snapshot).sort()) !==
                    stable(['specifier', 'version'])
                );
              }),
            ),
          ] as const,
      )
      .filter(([, entries]) => Object.keys(entries).length),
  );
}
