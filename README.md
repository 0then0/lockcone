# LockCone

**LockCone is git blame for dependency changes.**

Explain a large pnpm lockfile diff through the dependencies you intended to
change. LockCone compares two committed dependency graphs and shows paths from
changed manifest roots to changed packages. Reachability is evidence, not proof
of causality.

## A quick example

You update `vitest` in `package.json`. The lockfile also updates `vite`, `esbuild`,
and an unrelated `aws-sdk`:

```text
Manifest intent:
  vitest 4.1.10 → 4.1.11

Reachable from changed root:
  vitest → vite → esbuild

Outside dependency cone:
  aws-sdk 2.0.0 → 2.1.0
  UNEXPLAINED_BY_MANIFEST_CHANGE
  No path found from changed manifest dependencies.
```

This is an illustrative fixture, not a claim about those packages' published
dependency trees. Run the actual report locally with `pnpm demo`. No Git setup,
package downloads for the fixture, or AI service is needed.

## Build and run

Requires Node.js 22.12+ and pnpm 12.5.1 for development. The npm package has not
been published by this repository setup; build from source:

```bash
pnpm install --frozen-lockfile
pnpm build
node dist/cli/index.js --help
node dist/cli/index.js diff main..HEAD
node dist/cli/index.js diff --base origin/main --head HEAD
node dist/cli/index.js why esbuild --base origin/main --head HEAD
node dist/cli/index.js explain --format json
```

Use `--cwd /path/to/repository` to analyze another checkout. The repository must
have `package.json` and `pnpm-lock.yaml` at its Git root in both revisions.
LockCone reads committed files through Git; it does not check out revisions,
install target dependencies, run target scripts, or include uncommitted changes.

After building, `pnpm pack` creates an installable CLI archive. Its executable is
`lockcone`, so the equivalent installed command is `lockcone diff main..HEAD`.

## Commands

- `diff [base..head]`: compare exact commit states. A two-dot range does not use
  a merge base; three-dot ranges are rejected.
- `why <package>`: filter the report to that exact package name, including any
  matching direct dependency entries. A missing or unchanged package produces
  an empty change list and exit code 0.
- `explain [base..head]`: the full report, equivalent to `diff` in v0.1.

All commands accept `--base`, `--head`, `--cwd`, and `--format text|json`.
Without refs, comparison defaults to `HEAD~1..HEAD`, including for `why` and
`explain`. Ranges cannot be combined with explicit refs. Both commits must be
available locally; shallow clones may need more history.

Exit code **0** means analysis completed, even with unexplained or unknown
changes. Exit code **1** means invalid input, an unsupported lockfile, missing
files, or a Git/read/parse failure. LockCone does not call unexplained changes
invalid lockfiles or decide whether a PR should merge.

## How analysis works

1. Read each revision's manifests, workspace configuration, and lockfile.
2. Build separate graphs of exact package instances, importer dependency
   entries, and workspace packages. Keep peer suffixes and parallel versions.
3. Compare manifest dependency specifiers by workspace and dependency section.
   Additions, removals, workspace identity/version changes, and peer declarations
   are recorded as manifest intent. Workspace identity changes explain the
   workspace record itself; they do not make dependency upgrades explained.
4. Traverse each graph downward from changed roots. The old graph explains
   removed instances; the new graph explains added instances. Workspace links
   resolve relative to their importer and lead into that workspace's runtime and
   optional dependencies. They do not inherit the target's development tools.
5. Compare instances, dependency edges, and package metadata (including integrity)
   and attach an evidence path for each reachable changed instance.

The report groups package instances by package name, direct dependency entries
by importer/section/name, and workspace packages by path/name. `before` and
`after` list all versions in a group; `changedNodes` lists only changed instances.
Multiple versions are never arbitrarily paired as upgrades. An edge or integrity
change can therefore show the same version on both sides.

Summary counts are **change groups**, not lockfile lines, unique packages, or
individual version transitions. A direct upgrade usually produces both an
importer-resolution group and a package group. Metadata-only changes are reported;
formatting and mapping order changes are ignored.

### Confidence

- `explained`: every changed instance is reachable from a changed root in its
  corresponding graph, with no detected uncertainty.
- `partially-explained`: some changed instances in a group are reachable and
  others are outside the cone.
- `unexplained`: no path was found from changed manifest roots, with no detected
  modeling limitation. Reason: `UNEXPLAINED_BY_MANIFEST_CHANGE`.
- `unknown`: peer context, unsupported resolution inputs, or an incomplete graph
  prevent confident classification. Existing evidence paths are still included.

Possible explanations such as resolver updates, deduplication, and lockfile
regeneration are hypotheses, not detected causes. Unmodeled global configuration
or unresolved edges conservatively make all change groups `unknown`. Peer
uncertainty applies to affected instances and paths through them.

## Supported scope and limitations

- pnpm **lockfile v9**: one dependency document, optionally preceded by the pnpm
  environment document used by newer pnpm versions. Environment configuration
  changes produce a warning; that document is not analyzed as application packages.
- `dependencies`, `devDependencies`, `optionalDependencies`, scoped packages,
  npm aliases, and `workspace:*` links resolved as `link:` references.
- Shared workspace lockfiles, with importer paths identifying resolved members.
  Workspace membership supports `*`, `**`, `{a,b}`, and `!` package globs.
  Unsupported glob syntax warns; a matching manifest without a lockfile importer
  remains visible as manifest intent and warns that the lockfile is incomplete.
- Peer suffixes are preserved, but peer resolution is not simulated. Changes to
  catalogs, overrides, patches, custom pnpm configuration, or hooks produce
  uncertainty rather than a claim of causality. Hooks are never executed.
- Separate per-workspace lockfiles, custom lockfile locations, npm/yarn/Bun,
  other ecosystems, and SARIF are not supported in v0.1.
- Runtime/platform selection, global pnpm configuration, and external registry
  state are not reconstructed. This is graph evidence, not a solver replay.

LockCone is not a vulnerability scanner, an `npm audit` or Renovate replacement,
a package manager, a lockfile formatter, or an AI explanation system.

## JSON and CI

```bash
lockcone diff --base origin/main --head HEAD --format json > lockcone-report.json
```

The JSON object has `schemaVersion: 3`, resolved `base`/`head` commit IDs,
`manifestChanges`, `changes`, `warnings`, and `summary`. Each change includes
`kind`, `scope`, `change`, `before`, `after`, `changedNodes`, `confidence`, `reason`,
`evidence`, `details`, and `possibleExplanations`. Evidence contains `side`,
`node`, `root`, and a `pathId` into the shared `pathNodes` parent graph. Details
list changed edges, metadata field names, and `metadataDiff` entries with before
and after values (`null` means the field is absent). `manifestChanges.root` maps
those paths back to the manifest and dependency section. No diagnostic text is
mixed into successful JSON output; failures go to stderr.

The repository includes a composite [GitHub Action](action.yml). Once hosted,
replace `OWNER/lockcone@COMMIT_SHA` below with this repository and a reviewed
commit SHA. It builds LockCone and writes a JSON artifact path to `outputs.report`.
It does not install dependencies or run lifecycle scripts from the analyzed PR.

```yaml
name: Dependency changes
on: pull_request
permissions:
  contents: read
jobs:
  lockcone:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: OWNER/lockcone@COMMIT_SHA
        id: lockcone
        with:
          base: ${{ github.event.pull_request.base.sha }}
          head: ${{ github.event.pull_request.head.sha }}
      - uses: actions/upload-artifact@v6
        with:
          name: lockcone-report
          path: ${{ steps.lockcone.outputs.report }}
```

## Development

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm demo
```

The test fixtures cover direct and transitive upgrades, unrelated churn,
workspaces, and peer context changes. Additional tests cover old-graph removals,
parallel versions, cycles, aliases, malformed inputs, and the compiled CLI's
text/JSON interface. CLI tests use a deterministic Git transport double and do
not create commits or modify this repository's Git state.

Code is separated into Git reads (`src/git`), manifest validation
(`src/manifests`), the pnpm adapter (`src/pnpm`), graph traversal (`src/graph`),
analysis (`src/analysis`), rendering (`src/output`), and CLI commands (`src/cli`).
The graph model and traversal have no pnpm parser dependency; future package
manager adapters can provide the same graph structure.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines. Licensed
under [Apache-2.0](LICENSE).
