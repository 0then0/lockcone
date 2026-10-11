# pnpm catalogs

Dependency graph reachability provides evidence, not proof of causality.
LockCone reads committed metadata and never asks a registry, installs target
packages, executes target hooks, rewrites lockfiles, or replays resolution.

## Supported lockfile format

The adapter supports pnpm dependency lockfile v9, including the existing optional
environment document. Catalogs entered pnpm in
[v9.5.0](https://github.com/pnpm/pnpm/releases/tag/v9.5.0).
The supported protocol and snapshot shapes follow pnpm 9.5.0, 10.11.0,
and 11.9.0. The [ni example](acceptance/ni/README.md) uses metadata generated
for pnpm 11.9.0.
This is a metadata format contract, not a guarantee for every pnpm release or
every configuration that pnpm itself supports. Other lockfile versions are
input errors. pnpm 12 adds workspace/local catalog forms; those stay outside
LockCone's registry-only catalog scope.

## Configure a catalog

Define catalogs directly in root `pnpm-workspace.yaml`:

```yaml
catalog:
  typescript: ^5.0.0
catalogs:
  prod:
    package-manager-detector: ^1.7.0
```

Then reference entries by dependency name in `package.json`:

```json
{
  "dependencies": { "package-manager-detector": "catalog:prod" },
  "devDependencies": { "typescript": "catalog:" }
}
```

Compare commits with `lockcone diff --base BASE --head HEAD`, or select a
package with `lockcone why package-manager-detector --base BASE --head HEAD`.
For installation and command options, see the [README](../README.md).

## Declaration evidence

Only catalogs defined directly in the root `pnpm-workspace.yaml` are expanded.
The default catalog may be written under `catalog` or `catalogs.default`, once.
Named catalogs are maps under `catalogs`. `catalog:` and `catalog:default` select
the default; `catalog:name` selects the named map. Lookup uses the manifest
dependency name, including a scoped name, without substituting a real package
name from another dependency or catalog.

The three observations remain separate:

```text
Declared reference: catalog:prod
Effective declaration: ^1.7.0
Observed importer resolution: 1.7.0
```

`dependencies`, `devDependencies`, and `optionalDependencies` are tracked
separately for each importer. pnpm's optional dependency precedence is preserved:
a dependency also declared optional is modeled through the optional importer
entry. The shadowed declaration is still recorded with `shadowedByOptional`
and no separate observed resolution or traversal root. Consumers of workspace
links do not inherit workspace development tools.
Peer declarations are recorded but never traversed as runtime roots. Effective
catalog changes in peers retain the existing conservative peer warning.

An effective declaration change creates intent for every consuming importer.
The old graph supplies deletion evidence, the new graph addition evidence.
Parallel versions, peer suffixes, metadata changes, edge changes, and shared
roots keep their identities. A report maps changed catalog entries to affected
declaration IDs; each evidence root maps to a declaration on its graph side.

Switching catalog names, spelling `catalog:` as `catalog:default`, or switching
between a literal and catalog reference with an identical effective range is
an `origin` change. It does not create a traversal root or explain arbitrary
churn. Equality here is exact declaration string equality; LockCone does not
prove equivalence of differently written ranges. A changed observed resolution
or catalog snapshot cache alone is not declaration intent. Unused supported
catalog entry changes are reported with empty consumer lists and create no cone
or global uncertainty by themselves.

## Registry range boundary

Catalog values support stable numeric semver declarations: `1.2.3`, `1.2`, `1`,
`*`, `x` wildcards, `^`, `~`, `=`, `>`, `>=`, `<`, `<=`, whitespace conjunctions,
hyphen ranges, and `||` alternatives. Numeric components must have no leading
zeroes and fit safe JavaScript integers. LockCone checks that an
observed stable version fits the supported declaration. It does not select
versions or reproduce resolver policy.

Prerelease/build syntax, dist-tags, `npm:` aliases inside catalog entries,
`workspace:`, `file:`, `link:`, Git/URL dependencies, recursive `catalog:` values,
and other syntax receive explicit unsupported-value diagnostics. Catalog aliases
are deliberately unsupported; LockCone never guesses a package's real identity.
Literal npm aliases and workspace links outside catalogs remain supported.

## Lockfile evidence and uncertainty

For v9, importer entries keep `{specifier: catalog:name, version: ...}`.
The optional top-level `catalogs.<name>.<dependency>` cache has string `specifier`
(effective declaration) and `version` (base resolution). Importer resolution may
add a peer suffix to that base version. Package metadata and instance snapshots
stay in `packages` and `snapshots`; the catalog cache is not a dependency graph.

When present, cache specifier must exactly match the workspace entry, its stable
version must fit the supported range, and each consumer importer must agree with
the cache base version. The importer specifier must match the manifest reference;
its observed base version must fit the effective declaration, even without a
cache. The cache is optional. Its absence alone does not create uncertainty
or substitute for a declared range or observed resolution.

Malformed YAML, duplicate YAML keys, non-map catalogs, non-string entries,
duplicate default definitions, and malformed cache records are input errors
(exit 1). Missing entries, unsupported string values, and mismatched validly
shaped evidence are uncertainty (exit 0). Under the existing warning policy,
these global input warnings conservatively make change groups `unknown`, while
retaining observed paths. They never allow `explained`.

Only supported workspace catalog entries are removed from the global workspace
config comparison. Only consistent cache entries with the two known fields are
removed from the global lockfile config comparison. Unknown cache fields,
unsupported values, other top-level fields, environment changes, overrides,
patches, and missing graph edges retain conservative behavior.
An unchanged catalog reference in unmodeled configuration, including overrides,
can change meaning when that catalog changes, and receives global uncertainty.
This check is conservative at catalog-name granularity and does not resolve
override selectors. Used catalog changes with an existing pnpm hook also remain
unknown, since hooks can inspect config; hooks are never executed. Unused entry
changes alone do not activate this hook warning. As before, merely having
unchanged non-catalog overrides or hooks is not proof of an effect.

Peer uncertainty remains on affected instances/paths, and changed workspace peer
declarations retain global uncertainty. External registry state, platform
selection, global pnpm inputs, peer-resolution simulation, and reverse-edge
attribution remain outside scope. The report describes reachable changes and
remaining uncertainty, not a proven reason for resolver choice.

## JSON reports

Schema version increases from 3 to 4. Existing graph change fields, path IDs,
`manifestChanges` (actual manifest edits), commands, and exit codes retain their
meaning. `declarations.base/head`, `declarationChanges`, and `catalogChanges`
add effective intent and origin evidence. `effectiveRange` stores the expanded
catalog value; for a literal declaration it retains the original specifier,
including existing supported literal protocols. `uncertainty` describes limits
separately from the declaration and observed resolution.

`declarationChanges.change` is `added`, `removed`, `effective-range`, or `origin`;
`traversal` explicitly records root eligibility. Join affected declaration IDs
and `evidence.root` to `declarations` or the before/after declaration records.
Then follow `pathId` into the `pathNodes` graph. `why` retains relevant
declarations, catalog consumer IDs, and evidence paths. Matching direct
dependencies keep their declaration context even when only resolution changes;
the text report labels this as context without declaration intent.
`UNEXPLAINED_BY_MANIFEST_CHANGE` remains the legacy reason code for no path from
declared intent, now including catalog intent. Consumers must recognize v4;
there is no schema v3 compatibility output mode.

## pnpm format references

- [Current pnpm catalogs documentation](https://pnpm.io/catalogs) and its
  [pnpm.io source](https://github.com/pnpm/pnpm.io/blob/main/docs/catalogs.md).
- [pnpm 11.9 protocol parser](https://github.com/pnpm/pnpm/blob/v11.9.0/pnpm11/catalogs/protocol-parser/src/parseCatalogProtocol.ts):
  trim the suffix; empty selects `default`.
- [pnpm 11.9 catalog config](https://github.com/pnpm/pnpm/blob/v11.9.0/pnpm11/catalogs/config/src/getCatalogsFromWorkspaceManifest.ts):
  singular `catalog` and `catalogs.default` conflict, even with identical contents.
- [pnpm 11.9 lookup](https://github.com/pnpm/pnpm/blob/v11.9.0/pnpm11/catalogs/resolver/src/resolveFromCatalog.ts):
  lookup by dependency alias/key, with diagnostics for missing/recursive entries
  and unsupported local/workspace values in that pnpm version.
- [pnpm 9.5 lockfile types](https://github.com/pnpm/pnpm/blob/v9.5.0/lockfile/lockfile-types/src/index.ts),
  [9.5 snapshot writer](https://github.com/pnpm/pnpm/blob/v9.5.0/pkg-manager/resolve-dependencies/src/getCatalogSnapshots.ts),
  [10.11 lockfile types](https://github.com/pnpm/pnpm/blob/v10.11.0/lockfile/types/src/index.ts),
  [10.11 snapshot writer](https://github.com/pnpm/pnpm/blob/v10.11.0/pkg-manager/resolve-dependencies/src/getCatalogSnapshots.ts),
  and [11.9 lockfile types](https://github.com/pnpm/pnpm/blob/v11.9.0/pnpm11/lockfile/types/src/index.ts).
  The [11.9 snapshot writer](https://github.com/pnpm/pnpm/blob/v11.9.0/pnpm11/installing/deps-resolver/src/getCatalogSnapshots.ts)
  retains the same specifier/base-version shape.
