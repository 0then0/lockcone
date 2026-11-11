# pnpm peer contexts

pnpm records which peer providers a package instance was resolved with as a suffix
of its snapshot key. The suffix can change while every package version stays the
same:

```text
debug@4.4.3
→ debug@4.4.3(supports-color@7.2.0)
```

LockCone reports such changes separately from version changes. It answers one
question: for a package whose name and version exist on both sides, which peer
providers do the two commits show, which instances and edges changed, and which
workspace projects reach them?

The report describes committed keys, metadata, and edges. LockCone does not install
anything, resolve a peer, check a peer range, query a registry, replay pnpm, or
execute hooks. It states the observed bindings and reachability. It does not state
why pnpm chose a provider, and `peerBindings.causality` is always
`not-established`.

## Supported forms

A snapshot key is `name@version` followed by parenthesized groups:

- `(name@version)`: a peer provider. Names may be scoped.
- `(name@version(…)(…))`: a provider with its own contexts, nested to any depth
  within the limits below. The text between the outer parentheses is the snapshot
  key of the provider.
- `(patch_hash=…)`: a patch hash, on the instance or on a provider. It is kept
  apart from the peers; see [patches](patch-contract.md).

The key is read by structure with an explicit stack. LockCone never splits it on
`(` or `@` alone. A key is read up to 4096 characters of context, 16 levels, and 256
groups. pnpm's `peersSuffixMaxLength` setting, 1000 characters by default, replaces
a longer suffix with a hash.

Everything else keeps its uncertainty and gives no bindings:

- `opaque`: a group that is neither `name@version` nor `patch_hash=`, such as a
  hashed suffix. Its providers are not readable from the key and are not
  reconstructed.
- `malformed`: unbalanced parentheses, text outside the groups or after a nested
  group, a peer named twice at one level, or several patch hashes.
- `limit`: a context beyond the length, depth, or group limit.

The raw key and the raw suffix are always kept (`id`, `rawContext`), and `problems`
says why a context was not read. A `malformed` or `limit` suffix is kept exactly as
written, patch hash included, and a malformed key is never taken for the same
context as a readable one. Provider versions such as `link:` or `file:`
references have no snapshot and stay `unconfirmed`.

## Evidence levels

A name in the suffix is not a binding by itself. LockCone compares four records
for every peer of an instance:

1. the peer **declaration** in `packages[name@version].peerDependencies`, and
   whether `peerDependenciesMeta` marks it optional;
2. the **provider in the key**;
3. the **snapshot edge** of the peer's name, in `dependencies` or
   `optionalDependencies`. pnpm 12.4.1 records a resolved optional peer under
   `optionalDependencies`;
4. the snapshot's `transitivePeerDependencies` list.

Each peer gets one `kind`:

- `direct`: the package declares the peer, the key names a provider, and the edge
  points at exactly that instance. The binding carries the declaration and the edge.
- `transitive`: the package does not declare the peer, and a dependency edge leads
  to an instance whose own context names the same provider. The binding lists
  those edges as `inheritedThrough`. This is an inherited context, not a peer of the
  package. `listedTransitive` says whether the snapshot lists the name; the list
  alone is not evidence, because pnpm also lists optional peers that no provider
  satisfies.
- `unconfirmed`: the key names a provider, but the declaration is missing and
  nothing inherits it, the snapshot has no edge, the package metadata is missing, or
  the provider has no snapshot.
- `conflicting`: the declared peer's edge points at another instance than the key.
- `unbound`: the package declares the peer, and neither the key nor an edge names a
  provider. An optional peer without a provider is the usual case.
- `own-dependency`: the package declares the peer and an edge resolves it, but the
  key does not carry it. That is an ordinary dependency edge. Its changes are
  reported with the graph changes, not as context changes.

`unconfirmed` and `conflicting` bindings appear in the change's `uncertainty` with
the note that explains them (`NO_PROVIDER_EDGE`, `SUFFIX_EDGE_MISMATCH`,
`NOT_DECLARED_NOT_INHERITED`, `METADATA_MISSING`, `PROVIDER_SNAPSHOT_MISSING`).
Contradictions are kept, not resolved.

## Which instances are compared

Only packages whose name and version exist on both sides are compared. A new or
removed version is a version change and stays with the graph changes. Instances are
identified by name, version, and peer context without patch hashes, so a patch-only
change is not a peer context change.

Equal name and version do not pair two instances. LockCone ties instances through
the dependents that hold them, importer entries included, and uses the most
specific identity that a dependent has on both sides:

- `same-holder`: the dependent is the same instance or importer entry on both
  sides.
- `holder-rekeyed`: the dependent kept its name and version but has another
  context itself, as when a context change propagates upward.
- `holder-version-changed`: only the dependent's name is the same. The pair is
  listed with an uncertainty note.

A pair is `established` when one such dependent points at exactly one instance on
each side. When the shared dependents point at several instances on a side, every
combination is listed with `support: "ambiguous"`, and the change is `ambiguous`.
No pair is chosen by traversal order or by similarity of the keys. Instances with no
shared dependent are `unlinked`: they are listed as possible pairs only.

`shape` describes the linked set:

- `one-to-one`, `split` (one base context, several head contexts), `merge`, and
  `many-to-many`. A context that exists on both sides counts as the same instance,
  so dependents moving onto an existing context read as a merge.
- `added` and `removed`: a parallel context appeared or disappeared with no
  counterpart.
- `unlinked`: changed contexts on both sides without a shared dependent.
- `same-context`: the key is identical on both sides, and only what supports its
  bindings changed.

## Binding changes

Each listed pair compares the bindings by peer name:

- `provider-added`, `provider-removed`
- `provider-version-changed`
- `nested-context-changed`: the provider's name and version are the same and only
  its own context differs.
- `evidence-changed`: the same provider, with a different `kind` or edge.

The change also lists `instance-split`, `instance-merged`, `instance-added`,
`instance-removed`, `context-unreadable`, and `patch-hash-changed` in `events`.
`bindingChanges` is `null` when a context is unreadable on either side. Unchanged
bindings are not printed in text; JSON keeps every binding of every listed
instance.

## Workspace consumers

Each listed instance has `consumers`: the workspace projects that reach it, one
shortest path per project, as in the [patch report](patch-contract.md#workspace-consumers).
Runtime and optional edges of linked workspaces are inherited, development
dependencies are not. An instance used by several projects lists each of them. At
most 50 consumers are listed per instance, and the reverse traversal covers at most
100 instances per side.

## Classification

The section is additive. It never changes a group's `confidence`, the `reason`, or
the `warnings`. An instance with a peer context stays `unknown`, as before, even
when every binding is `direct` and every pair is established. Hooks, unknown
configuration, missing data, and ambiguous pairs keep their uncertainty.

## JSON

`peerBindings` is added to every report without changing `schemaVersion`, which
stays `4`; the section has its own `reportVersion`, currently `1`.

```text
peerBindings.reportVersion  1
peerBindings.causality      "not-established"
peerBindings.changes[]      id, name, version, shape, ambiguous, events, base, head,
                            instancesOmitted, correspondences,
                            correspondencesOmitted, uncertainty
peerBindings.changesOmitted changes beyond the limit
peerBindings.limits         changes, instancesPerChangeSide, correspondencesPerChange,
                            edgesPerCorrespondence, consumersPerInstance,
                            consumerTraversalsPerSide, contextLength, contextDepth,
                            contextSegments
peerBindings.truncated      messages for omitted changes and traversals
```

An instance in `base` or `head` has `id`, `name`, `version`, `rawContext`,
`patchHash`, `contextStatus`, `problems`, `changed`, `metadata`, `bindings`,
`transitivePeerDependencies`, and the consumers. `changed` is `false` for a context
that also exists on the other side. A binding has `peer`, `provider`,
`providerVersion`, `nestedContext`, `kind`, `declaration` (`package`, `range`,
`optional`), `edge` (`holder`, `section`, `name`, `target`), `inheritedThrough`,
`inheritedOmitted`, `listedTransitive`, and `notes`. A correspondence has `base`,
`head`, `support`, `established`, the shared dependent `edges`, `edgesOmitted`,
`bindingChanges`, and `patchHash`.

To check a `direct` binding by hand, read `declaration.package` under `packages`
and `edge.holder` under `snapshots`. To check a `transitive` one, read each
`inheritedThrough` edge and the key of its target.

`why <package>` keeps the changes of that package, and the changes whose changed
instances name it as a provider.

## Text

```text
Peer context changes (committed keys, metadata, and edges; why pnpm chose a provider is not established):
  debug@4.4.3: provider-added (one-to-one)
    debug@4.4.3 → debug@4.4.3(supports-color@7.2.0) [holder-rekeyed]
      supports-color: (no provider) → supports-color@7.2.0 (provider-added; head: direct optional peer, declaration and edge agree)
    Workspace consumers (graph reachability, not runtime usage):
      head: . (pnpm-update-optional-peer-fixture): transitive consumer via devDependencies of debug@4.4.3(supports-color@7.2.0); uncertain (reasons: explain)
```

`diff` prints the changed bindings of each pair and the consumers. `explain` and
`why` add the declaration, the edge, the inheriting edges, the dependents that tie
a pair, every consumer path, and its uncertainty reasons. A pair that is not
established is marked `possible`.

## Limits

- At most 100 changes, 20 instances per side of a change, 16 correspondences per
  change, and 5 shared dependents per correspondence are listed. When the possible
  pairs of a change exceed the limit, none is listed and the change is `ambiguous`;
  the instances and their bindings remain.
- A change of version together with a change of context is not paired.
- Peer ranges are not checked against provider versions, and workspace peer
  declarations are not interpreted.
- Aliased, linked, and local providers are not confirmed.
- The dependents of a re-keyed dependent are matched by name and version, so two
  parallel chains that change together are ambiguous.
- The resolver is not replayed. The report cannot say why a context changed.

## Fixtures and validation

`tests/peers.test.ts` builds its repositories by hand for the parser, the evidence
levels, the correspondence shapes, consumers, limits, and determinism. The
lockfiles under `tests/fixtures/peers/pnpm-14895` were written by pnpm 12.4.1; the
[pnpm/pnpm#14895 case](acceptance/pnpm-14895/README.md) records how, and checks the
public CLI against the raw lockfiles.
