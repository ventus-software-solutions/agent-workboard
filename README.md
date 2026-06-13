# Agent Workboard

Agent Workboard is a local-first project and task board for coordinating AI agents.

It gives the operator a browser UI, gives agents an API/MCP surface, and keeps the first version small enough to run with one Docker command.

## Local Security Boundary

Agent Workboard is a local-first, unauthenticated board. By default, the API server and development UI bind to `127.0.0.1`, and the Docker Compose port publish is pinned to `127.0.0.1:8088`. Other processes on the same machine can use the board, but it is not exposed to the LAN by default.

For a deliberate remote or hosted deployment, set `WORKBOARD_HOST=0.0.0.0` for the Node server or container and adjust any Docker port mapping or Vite `--host` value explicitly. Put that deployment behind trusted access controls such as a VPN, reverse proxy authentication, or another operator-approved boundary before exposing it to a network.

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

Docker Compose publishes `127.0.0.1:8088:8080` on the host. The container process sets `WORKBOARD_HOST=0.0.0.0` only inside the container so Docker can forward the loopback-only host port.

Data is stored in `.workboard-data/`, which is gitignored and bind-mounted into the container. The same directory is used by the local MCP example so the browser UI and MCP tools operate on the same board.

## Run In Development

```bash
npm install
npm run dev
```

The API runs on `http://localhost:8080` and the Vite UI runs on `http://localhost:5174`. Both bind to loopback by default.

## Test

```bash
npm test
```

## Architecture For Contributors

See [Architecture Overview](docs/architecture.md) for how the Express API, JSON store, React UI, MCP server, Docker data mount, upload storage, and future auth/SQLite/agent registry work fit together.

## MCP

```bash
npm run mcp
```

The MCP server exposes project/task listing, task creation, slot acquisition, next-task selection, presence updates, idle reporting, claiming, status updates, and comments over stdio.

## Agent Bootstrap

Every agent can get its operating instructions from the board itself.

See the [agent spawning guide](docs/agent-spawning.md) for operator steps, specialist prompts, reviewer queue handling, blocked-agent signals, and cleanup.

For copy-paste continuous worker prompts, see [continuous agent prompt templates](docs/continuous-agent-prompts.md).

For a PM agent:

```text
You are pm-agent. Read http://localhost:8088/api/agent-docs/pm-agent?format=md and do what it tells you.
```

For generic slot-based spawning, prefer agent types:

```text
You are implementer. Read http://localhost:8088/api/agent-docs/implementer?format=md and do what it tells you.
```

Generic workers can acquire a concrete slot before claiming work. A worker can say `I am implementer`, then `POST /api/bootstrap` or MCP `acquire_agent_slot` assigns the next available matching concrete slot such as `implementer-backend-1`.

Queue-draining agents can call MCP `get_next_task` or `GET /api/agents/:agentId/next-task` after slot acquisition. The helper does not claim implicitly; it returns a `selection.claim` payload that can be passed to `claim_task`, or `selection.review` metadata for reviewer agents handling existing `status=review` tasks without overwriting the original assignee. Agents can heartbeat with `update_presence` and report an empty queue with `report_no_eligible_work`.

Useful endpoints:

- `GET /api/agent-docs`
- `GET /api/agent-docs/pm-agent`
- `GET /api/agent-docs/pm-agent?format=md`
- `GET /api/agent-slots`
- `GET /api/agents/presence`
- `GET /api/agents/:agentId/next-task`
- `POST /api/agents/:agentId/presence`
- `POST /api/agents/:agentId/no-eligible-work`
- `POST /api/bootstrap`
- `POST /api/agent-slots/acquire`

The same contract is available over MCP through `get_agent_instructions`, `acquire_agent_slot`, `get_next_task`, `update_presence`, and `report_no_eligible_work`.

Agent instructions include branch/worktree discipline. Implementation agents should claim a task, then create or switch to a task branch/worktree before editing files. The shared `main` checkout should stay available for the running local service and operator state.

Agents should claim work through MCP `claim_task` or `POST /api/tasks/:taskId/claim` with the expected current status and assignee when known. Do not claim by directly PATCHing `assignee` and `status`; generic task updates are for ordinary operator edits after ownership is clear.

Reviewer agents are the default merge owners. They should scan `status=review`, verify the branch or worktree evidence, merge approved work, comment the merge SHA and verification, and move the original task to `done`. Requested changes go back to `ready` or `blocked` with findings.

`done` is evidence-gated. A task can only move to `done` with a completion record:

- `completionType=merged` for code/docs implementation, with `commitSha`, optional `branch`, `mergedTo`, tests, and notes.
- `completionType=no-code` for PM/planning outputs, with notes.
- `completionType=audit-only` for reviews or investigations that did not merge code, with notes.
- `completionType=superseded` for duplicates, with `supersededByTaskId` or notes.

Older tasks that were already marked done before this rule are backfilled as `legacy-needs-audit` so the board does not pretend they were certified.

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
- `POST /api/tasks/:taskId/claim`
- `GET /api/agent-slots`
- `POST /api/bootstrap`
- `POST /api/agent-slots/acquire`
- `GET /api/agents/presence`
- `GET /api/agents/:agentId/next-task`
- `POST /api/agents/:agentId/presence`
- `POST /api/agents/:agentId/no-eligible-work`
- `POST /api/tasks/:taskId/comments`
- `POST /api/tasks/:taskId/attachments`
- `GET /api/tasks/:taskId/attachments/:attachmentId/download`
- `GET /api/agent-docs`
- `GET /api/agent-docs/:agentId`

## Open Source Status

This project is prepared for open-source release under the MIT license. Before publishing, the next useful pass is a security review for auth, project isolation, and hosted/team deployment assumptions.

For the first source release process, use the [v0.1.0 release checklist](docs/release-v0.1.0.md).

See the [Ventus OSS-to-commercial roadmap](docs/roadmap.md) for the local-first boundary, pre-OSS-launch requirements, and later hosted/team candidates.
