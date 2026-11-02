import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';

// Patch files are hashed from the exact committed bytes. Larger files are not read;
// their Git blob ID still distinguishes changed from identical bytes.
export const maxPatchBytes = 8 * 1024 * 1024;
export const maxPatchFiles = 256;

export type PatchFile =
  | { status: 'present'; blob: string | null; size: number; sha256: string }
  | { status: 'oversized'; blob: string | null; size: number }
  | { status: 'missing' }
  | { status: 'unsupported'; reason: string };

export interface RepositoryState {
  revision: string;
  files: Map<string, string>;
  // Committed state of every configured patch path. Hand-built states may omit it.
  patchFiles?: Map<string, PatchFile>;
}

export function normalizePatchPath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/'));
}

// A patch reference must name a file inside the repository snapshot.
export function patchPathProblem(path: string): string | undefined {
  if (!path || path === '.' || path.endsWith('/'))
    return 'the path does not name a file';
  if (path.includes('\0')) return 'the path contains a NUL byte';
  if (posix.isAbsolute(path) || /^[A-Za-z]:/.test(path)) return 'the path is absolute';
  if (path === '..' || path.startsWith('../')) return 'the path leaves the repository';
  return undefined;
}

export function patchFile(state: RepositoryState, path: string): PatchFile {
  const read = state.patchFiles?.get(path);
  if (read) return read;
  const problem = patchPathProblem(path);
  if (problem) return { status: 'unsupported', reason: problem };
  const content = state.files.get(path);
  if (content === undefined) return { status: 'missing' };
  const bytes = Buffer.from(content, 'utf8');
  return {
    status: 'present',
    blob: null,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

// True only when both sides prove identical or different bytes.
export function sameFileBytes(left: PatchFile, right: PatchFile): boolean | undefined {
  if (
    (left.status !== 'present' && left.status !== 'oversized') ||
    (right.status !== 'present' && right.status !== 'oversized')
  )
    return undefined;
  if (left.blob !== null && right.blob !== null) return left.blob === right.blob;
  if (left.status === 'present' && right.status === 'present')
    return left.sha256 === right.sha256;
  return undefined;
}

export const resolutionFiles = new Set(['.npmrc', '.pnpmfile.cjs', 'pnpmfile.cjs']);

function patchPaths(value: unknown, lockfileFormat: boolean): Set<string> {
  const paths = new Set<string>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return paths;
  for (const patch of Object.values(value)) {
    if (typeof patch === 'string') {
      if (!lockfileFormat) paths.add(normalizePatchPath(patch));
    } else if (
      lockfileFormat &&
      patch !== null &&
      typeof patch === 'object' &&
      'path' in patch &&
      typeof patch.path === 'string'
    ) {
      paths.add(normalizePatchPath(patch.path));
    }
  }
  return paths;
}

export function configuredPatches(files: Map<string, string>): Set<string> {
  const paths = new Set<string>();
  const lockfile = files.get('pnpm-lock.yaml');
  try {
    const documents = parseAllDocuments(lockfile ?? '', { uniqueKeys: true });
    const value = documents.at(-1)?.toJS({ maxAliasCount: 100 });
    if (value && typeof value === 'object' && 'patchedDependencies' in value) {
      for (const path of patchPaths(
        (value as { patchedDependencies?: unknown }).patchedDependencies,
        true,
      ))
        paths.add(path);
    }
  } catch {
    // Let the lockfile parser report syntax errors after all files are read.
  }
  const configs = [
    {
      source: files.get('pnpm-workspace.yaml'),
      parse: (source: string) =>
        parse(source, { maxAliasCount: 100, uniqueKeys: true }),
      lockfileFormat: false,
    },
    {
      source: files.get('package.json'),
      parse: (source: string) => JSON.parse(source) as { pnpm?: unknown },
      lockfileFormat: false,
    },
  ];
  for (const { source, parse: parseConfig } of configs) {
    if (source === undefined) continue;
    try {
      const parsed = parseConfig(source);
      const config = 'pnpm' in parsed ? parsed.pnpm : parsed;
      const patched =
        config !== null && typeof config === 'object' && 'patchedDependencies' in config
          ? config.patchedDependencies
          : undefined;
      for (const path of patchPaths(patched, false)) paths.add(path);
    } catch {
      // Manifest and workspace parsers report their own syntax errors.
    }
  }
  return paths;
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

export interface TreeEntry {
  object: string;
  path: string;
  mode: string;
  type: string;
}

export async function parseTreeBatch(
  chunks: AsyncIterable<Buffer>,
): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  let pending = Buffer.alloc(0);
  for await (const chunk of chunks) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(0, start);
      if (end < 0) {
        pending = Buffer.concat([pending, chunk.subarray(start)]);
        break;
      }
      const record = Buffer.concat([pending, chunk.subarray(start, end)]).toString(
        'utf8',
      );
      pending = Buffer.alloc(0);
      const separator = record.indexOf('\t');
      const [mode, type, object] = record.slice(0, separator).split(' ');
      if (
        separator < 0 ||
        mode === undefined ||
        type === undefined ||
        object === undefined
      ) {
        throw new Error('Git returned a malformed tree entry.');
      }
      entries.push({ object, path: record.slice(separator + 1), mode, type });
      start = end + 1;
    }
  }
  if (pending.length) throw new Error('Git returned a truncated tree listing.');
  return entries;
}

type BlobRequest = Pick<TreeEntry, 'object' | 'path'>;

interface BlobReader {
  header(entry: BlobRequest): Promise<number>;
  bytes(size: number): Promise<Buffer>;
  skip(size: number): Promise<void>;
  boundary(entry: BlobRequest): Promise<void>;
  finish(): Promise<void>;
}

function blobReader(chunks: AsyncIterable<Buffer>): BlobReader {
  const iterator = chunks[Symbol.asyncIterator]();
  let chunk: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let offset = 0;
  async function fill(): Promise<void> {
    while (offset === chunk.length) {
      const next = await iterator.next();
      if (next.done) throw new Error('Git returned a truncated blob batch.');
      chunk = next.value;
      offset = 0;
    }
  }
  async function readLine(): Promise<string> {
    const parts: Buffer[] = [];
    while (true) {
      await fill();
      const end = chunk.indexOf(0x0a, offset);
      if (end >= 0) {
        parts.push(chunk.subarray(offset, end));
        offset = end + 1;
        return Buffer.concat(parts).toString('ascii');
      }
      parts.push(chunk.subarray(offset));
      offset = chunk.length;
    }
  }
  async function readBytes(size: number): Promise<Buffer> {
    const parts: Buffer[] = [];
    let remaining = size;
    while (remaining > 0) {
      await fill();
      const length = Math.min(remaining, chunk.length - offset);
      parts.push(chunk.subarray(offset, offset + length));
      offset += length;
      remaining -= length;
    }
    return Buffer.concat(parts, size);
  }
  async function skipBytes(size: number): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      await fill();
      const length = Math.min(remaining, chunk.length - offset);
      offset += length;
      remaining -= length;
    }
  }
  return {
    async header(entry) {
      const [object, type, sizeText, extra] = (await readLine()).split(' ');
      const size = Number(sizeText);
      if (
        object !== entry.object ||
        type !== 'blob' ||
        extra !== undefined ||
        !Number.isSafeInteger(size) ||
        size < 0
      ) {
        throw new Error(`Git did not return a valid blob for ${entry.path}.`);
      }
      return size;
    },
    bytes: readBytes,
    skip: skipBytes,
    async boundary(entry) {
      if ((await readBytes(1))[0] !== 0x0a)
        throw new Error(`Git returned a malformed blob boundary for ${entry.path}.`);
    },
    async finish() {
      if (offset < chunk.length || !(await iterator.next()).done)
        throw new Error('Git returned unexpected data after the blob batch.');
    },
  };
}

export async function parseBlobBatch(
  entries: BlobRequest[],
  chunks: AsyncIterable<Buffer>,
): Promise<Map<string, string>> {
  const blobs = new Map<string, string>();
  const reader = blobReader(chunks);
  for (const entry of entries) {
    const content = await reader.bytes(await reader.header(entry));
    await reader.boundary(entry);
    blobs.set(entry.path, content.toString('utf8'));
  }
  await reader.finish();
  return blobs;
}

// Hashes exact blob bytes. Blobs above the limit are consumed but never retained.
export async function parsePatchBatch(
  entries: BlobRequest[],
  chunks: AsyncIterable<Buffer>,
  limit = maxPatchBytes,
): Promise<Map<string, PatchFile>> {
  const files = new Map<string, PatchFile>();
  const reader = blobReader(chunks);
  for (const entry of entries) {
    const size = await reader.header(entry);
    if (size > limit) {
      await reader.skip(size);
      files.set(entry.path, { status: 'oversized', blob: entry.object, size });
    } else {
      const content = await reader.bytes(size);
      files.set(entry.path, {
        status: 'present',
        blob: entry.object,
        size,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
    }
    await reader.boundary(entry);
  }
  await reader.finish();
  return files;
}

export async function streamGit<T>(
  cwd: string,
  args: string[],
  input: string,
  parse: (stdout: AsyncIterable<Buffer>) => Promise<T>,
): Promise<T> {
  const child = spawn('git', args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  child.stderr.on('data', (part: Buffer) => stderr.push(part));
  child.stdin.on('error', () => undefined);
  const closed = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
  });
  try {
    child.stdin.end(input);
    const result = await parse(child.stdout);
    const code = await closed;
    if (code !== 0)
      throw new Error(
        `Git read failed: ${Buffer.concat(stderr).toString('utf8').trim()}`,
      );
    return result;
  } catch (error) {
    child.kill();
    await closed.catch(() => undefined);
    const detail = Buffer.concat(stderr).toString('utf8').trim();
    if (error instanceof Error && error.message.startsWith('Git ')) {
      if (!detail || error.message.includes(detail)) throw error;
      throw new Error(`${error.message}: ${detail}`, { cause: error });
    }
    throw new Error(`Git read failed: ${detail || String(error)}`);
  }
}

async function listTree(cwd: string, revision: string): Promise<TreeEntry[]> {
  return streamGit(
    cwd,
    ['ls-tree', '-r', '-z', '--full-tree', revision],
    '',
    parseTreeBatch,
  );
}

async function readBlobs<T>(
  cwd: string,
  entries: TreeEntry[],
  parse: (
    entries: TreeEntry[],
    stdout: AsyncIterable<Buffer>,
  ) => Promise<Map<string, T>>,
): Promise<Map<string, T>> {
  if (!entries.length) return new Map();
  return streamGit(
    cwd,
    ['cat-file', '--batch'],
    `${entries.map(({ object }) => object).join('\n')}\n`,
    (stdout) => parse(entries, stdout),
  );
}

// Resolve each configured patch path in the committed tree only. Symlinks,
// submodules, and over-limit requests are reported instead of followed.
async function readPatchFiles(
  cwd: string,
  tree: TreeEntry[],
  paths: Set<string>,
): Promise<Map<string, PatchFile>> {
  const byPath = new Map(tree.map((entry) => [entry.path, entry]));
  const files = new Map<string, PatchFile>();
  const readable: TreeEntry[] = [];
  for (const path of [...paths].sort()) {
    const entry = byPath.get(path);
    const problem = patchPathProblem(path);
    if (problem) files.set(path, { status: 'unsupported', reason: problem });
    else if (!entry) files.set(path, { status: 'missing' });
    else if (entry.mode === '120000')
      files.set(path, { status: 'unsupported', reason: 'the path is a symlink' });
    else if (entry.type !== 'blob')
      files.set(path, { status: 'unsupported', reason: 'the path is a submodule' });
    else if (readable.length >= maxPatchFiles)
      files.set(path, {
        status: 'unsupported',
        reason: `more than ${maxPatchFiles} patch files are configured`,
      });
    else readable.push(entry);
  }
  for (const [path, file] of await readBlobs(cwd, readable, parsePatchBatch))
    files.set(path, file);
  return files;
}

export async function readRepository(
  cwd: string,
  ref: string,
): Promise<RepositoryState> {
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const revision = git(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ]).trim();
  const tree = await listTree(root, revision);
  const candidates = tree.filter(
    ({ path }) =>
      path === 'pnpm-lock.yaml' ||
      path === 'pnpm-workspace.yaml' ||
      path === 'package.json' ||
      path.endsWith('/package.json') ||
      resolutionFiles.has(path),
  );
  const initial = await readBlobs(root, candidates, parseBlobBatch);
  const patchFiles = await readPatchFiles(root, tree, configuredPatches(initial));
  const files = initial;
  if (!files.has('package.json') || !files.has('pnpm-lock.yaml')) {
    throw new Error(
      `Revision ${ref} needs package.json and pnpm-lock.yaml at the repository root.`,
    );
  }
  return { revision, files, patchFiles };
}
