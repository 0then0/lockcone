# Case study: an optional peer context in pnpm/pnpm#14895

[pnpm/pnpm#14895](https://github.com/pnpm/pnpm/issues/14895) reports that
`pnpm update` on pnpm 12.4.1 needed two passes: the second pass attached the
optional peer `supports-color@7.2.0` to `debug` and, through it, to
`vite-plugin-node`, with no package version in the diff. The issue is closed, and
[pull request 14898](https://github.com/pnpm/pnpm/pull/14898) fixed it (merged on
2026-09-14, commit `4cf601019b10a2be1d499034cd81417f54d3da6c`).

This case runs the public CLI on the lockfiles of the first and the second pass and
checks the reported bindings against the raw lockfiles.

## How the lockfiles were obtained

The upstream fixture publishes only its baseline lockfile, so the passes were
reproduced on 2026-11-11 in a disposable directory.

- Fixture: [orgads/pnpm-update-optional-peer-fixture](https://github.com/orgads/pnpm-update-optional-peer-fixture)
  at `dbbfb3ef5afa82bf9c0419ff7f4db1e873fa0e35`, its only commit.
- pnpm 12.4.1, the `@pnpm/exe.darwin-arm64` binary of the npm package, installed
  with `npm install pnpm@12.4.1 --ignore-scripts` into a temporary prefix.
- Node.js 24.21.0, the version named in the issue, on macOS 15.7.9 (arm64). The
  issue was reported on Linux.
- `HOME`, the XDG directories, and `PNPM_HOME` pointed into the temporary directory,
  so no user configuration, store, or cache was read or written.

The commands are those of the fixture's `reproduce.sh`:

```bash
cp pnpm-lock.initial.yaml pnpm-lock.yaml
sed -i.bak 's/"@nestjs\/cli": "11.0.24"/"@nestjs\/cli": "12.0.1"/' package.json
pnpm update --lockfile-only --ignore-scripts   # saved as pass 1
pnpm update --lockfile-only --ignore-scripts   # saved as pass 2
pnpm update --lockfile-only --ignore-scripts   # pass 3, identical to pass 2
```

`--lockfile-only --ignore-scripts` means that no package was installed and no
lifecycle script ran. The command reads registry metadata.

## Inputs

The three states are stored under `tests/fixtures/peers/pnpm-14895`. SHA-256:

```text
initial  package.json         43ebeba5af2b1ac586e5061f9739aa190cd7729d2c9900acfbe4a8721be5dea0
initial  pnpm-lock.yaml       e0a85913139a007800b168a0c41ea88fcf9813c5ccc0a3e16b20d73a1b510e09
pass 1   package.json         6e14b54d5b038f302054038b3e184234d8d20f411395ca8292d55f1e535f3ded
pass 1   pnpm-lock.yaml       e2f224f8f8bca57ab7ea9ec2c65a04c88fe0e0853c81a51e595c77957fc49174
pass 2   package.json         6e14b54d5b038f302054038b3e184234d8d20f411395ca8292d55f1e535f3ded
pass 2   pnpm-lock.yaml       768e066162b5d043ba2fe23868b21d4db932c322a5bfca0044efa727d00a3dbe
all      pnpm-workspace.yaml  9edf936f4328acebeb577710691806b3b4b0dae3af9c48b5e5ca7546fda5c75e
```

- `initial` is the fixture as committed: `@nestjs/cli` `11.0.24`,
  `vite-plugin-node` `8.0.0`, and the baseline lockfile.
- `pass 1` and `pass 2` share the manifest with `@nestjs/cli` `12.0.1` and the same
  `pnpm-workspace.yaml`, which holds one `minimumReleaseAgeExclude` entry. Only the
  lockfile differs between them. No manifest declares `packageManager`.

## What was and was not reproduced

The behavior was reproduced: pass 1 and pass 2 differ, pass 2 and pass 3 are
byte-identical, and the pass 1 to pass 2 diff has the same five hunks as the issue.

The lockfiles are not the historical ones. The issue reports the SHA-256 values
`26efc464…` and `fad156b8…` for its two passes, and this run produced `e2f224f8…` and
`768e066…`. `pnpm update` resolves against the current registry, and two months of
releases moved other packages: the issue shows `vite@8.3.0`, this run has
`vite@8.3.7`. The statements below are observations on this run. They agree with the
issue's diff in every line except the `vite` version.

For the same reason `initial` to `pass 1` is not a clean experiment. It contains
the `@nestjs/cli` upgrade and every registry update at once: 206 change groups,
188 `unknown` and 18 `unexplained`. `pass 1` to `pass 2` is clean: same manifest,
same configuration, same pnpm, same registry state within one run, and identical
`packages` keys on both sides.

## Result

```bash
lockcone diff PASS1..PASS2
```

```text
Peer context changes (committed keys, metadata, and edges; why pnpm chose a provider is not established):
  debug@4.4.3: provider-added (one-to-one)
    debug@4.4.3 → debug@4.4.3(supports-color@7.2.0) [holder-rekeyed]
      supports-color: (no provider) → supports-color@7.2.0 (provider-added; head: direct optional peer, declaration and edge agree)
    Workspace consumers (graph reachability, not runtime usage):
      base: . (pnpm-update-optional-peer-fixture): transitive consumer via devDependencies of debug@4.4.3; uncertain (reasons: explain)
      head: . (pnpm-update-optional-peer-fixture): transitive consumer via devDependencies of debug@4.4.3(supports-color@7.2.0); uncertain (reasons: explain)
  vite-plugin-node@8.0.0: provider-added (one-to-one)
    vite-plugin-node@8.0.0(vite@8.3.7) → vite-plugin-node@8.0.0(supports-color@7.2.0)(vite@8.3.7) [same-holder]
      supports-color: (no provider) → supports-color@7.2.0 (provider-added; head: transitive context, inherited through a dependency)
    Workspace consumers (graph reachability, not runtime usage):
      base: . (pnpm-update-optional-peer-fixture): direct consumer via devDependencies of vite-plugin-node@8.0.0(vite@8.3.7); uncertain (reasons: explain)
      head: . (pnpm-update-optional-peer-fixture): direct consumer via devDependencies of vite-plugin-node@8.0.0(supports-color@7.2.0)(vite@8.3.7); uncertain (reasons: explain)
```

- `debug@4.4.3` keeps its version. Its optional peer `supports-color` had no
  provider and is bound to `supports-color@7.2.0`. The binding is `direct`: the
  package declares the peer, the key names the provider, and the snapshot edge
  points at it. The pair is tied by the `debug` edge of `vite-plugin-node`, which
  changed its own key, hence `holder-rekeyed`.
- `vite-plugin-node@8.0.0` keeps its version. It does not declare `supports-color`;
  the context is `transitive`, inherited through its `debug` edge. Its own peer
  `vite@8.3.7` is `direct` on both sides and unchanged, so the text omits it. The
  pair is tied by the root importer's `devDependencies` entry, the same on both
  sides.
- The consumer of both is the root project: directly for `vite-plugin-node`, and
  through `vite-plugin-node` for `debug`.

`why debug` adds the evidence:

```text
head declaration: debug@4.4.3 peerDependencies.supports-color "*" (optional)
head edge: debug@4.4.3(supports-color@7.2.0) -- optionalDependencies.supports-color -> supports-color@7.2.0
path dependency:[".","devDependencies","vite-plugin-node"] → vite-plugin-node@8.0.0(supports-color@7.2.0)(vite@8.3.7) → debug@4.4.3(supports-color@7.2.0)
```

## What stays unknown

The three change groups of the pair (`debug`, `vite-plugin-node`, and the importer
entry of `vite-plugin-node`) stay `unknown` with no path from a changed declaration.
LockCone shows that the binding appeared and who reaches it. It does not show why
pnpm attached the provider in the second pass and not in the first. That reason is
in the pull request, not in the lockfiles.

## Independent checks

`examples/peer-acceptance.mjs` commits the three states to a temporary Git
repository, runs the CLI on those revisions, and reads the lockfiles with the `yaml`
package, without importing LockCone:

- `package.json` and `pnpm-workspace.yaml` are byte-identical in pass 1 and pass 2,
  and both lockfiles have the same `packages` keys, so no version differs.
- Exactly two snapshot keys were replaced: `debug@4.4.3` and
  `vite-plugin-node@8.0.0(vite@8.3.7)`.
- `packages["debug@4.4.3"]` declares `supports-color: "*"` with
  `peerDependenciesMeta.supports-color.optional: true`. The pass 2 snapshot has
  `optionalDependencies.supports-color: 7.2.0`, the pass 1 snapshot has no such
  edge, and `supports-color@7.2.0` has a snapshot.
- `packages["vite-plugin-node@8.0.0"]` declares `vite` and `@swc/core`, not
  `supports-color`. Its pass 2 snapshot has `debug: 4.4.3(supports-color@7.2.0)` and
  `vite: 8.3.7`.
- Both passes list `supports-color` under `transitivePeerDependencies` of
  `vite-plugin-node`, although pass 1 binds no provider. The list alone therefore
  does not show a binding, and LockCone does not treat it as one.
- Every hop of every reported consumer path is an edge of the raw lockfile.
- Control: a revision with the pass 2 bytes compared with pass 2 reports no peer
  context change and no change group.

[evidence.json](evidence.json) holds the `peerBindings` section, the consumer paths,
the independent readings, and the control.

## Reproduce

```bash
pnpm install --frozen-lockfile
pnpm build
node examples/peer-acceptance.mjs
```

The script needs no network and rewrites `evidence.json`. Regenerating the
lockfiles needs pnpm 12.4.1 and network access, and a later run can resolve newer
versions again.
