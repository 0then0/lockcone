import { execFileSync } from 'node:child_process';
import { parseAllDocuments } from 'yaml';

export interface RepositoryState {
  revision: string;
  files: Map<string, string>;
}

export const resolutionFiles = new Set(['.npmrc', '.pnpmfile.cjs', 'pnpmfile.cjs']);

export function configuredPatches(lockfile: string | undefined): Set<string> {
  if (lockfile === undefined) return new Set();
  try {
    const documents = parseAllDocuments(lockfile, { uniqueKeys: true });
    const value = documents.at(-1)?.toJS({ maxAliasCount: 100 });
    if (value && typeof value === 'object' && 'patchedDependencies' in value) {
      const configured = (value as { patchedDependencies?: unknown })
        .patchedDependencies;
      if (configured && typeof configured === 'object') {
        return new Set(
          Object.values(configured).filter(
            (item): item is string => typeof item === 'string',
          ),
        );
      }
    }
  } catch {
    // Let the lockfile parser report syntax errors after all files are read.
  }
  return new Set();
}

function git(cwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error as { stderr?: string | Buffer; message?: string };
    throw new Error(
      `Git read failed: ${String(detail.stderr ?? detail.message).trim()}`,
    );
  }
}

interface TreeEntry {
  object: string;
  path: string;
}

function listTree(cwd: string, revision: string): TreeEntry[] {
  return git(cwd, ['ls-tree', '-r', '-z', '--full-tree', revision])
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const separator = record.indexOf('\t');
      const [mode, type, object] = record.slice(0, separator).split(' ');
      if (mode === undefined || type === undefined || object === undefined) {
        throw new Error('Git returned a malformed tree entry.');
      }
      return { object, path: record.slice(separator + 1) };
    });
}

function readBlobs(cwd: string, entries: TreeEntry[]): Map<string, string> {
  const blobs = new Map<string, string>();
  if (!entries.length) return blobs;
  try {
    const output = execFileSync('git', ['cat-file', '--batch'], {
      cwd,
      input: `${entries.map(({ object }) => object).join('\n')}\n`,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let offset = 0;
    for (const entry of entries) {
      const end = output.indexOf(0x0a, offset);
      if (end < 0) throw new Error('Git returned a truncated blob header.');
      const header = output.toString('ascii', offset, end).split(' ');
      const size = Number(header[2]);
      if (header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0) {
        throw new Error(`Git did not return a blob for ${entry.path}.`);
      }
      const start = end + 1;
      const finish = start + size;
      if (finish >= output.length || output[finish] !== 0x0a) {
        throw new Error(`Git returned a truncated blob for ${entry.path}.`);
      }
      blobs.set(entry.path, output.toString('utf8', start, finish));
      offset = finish + 1;
    }
    return blobs;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Git ')) throw error;
    const detail = error as { stderr?: string | Buffer; message?: string };
    throw new Error(
      `Git blob read failed: ${String(detail.stderr ?? detail.message).trim()}`,
    );
  }
}

export function readRepository(cwd: string, ref: string): RepositoryState {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const revision = git(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ]).trim();
  const tree = listTree(root, revision);
  const candidates = tree.filter(
    ({ path }) =>
      path === 'pnpm-lock.yaml' ||
      path === 'pnpm-workspace.yaml' ||
      path === 'package.json' ||
      path.endsWith('/package.json') ||
      resolutionFiles.has(path),
  );
  const initial = readBlobs(root, candidates);
  const lockfile = initial.get('pnpm-lock.yaml');
  const patches = configuredPatches(lockfile);
  const patchEntries = tree.filter(({ path }) => patches.has(path));
  const files = new Map([...initial, ...readBlobs(root, patchEntries)]);
  if (!files.has('package.json') || !files.has('pnpm-lock.yaml')) {
    throw new Error(
      `Revision ${ref} needs package.json and pnpm-lock.yaml at the repository root.`,
    );
  }
  return { revision, files };
}
