// Regenerates tests/fixtures/patches with real, pinned pnpm releases.
//
//   node examples/patch-fixtures.mjs
//
// This is fixture preparation, kept apart from analysis: it needs network access to
// the npm registry, writes lockfiles with `pnpm install --lockfile-only
// --ignore-scripts` in a temporary directory, and never installs packages or runs
// package scripts. LockCone itself does none of this. Review the generated files
// and tests/fixtures/patches/provenance.json together.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../tests/fixtures/patches/', import.meta.url));

const diff = (file, marker) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,3 @@\n+// ${marker}\n 'use strict';\n \n`;
const crlf = (text) => text.replaceAll('\n', '\r\n');
const quote = (key) => (/^[A-Za-z0-9._-]+$/.test(key) ? key : `'${key}'`);

// One committed side: manifests, workspace configuration, and patch files.
function side({ pnpm, patched = {}, files = {}, packages }) {
  const major = Number(pnpm.split('.')[0]);
  const root = {
    name: 'patch-fixture',
    version: '1.0.0',
    private: true,
    packageManager: `pnpm@${pnpm}`,
  };
  let workspace = 'packages:\n  - packages/*\n';
  const selectors = Object.entries(patched);
  if (selectors.length) {
    if (major >= 11)
      workspace += `patchedDependencies:\n${selectors
        .map(([selector, path]) => `  ${quote(selector)}: ${path}\n`)
        .join('')}`;
    else root.pnpm = { patchedDependencies: Object.fromEntries(selectors) };
  }
  const tree = {
    'package.json': `${JSON.stringify(root, null, 2)}\n`,
    'pnpm-workspace.yaml': workspace,
    ...files,
  };
  for (const [name, dependencies] of Object.entries(packages))
    tree[`packages/${name}/package.json`] = `${JSON.stringify(
      { name, version: '1.0.0', private: true, dependencies },
      null,
      2,
    )}\n`;
  return { pnpm, tree };
}

const cases = {
  // Main acceptance case: the patched version stays 3.0.1, only patch bytes change.
  // Workspace a reaches is-odd; workspace b reaches the independent ms.
  'content-change': (() => {
    const packages = { a: { 'is-odd': '3.0.1' }, b: { ms: '2.1.3' } };
    const patched = { 'is-odd@3.0.1': 'patches/is-odd@3.0.1.patch' };
    return {
      base: side({
        pnpm: '11.28.9',
        patched,
        files: { 'patches/is-odd@3.0.1.patch': diff('index.js', 'patch one') },
        packages,
      }),
      head: side({
        pnpm: '11.28.9',
        patched,
        files: { 'patches/is-odd@3.0.1.patch': diff('index.js', 'patch two') },
        packages,
      }),
    };
  })(),
  // The same bytes move to a new path; the lockfile hash stays the same.
  'path-only': (() => {
    const packages = { a: { 'is-odd': '3.0.1' }, b: { ms: '2.1.3' } };
    const body = diff('index.js', 'patch one');
    return {
      base: side({
        pnpm: '11.28.9',
        patched: { 'is-odd@3.0.1': 'patches/is-odd.patch' },
        files: { 'patches/is-odd.patch': body },
        packages,
      }),
      head: side({
        pnpm: '11.28.9',
        patched: { 'is-odd@3.0.1': 'patches/odd/is-odd.patch' },
        files: { 'patches/odd/is-odd.patch': body },
        packages,
      }),
    };
  })(),
  // A declaration appears; run the case backwards for a removal.
  'declaration-added': (() => {
    const packages = { a: { 'is-odd': '3.0.1' }, b: { ms: '2.1.3' } };
    return {
      base: side({ pnpm: '11.28.9', packages }),
      head: side({
        pnpm: '11.28.9',
        patched: { 'is-odd@3.0.1': 'patches/is-odd.patch' },
        files: { 'patches/is-odd.patch': diff('index.js', 'patch one') },
        packages,
      }),
    };
  })(),
  // CRLF conversion changes the bytes, but pnpm 10 and 11 record the same hash.
  'line-endings': (() => {
    const packages = { a: { 'is-odd': '3.0.1' }, b: { ms: '2.1.3' } };
    const patched = { 'is-odd@3.0.1': 'patches/is-odd.patch' };
    const body = diff('index.js', 'patch one');
    return {
      base: side({
        pnpm: '11.28.9',
        patched,
        files: { 'patches/is-odd.patch': body },
        packages,
      }),
      head: side({
        pnpm: '11.28.9',
        patched,
        files: { 'patches/is-odd.patch': crlf(body) },
        packages,
      }),
    };
  })(),
  // A name-only selector reaches two ms versions; a scoped package is also patched.
  'multi-version': (() => {
    const packages = {
      b: { ms: '2.1.3', '@types/ms': '2.1.0' },
      c: { ms: '2.0.0' },
      d: { 'is-odd': '3.0.1' },
    };
    const patched = (path) => ({
      ms: path,
      '@types/ms@2.1.0': 'patches/types-ms.patch',
    });
    const files = (marker) => ({
      'patches/ms.patch': diff('index.js', marker),
      'patches/types-ms.patch': diff('index.d.ts', `types ${marker}`),
    });
    return {
      base: side({
        pnpm: '11.28.9',
        patched: patched('patches/ms.patch'),
        files: files('patch one'),
        packages,
      }),
      head: side({
        pnpm: '11.28.9',
        patched: patched('patches/ms.patch'),
        files: files('patch two'),
        packages,
      }),
    };
  })(),
  // A range selector patches a transitive dependency; a and d share it, and e reaches
  // it only through a workspace link to a.
  shared: (() => {
    const packages = {
      a: { 'is-odd': '3.0.1' },
      d: { 'is-odd': '3.0.1' },
      e: { a: 'workspace:*' },
    };
    const patched = { 'is-number@^6.0.0': 'patches/is-number.patch' };
    return {
      base: side({
        pnpm: '11.28.9',
        patched,
        files: { 'patches/is-number.patch': diff('index.js', 'patch one') },
        packages,
      }),
      head: side({
        pnpm: '11.28.9',
        patched,
        files: { 'patches/is-number.patch': diff('index.js', 'patch two') },
        packages,
      }),
    };
  })(),
  // One patched package appears in two peer contexts.
  peers: (() => {
    const packages = {
      a: { react: '17.0.2', 'use-sync-external-store': '1.2.0' },
      b: { react: '18.3.1', 'use-sync-external-store': '1.2.0' },
    };
    const patched = { 'use-sync-external-store@1.2.0': 'patches/store.patch' };
    return {
      base: side({
        pnpm: '11.28.9',
        patched,
        files: { 'patches/store.patch': diff('index.js', 'patch one') },
        packages,
      }),
      head: side({
        pnpm: '11.28.9',
        patched,
        files: { 'patches/store.patch': diff('index.js', 'patch two') },
        packages,
      }),
    };
  })(),
  // pnpm 10 wrote package.json#pnpm and the { hash, path } lockfile shape.
  pnpm10: (() => {
    const packages = { a: { 'is-odd': '3.0.1' }, b: { ms: '2.1.3' } };
    const patched = { 'is-odd@3.0.1': 'patches/is-odd@3.0.1.patch' };
    return {
      base: side({
        pnpm: '10.34.9',
        patched,
        files: { 'patches/is-odd@3.0.1.patch': diff('index.js', 'patch one') },
        packages,
      }),
      head: side({
        pnpm: '10.34.9',
        patched,
        files: { 'patches/is-odd@3.0.1.patch': diff('index.js', 'patch two') },
        packages,
      }),
    };
  })(),
};

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(join(directory, entry.name))
      : [join(directory, entry.name)],
  );
}

const provenance = {};
const scratch = mkdtempSync(join(tmpdir(), 'lockcone-patch-fixtures-'));
try {
  for (const [name, sides] of Object.entries(cases)) {
    provenance[name] = {};
    for (const [label, { pnpm, tree }] of Object.entries(sides)) {
      const work = join(scratch, name, label);
      for (const [path, content] of Object.entries(tree)) {
        mkdirSync(dirname(join(work, path)), { recursive: true });
        writeFileSync(join(work, path), content);
      }
      execFileSync(
        'npx',
        ['--yes', `pnpm@${pnpm}`, 'install', '--lockfile-only', '--ignore-scripts'],
        { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] },
      );
      const target = join(output, name, label);
      rmSync(target, { recursive: true, force: true });
      cpSync(work, target, { recursive: true });
      provenance[name][label] = {
        pnpm,
        files: Object.fromEntries(
          walk(target)
            .map((path) => relative(target, path))
            .sort()
            .map((path) => [
              path,
              createHash('sha256')
                .update(readFileSync(join(target, path)))
                .digest('hex'),
            ]),
        ),
      };
    }
  }
  writeFileSync(
    join(output, 'provenance.json'),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
