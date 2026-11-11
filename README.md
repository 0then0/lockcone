![LockCone: a changed root and its reachable dependency cone](assets/icon.svg)

# LockCone

[![CI](https://img.shields.io/github/actions/workflow/status/0then0/lockcone/ci.yml?branch=main&label=CI)](https://github.com/0then0/lockcone/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Node.js 22.12+](https://img.shields.io/badge/Node.js-%3E%3D22.12-43853d)](package.json)
[![pnpm lockfile v9](https://img.shields.io/badge/pnpm-lockfile%20v9-f69220)](#supported-inputs)

LockCone explains pnpm dependency changes by comparing two committed dependency
graphs. It shows which changed packages are reachable from the dependencies you
changed, including updates made through catalogs in `pnpm-workspace.yaml`. It
also reports pnpm patch changes: what changed in a patch, which package
instances it is tied to, and which workspace projects reach them. For `overrides`,
it ties a changed rule to the dependency edges it governs and shows the paths
to the workspace projects that reach them.

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
for checking the download. Catalog support requires v0.2 or later, and patch
reports require v0.3 or later, and override reports require v0.4 or later.

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
- `explain [base..head]`: the same report as `diff`, with the complete dependency
  path and uncertainty reasons for each patch consumer.
- `why <package>`: show changes for that exact package name, matching direct
  dependency entries, relevant declarations, evidence paths, patch and override
  changes that name the package, and peer context changes of the package or of
  instances that name it as a provider.

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

## Patch changes

A patched dependency can keep its version while its patch changes. LockCone
compares the committed patch declaration, patch file, and lockfile metadata of
the two commits, and reports them as separate events:

```text
Patch changes (committed bytes and metadata only; nothing is applied or installed):
  is-odd@3.0.1: content-changed, lockfile-hash-changed
    patch bytes: changed
      base: patches/is-odd@3.0.1.patch: sha256 107afd3e…, 110 bytes
      head: patches/is-odd@3.0.1.patch: sha256 62b2426c…, 110 bytes
    head instances:
      is-odd@3.0.1(patch_hash=62b2426c5b83…) [lockfile-confirmed; …]
    Workspace consumers (graph reachability, not runtime usage or proof of application):
      head: packages/a (a): direct consumer via dependencies; link lockfile-confirmed
```

This output abbreviates the bundled `content-change` fixture, generated by pnpm
11.28.9. A second workspace that depends on an unrelated package does not appear.

- Events are `declaration-added/removed`, `selector-changed`, `source-changed`,
  `path-changed`, `content-changed`, `lockfile-*`, and `input-unavailable`.
  A moved file with identical bytes is only `path-changed`.
- Bytes are compared exactly as committed, with no line-ending normalization.
  The hash in the lockfile is shown as an opaque pnpm value, never as the file's
  SHA-256, and the two can disagree without implying anything about an install.
- A `lockfile-confirmed` association means the instance's `patch_hash` equals the
  lockfile entry of a selector that matches it. `selector-applicable` means only
  that a declared selector matches. Anything unsupported or contradictory stays
  `unknown` with its reason.
- Consumers are workspace projects that reach the instance in the dependency
  graph, shown separately for base and head as direct or transitive. They are not
  proof of runtime use, a rebuild, or why pnpm chose a version.

Patch changes are never an error, and they do not make other changes explained:
a patched instance stays `unknown`, and the global `Resolution input changed`
warnings remain. The [patch reference](docs/patch-contract.md) lists the
supported forms, evidence rules, JSON fields, and limits.

## Override changes

A rule in `overrides` can change a dependency without any manifest edit. In a
workspace where `a` and `b` both depend on `leaf`, the rule `a>leaf: 2.0.0` moves
`leaf` for `a` only. LockCone matches the rule to the edges of the committed
graph, on both sides:

```text
Override changes (declarations, lockfile records, and committed edges only; nothing is resolved or installed):
  a > leaf: declaration-added, lockfile-record-added
    head declaration: pnpm-workspace.yaml → "2.0.0" (exact)
    head lockfile record: "2.0.0"
    attribution: complete
    Affected edges (committed graph; reachability, not proof that the rule caused every update):
      a@1.0.0 leaf: leaf@1.0.0 → leaf@2.0.0 (target-changed)
        Evidence path starts at this edge.
        head: governed; resolution satisfies the value
          consumer head: . (root): direct via dependencies
```

This output abbreviates a hand-built test case. The edge of `b` is not listed,
because the parent selector does not match it, and `b` keeps its version.

- A declaration, its lockfile record, and the observed graph are separate. Events
  are `declaration-added/removed/changed`, `source-changed`, and
  `lockfile-record-added/removed/changed`. A rule whose lockfile record changed
  while the declaration did not is reported as exactly that, with the record
  mismatch as a warning.
- The source follows `packageManager`: `pnpm-workspace.yaml` for pnpm 11 and later;
  `pnpm.overrides` and `resolutions` in `package.json` for pnpm 9 and 10. Other
  sources are shown and stay `unknown`.
- A selector range restricts the range that the dependent declares, not the
  resolved version, and a parent range restricts the dependent's own version. The
  lockfile does not record what a package declares, so target ranges are decided
  on workspace dependencies only. Edges are never matched by the name of the
  package they resolve to.
- When the declaration and record agree and every matching edge is decided, the
  rule's edge can make the dependent and the new package `explained`. Packages
  reachable only beyond that edge keep `unknown` with their path, because a
  matching rule does not show why they changed. Overlapping rules, undecidable
  edges, mismatches, hooks, and unsupported rules keep their warnings.

Supported rules are `name`, `name@range`, and `parent>child` selectors, scoped
names included, with an exact stable version or a stable registry range as the
value. See the [override reference](docs/override-contract.md) for the evidence
rules, JSON fields, and limits.

## Peer context changes

pnpm records the peer providers of a package instance as a suffix of its lockfile
key, and that suffix can change while every version stays the same. LockCone
compares the instances whose name and version exist on both sides:

```text
Peer context changes (committed keys, metadata, and edges; why pnpm chose a provider is not established):
  debug@4.4.3: provider-added (one-to-one)
    debug@4.4.3 → debug@4.4.3(supports-color@7.2.0) [holder-rekeyed]
      supports-color: (no provider) → supports-color@7.2.0 (provider-added; head: direct optional peer, declaration and edge agree)
    Workspace consumers (graph reachability, not runtime usage):
      head: . (pnpm-update-optional-peer-fixture): transitive consumer via devDependencies of debug@4.4.3(supports-color@7.2.0); uncertain (reasons: explain)
```

This output abbreviates the bundled lockfiles of
[pnpm/pnpm#14895](docs/acceptance/pnpm-14895/README.md), written by pnpm 12.4.1.

- A name in the suffix is not a binding by itself. A `direct` binding needs the
  peer declaration in the package metadata, the provider in the key, and a snapshot
  edge to that instance. A `transitive` context is inherited through a dependency
  edge and is labeled as such. Anything else is `unconfirmed` or `conflicting`, with
  its reason.
- Events are `provider-added/removed`, `provider-version-changed`,
  `nested-context-changed`, `evidence-changed`, and `instance-split/merged/added/removed`.
- Equal name and version do not pair two instances. Pairs are tied by the dependents
  that hold them. When those point at several instances, every possible pair is
  listed and the change is `ambiguous`.
- Nested and scoped contexts and patch hashes are read by structure. Hashed,
  malformed, or oversized suffixes are kept as written and give no bindings.
- `why` and `explain` add the declaration, the edges, and every consumer path.

The section reports what the two commits show. It does not say why pnpm chose a
provider, and it never changes a classification: an instance with a peer context
stays `unknown`. See the [peer context reference](docs/peer-contract.md) for the
evidence levels, pairing rules, JSON fields, and limits.

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
- Peer contexts in snapshot keys: `(name@version)` groups, nested and scoped, next to
  `patch_hash` groups. See the [peer context reference](docs/peer-contract.md#supported-forms).
- Patches declared as `patchedDependencies` in root `pnpm-workspace.yaml` or the
  root `package.json` `pnpm` field, recorded in the lockfile as a hash string or a
  `{ hash, path }` object, with name, exact-version, and registry-range selectors.
  Whether a source is read depends on `packageManager`; see the
  [patch reference](docs/patch-contract.md#supported-forms).
- Overrides declared in `pnpm-workspace.yaml`, `package.json` `pnpm.overrides`, or
  `resolutions`, recorded in the lockfile `overrides` map, with name, `name@range`,
  and `parent>child` selectors and an exact stable version or stable range as the
  value. See the [override reference](docs/override-contract.md#configuration-sources).

Traversal follows runtime and optional dependencies of linked workspaces; it
never inherits their development dependencies. Workspace identity changes
explain the workspace record itself, not its dependency upgrades.

Catalog aliases, prerelease/build ranges, tags, local/workspace/Git/URL catalog
values, external catalog files, and catalog override attribution are unsupported.
Override values such as `-`, `link:`, `workspace:`, `npm:`, `catalog:`, `$name`, tags,
and prerelease versions, convergence selectors (`name@`), peer edges, and per-project
overrides are not modeled, and neither are hooks, unknown configuration, and
incomplete edges: they retain conservative uncertainty. An unchanged `catalog:`
override whose catalog changed stays global uncertainty. Patches are reported in
detail, but their global warnings remain. Hooks are never executed. Global unmodeled
input changes can make all groups `unknown`; peer uncertainty applies to affected
instances and paths. Peer bindings are reported as observed: peer ranges are not
checked, hashed suffixes are not decoded, and a context change is never attributed
to a resolver decision.

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
`patches`, `overrides`, `peerBindings`, `changes`, `pathNodes`, `warnings`, and
`summary`.

`manifestChanges` contains actual manifest edits. `declarations.base/head`
separates original specifiers, catalog origins, effective ranges, observed
resolutions, and uncertainty. `declarationChanges` records intent and traversal
eligibility. `catalogChanges` records changed entries and their consumer IDs.

Each graph change includes before/after versions, changed instance IDs,
confidence, a reason, evidence, and edge/metadata details. Follow `evidence.root`
to a declaration on the same side; follow `pathId` through `pathNodes` to read
the dependency path. Metadata differences use `null` for an absent field.

`patches` was added in 0.3.0, `overrides` in 0.4.0, and `peerBindings` after 0.4.0,
all without changing the schema version. Each carries its own `reportVersion`
(currently `1`). `peerBindings` changes no other field. An evidence
entry gets a `via` field only when its path starts at an override edge; evidence of
declarations, catalogs, and patches is unchanged. Schema v4 consumers that ignore
unknown fields keep working.

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
      - uses: actions/checkout@v7
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
The [radix-ui/primitives case](docs/acceptance/radix-primitives/README.md) checks a
real patch change, a moved declaration, and the lockfile format change of a pnpm 11
migration against Git and the raw lockfile. The
[nitsuah/farm-3j case](docs/acceptance/farm-3j/README.md) checks a PostCSS override
repair: what the override analysis explains, and the manifest/lockfile mismatches
that keep every group `unknown`. The
[pnpm/pnpm#14895 case](docs/acceptance/pnpm-14895/README.md) checks an optional peer
context that appears at unchanged versions, on lockfiles reproduced with pnpm 12.4.1.

See [CONTRIBUTING.md](CONTRIBUTING.md) for checks, fixtures, and release procedures,
and [CHANGELOG.md](CHANGELOG.md) for release history. Use the GitHub issue forms
for bugs and feature requests; report vulnerabilities privately through
[SECURITY.md](SECURITY.md). Participation follows the
[code of conduct](CODE_OF_CONDUCT.md).

Licensed under [Apache-2.0](LICENSE).
