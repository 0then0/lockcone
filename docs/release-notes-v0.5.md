# LockCone 0.5.0

LockCone can now answer "a peer context changed, so which provider moved and who
reaches it?". Reports describe changes of the peer suffix in pnpm snapshot keys on
their own, including changes that leave every package version the same.

## What is new

- Peer context changes for package instances whose name and version exist on both
  sides: the instance keys of both sides, the providers before and after, and the
  events `provider-added/removed`, `provider-version-changed`,
  `nested-context-changed`, `evidence-changed`, and
  `instance-split/merged/added/removed`.
- Evidence levels. A `direct` binding needs the peer declaration, the provider in
  the key, and a snapshot edge to that instance. A `transitive` context is inherited
  through a dependency edge. `unconfirmed` and `conflicting` bindings keep their
  reason.
- Optional peers, nested and scoped contexts, and patch hashes next to peers. Hashed,
  malformed, and oversized suffixes are kept as written and give no bindings.
- Instances are paired through the dependents that hold them. Possible pairs stay
  `ambiguous`, and nothing is paired by name and version alone.
- Workspace consumers with paths for every listed instance. `explain` and `why` add
  the declaration, the edges, and the uncertainty reasons.

See the [peer context reference](peer-contract.md) and the
[pnpm/pnpm#14895 case](acceptance/pnpm-14895/README.md).

## Compatibility

- Commands, options, and exit codes are unchanged.
- JSON keeps `schemaVersion: 4`. The `peerBindings` section is additive with its own
  `reportVersion` (1).
- No classification or warning changes. An instance with a peer context stays
  `unknown`, and the section never states why pnpm chose a provider.
- Development dependencies were updated for published advisories in Vitest, Vite,
  and source-map-js. The release archive has the same runtime dependencies as 0.4.0.

## Limits

A change of version together with a change of context is not paired. Peer ranges
are not checked, aliased, linked, and local providers are not confirmed, and two
parallel chains that change context together are reported as ambiguous. The
resolver is not replayed.
