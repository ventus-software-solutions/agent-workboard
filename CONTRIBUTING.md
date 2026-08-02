# Contributing

Agent Workboard is early and intentionally small. Keep changes focused, tested, and useful to the operator/agent workflow.

## Local Setup

Requires Node.js 20.11 or newer. The default SQLite store shells out to the `sqlite3`
command, so install it and make sure it is on `PATH` before running the tests; without it
the SQLite persistence tests fail with `spawn sqlite3 ENOENT`. To skip SQLite entirely,
set `WORKBOARD_STORAGE=json`.

```bash
npm install
npm test
npm run dev
```

## Docker Check

```bash
docker compose up --build
```

Open `http://localhost:8088`.

## Before Opening A Pull Request

GitHub Actions CI runs `npm install`, `npm test`, and `npm run build` on every pull request and on pushes to `main`. It does not require repository secrets, so external contributors can validate ordinary changes without release credentials.

- Run `npm test` and `npm run build`.
- Keep examples, fixtures, and docs free of machine-specific absolute paths.
- Do not commit `mcp.json`; copy `mcp.example.json` and fill in your own paths.
- Report suspected vulnerabilities privately, per [SECURITY.md](SECURITY.md), instead of opening an issue.

## Contribution Shape

- One logical change per pull request.
- Add or update tests for new behavior.
- Keep the UI operator-first: clear projects, clear ownership, clear status, clear evidence.
- Keep the agent interface scriptable: every UI action that agents need should also be possible through API or MCP.
- Do not add hosted/cloud assumptions without documenting the security model.

## Current Priority Areas

- Drag-and-drop task movement.
- Stronger MCP smoke tests and client examples.
- Browser/e2e coverage.
- Auth and role enforcement design.
- Better task detail hierarchy for review/test evidence.
