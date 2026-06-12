# Agent Workboard

Agent Workboard is a local-first project and task board for coordinating AI agents.

It gives the operator a browser UI, gives agents an API/MCP surface, and keeps the first version small enough to run with one Docker command.

## What It Has

- Multi-project task board
- Kanban statuses: backlog, ready, in progress, review, testing, blocked, done
- Agent roles: PM, implementer, reviewer, tester, researcher, operator
- Project/task filtering
- Task comments and activity
- File attachments
- Docker deployment
- Stdio MCP server for agent tools

## Run Locally With Docker

```bash
docker compose up --build
```

Open `http://localhost:8088`.

Data is stored in `.workboard-data/`, which is gitignored and bind-mounted into the container. The same directory is used by the local MCP example so the browser UI and MCP tools operate on the same board.

## Run In Development

```bash
npm install
npm run dev
```

The API runs on `http://localhost:8080` and the Vite UI runs on `http://localhost:5174`.

## Test

```bash
npm test
```

## MCP

```bash
npm run mcp
```

The MCP server exposes project/task listing, task creation, claiming, status updates, and comments over stdio.

## Agent Bootstrap

Every agent can get its operating instructions from the board itself.

For a PM agent:

```text
You are pm-agent. Read http://localhost:8088/api/agent-docs/pm-agent?format=md and do what it tells you.
```

Useful endpoints:

- `GET /api/agent-docs`
- `GET /api/agent-docs/pm-agent`
- `GET /api/agent-docs/pm-agent?format=md`

The same contract is available over MCP through `get_agent_instructions`.

Agent instructions include branch/worktree discipline. Implementation agents should claim a task, then create or switch to a task branch/worktree before editing files. The shared `main` checkout should stay available for the running local service and operator state.

Reviewer agents are the default merge owners. They should scan `status=review`, verify the branch or worktree evidence, merge approved work, comment the merge SHA and verification, and move the original task to `done`. Requested changes go back to `ready` or `blocked` with findings.

Example:

```bash
git fetch origin main
git worktree add C:/git/wt-agent-workboard-implementer-01-claim-api -b implementer-01/claim-api origin/main
cd C:/git/wt-agent-workboard-implementer-01-claim-api
```

Example local MCP command:

```json
{
  "mcpServers": {
    "agent-workboard": {
      "command": "node",
      "args": ["C:/git/agent-workboard/server/mcp.js"],
      "env": {
        "WORKBOARD_DATA_DIR": "C:/git/agent-workboard/.workboard-data"
      }
    }
  }
}
```

## API

- `GET /api/projects`
- `POST /api/projects`
- `GET /api/tasks`
- `POST /api/tasks`
- `GET /api/tasks/:taskId`
- `PATCH /api/tasks/:taskId`
- `POST /api/tasks/:taskId/comments`
- `POST /api/tasks/:taskId/attachments`
- `GET /api/tasks/:taskId/attachments/:attachmentId/download`
- `GET /api/agent-docs`
- `GET /api/agent-docs/:agentId`

## Open Source Status

This project is prepared for open-source release under the MIT license. Before publishing, the next useful pass is a security review for auth, project isolation, and hosted/team deployment assumptions.
