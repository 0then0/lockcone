# Case study: a catalog update in ni

This example compares two unmodified commits from
[antfu-collective/ni](https://github.com/antfu-collective/ni). A dependency's catalog
range and lockfile resolution change while the root manifest stays identical.
It demonstrates how LockCone distinguishes catalog intent from unrelated
lockfile changes.

## Input change

- Base: `a8da02adf4f6168a2b3cf7dbd30d24c5cbfbf186`.
- Head: `0e9a94e76f28666161245da8bdf48c2b892f69ef`.
- [Upstream commit](https://github.com/antfu-collective/ni/commit/0e9a94e76f28666161245da8bdf48c2b892f69ef).

```text
package.json: identical bytes
dependencies.package-manager-detector: catalog:prod → catalog:prod
catalogs.prod.package-manager-detector: ^1.6.0 → ^1.7.0
Importer resolution: 1.6.0 → 1.7.0
```

The root manifest has the same Git blob ID on both sides:
`50b294a9fc9518aeb1439962c148d392972e655a`. Its SHA-256 is
`4672036546ce5a176030561565e3e34509061cc7137127c8b8a375649d7b6b17`.

## Results

LockCone v0.1.0 reports six `unknown` groups because it does not interpret catalog
intent. LockCone v0.2.0 reports two `explained`, four `unexplained`, and no
`unknown` groups. No manifest changes or global warnings are reported by v0.2.

The explained groups are the importer dependency entry and the
`package-manager-detector` package instances. Their evidence follows:

```text
pnpm-workspace.yaml catalogs.prod.package-manager-detector
→ dependency:[".","dependencies","package-manager-detector"]
→ package-manager-detector@1.6.0 (base) / @1.7.0 (head)
```

The four unexplained groups are unchanged-version instances whose outgoing
edges to `package-manager-detector` change:

- `@antfu/install-pkg@1.1.0`.
- `@antfu/ni@30.1.0`, a dependency instance distinct from the root project.
- `bumpp@11.1.0`.
- `taze@19.14.1`.

These packages depend on the updated package; they are not reachable downward
from it. Their reverse-edge changes stay visible without a fabricated path or
claim about pnpm's resolver. Counts refer to change groups, not unique packages
or lockfile lines.

Read the complete reports:

- v0.1.0: [JSON](baseline.json), [text](baseline.txt).
- v0.2.0: [JSON](v0.2.json), [text](v0.2.txt).

## Reproduce the comparison

From a LockCone checkout with its development dependencies installed:

```bash
pnpm build
node examples/catalog-acceptance.mjs
```

The script clones ni without checkout into temporary storage. To use an existing
local repository containing both commits instead:

```bash
node examples/catalog-acceptance.mjs /path/to/ni
```

The script reads committed metadata, builds baseline LockCone v0.1.0 from
`440cdae7345b2aab7e3fd84b0ad5a318c3a98673` using the existing development
dependencies, and runs both analyzers in JSON and text modes. It also compares
classification and evidence on the non-catalog `upgrade`, `workspace`, and
`peer` fixtures.

It updates `tests/fixtures/ni`, the four reports in this directory, and
`provenance.json`. Review generated changes before committing them. Temporary
clone/build directories are removed afterward. No target dependencies are
installed; target scripts and hooks are never run. Git index, branches, and
history are not changed.

Each analyzer runs the equivalent of:

```bash
node dist/cli/index.js diff --cwd /path/to/ni \
  --base a8da02adf4f6168a2b3cf7dbd30d24c5cbfbf186 \
  --head 0e9a94e76f28666161245da8bdf48c2b892f69ef --format json
```

Repeat with `--format text` for the readable report.

## Verify the inputs and reports

[provenance.json](provenance.json) records input revisions, Git blob IDs, fixture
paths, source and report SHA-256 hashes, runtime versions, command arguments,
and measured summaries. Command paths use documented placeholders so the record
can be read and reproduced on another machine. Analyzer source hashes identify
the exact implementation even when it has no release tag.

Fixtures preserve every metadata file read from the upstream commits, including
nested test manifests. Manifests outside the root workspace are ignored by graph
construction. Neither declarations nor resolutions are edited for this example.
The upstream metadata declares pnpm 11.9.0; reproducing the analysis does not
require running that package manager.

This case has no changed peer context and the updated package has no modeled
outgoing dependencies. It therefore demonstrates direct catalog evidence and
reverse-edge handling, not every traversal or uncertainty scenario. Repository
regression tests cover transitive traversal, peers, workspace boundaries,
metadata changes, and malformed or inconsistent catalog inputs. See the
[catalog reference](../../catalog-contract.md) for the complete support boundary.
