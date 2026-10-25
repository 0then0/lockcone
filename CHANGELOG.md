# Changelog

User-visible changes are recorded here. Version links lead to the published
release or the corresponding comparison of commits.

## [Unreleased]

### Security

- Update Zod from 4.6.5 to 4.6.7, which includes the fix for collection-validation
  memory exhaustion ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)).

### Added

- Monthly Dependabot checks for GitHub Actions, with grouped minor/patch updates,
  a single open version-update PR, and a seven-day cooldown.
- EditorConfig settings and Git attributes that preserve fixture bytes.
- Bug report and feature request forms, a pull request template, a code of
  conduct, and a security reporting policy.

### Changed

- Ignore rules now cover the project's build output, release archives, local
  caches, and environment files without unrelated framework rules.
- CI cancels superseded runs; CI and release jobs have explicit timeouts.
- Contributor and release documentation links to the project policies and changelog.

## [0.2.0]

### Added

- Default and named pnpm catalogs in runtime, development, and optional dependencies.
- Declaration intent and origin evidence for catalog-only updates.
- Consistency checks for catalog entries, snapshots, and importer resolutions.
- Catalog context in `why`, including changes to resolution alone.
- A reproducible ni case study with pinned inputs and baseline comparisons.

### Changed

- JSON reports use schema v4 with `declarations`, `declarationChanges`, and
  `catalogChanges`. Schema v3 output is not available.
- Catalog origin changes with the same effective range do not create traversal
  roots. Resolution-only changes do not become declaration intent.
- Supported catalog updates no longer produce blanket configuration uncertainty;
  unsupported or inconsistent evidence remains conservative.

See the [v0.2 release notes](docs/release-notes-v0.2.md) for compatibility and limits.

## [0.1.0]

### Added

- `diff`, `explain`, and `why` commands for committed pnpm v9 dependency graphs.
- Old/new graph traversal, workspace handling, evidence paths, and text/JSON reports.
- Conservative classification for peer context and unsupported resolution inputs.
- A composite GitHub Action and release archives with SHA-256 checksums.

[Unreleased]: https://github.com/0then0/lockcone/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/0then0/lockcone/releases/tag/v0.2.0
[0.1.0]: https://github.com/0then0/lockcone/releases/tag/v0.1.0
