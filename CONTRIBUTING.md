# Contributing

Agent Workboard is early and intentionally small. Keep changes focused, tested, and useful to the operator/agent workflow.

## Local Setup

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
