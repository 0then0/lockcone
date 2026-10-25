# Security policy

## Supported versions

Security fixes target the latest patch release in the 0.2 series. Older series
are not maintained; upgrade to a supported release before reporting an issue
that has already been fixed.

## Report a vulnerability privately

Email the maintainer at [zheltov_pe@mail.ru](mailto:zheltov_pe@mail.ru) with the
subject `LockCone security report`. Do not open a public issue or pull request
with exploit details before the report has been assessed.

Include:

- The affected LockCone version, Node.js version, and operating system.
- Reproduction steps and minimal input files, with secrets and private data removed.
- The observed impact and any proposed mitigation or fix.

The maintainer will assess the report and coordinate a fix and disclosure when
appropriate. Response times depend on maintainer availability; there is no
promised response deadline.

## Scope and safe use

LockCone parses repository-controlled manifests, YAML, and lockfiles and reads
committed data through Git. Reports of unintended command execution, unsafe path
handling, sensitive-data disclosure, terminal injection, or resource exhaustion
in these paths are relevant security reports.

Core analysis does not install target dependencies, execute target scripts or
hooks, or query registries. The GitHub Action installs LockCone's own build
dependencies. Pin the action to a reviewed commit SHA and give workflows only
the permissions they need. Never run untrusted pull-request code in a privileged
`pull_request_target` workflow.

LockCone is not a vulnerability scanner. An `explained` dependency change is
reachability evidence, not a security assessment. Ordinary incorrect reports
and unsupported inputs belong in the public bug tracker unless they have a
security impact.
