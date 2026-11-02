# pnpm patches

LockCone 0.3 reports changes to pnpm patches separately from version changes. It
answers one question: the version of a dependency is unchanged, but its patch
changed. What changed, which package instances are tied to it, and which
workspace projects reach them?

The report describes committed bytes and metadata. LockCone does not apply a
patch, interpret its diff, run a command, query a registry, execute `pnpmfile`
or hooks, or decide whether an install would succeed. Graph reachability is not
runtime usage, a required rebuild, or proof of why pnpm resolved a package.

## Three independent observations

A patch has three records that can change independently. The report never merges
them into one "patch changed" verdict.

1. **Declaration.** The selector and file reference in configuration, with the
   source file and the original value.
2. **Patch file.** The exact committed bytes behind the reference.
3. **Lockfile metadata.** The `patchedDependencies` entry in `pnpm-lock.yaml` and
   the `(patch_hash=…)` suffix of package instances.

Each change lists the events it observed:

- `declaration-added`, `declaration-removed`
- `selector-changed`: the selector changed while the referenced file stayed the
  same. LockCone pairs a removed and an added selector only when that file is
  unique on both sides; otherwise it reports an addition and a removal.
- `source-changed`: the same selector moved between `package.json#pnpm` and
  `pnpm-workspace.yaml`.
- `path-changed`: the file reference changed. `content` tells whether the bytes
  stayed identical.
- `content-changed`: the bytes differ.
- `lockfile-entry-added`, `lockfile-entry-removed`, `lockfile-hash-changed`,
  `lockfile-path-changed`, `lockfile-shape-changed`.
- `input-unavailable`: a referenced file is missing, unreadable, or its path is
  unsupported. The report keeps this even when nothing else changed.

`content.status` is `changed`, `identical`, `one-sided` (the file exists on one
side only), `unavailable` (a referenced file cannot be read or compared), or
`no-file-reference` (neither side names a file, as with a pnpm 11 lockfile entry
that no configuration declares). `content.basis` is `sha256` or `git-blob`.

### Byte identity

LockCone hashes the exact blob bytes of the selected commit with SHA-256, without
text decoding or line-ending normalization. Files larger than 8 MiB are not read;
their Git blob IDs still distinguish identical from different bytes, and a note
explains that no digest was computed. At most 256 patch files are read per
commit.

The hash in the lockfile is shown as an opaque value with `hashAlgorithm:
"unconfirmed"`. LockCone compares it between the two sides, and it never checks
a file against it. pnpm 10.34.9 and 11.28.9 were observed recording the same
hash for a patch before and after a CRLF conversion, so changed bytes need not
change the hash and the reverse is possible after a pnpm update. When the two
signals disagree, the report states what it observed, for example
`CONTENT_CHANGED_LOCKFILE_HASH_UNCHANGED`, and draws no conclusion about an
install.

## Supported forms

Configuration is read from the committed root files:

- `patchedDependencies` in root `pnpm-workspace.yaml`.
- `pnpm.patchedDependencies` in root `package.json`.
- The `patchedDependencies` map in `pnpm-lock.yaml`, in either shape: a hash
  string, or `{ hash, path }` as written by pnpm 10. The shape is never used to
  infer the pnpm version.

Whether a configuration source is read depends on the declared `packageManager`
of the root manifest:

- pnpm 11 or later: `pnpm-workspace.yaml` is `active`. The `package.json` field
  is `inactive`: pnpm 11.28.9 and 12.5.1 ignore it with a warning. LockCone
  still shows such a declaration, but it does not apply it to instances.
- pnpm 10 or earlier: `package.json#pnpm` is `active`. `pnpm-workspace.yaml` is
  `unverified`, because LockCone only verified it with pnpm 10.34.9.
- No `packageManager`, or a value that is not `pnpm@…`: both sources are
  `unverified`.

Selectors follow the pnpm documentation:

- `name`: every version. `@scope/name` is supported.
- `name@1.2.3`: one exact version, including prerelease and build suffixes.
- `name@range`: ranges accepted by LockCone's registry-range parser
  (`^`, `~`, comparators, `||`, hyphen ranges, `x` and `*`).

Anything else, such as `name@latest` or `name@npm:other@1`, is an `unsupported`
selector. It stays visible, and the instances of that package name are linked as
`unknown` with the reason.

Patch paths are resolved inside the commit only, relative to the repository root.
Absolute paths, paths leaving the repository, symlinks, and submodule entries are
reported as unsupported and are never followed. LockCone resolves a path by
looking it up in the commit's tree, so a path through a symlinked directory is
simply absent. Paths are never passed to a shell.

Multiple workspace files, non-root configuration, `patchesDir`, global pnpm
configuration, and `allowUnusedPatches` are outside the model.

## Association with package instances

An instance is a snapshot key. Its patch hash is the `(patch_hash=…)` group, and
every other parenthesized group is its peer context. Different peer contexts and
versions are separate instances; nothing is paired by package name. A base
instance and a head instance are shown as counterparts only when name, version,
and peer context are identical, so a unique instance has at most one counterpart.

Each instance is linked to a selector with one of three associations:

- `lockfile-confirmed`: the instance's `patch_hash` equals the lockfile entry of
  a selector that matches its name and version.
- `selector-applicable`: a declared selector matches by supported syntax, but the
  lockfile instance carries no `patch_hash`. This shows applicability, not
  application.
- `unknown`: the data is insufficient or contradictory. The `reasons` say why.

When several selectors match, LockCone follows the documented priority of exact
over range over name. It marks the result `unknown` when two selectors of equal
priority match, for example overlapping ranges (pnpm 11.28.9 rejects those with
`ERR_PNPM_PATCH_KEY_CONFLICT`), when a higher-priority selector disagrees with
the instance's hash, when sources declare different files for one selector, or
when the instance's hash is absent from the lockfile.

Patched instances that match no selector appear under `patches.unlinked`.
Declaration and lockfile disagreements are listed as notes on the selector, for
example `DECLARED_WITHOUT_LOCKFILE_ENTRY`, `LOCKFILE_ENTRY_WITHOUT_DECLARATION`,
`LOCKFILE_PATH_DIFFERS_FROM_DECLARATION`, and `CONFLICTING_DECLARATIONS`.

## Workspace consumers

For each linked instance and side, LockCone follows dependency edges backwards to
the workspace importers that reach it. It uses the same graph as the dependency
cones: runtime and optional edges of linked workspaces are inherited, and a
workspace's development dependencies are not.

Each consumer records:

- `workspace` and `name`: the importer path and its package name.
- `relation`: `direct` if a dependency entry of that importer resolves to the
  instance, otherwise `transitive`. A consumer with several routes reports one
  shortest path.
- `section`: the dependency section of the first hop.
- `path`: node IDs from the importer's dependency entry to the instance.
- `basis`: the instance's association. A `selector-applicable` or `unknown`
  basis means the consumer reaches an instance whose patch is not confirmed.
- `uncertain` and `uncertainty`: whether any node on the path carries a peer
  context or other uncertainty under the existing graph rules. A `patch_hash`
  suffix alone also marks a node uncertain there, and the reasons say so.

Output is bounded. Each side traverses consumers for at most 100 instances, a
change lists at most 100 instances per side, and at most 50 consumers are listed
per instance. `consumersOmitted`, `instancesOmitted`,
and `truncated` report what was left out.

## Interaction with classification

Patch changes are not dependency roots. They do not change `changes`,
`confidence`, or `summary`, and they are never an error or a security finding.

- A patched instance key contains a parenthesized group, so the existing
  classifier already treats it like a peer context and reports it as `unknown`.
- Changed patch files, lockfile patch metadata, and workspace configuration keep
  their global warnings, such as `Resolution input changed: patches/x.patch`.
  They continue to make every group `unknown`.
- Explaining a patch association does not explain the other lockfile changes in
  the same commit pair. Those stay as they were.

A changed or missing patch file adds the same warnings as before. A configured
file that cannot be read (a symlink, a submodule, or a path outside the
repository) now gets `Configured patch file is unsupported: PATH (REASON)`
instead of being read or reported as missing. Over-limit files are compared by
Git blob ID. Unsupported selectors and inactive sources add notes under
`patches` but no global warning, so a repository with an unchanged patch setup
keeps its classification.

## JSON

`patches` is added to every report without changing `schemaVersion`, which stays
`4`. Consumers that ignore unknown fields keep working. The section has its own
`reportVersion`, currently `1`.

```text
patches.reportVersion  1
patches.pnpm           { base, head }: packageManager declaration and major version
patches.notes          configuration problems that belong to no selector
patches.changes[]      id, name, selector{base,head}, selectorKind, events, content,
                       observations, base, head
patches.unlinked       patched instances without a selector
patches.limits         instancesPerSide, consumersPerInstance
patches.truncated      messages for omitted traversal
```

`base` and `head` of a change are `null` when the selector is absent on that side.
Each side has `declarations` (source, status, original `reference`, normalized
`path`), `file` (`status`, `sha256`, `size`, `gitBlob`, `reason`), `lockfile`
(`hash`, `hashAlgorithm`, `path`, `shape`), `instances`, and `notes`. Each
instance has `id`, `name`, `version`, `peerContext`, `patchHash`, `association`,
`reasons`, `counterpart`, and `consumers`.

`why <package>` keeps the patch changes whose selector or linked instances name
that package.

## Text

`diff` prints the selector, events, references, byte identity, lockfile metadata,
instances, and consumers with their relation and basis. `explain` and `why` add
the full dependency path and the uncertainty reasons of every consumer. Patch
contents are not printed. Instance IDs are shortened to twelve hash characters in
text output only.

## Fixtures and validation

`tests/fixtures/patches` holds base/head repositories whose lockfiles were
written by pinned pnpm releases with `pnpm install --lockfile-only
--ignore-scripts`. `node examples/patch-fixtures.mjs` regenerates them and
`provenance.json`. That script needs network access and is separate from
analysis. Regeneration may change lockfile contents when the registry does.

- `content-change`: pnpm 11.28.9. Workspace `a` reaches the patched `is-odd`, and
  workspace `b` reaches the independent `ms`. The version is unchanged, the bytes
  and the lockfile hash change, and `b` never appears in the patch report.
- `path-only`, `declaration-added`, `line-endings`: a moved file, a new
  declaration, and a CRLF conversion whose lockfile hash did not change.
- `multi-version`: a name selector across two `ms` versions plus a scoped package.
- `shared`: a range selector on a transitive package with three consumers, one
  through a workspace link.
- `peers`: one patched package in two peer contexts.
- `pnpm10`: pnpm 10.34.9 with `package.json#pnpm` and the `{ hash, path }` shape.

Cases that real pnpm cannot produce, such as an unsupported selector, a missing
blob, overlapping ranges, and disagreeing metadata, are hand-built in
`tests/patches.test.ts`. Tests that commit to a temporary Git repository check
that working-copy edits, symlinks, submodules, and oversized files do not change
the committed comparison.

The [radix-ui/primitives case](acceptance/radix-primitives/README.md) checks the
public CLI on pinned upstream commits against Git and the raw lockfile.

## Limits

- Association shows what committed metadata supports. It is not evidence that a
  patch applied cleanly, or at all, at install time.
- pnpm may reject or ignore patches (unused or conflicting selectors, failing
  hunks). LockCone does not replay that.
- A lockfile written by one pnpm version is read by shape and keys, not validated
  against that version's writer.
- The `hash` algorithm and pnpm's normalization are not modeled.
- Patch files outside the commit, generated patches, and patches applied by
  tools other than pnpm are not seen.
- Reachability covers committed importers and edges the existing graph models.

## References

- [pnpm patch](https://pnpm.io/cli/patch) and
  [pnpm settings](https://pnpm.io/settings).
- [pnpm/pnpm#13307](https://github.com/pnpm/pnpm/issues/13307): a closed issue
  about reading a pnpm 10 `patchedDependencies` lockfile shape with a newer
  parser.
- [microsoft/rushstack#5837](https://github.com/microsoft/rushstack/issues/5837):
  a closed issue about pnpm 11 ignoring the `package.json` `pnpm` field.

Both issues are closed and are cited only to show why configuration source and
lockfile shape matter. LockCone does not claim to reproduce either defect or that
either applies today.
