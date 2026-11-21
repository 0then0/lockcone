# pnpm #14351 tarball integrity lab

The latest pnpm 10 tag checked on 2026-11-21 was `v10.34.9`. Its commit
`aa97047a81b4a7ed41f9a2f5479555ed7f7685b6` is the direct parent of the backport
`b31b2aabb1572ca555e3ef788a7fc55306a3b2dd`. No pnpm 10 release tag includes the
backport. Both CLIs in the lab print `10.34.9`, with the second built from the
exact backport commit. [Issue #14351](https://github.com/pnpm/pnpm/issues/14351),
[backport #17440](https://github.com/pnpm/pnpm/pull/17440),
[tag comparison](https://github.com/pnpm/pnpm/compare/v10.34.9...b31b2aabb1572ca555e3ef788a7fc55306a3b2dd).

## Run

Use the LockCone checkout with its pinned dependencies, Node.js 24.21.0, Git,
Corepack and port `41351` available on loopback. The CLI preparation commands
download published packages and build the pinned pnpm source in a temporary directory.

```sh
pnpm build
lab_root=$(mktemp -d)
mkdir "$lab_root/published" "$lab_root/source"
curl -fsSL https://registry.npmjs.org/pnpm/-/pnpm-10.34.9.tgz \
  | tar -xz -C "$lab_root/published" --strip-components 1
curl -fsSL https://codeload.github.com/pnpm/pnpm/tar.gz/b31b2aabb1572ca555e3ef788a7fc55306a3b2dd \
  | tar -xz -C "$lab_root/source" --strip-components 1
(
  cd "$lab_root/source"
  export COREPACK_HOME="$lab_root/corepack"
  export XDG_CACHE_HOME="$lab_root/cache" XDG_DATA_HOME="$lab_root/data" XDG_CONFIG_HOME="$lab_root/config"
  export npm_config_userconfig=/dev/null npm_config_globalconfig=/dev/null
  CI=true pnpm --filter 'pnpm...' install --frozen-lockfile --ignore-scripts \
    --store-dir "$lab_root/build-store"
  pnpm --dir pnpm exec tsc --build
  pnpm --dir pnpm run bundle
  cp pnpm/pnpmrc pnpm/dist/pnpmrc
)
node examples/tarball-integrity-lab.mjs \
  "$lab_root/published/bin/pnpm.cjs" "$lab_root/source/pnpm/dist/pnpm.cjs"
```

The script serves a deterministic archive at
`http://127.0.0.1:41351/lab-tarball.tgz`. For each CLI, it runs these commands
with separate workspaces and stores. `pnpm` below denotes the selected CLI.

```sh
pnpm install --lockfile-only --no-frozen-lockfile --ignore-scripts --store-dir "$warm_store"
pnpm --filter lab-direct update --lockfile-only --ignore-scripts --store-dir "$warm_store"
# Run in a clean workspace with the updated lockfile.
pnpm install --frozen-lockfile --ignore-scripts --store-dir "$fresh_store"
```

The directory printed as `Lab files` holds `published/initial.yaml`,
`published/updated.yaml`, `backport/initial.yaml`, and `backport/updated.yaml`.
It also holds the command logs and reports from the disposable Git comparisons.
The script reads the YAML independently of LockCone, checks any recorded digest
against the local archive, and records HTTP methods and exit codes.

## Observed results

- Published `10.34.9` initially recorded the archive's SHA-512. The warm update
  reused the archive and wrote the lockfile without `integrity`, then exited `1`
  with `ERR_PNPM_MISSING_TARBALL_INTEGRITY`. The frozen install in a fresh workspace
  and store also exited `1` with that error, before requesting the archive.
- Backport build `10.34.9` at `b31b2aa` kept the initial SHA-512 byte for byte.
  The warm update exited `0`. The frozen install downloaded the archive into a
  fresh store, installed the fixture, and exited `0`.
- Both warm updates made a `HEAD` request and no `GET`. The first pair of
  lockfiles differed only in the integrity field. The backport pair had identical
  bytes. LockCone reported one loss in the first pair with `packages/direct`
  directly reaching the tarball and `packages/transitive` reaching it through
  `packages/direct`. The reports excluded `packages/independent`. The backport
  comparison produced no loss.
