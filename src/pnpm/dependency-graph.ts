import { posix } from 'node:path';
import type { RepositoryState } from '../git/repository.js';
import type { DependencyGraph, GraphNode } from '../graph/dependency-graph.js';
import { dependencyId, workspaceId } from '../graph/dependency-graph.js';
import type { Manifest } from '../manifests/package-json.js';
import { parseManifest, sections } from '../manifests/package-json.js';
import type { Lockfile } from './lockfile-parser.js';
import { parseLockfile, parseWorkspace } from './lockfile-parser.js';

export interface PnpmState {
  revision: string;
  graph: DependencyGraph;
  manifests: Map<string, Manifest>;
  lockfile: Lockfile;
  workspace: Record<string, unknown>;
  files: Map<string, string>;
}

function identity(
  key: string,
): { name: string; version: string; base: string } | undefined {
  const base = key.split('(')[0]!;
  const separator = base.indexOf('@', base.startsWith('@') ? 1 : 0);
  if (separator <= 0) return undefined;
  return {
    name: base.slice(0, separator),
    version: key.slice(separator + 1),
    base,
  };
}

function compileWorkspacePattern(pattern: string): RegExp | undefined {
  const normalized = posix.normalize(pattern.replace(/\/$/, ''));
  if (normalized !== pattern.replace(/\/$/, '') || /[\\?()[\]|]/.test(pattern)) {
    return undefined;
  }
  let source = '^';
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index++;
        if (pattern[index + 1] === '/') {
          source += '(?:.*/)?';
          index++;
        } else source += '.*';
      } else source += '[^/]*';
    } else if (character === '{') {
      const end = pattern.indexOf('}', index + 1);
      if (end < 0) return undefined;
      const choices = pattern.slice(index + 1, end).split(',');
      if (
        choices.length < 2 ||
        choices.some((choice) => !choice || /[{}*]/.test(choice))
      )
        return undefined;
      source += `(?:${choices.map((choice) => choice.replace(/[.+^$\\]/g, '\\$&')).join('|')})`;
      index = end;
    } else source += character.replace(/[.+^$\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}

function workspaceMembers(
  repository: RepositoryState,
  workspace: Record<string, unknown>,
  importerPaths: Set<string>,
  warn: (message: string) => void,
): Set<string> {
  const value = workspace.packages;
  if (value === undefined) return new Set(importerPaths);
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    warn('Invalid pnpm-workspace.yaml packages; workspace membership is unknown.');
    return new Set(importerPaths);
  }
  const include: RegExp[] = [];
  const exclude: RegExp[] = [];
  for (const entry of value as string[]) {
    const negative = entry.startsWith('!');
    const pattern = compileWorkspacePattern(negative ? entry.slice(1) : entry);
    if (!pattern) {
      warn(`Unsupported workspace glob: ${entry}`);
      continue;
    }
    (negative ? exclude : include).push(pattern);
  }
  const members = new Set(importerPaths);
  if (include.length) {
    for (const path of repository.files.keys()) {
      if (!path.endsWith('/package.json')) continue;
      const directory = path.slice(0, -'/package.json'.length);
      if (
        include.some((pattern) => pattern.test(directory)) &&
        !exclude.some((pattern) => pattern.test(directory))
      ) {
        members.add(directory);
      }
    }
  }
  return members;
}

export function buildPnpmState(repository: RepositoryState): PnpmState {
  const source = repository.files.get('pnpm-lock.yaml');
  if (source === undefined) throw new Error('Missing pnpm-lock.yaml.');
  const lockfile = parseLockfile(source);
  const workspace = parseWorkspace(repository.files.get('pnpm-workspace.yaml'));
  const graph: DependencyGraph = { nodes: new Map(), warnings: [] };
  const manifests = new Map<string, Manifest>();
  const warn = (message: string): void => {
    graph.warnings.push(message);
  };

  const importerPaths = new Set(Object.keys(lockfile.importers));
  const members = workspaceMembers(repository, workspace, importerPaths, warn);
  for (const path of [...members].sort()) {
    if (
      posix.isAbsolute(path) ||
      posix.normalize(path) !== path ||
      path.startsWith('..')
    ) {
      throw new Error(`Unsupported importer path: ${path}`);
    }
    const manifestPath = path === '.' ? 'package.json' : `${path}/package.json`;
    const contents = repository.files.get(manifestPath);
    if (contents === undefined)
      throw new Error(`Missing manifest for importer: ${manifestPath}`);
    const manifest = parseManifest(contents, manifestPath);
    manifests.set(path, manifest);
    if (!importerPaths.has(path)) {
      warn(`Manifest/lockfile mismatch: ${manifestPath} has no importer.`);
    }
    graph.nodes.set(workspaceId(path), {
      id: workspaceId(path),
      kind: 'workspace',
      name: manifest.name ?? path,
      version: manifest.version ?? '',
      scope: path,
      edges: [],
      metadata: {
        name: manifest.name,
        version: manifest.version,
        peers: manifest.peerDependencies,
      },
      uncertain: Object.keys(manifest.peerDependencies).length > 0,
    });
  }
  if (!manifests.has('.'))
    throw new Error('The lockfile must contain the root importer ".".');

  for (const [key, snapshot] of Object.entries(lockfile.snapshots)) {
    const parsed = identity(key);
    if (!parsed) {
      warn(`Unsupported package identity: ${key}`);
      continue;
    }
    const metadata = lockfile.packages[parsed.base];
    if (!metadata) warn(`Missing package metadata: ${parsed.base}`);
    if (!/^\d+\.\d+\.\d+(?:[-+][^()]*)?$/.test(parsed.version.split('(')[0]!)) {
      warn(`Unsupported package resolution: ${key}`);
    }
    graph.nodes.set(key, {
      id: key,
      kind: 'package',
      name: parsed.name,
      version: parsed.version,
      scope: '',
      edges: [],
      metadata: { package: metadata, snapshot },
      uncertain:
        key.includes('(') ||
        Object.keys(metadata?.peerDependencies ?? {}).length > 0 ||
        snapshot.transitivePeerDependencies.length > 0,
    });
  }
  const snapshotBases = new Set(
    Object.keys(lockfile.snapshots).map((key) => identity(key)?.base),
  );
  for (const key of Object.keys(lockfile.packages)) {
    if (!snapshotBases.has(key)) {
      // Retain orphan metadata changes instead of silently dropping them.
      const parsed = identity(key);
      if (parsed)
        graph.nodes.set(key, {
          id: key,
          kind: 'package',
          name: parsed.name,
          version: parsed.version,
          scope: '',
          edges: [],
          metadata: { package: lockfile.packages[key] },
          uncertain: true,
        });
      warn(`Package metadata has no snapshot: ${key}`);
    }
  }

  function resolve(name: string, reference: string, importerPath?: string): string {
    if (reference.startsWith('link:') && importerPath !== undefined) {
      const path = posix.normalize(posix.join(importerPath, reference.slice(5)));
      const target = workspaceId(path);
      if (graph.nodes.has(target)) return target;
    } else {
      // Alias resolutions contain the real package name; never match by name alone.
      for (const candidate of [
        `${name}@${reference}`,
        reference.replace(/^npm:/, ''),
      ]) {
        if (graph.nodes.has(candidate)) return candidate;
      }
    }
    warn(
      `Unresolved dependency: ${importerPath ?? 'snapshot'}: ${name} -> ${reference}`,
    );
    return `unresolved:${JSON.stringify([importerPath, name, reference])}`;
  }

  for (const [key, snapshot] of Object.entries(lockfile.snapshots)) {
    const node = graph.nodes.get(key);
    if (!node) continue;
    for (const section of ['dependencies', 'optionalDependencies'] as const) {
      for (const [name, reference] of Object.entries(snapshot[section])) {
        node.edges.push({
          name,
          kind: section,
          target: resolve(name, reference),
        });
      }
    }
  }
  const importerEntries = [...Object.entries(lockfile.importers)];
  for (const path of manifests.keys()) {
    if (!importerPaths.has(path))
      importerEntries.push([path, {} as Lockfile['importers'][string]]);
  }
  for (const [path, importer] of importerEntries) {
    const manifest = manifests.get(path)!;
    const workspaceNode = graph.nodes.get(workspaceId(path))!;
    for (const section of sections) {
      const names = new Set([
        ...Object.keys(manifest[section]),
        ...Object.keys(importer[section] ?? {}),
      ]);
      for (const name of [...names].sort()) {
        const declared = manifest[section][name];
        const resolved = importer[section]?.[name];
        // pnpm puts dependencies also declared optional only in optionalDependencies.
        if (
          !resolved &&
          section === 'dependencies' &&
          manifest.optionalDependencies[name]
        )
          continue;
        if (!resolved || declared !== resolved.specifier) {
          warn(`Manifest/lockfile mismatch: ${path} ${section}.${name}`);
        }
        const id = dependencyId(path, section, name);
        const node: GraphNode = {
          id,
          kind: 'dependency',
          name,
          version: resolved?.version ?? '',
          scope: `${path}:${section}`,
          edges: [],
          metadata: { declared, specifier: resolved?.specifier },
          uncertain: /^(catalog:|file:|https?:|git[+:])/.test(declared ?? ''),
        };
        if (resolved) {
          const target = resolve(name, resolved.version, path);
          node.edges.push({ name, kind: section, target });
          node.uncertain ||= graph.nodes.get(target)?.uncertain ?? false;
        }
        graph.nodes.set(id, node);
        // Consumers of a workspace package do not inherit its development tools.
        // Changed devDependencies remain independent traversal roots.
        if (section !== 'devDependencies')
          workspaceNode.edges.push({ name, kind: section, target: id });
        if (/^(catalog:|file:|https?:|git[+:])/.test(declared ?? ''))
          warn(`Unsupported dependency protocol: ${path} ${name}: ${declared}`);
      }
    }
  }
  graph.warnings = [...new Set(graph.warnings)].sort();
  return { ...repository, graph, manifests, lockfile, workspace };
}
