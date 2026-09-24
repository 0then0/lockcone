import { dependencyId, stable, workspaceId } from '../graph/dependency-graph.js';
import { sections } from '../manifests/package-json.js';
import type { PnpmState } from '../pnpm/dependency-graph.js';

export interface ManifestChange {
  root: string;
  manifest: string;
  section: string;
  name: string;
  before: string | null;
  after: string | null;
}

export function manifestChanges(base: PnpmState, head: PnpmState): ManifestChange[] {
  const changes: ManifestChange[] = [];
  for (const path of [
    ...new Set([...base.manifests.keys(), ...head.manifests.keys()]),
  ].sort()) {
    const before = base.manifests.get(path);
    const after = head.manifests.get(path);
    const manifest = path === '.' ? 'package.json' : `${path}/package.json`;
    if (
      before?.name !== after?.name ||
      before?.version !== after?.version ||
      !before ||
      !after
    ) {
      changes.push({
        root: workspaceId(path),
        manifest,
        section: 'workspace',
        name: after?.name ?? before?.name ?? path,
        before: before ? `${before.name ?? path}@${before.version ?? ''}` : null,
        after: after ? `${after.name ?? path}@${after.version ?? ''}` : null,
      });
    }
    for (const section of sections) {
      const names = new Set([
        ...Object.keys(before?.[section] ?? {}),
        ...Object.keys(after?.[section] ?? {}),
      ]);
      for (const name of [...names].sort()) {
        const oldValue = before?.[section][name] ?? null;
        const newValue = after?.[section][name] ?? null;
        if (oldValue !== newValue)
          changes.push({
            root: dependencyId(path, section, name),
            manifest,
            section,
            name,
            before: oldValue,
            after: newValue,
          });
      }
    }
    if (
      stable(before?.peerDependencies ?? {}) !== stable(after?.peerDependencies ?? {})
    ) {
      changes.push({
        root: workspaceId(path),
        manifest,
        section: 'peerDependencies',
        name: after?.name ?? before?.name ?? path,
        before: stable(before?.peerDependencies ?? {}),
        after: stable(after?.peerDependencies ?? {}),
      });
    }
  }
  return changes;
}
