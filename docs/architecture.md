# Architecture Overview

Agent Workboard is a local-first React and Express application with a shared JSON-backed store. The browser UI, HTTP API, and MCP server all operate on the same project, task, capability, agent slot, presence, and Agent Talks data.

## Runtime Shape

```text
Browser UI (React/Vite)
  -> HTTP API (Express)
      -> WorkboardStore
          -> workboard.json
          -> uploads/

Agent MCP client
  -> stdio MCP server
      -> WorkboardStore
          -> same workboard.json and uploads/
```

The important design choice is that workflow rules live in the store, not separately in the UI, API routes, or MCP handlers. If a task transition, validation rule, completion record, capability link, agent slot, or talk message must behave the same for every caller, implement it in `server/storage/workboardStore.js` and expose it through the route or tool layer.

## Server Entry Point

`server/index.js` is the Node server entry point. It reads listen settings from `server/listenConfig.js`, creates a `WorkboardStore`, initializes persistence, builds the Express app with `createApp`, and starts listening.

Default data location is `.workboard-data/`, unless `WORKBOARD_DATA_DIR` is set. Default bind address is loopback through `WORKBOARD_HOST` handling in `server/listenConfig.js`.

Change this layer when you need to:

- adjust process-level startup, environment variables, or listen behavior
- add server-wide warnings or startup checks
- change where the local data directory is selected

Keep request behavior out of this file. HTTP behavior belongs in `server/app.js`; workflow behavior belongs in `server/storage/workboardStore.js`.

## Express API

`server/app.js` owns HTTP routing, request parsing, response shaping, attachment upload handling, static asset serving, and API error formatting.

The main API groups are:

- health and metadata: `/api/health`, `/api/meta`
- agent docs and slot bootstrap: `/api/agent-docs`, `/api/bootstrap`, `/api/agent-slots`
- presence and next-work helpers: `/api/agents/:agentId/presence`, `/api/agents/:agentId/next-task`, `/api/agents/:agentId/no-eligible-work`
- projects and tasks: `/api/projects`, `/api/tasks`, `/api/tasks/:taskId`, `/api/tasks/:taskId/claim`
- task evidence: `/api/tasks/:taskId/comments`, `/api/tasks/:taskId/attachments`, attachment download routes
- project coordination: `/api/projects/:projectId/talks`
- capability registry: `/api/capabilities`
- MCP discovery: `/api/mcp/tools`

Routes should stay thin. They should parse HTTP input, call the store, decorate output only when needed for presentation, and pass errors to the shared error handler. Before adding a new endpoint, check whether a current route already returns the required shape, especially under `/api/board-state`, `/api/tasks`, `/api/agents/:agentId/next-task`, or `/api/projects/:projectId/talks`.

Change this layer when you need to:

- add, rename, or remove an HTTP endpoint
- change upload limits or multipart handling
- add response decoration that is specific to HTTP clients
- update static `dist/` fallback behavior for production builds

After API changes, update `src/lib/api.js`, MCP tools if agents need the behavior, and tests in `tests/api.test.js` or targeted store tests.

## JSON Store And Workflow Rules

`server/storage/workboardStore.js` is the domain model and persistence layer. It defines:

- status, role, priority, completion, talk kind, and capability status enums
- default seeded projects, tasks, capabilities, agent types, and agent slots
- migrations for older JSON data
- project, task, capability, Agent Talks, presence, and agent slot operations
- claim, next-task, completion record, stale work, and capability-link rules
- comment and attachment metadata updates
- persistence to `workboard.json`

The store writes to `${WORKBOARD_DATA_DIR}/workboard.json`, or `.workboard-data/workboard.json` in local development. It serializes writes through `save()` and uses a filesystem lock for claim paths that need stale-safe read-modify-write behavior across processes. File writes go through a temporary JSON file and rename.

Change this layer when you need to:

- add fields to projects, tasks, comments, attachments, talk messages, capabilities, presence, agent slots, or completion records
- enforce validation that must apply to UI, API, and MCP callers
- change workflow transitions, task selection, queue sorting, or reviewer rules
- migrate existing local JSON data
- alter default seed data for new boards

When adding or changing fields, update the normalization and migration paths first. Then update HTTP routes, MCP schemas, UI payloads, and tests. Keep `workboard.json` backward compatible where practical because local operators may already have data in `.workboard-data/`.

## React UI

The frontend lives under `src/`. `src/main.jsx` mounts the app. `src/App.jsx` contains the board shell and current UI surfaces: project sidebar, board, task drawer, task creation, capability registry, agent registry, stale work, and Agent Talks. Supporting helpers are in `src/lib/`.

The API client is `src/lib/api.js`. It centralizes fetch calls, JSON error handling, FormData upload behavior, and `VITE_API_BASE` support. Vite proxies `/api` to the local Express dev server in `vite.config.js`; production serves the built `dist/` assets from Express.

Change this layer when you need to:

- add or alter operator-facing workflows
- update task drawer behavior, board controls, filters, or coordination views
- send new fields to the API
- display new store data returned by existing endpoints
- tune frontend-only derived views such as the agent registry

For UI changes, keep data loading in `App.jsx` near the existing API calls unless the feature is large enough to justify a new helper in `src/lib/`. If the UI starts sending a new field, add a focused regression test because strict store validation can expose mismatches quickly.

## MCP Server

`server/mcp.js` exposes the board to agent clients over stdio using the Model Context Protocol SDK. It creates its own `WorkboardStore` with the same `WORKBOARD_DATA_DIR` convention, registers tools, and shares workflow behavior with the HTTP API by calling the store.

`server/mcpToolHandlers.js` holds shared MCP helper constants and small patch builders. Tool names include agent instructions, project and task listing, capability lookup, task creation and claiming, agent slot acquisition, next-task selection, presence updates, no-work reports, status updates, task comments, and Agent Talks.

Change this layer when you need to:

- expose an existing store operation to agents
- update MCP input schemas when store fields change
- add a tool that should be callable without the browser UI
- keep agent docs aligned with available tool behavior

Do not duplicate workflow checks in MCP handlers. Add the rule to the store, then make the MCP schema accept the input needed to call it.

## Docker, Data Mounts, And Local Deployment

`Dockerfile` builds the Vite app, installs production Node dependencies, copies `dist/` and `server/`, sets `WORKBOARD_DATA_DIR=/data`, and exposes port `8080`.

`docker-compose.yml` runs the app as `agent-workboard`, publishes `127.0.0.1:8088:8080`, sets `WORKBOARD_HOST=0.0.0.0` inside the container so Docker can forward traffic, and bind-mounts `./.workboard-data:/data`.

The data directory is intentionally outside the image:

```text
.workboard-data/
  workboard.json
  uploads/
```

Change this layer when you need to:

- alter container startup, exposed ports, or production environment variables
- change where persistent local data is mounted
- add runtime dependencies that production needs
- document a deliberate hosted deployment boundary

Keep the default deployment local-first. If you expose it beyond loopback, put it behind an operator-approved access control layer.

## Upload Storage

Task attachments enter through `POST /api/tasks/:taskId/attachments` in `server/app.js`. Multer keeps uploads in memory with a 25 MB limit, then `WorkboardStore.addAttachment` writes the file to `uploads/` under the data directory.

The task stores attachment metadata, not the file bytes:

- generated attachment id
- sanitized original filename
- MIME type
- size
- SHA-256 hash
- stored filename
- uploader and timestamp

Downloads call `WorkboardStore.getAttachment`, look up the metadata on the task, and return the matching file from `uploads/`.

Change this layer when you need to:

- raise or lower upload size limits
- add attachment metadata
- change filename sanitization or hash behavior
- move file bytes to another storage backend

If storage moves away from the local filesystem, keep the task metadata shape stable or add a migration. Existing boards may already reference files in `.workboard-data/uploads/`.

## Future Work Placement

Auth and access control should start at the Express boundary, because every browser request enters through `server/app.js`. Once identity exists, pass the actor or principal into store methods so task activity, completion records, comments, and talk messages remain audit-friendly. MCP will need a parallel trust model instead of silently bypassing auth.

SQLite should replace the persistence internals of `WorkboardStore` without moving workflow rules out of the store. A practical migration path is to keep public store methods stable, add a storage adapter under `server/storage/`, migrate `workboard.json` into tables on startup or with a script, then update tests to cover both data migration and locking/concurrency behavior.

Agent registry work belongs in both store data and UI derivation. Persistent slot/type definitions, leases, presence, and next-task rules belong in `server/storage/workboardStore.js`. Operator-facing grouping and display logic belongs in `src/lib/agentRegistry.js` and the coordination components in `src/App.jsx`. MCP and agent docs should be updated whenever new registry fields affect how agents claim or report work.

## Change Checklist

Use this quick path when changing a layer:

- Store rule or data shape: update `server/storage/workboardStore.js`, migrations, API/MCP callers, UI payloads, and store/API tests.
- HTTP endpoint: update `server/app.js`, `src/lib/api.js`, MCP if agents need it, and `tests/api.test.js`.
- Agent tool: update `server/mcp.js`, `server/mcpToolHandlers.js`, agent docs if instructions change, and MCP-focused tests when available.
- UI workflow: update `src/App.jsx` or `src/lib/*`, then add a focused UI or e2e regression if it crosses the API.
- Deployment behavior: update `server/index.js`, `server/listenConfig.js`, `Dockerfile`, `docker-compose.yml`, and README security/deployment notes.
- Attachment behavior: update both `server/app.js` upload handling and `WorkboardStore` attachment methods, then test upload and download paths.
