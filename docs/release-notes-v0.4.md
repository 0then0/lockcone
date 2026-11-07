# LockCone 0.4.0

LockCone can now answer "an override changed, so what did it move?". Reports
describe pnpm `overrides` changes on their own, tie them to the dependency edges
they govern, and show which workspace projects reach those edges.

## What is new

- Separate events for the declaration, its source, and the lockfile record, so a
  record-only change is not mistaken for a declaration change.
- Supported rules: `name`, `name@range`, and `parent>child` selectors (scoped names
  included) with an exact stable version or a stable registry range as the value.
  A selector range restricts the declared range, and a parent range restricts the
  dependent's version, as in the pnpm sources.
- The configuration source follows `packageManager`: `pnpm-workspace.yaml` for pnpm
  11 and later, `pnpm.overrides` and `resolutions` for pnpm 9 and 10.
- Evidence paths from a governed edge. A complete rule can make the dependent and the
  new package `explained`; packages beyond the edge stay `unknown`.
- `explain` and `why` show consumer paths and uncertainty reasons.

See the [override reference](override-contract.md) and the
[farm-3j case](acceptance/farm-3j/README.md).

## Compatibility

- Commands, options, and exit codes are unchanged.
- JSON keeps `schemaVersion: 4`. The `overrides` section is additive with its own
  `reportVersion` (1), and `evidence[].via` appears only on override evidence.
- Supported, fully accounted overrides no longer trigger the global
  `Workspace configuration changed` and `Lockfile resolution configuration changed`
  warnings. Unsupported rules, hooks, `catalog:` overrides, and manifest/lockfile
  mismatches keep them.

## Limits

Peer edges, per-project overrides, convergence selectors, `-`, local, alias, and
`catalog:` values are not modeled, and target ranges are not tested on edges between
packages, because a lockfile does not record declared ranges.
