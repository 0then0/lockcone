![LockCone: a changed root and its reachable dependency cone](assets/icon.svg)

# LockCone

[![CI](https://img.shields.io/github/actions/workflow/status/0then0/lockcone/ci.yml?branch=main&label=CI)](https://github.com/0then0/lockcone/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node.js 22.12+](https://img.shields.io/badge/Node.js-%3E%3D22.12-43853d)](package.json)
[![pnpm lockfile v9](https://img.shields.io/badge/pnpm-lockfile%20v9-f69220)](#supported-inputs)

LockCone explains pnpm dependency changes by comparing two committed dependency
graphs. It shows which changed packages are reachable from the dependencies you
changed, including updates made through catalogs in `pnpm-workspace.yaml`.

A path is evidence of reachability, not proof of why pnpm chose a version.
Packages outside those paths remain visible in the report.

## Quick start

Use Node.js 22.12 or later and the pnpm version pinned in `package.json`.
Build this checkout, then compare two commits in a repository:

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/cli/index.js diff --cwd /path/to/repository --base main --head HEAD
```

Both commits must contain `package.json` and a pnpm v9 `pnpm-lock.yaml` at the
Git root. LockCone reads committed files through Git. Uncommitted changes are
not included, and target dependencies, scripts, and hooks are never executed.

To install a published version, download its `.tgz` archive from
[GitHub Releases](https://github.com/0then0/lockcone/releases) and install it:

```bash
npm install --global ./lockcone-VERSION.tgz
lockcone --help
```

Replace `VERSION` with the archive's version. Each release includes `SHA256SUMS`
for checking the download. Catalog support requires v0.2 or later.

## Read a dependency report

Suppose you update `vitest`, and the lockfile also changes `vite`, `esbuild`, and
an unrelated `aws-sdk`. LockCone distinguishes the reachable changes from the
rest:

```text
Changed dependency:
  vitest 4.1.10 → 4.1.11

Reachable path:
  vitest → vite → esbuild

Outside dependency cone:
  aws-sdk 2.0.0 → 2.1.0
```

This example illustrates the bundled fixture, not the packages' published
dependency trees. Run `pnpm demo` to see its complete report.

Reports classify each change group as:

- `explained`: all changed instances are reachable from changed declarations,
  with no detected uncertainty.
- `partially-explained`: some changed instances are reachable and others are not.
- `unexplained`: no path was found from changed declarations, with no detected
  modeling limitation.
- `unknown`: peer context, unsupported resolution inputs, or incomplete data
  prevent a confident classification. Available paths are still shown.

Groups represent package names, importer/section/dependency entries, or
workspace packages. Summary counts are groups, not unique packages or lockfile
lines. A direct upgrade usually produces both an importer and a package group.
Parallel versions remain separate instances; they are not arbitrarily paired as
upgrades. Metadata and edge changes are reported even when versions stay equal.

Unexplained changes are not automatically errors. Suggestions such as
resolution updates or deduplication are hypotheses, not detected causes.

## Commands and exit codes

- `diff [base..head]`: compare two exact commit states.
- `explain [base..head]`: the same full report as `diff`.
- `why <package>`: show changes for that exact package name, matching direct
  dependency entries, relevant declarations, and evidence paths.

All commands accept `--base`, `--head`, `--cwd`, and `--format text|json`.
Without refs they compare `HEAD~1..HEAD`. Two-dot ranges compare the named
commits directly, without a merge base. Three-dot ranges are rejected, and a
range cannot be combined with explicit refs. Both commits must be available
locally; shallow clones may need additional history.

```bash
lockcone diff main..HEAD
lockcone why esbuild --base origin/main --head HEAD
lockcone explain --format json
```

Exit code `0` means analysis completed, including reports with unexplained or
unknown changes. A missing or unchanged package requested through `why` returns
an empty change list and exit code `0`. Exit code `1` indicates invalid input,
unsupported lockfiles, missing files, or a Git/read/parse failure.

## Catalog updates

A manifest may keep `"package-manager-detector": "catalog:prod"` while the
corresponding workspace entry changes:

```yaml
catalogs:
  prod:
    package-manager-detector: ^1.7.0
```

LockCone compares each revision's catalog entry and records effective dependency
intent for every consuming importer. Reports keep three values separate:

```text
Declared reference: catalog:prod
Effective declaration: ^1.7.0
Observed resolution: 1.7.0
```

The old graph supplies evidence for removals and the new graph for additions.
Changing catalog origin while retaining the same effective range records an
origin change, without creating a traversal root. A resolution change alone is
not declaration intent. `why` still shows the unchanged catalog declaration
and observed resolutions for a matching direct dependency.

Unused supported catalog entries do not create dependency cones or global
uncertainty. Catalog peers retain peer uncertainty and never become runtime
traversal roots. See the [catalog reference](docs/catalog-contract.md) for range
syntax, snapshot checks, and unsupported forms.

## Supported inputs

- pnpm dependency lockfile v9, optionally preceded by the environment document
  used by newer pnpm versions. Environment changes produce uncertainty.
- Runtime, development, and optional dependencies, scoped names, literal npm
  aliases, and workspace links resolved as `link:` references.
- Shared workspace lockfiles. Workspace membership supports `*`, `**`, `{a,b}`,
  and `!` globs. Unsupported syntax and missing importers produce warnings.
- Default and named catalogs defined directly in root `pnpm-workspace.yaml`,
  using stable registry ranges.
- Parallel package versions, peer suffixes, metadata changes, and edge changes.

Traversal follows runtime and optional dependencies of linked workspaces; it
never inherits their development dependencies. Workspace identity changes
explain the workspace record itself, not its dependency upgrades.

Catalog aliases, prerelease/build ranges, tags, local/workspace/Git/URL catalog
values, external catalog files, and catalog override attribution are unsupported.
Overrides, patches, hooks, unknown configuration, and incomplete edges retain
conservative uncertainty. Hooks are never executed. Global unmodeled input
changes can make all groups `unknown`; peer uncertainty applies to affected
instances and paths.

Separate workspace lockfiles, custom lockfile locations, other package managers,
registry state, platform selection, global pnpm inputs, and resolver replay are
not modeled. LockCone does not perform vulnerability scanning or decide whether
a change should merge.

## JSON reports

```bash
lockcone diff --base origin/main --head HEAD --format json > lockcone-report.json
```

The JSON report uses `schemaVersion: 4` and includes resolved commit IDs,
`manifestChanges`, `declarations`, `declarationChanges`, `catalogChanges`,
`changes`, `pathNodes`, `warnings`, and `summary`.

`manifestChanges` contains actual manifest edits. `declarations.base/head`
separates original specifiers, catalog origins, effective ranges, observed
resolutions, and uncertainty. `declarationChanges` records intent and traversal
eligibility. `catalogChanges` records changed entries and their consumer IDs.

Each graph change includes before/after versions, changed instance IDs,
confidence, a reason, evidence, and edge/metadata details. Follow `evidence.root`
to a declaration on the same side; follow `pathId` through `pathNodes` to read
the dependency path. Metadata differences use `null` for an absent field.

Output is deterministic for equivalent input mappings. Successful JSON contains
no diagnostic text; failures go to stderr. Consumers must explicitly support
schema v4; schema v3 output is not available. See the
[v0.2 compatibility notes](docs/release-notes-v0.2.md).

## GitHub Actions

The [composite action](action.yml) builds LockCone and exposes the JSON report
path as `outputs.report`. Pin it to a reviewed commit SHA:

```yaml
name: Dependency changes
on: pull_request
permissions:
  contents: read
jobs:
  lockcone:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: 0then0/lockcone@COMMIT_SHA
        id: lockcone
        with:
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
      - uses: actions/upload-artifact@v6
        with:
          name: lockcone-report
          path: ${{ steps.lockcone.outputs.report }}
```

Replace `COMMIT_SHA` with the selected LockCone revision. The action installs
LockCone's build dependencies, but never installs dependencies or runs lifecycle
scripts from the analyzed repository. Unknown or unexplained groups do not fail
the action; apply any merge policy separately.

## Examples and development

The [ni case study](docs/acceptance/ni/README.md) compares unchanged upstream
commits: v0.1 reports six unknown groups; v0.2 reports two explained and four
unexplained groups. The remaining reverse dependency edges are outside the cone.

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks, fixtures, and release procedures.
Licensed under [Apache-2.0](LICENSE).
