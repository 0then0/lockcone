# Contributing

Use Node.js 22.12+ and the pnpm version pinned in `package.json`.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

Keep changes focused and add a small fixture or regression test for analysis
changes. Fixtures are data only: never install them or execute their scripts.
Document unsupported resolution behavior and prefer `unknown` over a false
claim. Evidence should say “reachable from changed root”, not “caused by”.

Preserve deterministic JSON output and discuss report schema changes before
changing `schemaVersion`. Keep Git reads, parsing, graph analysis, and output
separate. Do not add network calls, AI services, or automatic failure policies to
the core analysis.

Pull requests should describe the behavior change, relevant limitations, and
checks run. Commit messages use Conventional Commits (`feat`, `fix`, `refactor`,
`chore`, `docs`, or `test`).
