# pnpm overrides

LockCone reports changes to pnpm `overrides` separately from version changes. It
answers one question: a rule changed, so which edges of the committed dependency
graph does it govern, did they resolve differently, and which workspace projects
reach them?

The report describes committed bytes and metadata. LockCone does not install
anything, resolve a version, query a registry, replay pnpm, execute `pnpmfile` or
hooks, or decide whether an install would succeed. A path is graph reachability,
not proof that a rule caused every update on it.

## Three independent observations

An override has three records that can change independently. The report never
merges them into one "override changed" verdict.

1. **Declaration.** A selector and a value in a configuration source that the
   declared pnpm reads.
2. **Lockfile record.** The top-level `overrides` map of `pnpm-lock.yaml`. pnpm
   writes the selector and the value after it has resolved `catalog:` and `$name`
   references, and compares the map with its own configuration on a frozen install.
3. **Observed graph.** The edges that the rule governs resolve to a different
   package on the two sides.

Each change lists the events it observed:

- `declaration-added`, `declaration-removed`, `declaration-changed`
- `source-changed`: the same selector moved between configuration sources.
- `lockfile-record-added`, `lockfile-record-removed`, `lockfile-record-changed`

A change in the graph is never an event of its own. It appears as the affected
`edges` of a rule that has at least one event. A rule with no event is not listed,
even when a package under it changed. Selectors are compared as written, so a
renamed selector is one removal and one addition.

`consistency` compares the two records on each side: `consistent`,
`record-differs`, `record-missing`, `record-without-declaration`,
`unsupported-declaration`, or `not-declared`. A record-only change always comes
with a `record-differs` side, and `observations` says so
(`RECORD_CHANGED_DECLARATION_UNCHANGED`). A changed declaration with an unchanged
record is `DECLARATION_CHANGED_RECORD_UNCHANGED`. A rule that changed while no
matching edge moved is `NO_OBSERVED_GRAPH_CHANGE`.

## Configuration sources

The declared `packageManager` of the root manifest selects the source, as it does
for [patches](patch-contract.md#supported-forms). The matching code was read in the
sources of pnpm 9.0.0, 10.34.9, 11.28.9, and 12.5.1.

- pnpm 11 or later: `overrides` in the root `pnpm-workspace.yaml` is `active`. The
  `package.json` fields `pnpm.overrides` and `resolutions` are `inactive`: pnpm
  11.28.9 lists `overrides` among the `pnpm` field keys it ignores, and the pnpm
  12.5.1 reader states that the legacy shape is no longer consulted. No read of
  `resolutions` was found in the pnpm 11.28.9 configuration and installer sources.
- pnpm 9 and 10: `pnpm.overrides` and the Yarn-compatible `resolutions` of the root
  manifest are `active`. pnpm merges them as `{ ...resolutions, ...pnpm.overrides }`,
  so `pnpm.overrides` wins for a selector declared in both. A shadowed entry is
  kept in the output and has no effect. `pnpm-workspace.yaml` is `unverified`.
  pnpm 10.34.9 does read it and lets a non-empty `overrides` replace the manifest
  map, but LockCone applies the rule of the patch settings and verifies the
  workspace file only from pnpm 11.
- No `packageManager`, or a value that is not `pnpm@…`: every source is
  `unverified`.

Overrides in an `unverified` source, or `overrides` inside the pnpm 12 per-project
`packageConfigs`, may replace or extend the confirmed rules. In that case no rule
is attributed, a note says why, and the conservative global comparison stays in
force. Overrides in an `inactive` source are shown as notes and ignored.

## Supported rules

A selector is `name`, `name@range`, `parent>child`, or `parent@range>child@range`.
Names may be scoped. The `>` that separates parent and child is the first one that
does not follow a space, `|`, or `@`, as in pnpm, so `leaf@>=1.0.0` and
`a@>=1.0.0 <2.0.0>leaf` parse as intended. A range must be a stable registry range
that LockCone's parser accepts: `^`, `~`, comparators, `||`, hyphen ranges, `x`, and
`*`. The value must be an exact stable version (`2.0.0`) or such a range (`^2.1.0`).

These forms keep their uncertainty and are never attributed:

- Values `-`, `link:`, `file:`, `workspace:`, `npm:`, `catalog:`, `$name`, git and
  URL specifiers, tags, prerelease or build versions, and other strings.
- Selectors with an empty range (`name@`, a pnpm 11 convergence override), a
  range outside the supported syntax, an unsupported package name, a second `>`, or
  surrounding whitespace.

An unsupported rule that might govern an edge (its target name equals the edge's
alias) makes that edge undecidable for every rule. The unsupported rule itself
stays in the global configuration comparison, so a change to it keeps `Workspace
configuration changed` or `Lockfile resolution configuration changed`.

### What a selector range restricts

The pnpm sources agree on this point from pnpm 9 to pnpm 12.

- The **target range** (`leaf@^1`) is compared with the range the dependent
  **declares** for the dependency. The rule applies when the two ranges intersect,
  when their text is identical, and never when the declared specifier is a protocol
  such as `workspace:`. The resolved version is not consulted.
- The **parent range** (`a@^1>leaf`) is compared with the version of the dependent
  package itself, with `semver.satisfies`.
- The **target name** is the dependency key in the dependent's manifest, which is the
  alias. A package behind an npm alias is not matched by its real name, and a rule
  for the real name does not govern an aliased edge.
- A parent-scoped rule wins over a generic rule for the same edge. Several matching
  rules of one tier are not resolved: pnpm picks the most specific one by a
  comparator that LockCone does not replay, so the edge is `ambiguous`.

Workspace projects are dependents too. A direct dependency of an importer can be
overridden, and a parent selector matches the importer's own `name` and `version`.

A lockfile records the resolved reference of a package dependency but not the range
the package declared. LockCone therefore cannot test a target range on the edges
between packages, and such edges are `undecidable`. A target range is decided only
on importer edges, where the manifest holds the declared specifier. A catalog
reference on an importer is `undecidable` for range selectors as well, because it is
not shown that the hook reads it before catalog resolution. Generic and parent-only
selectors need no declared range and are decided everywhere.

Edges that exist because of a peer dependency are counted and not attributed. Since
pnpm 11, overrides also reach peers that pnpm installs automatically, and peer
resolution is not modeled.

Range intersection uses the dense comparator semantics of node-semver, in which
`>1.0.0` and `<1.0.1` intersect. It was compared with node-semver 7.8.5 on about
870,000 range pairs and agrees except for ranges that contain the empty set such as
`1 <0.x`. The Rust implementation of pnpm 12 has the same structure; its range
algebra was not compared.

## Affected edges and consumers

An edge is a dependent, a dependency alias, and the package it resolves to. The
dependent is either a package snapshot or a dependency entry of a workspace
importer. For every rule with an event LockCone pairs the edges of the two sides:

- `same-holder`: the dependent instance exists on both sides. An edge whose target
  changed is listed.
- `holder-changed`: the dependent has a different version or peer context. The
  edge is paired only when the match is unique, and it is never attributed, because
  the dependent changed for its own reasons.

Only edges that changed are listed (at most 100 per rule); `observations` counts the
unchanged ones. Each side of an edge has `state` (`governed`, `shadowed`,
`ambiguous`, `undecidable`, `rule-absent`, `peer`) and, for a governed edge,
`observed`: whether the resolved package equals the exact value or satisfies the
range. `consumers` are the workspace projects that reach the dependent, one
shortest path per project, as in the patch report: runtime and optional edges of
linked workspaces are inherited, development dependencies are not. `relation` is
`direct` when the project declares the dependent itself, and the path ends with the
resolved package. At most 50 consumers are listed per edge, and the reverse
traversal covers at most 100 dependents per side (`truncated` reports the rest).

## Attribution and classification

Each rule has an `attribution`:

- `complete`: on every side where the rule is declared, the declaration is
  supported, the lockfile record equals the value, no matching edge is ambiguous or
  undecidable, and every governed edge resolves inside the value.
- `incomplete`: anything else. Each reason is also a global warning that starts with
  `Override SELECTOR (base|head):`, so the groups stay `unknown`.

A changed edge is attributed when the dependent is the same instance on both sides,
differs between the sides only in that edge, is governed on every side where the
rule exists, and is not governed by another rule on the other side. For such edges
an evidence path starts at a root `override:["SELECTOR"]` and runs through the
dependent to the package on each side. The group's `evidence` entry carries `via`:

- `reach: "edge"`: the dependent that holds the edge and the package it resolves to.
  With a `complete` rule and no other uncertainty these groups can be `explained`.
- `reach: "beyond-edge"`: packages reachable only from that package. The rule fixes
  the version of the edge, not the dependencies of the new version, so these paths
  are always uncertain: the group is `unknown` and the path is shown. A matching rule
  does not prove why those packages changed.

An update that no declaration and no attributed edge reaches stays `unexplained`
even in the same lockfile. An `incomplete` rule still shows its paths, with
`via.attribution: "incomplete"`, and never raises a group above `unknown`.

Only the entries that the report interprets leave the global configuration
comparison: supported rules of an active source in `pnpm-workspace.yaml`,
`package.json#pnpm`, or `package.json#resolutions`, and their lockfile records.
Everything else keeps its warning:

- unsupported rules, and a change in an `unverified` or `inactive` source;
- an unchanged `catalog:` value whose catalog changed (`Changed catalog … is
  referenced by unmodeled resolution configuration.`);
- hooks (`.pnpmfile.cjs`), `packageExtensions`, and every other workspace, manifest,
  or lockfile setting;
- manifest/lockfile mismatches of importers.

## JSON

`overrides` is added to every report without changing `schemaVersion`, which stays
`4`; the section has its own `reportVersion`, currently `1`. `evidence[].via` is
present only on override evidence, so evidence of ordinary declarations, catalogs,
and patches is unchanged.

```text
overrides.reportVersion  1
overrides.pnpm           { base, head }: packageManager declaration and major version
overrides.notes          configuration problems per side
overrides.changes[]      id, selector, parent, target, events, base, head,
                         attribution{level,root,reasons}, edges, edgesOmitted,
                         observations
overrides.limits         edgesPerRule, consumersPerEdge, edgeTraversalsPerSide
overrides.truncated      messages for omitted edges and traversals
```

`base` and `head` of a change are `null` when the rule has neither a declaration nor
a record on that side. Each has `declaration` (`source`, `sourceStatus`, `value`,
`valueKind`, `supported`, `problems`), `lockfile` (`value`), `consistency`, and the
`edges` counts (`candidates`, `governed`, `shadowed`, `ambiguous`, `undecidable`,
`peer`, `violating`). Each edge has `alias`, `section`, `change`, `pairing`,
`attributed`, `reasons`, and per side `holder`, `parent`, `declared`, `target`,
`targetVersion`, `state`, `observed`, `reasons`, and the consumers.

`why <package>` keeps the changes whose selector names the package, or whose edges
have it as dependent, alias, or target.

## Text

`diff` prints the selector, the declaration and record of each side, the
attribution, the changed edges with their state, and the consumers. `explain` and
`why` add every consumer path and its uncertainty reasons. Groups with override
evidence print `override SELECTOR (complete|incomplete) → …` as the path root, and
paths beyond the edge say that the rule does not show why the package changed.

## Fixtures and validation

`tests/overrides.test.ts` builds its repositories by hand, because a real pnpm run
queries a registry. They cover a global rule with consumer paths, a parent-scoped
rule with two parents and a parallel version, added, changed, and removed rules,
scoped names, selector range boundaries, an unrelated update in the same lockfile,
a declaration without a graph change, a record-only change, ambiguous overlap,
source selection by `packageManager`, alias edges, and regressions for `catalog:`
references, hooks, and unsupported values.

The [farm-3j case](acceptance/farm-3j/README.md) checks the public CLI on the
commits of a merged upstream pull request that updates a PostCSS override, against
Git and the raw lockfile.

## Limits

- LockCone matches rules to edges that the committed lockfile contains. It does not
  show that pnpm would produce that lockfile, or that an install succeeds.
- The declared range of a transitive dependency is not in the lockfile, so target
  ranges are not tested on package edges.
- Peer resolution, automatically installed peers, per-project overrides, convergence
  overrides, `-`, local and alias targets, and `catalog:` values are not modeled.
- Tie-breaking between overlapping rules is not replayed.
- Hooks and `packageExtensions` run before overrides in pnpm and can change which
  dependencies exist. They are never executed, and their changes stay global
  warnings.

## References

- [pnpm settings: overrides](https://pnpm.io/settings#overrides).
- Sources read: `hooks/read-package-hook/src/createVersionsOverrider.ts`,
  `config/parse-overrides/src/index.ts`, and `config/config/src/getOptionsFromRootManifest.ts`
  at v9.0.0 and v10.34.9; the `pnpm11/` equivalents plus
  `config/reader/src/getConfig/ignoredPnpmFieldKeys.ts` at v11.28.9;
  `pnpm/crates/package-manager/src/overrides.rs`, `overrides/selectors.rs`,
  `pnpm/crates/config-parse-overrides/src/lib.rs`, and
  `pnpm/crates/config/src/workspace_yaml/settings.rs` at v12.5.1.
