# Case study: pnpm 11 migration in radix-ui/primitives

This case runs the public CLI on two pinned commits of
[radix-ui/primitives](https://github.com/radix-ui/primitives), a pnpm workspace
with a committed patch. The upstream commit that migrates the repository from
pnpm 10.2.0 to 11.5.0 also changes that patch, so the pair contains a real
patch-file change, a move of the declaration, and a change of lockfile format.

It is a historical upstream change and a metadata comparison. It does not
reproduce a pnpm defect, and it does not show that the patch applies or fails.

## Inputs

- Base: `da4175faf82a3f0bbf8d290b1caddf47ced7a4e7`, `packageManager: pnpm@10.2.0`.
- Head: `3bc7532514ef1451d09648fc98d3ed8ddfcc55f4`, `packageManager: pnpm@11.5.0`.
- [Upstream commit](https://github.com/radix-ui/primitives/commit/3bc7532514ef1451d09648fc98d3ed8ddfcc55f4).
- Patch file: `patches/@changesets__apply-release-plan.patch`.
- Metadata forms: base declares `pnpm.patchedDependencies` in `package.json`, and
  its lockfile records `{ hash, path }`. Head declares `patchedDependencies` in
  `pnpm-workspace.yaml`, and its lockfile records only the hash string. Both use
  the name-only selector `@changesets/apply-release-plan` and lockfile v9.

## Result

LockCone reports one patch change, `@changesets/apply-release-plan`, with four
independent events:

- `source-changed`: `package.json#pnpm` → `pnpm-workspace.yaml`.
- `content-changed`: SHA-256 `399787ec…93eb` (2182 bytes) →
  `07a08c92…08ea` (2184 bytes).
- `lockfile-hash-changed`: the recorded hash changed with the bytes.
- `lockfile-shape-changed`: `{ hash, path }` → hash string. The path is not
  reported as changed.

The path of the file did not change. The patched instance moved from
`@changesets/apply-release-plan@7.0.13` to `7.1.1`, so the two instances have
no counterpart with the same name and version. Each is `lockfile-confirmed`:
its `patch_hash` equals the lockfile entry for the selector.

One workspace consumer, the root importer `.`, reaches the instance on both
sides, through its development dependency `@changesets/cli`:

```text
base: dependency:[".","devDependencies","@changesets/cli"]
      → @changesets/cli@2.29.7(@types/node@24.12.4)
      → @changesets/apply-release-plan@7.0.13(patch_hash=399787ec…)
head: dependency:[".","devDependencies","@changesets/cli"]
      → @changesets/cli@2.31.0(@types/node@24.12.4)
      → @changesets/apply-release-plan@7.1.1(patch_hash=07a08c92…)
```

The relation is `transitive`, and the path is `uncertain` under the existing
graph rules because the intermediate package has a peer context.

The pair also changes many unrelated resolutions. All 864 change groups stay
`unknown`, with the same global warnings as before, such as
`Resolution input changed` for the patch file, and a changed `packageManager`.
Explaining the patch does not explain those groups, and no consumer path is
invented for them.

[evidence.json](evidence.json) holds the patch section of the report, the text
excerpt, the global warnings, and the independent readings below.

## Independent checks

The script reads the same commits with Git and parses the lockfile with the `yaml`
package. It does not import LockCone.

- The patch blobs are `1b82cab37a4b52dd844b5501bf2e0a758e276d14` (base) and
  `abc9f837fc2621871906cd88634cef8ef0b41c1a` (head). Their SHA-256 digests and
  sizes equal the reported ones. For these two LF patches the lockfile hash also
  equals the SHA-256 of the bytes. LockCone treats that as an observation only.
- The lockfile has one `patchedDependencies` entry, and exactly one snapshot of
  `@changesets/apply-release-plan` carries that hash.
- A reverse search over the raw snapshots finds the root importer's
  `@changesets/cli` and no other importer. LockCone's consumer and path match on
  both sides.

## Reproduce

From a LockCone checkout with its development dependencies installed:

```bash
pnpm build
node examples/patch-acceptance.mjs
```

The script clones the repository without a checkout and without blobs, into
temporary storage, fetching blobs on demand. It never installs dependencies or
runs scripts or hooks of the target. Network access is required. A partial clone
can fail transiently while fetching blobs, so the script retries the CLI. To use
an existing clone that has both commits:

```bash
node examples/patch-acceptance.mjs /path/to/primitives
```

It rewrites `evidence.json` and fails if LockCone and the independent reading
disagree. Equivalent CLI call:

```bash
node dist/cli/index.js explain --cwd /path/to/primitives \
  --base da4175faf82a3f0bbf8d290b1caddf47ced7a4e7 \
  --head 3bc7532514ef1451d09648fc98d3ed8ddfcc55f4 --format json
```
