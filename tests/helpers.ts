import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import type { RepositoryState } from '../src/git/repository.js';

export function fixture(name: string, side: string): RepositoryState {
  const root = fileURLToPath(new URL(`./fixtures/${name}/${side}/`, import.meta.url));
  const files = new Map<string, string>();
  function walk(dir: string): void {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, item.name);
      if (item.isDirectory()) walk(path);
      else
        files.set(
          relative(root, path).split(sep).join('/'),
          readFileSync(path, 'utf8'),
        );
    }
  }
  walk(root);
  return { revision: side, files };
}

export function state(
  manifest: unknown,
  importers: unknown,
  snapshots: Record<string, unknown>,
  extra = {},
): RepositoryState {
  const packages = Object.fromEntries(
    Object.keys(snapshots).map((key) => [key.split('(')[0]!, {}]),
  );
  return {
    revision: 'fixture',
    files: new Map([
      ['package.json', JSON.stringify(manifest)],
      [
        'pnpm-lock.yaml',
        stringify({ lockfileVersion: '9.0', importers, packages, snapshots, ...extra }),
      ],
    ]),
  };
}
