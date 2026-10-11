import { stable } from '../graph/dependency-graph.js';
import type { Declaration } from '../pnpm/catalogs.js';
import type { PnpmState } from '../pnpm/dependency-graph.js';
import { supportedRegistryRange } from '../pnpm/registry-range.js';

export interface DeclarationChange {
  root: string;
  change: 'added' | 'removed' | 'effective-range' | 'origin';
  before: Declaration | null;
  after: Declaration | null;
  traversal: boolean;
}
export interface CatalogChange {
  catalog: string;
  entry: string;
  before: string | null;
  after: string | null;
  affectedDeclarations: { base: string[]; head: string[] };
  uncertainty: string[];
}

export function declarationChanges(
  base: PnpmState,
  head: PnpmState,
): DeclarationChange[] {
  const changes: DeclarationChange[] = [];
  for (const root of [
    ...new Set([...base.declarations.keys(), ...head.declarations.keys()]),
  ].sort()) {
    const before = base.declarations.get(root) ?? null;
    const after = head.declarations.get(root) ?? null;
    // Observed resolutions and snapshot cache changes are not declared intent.
    if (
      before &&
      after &&
      before.specifier === after.specifier &&
      before.effectiveRange === after.effectiveRange &&
      stable(before.catalog) === stable(after.catalog)
    )
      continue;
    const catalogRelated = before?.source === 'catalog' || after?.source === 'catalog';
    const originOnly =
      before !== null &&
      after !== null &&
      catalogRelated &&
      before.effectiveRange !== null &&
      before.effectiveRange === after.effectiveRange;
    const change = !before
      ? 'added'
      : !after
        ? 'removed'
        : originOnly
          ? 'origin'
          : 'effective-range';
    changes.push({
      root,
      change,
      before,
      after,
      traversal:
        !originOnly &&
        (after ?? before)!.section !== 'peerDependencies' &&
        [before, after].some((item) => item !== null && !item.shadowedByOptional),
    });
  }
  return changes;
}

export function catalogChanges(base: PnpmState, head: PnpmState): CatalogChange[] {
  const changes: CatalogChange[] = [];
  for (const catalog of [
    ...new Set([...Object.keys(base.catalogs), ...Object.keys(head.catalogs)]),
  ].sort()) {
    for (const entry of [
      ...new Set([
        ...Object.keys(base.catalogs[catalog] ?? {}),
        ...Object.keys(head.catalogs[catalog] ?? {}),
      ]),
    ].sort()) {
      const before = base.catalogs[catalog]?.[entry] ?? null;
      const after = head.catalogs[catalog]?.[entry] ?? null;
      if (before === after) continue;
      const consumers = (state: PnpmState): string[] =>
        [...state.declarations.values()]
          .filter(
            (item) => item.catalog?.name === catalog && item.catalog.entry === entry,
          )
          .map((item) => item.root)
          .sort();
      changes.push({
        catalog,
        entry,
        before,
        after,
        affectedDeclarations: { base: consumers(base), head: consumers(head) },
        uncertainty: [before, after]
          .filter(
            (range): range is string =>
              range !== null && !supportedRegistryRange(range),
          )
          .map((range) => `Unsupported catalog value: ${catalog}.${entry}: ${range}`),
      });
    }
  }
  return changes;
}
