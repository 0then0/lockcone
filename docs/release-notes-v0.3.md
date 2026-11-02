# LockCone 0.3.0

LockCone can answer the question "the version is the same, but the patch
changed". Reports now describe pnpm patch changes on their own, tie them to
package instances, and show which workspace projects reach those instances.

## What is new

- Separate events for declaration, selector, source file, file reference, exact
  patch bytes, and lockfile metadata, so a content change, a moved file, and a
  metadata-only change are not mixed into one "patch changed".
- Byte identity from the committed blob: SHA-256 without normalization. The
  lockfile hash stays an opaque pnpm value, and disagreements with the bytes are
  reported as observations.
- Associations with package instances: `lockfile-confirmed`, `selector-applicable`,
  or `unknown` with a reason. Peer contexts, multiple versions, scoped names,
  exact selectors, and registry ranges stay separate.
- Direct and transitive workspace consumers for base and head, with the dependency
  path and its uncertainty. This is graph reachability, not runtime impact.
- `explain` and `why` add the full paths; `diff` keeps the brief form.

See the [patch reference](patch-contract.md) for the supported forms, JSON fields,
and limits, and the [radix-ui/primitives case](acceptance/radix-primitives/README.md)
for a check against real upstream commits.

## Compatibility

- Commands, options, and exit codes are unchanged. Patch changes are not errors
  or security findings.
- JSON keeps `schemaVersion: 4`. The new `patches` field is additive and has its own
  `reportVersion` (1). Existing fields keep their meaning; the ni case study report
  is unchanged apart from `patches`.
- Classification is unchanged. Patched instances stay `unknown`, global patch
  warnings stay, and explaining a patch does not explain other resolution changes.
- A symlinked, submodule, or out-of-repository patch path now gets a
  `Configured patch file is unsupported` warning instead of being read as text.
  Patch files above 8 MiB are not read and are compared by Git blob ID.

## Limits

LockCone does not apply patches, replay pnpm's selection, or know whether an
install succeeded. The `package.json` `pnpm` field is shown but treated as inactive
for pnpm 11 and later, and unverified when `packageManager` is missing.
Non-root configuration, `patchesDir`, global pnpm configuration, and patches
applied by other tools are outside the model.
