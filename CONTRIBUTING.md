# Contributing to LockCone

Read the [code of conduct](CODE_OF_CONDUCT.md) before participating. Use the
[issue forms](https://github.com/0then0/lockcone/issues/new/choose) for bugs and
feature requests. Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## Set up the project

Use Node.js 22.12 or later and the pnpm version pinned in `package.json`:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm demo
```

## Validate a change

Run the relevant tests while developing, then run the repository checks:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm demo
```

`pnpm test` builds the CLI before running Vitest. `pnpm format:check` checks
formatting without changing files; `pnpm format` applies formatting.

EditorConfig uses UTF-8, LF, and two-space indentation to match Biome. Git
normalizes text line endings, except under `tests/fixtures`, where original
bytes are preserved. Do not normalize or reformat fixtures to satisfy editor
defaults. Keep generated `dist`, release archives, and local environment files
out of commits; commit dependency lockfiles.

Add regression tests for meaningful behavior changes. Tests should verify the
reported result, uncertainty, and evidence rather than just implementation
calls. Fixtures are input data: never install their dependencies or execute
their scripts. CLI tests use a deterministic Git transport double.

To regenerate the upstream catalog example, follow the
[ni reproduction instructions](docs/acceptance/ni/README.md). That script updates
fixtures, reports, and provenance; review those files together.

Patch fixtures under `tests/fixtures/patches` come from pinned pnpm releases.
`node examples/patch-fixtures.mjs` regenerates them with `pnpm install
--lockfile-only --ignore-scripts` in a temporary directory; it needs network access
and is separate from analysis. The external
[radix-ui/primitives case](docs/acceptance/radix-primitives/README.md) is checked
with `node examples/patch-acceptance.mjs` after `pnpm build`. Patch fixtures keep
their exact bytes, including CRLF.

Override tests build their repositories by hand, because a real pnpm run queries a
registry. The [farm-3j case](docs/acceptance/farm-3j/README.md) is checked with
`node examples/override-acceptance.mjs` after `pnpm build`; it needs network access
and rewrites its evidence file. Override matching follows the pnpm sources listed in
the [override reference](docs/override-contract.md#references). Check a change to
the matching rules against those sources, and compare changed range code with
node-semver in a scratch directory; it is not a dependency.

Peer context tests build their repositories by hand, except
`tests/fixtures/peers/pnpm-14895`, which holds lockfiles written by pnpm 12.4.1. The
[pnpm/pnpm#14895 case](docs/acceptance/pnpm-14895/README.md) records the commands,
and `node examples/peer-acceptance.mjs` checks the public CLI against those lockfiles
after `pnpm build`, without network access. It rewrites its evidence file.

## Preserve the analysis contract

Keep changes focused. Preserve deterministic output, exact package identities,
and separate old/new graph evidence. Document unsupported resolution behavior
and prefer `unknown` to an unsupported explanation. Describe paths as
“reachable from changed declarations”, without claiming resolver causality.

Keep responsibilities in the existing modules:

- `src/git`: committed repository reads.
- `src/manifests`: manifest validation.
- `src/pnpm`: lockfile, workspace, patch, and override metadata interpretation.
- `src/graph`: package instances and traversal.
- `src/analysis`: intent, graph comparison, patch reports, and classification.
- `src/output` and `src/cli`: reports and command interfaces.

The graph and traversal modules do not depend on the pnpm parser. Core analysis
must not query registries, install target packages, execute hooks, use AI services,
or introduce an automatic merge policy.

Patch and peer context reports describe committed metadata and never change
classification.
Discuss incompatible report changes before changing `schemaVersion`; additive
sections such as `patches` and `peerBindings` carry their own `reportVersion`. Update
consumers, CI validators, tests, and documentation together. The
[catalog reference](docs/catalog-contract.md) describes the current schema and
uncertainty policy.

## Submit a change

Pull requests should explain the user-visible behavior, relevant limitations,
and checks actually run, using the pull request template. Record user-visible
changes under `Unreleased` in [CHANGELOG.md](CHANGELOG.md).
Use Conventional Commits with `feat`, `fix`, `refactor`,
`chore`, `docs`, or `test` types.

## Dependency maintenance

Dependabot checks GitHub Actions in workflows and the root composite action on
the first day of each month. Minor and patch updates are grouped; major updates
receive separate pull requests. At most one version-update pull request is open
at a time, and new releases have a seven-day cooldown before being considered.
Review and merge updates after CI passes.

The project uses pnpm 12.5.1. GitHub currently documents Dependabot support for
pnpm 7–10, so npm dependency updates are not configured. Enable them once the
project's pnpm version is supported. See GitHub's
[supported ecosystems](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories)
and the [Dependabot configuration](.github/dependabot.yml).

## Release a version

Update `package.json`, the changelog, and any detailed release notes. Move the
relevant `Unreleased` entries into a versioned section and update comparison
links. Run the checks and verify the
packed archive in a disposable directory. Match the `vVERSION` tag to the
package version. The [release workflow](.github/workflows/release.yml) rejects a
mismatch, packs the package, installs and invokes it, and attaches the archive
and `SHA256SUMS` to a GitHub Release.

Release archives include the CLI, README, license, icon, changelog, project
policies, and documentation.
Tagging and publishing are separate from committing or pushing source changes.
