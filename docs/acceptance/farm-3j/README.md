# Case study: a PostCSS override in nitsuah/farm-3j

This case runs the public CLI on the two commits of
[pull request 416](https://github.com/nitsuah/farm-3j/pull/416) of
[nitsuah/farm-3j](https://github.com/nitsuah/farm-3j), a merged upstream change.
The pull request regenerates `pnpm-lock.yaml` so that its recorded `postcss`
override matches `package.json`. It is a historical change and a metadata
comparison. It does not show that an install succeeds or fails.

## Inputs

- Base: `f509a0c41604139766ba0e6d4bfbe18413479625`, the parent of the pull request
  commit.
- Head: `e9aa40fb36eaaf770587fbcfcc95d470abfd6fa7`, the only commit of the pull
  request. The squash commit `d708cc7a55aa6fe12c0240db7976ca7a1bd7de3e` has the
  same parent and the same tree.
- The pair changes one file, `pnpm-lock.yaml` (196 additions, 234 deletions).
- `packageManager: pnpm@9.0.0` on both sides, no `pnpm-workspace.yaml`. The root
  `package.json` declares ten `pnpm.overrides`, among them `postcss: "8.5.32"`, and
  that declaration is identical on both sides.
- The lockfile records `overrides.postcss`: `8.5.31` at base and `8.5.32` at head.

So the base lockfile was stale: the declaration said 8.5.32 while the lockfile
recorded and resolved 8.5.31. The commit message of the pull request describes the
same repair (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`).

## Before and after

LockCone at `e39e2f3`, before override analysis, reported 63 change groups, all
`unknown`, with 11 warnings. One of them, `Lockfile resolution configuration
changed.`, did not say which setting changed or whether it mattered.

With override analysis the report has the same 63 groups, all still `unknown`, and
12 warnings. The generic lockfile warning is gone and two override warnings take its
place, next to the same ten importer-entry mismatches.

## What the new logic explains

The `overrides` section has one rule, `postcss`, with one event,
`lockfile-record-changed`:

- Declaration: `package.json#pnpm` (active for pnpm 9), `"8.5.32"` on both sides.
  There is no declaration event.
- Lockfile record: `"8.5.31"` → `"8.5.32"`. Base `consistency` is `record-differs`,
  head is `consistent`.
- Attribution: `incomplete`, because the base side disagrees with its own
  declaration. The reasons are the record difference and four governed edges that
  resolve to 8.5.31 instead of the declared value. They are global warnings.

Five edges have the alias `postcss` on each side. One is a peer edge of
`autoprefixer`, counted and not attributed. The other four changed target from
`postcss@8.5.31` to `postcss@8.5.32` and all resolve inside the value at head:

- `@tailwindcss/postcss@4.3.3`: the same dependent on both sides. Its evidence path
  starts at the rule and is attributed, kept uncertain by the base disagreement. The
  consumer is the root importer, through its development dependency.
- The root importer's `devDependencies.postcss`: not attributed. The entry differs
  in more than this edge, because its recorded `specifier` also changed from `8.5.31`
  to `8.5.32`. That specifier is one of the existing manifest/lockfile mismatches.
- `next` and `vite`: not attributed. The dependent itself changed (`next` 16.4.2 →
  16.4.3, `vite` with a new peer context), so the edge may have changed for another
  reason. They are listed with their consumers.

Two of the 63 groups, the packages `postcss` and `@tailwindcss/postcss`, carry
override evidence, shown as `override postcss (incomplete) → …`. Both stay
`unknown`.

## Where uncertainty remains

All 63 groups stay `unknown` for reasons that are not about the override:

- Ten dependency entries of the root importer have a manifest/lockfile mismatch.
  The base lockfile specifiers lag the manifest (`next` 16.4.2 against 16.4.3, `lucide-react`, `@types/node`, and
  others), which is the same staleness as the override record. These warnings are
  global and cover every group.
- The base side of the `postcss` rule is inconsistent, so even its attributed edge
  cannot be promoted.
- Peer contexts and the many unrelated version bumps of the regenerated lockfile have
  no path from any declaration or rule.

The new logic therefore explains the origin of the former generic warning and ties
five edges to the rule with their consumers, and it declines to explain the groups.
That matches the situation: the pull request repairs a stale lockfile rather than
changing a dependency decision.

[evidence.json](evidence.json) holds the `overrides` section, the text excerpt, the
warnings, the summary, and the independent readings below.

## Independent checks

The script reads the same commits with Git and parses the lockfile with the `yaml`
package. It does not import LockCone.

- The head commit's parent is the base commit, the squash commit has the same tree,
  and only `pnpm-lock.yaml` differs.
- The manifest declares `postcss: 8.5.32` and the lockfile records `8.5.31` and
  `8.5.32`, as reported.
- A scan of the raw lockfile finds five `postcss` dependency entries on each side
  (the root importer and four snapshots, one of them a peer). At base all four
  non-peer entries resolve outside the declared value, at head none does. LockCone's
  `governed`, `peer`, and `violating` counts equal these numbers.
- Each listed edge has the reported target in the raw lockfile, and every consumer
  path ends at that target.

## Reproduce

```bash
pnpm install --frozen-lockfile
pnpm build
node examples/override-acceptance.mjs
```

The script clones the repository without a checkout into temporary storage, so no
dependency or script of farm-3j runs. It needs network access and rewrites
`evidence.json`. Pass the path of an existing clone as an argument to reuse it.
