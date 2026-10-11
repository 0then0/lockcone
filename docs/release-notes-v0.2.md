# LockCone 0.2.0

LockCone can explain catalog-only dependency updates in root
`pnpm-workspace.yaml`, even when `package.json` keeps the same catalog reference.
Reports show the changed catalog entry, affected dependency declarations,
observed resolutions, and reachable package changes.

## Catalog support

- Default and named catalogs in runtime, development, and optional dependencies.
- Stable registry semver ranges and consistency checks against importer entries
  and any present catalog snapshots.
- Separate reference, effective declaration, catalog origin, and resolution data.
- Origin changes recorded without attributing unrelated package churn to them.
- Resolution-only changes reported without inventing declaration intent.
- Catalog peers recorded conservatively, without runtime traversal roots.

`why` preserves catalog context for matching direct dependencies, including
resolution-only changes. Other configuration, overrides, patches, hooks, unknown
fields, and incomplete graph data continue to produce uncertainty when relevant.

The [ni case study](acceptance/ni/README.md) demonstrates the result on unchanged
upstream commits. Six unknown groups in v0.1 become two explained and four
unexplained groups in v0.2. Reverse dependency edges remain outside the cone.
Reachability still provides evidence rather than proof of resolver causality.

## JSON compatibility

JSON reports use schema v4 instead of v3. Consumers must update their schema
checks. Schema v3 output is not available.

The new `declarations.base/head`, `declarationChanges`, and `catalogChanges`
fields describe declaration context and intent. `manifestChanges` still means
actual manifest edits. Existing graph change fields, path IDs, commands, and
exit-code meanings are preserved. Unknown and unexplained groups do not cause a
nonzero exit code.

See the [catalog reference](catalog-contract.md#json-reports) for field meanings
and how to follow declaration IDs and evidence paths.

## Limitations

Catalog npm aliases, prerelease/build ranges, dist-tags, local and workspace
catalog values, catalogs from external configuration, and catalog references in
overrides remain unsupported. Target installs, hooks, network resolution, and
resolver replay are never used to produce explanations.

See the [README](../README.md) for installation and commands, and the
[catalog reference](catalog-contract.md) for supported syntax and diagnostics.
