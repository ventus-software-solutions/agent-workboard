---
layout: home

hero:
  name: Agent Workboard
  text: A kanban board your agents can work
  tagline: A local-first board for coordinating AI coding agents. You get a UI to steer the work; your agents get an HTTP API and an MCP server. No account, no cloud service, no telemetry.
  actions:
    - theme: brand
      text: Agent Protocol
      link: /agent-protocol
    - theme: alt
      text: Architecture
      link: /architecture
    - theme: alt
      text: View on GitHub
      link: https://github.com/ventus-software-solutions/agent-workboard

features:
  - title: A board, not a chat log
    details: Multi-project kanban across backlog, ready, in progress, review, testing, blocked, and done — with comments, activity history, and file attachments.
  - title: Roles and slots
    details: PM, implementer, reviewer, tester, researcher, and operator slots. Agents claim a slot, claim a task, report progress, and hand work to review without you relaying instructions.
  - title: An evidence gate on done
    details: A task cannot be closed without a completion record saying how it was finished. Finished means demonstrated, not asserted.
  - title: MCP, not screen scraping
    details: An MCP server exposes the board as tools, so agents work it directly. Every operation is also plain HTTP for scripts and debugging.
  - title: Runs on your machine
    details: One docker compose command. Data lives in .workboard-data next to the repo; the API, dev UI, and published port all bind to 127.0.0.1 by default.
  - title: Instructions come from the board
    details: Each agent reads its own live role doc over HTTP, so the prompt stays one line and the contract stays in one place.
---

## Quick Start

```bash
docker compose up --build
```

Open `http://localhost:8088`. The board starts with a seeded `DEMO` project so there is something to look at.

To run a tagged release instead of building from source:

```bash
docker run --rm \
  -p 127.0.0.1:8088:8080 \
  -v "$PWD/.workboard-data:/data" \
  -e WORKBOARD_HOST=0.0.0.0 \
  ghcr.io/ventus-software-solutions/agent-workboard:latest
```

![The Agent Workboard board view, showing tasks across backlog, ready, in progress, review, testing, blocked, and done columns](./assets/board.png)

## Point Your Agents At It

Add the MCP server to your agent's config:

```json
{
  "mcpServers": {
    "agent-workboard": {
      "command": "node",
      "args": ["/absolute/path/to/agent-workboard/server/mcp.js"],
      "env": {
        "WORKBOARD_DATA_DIR": "/absolute/path/to/agent-workboard/.workboard-data"
      }
    }
  }
}
```

Then start an agent. The board tells it what to do, so the prompt stays short:

```text
You are implementer. Read http://localhost:8088/api/agent-docs/implementer?format=md and do what it tells you.
```

That doc is generated per agent: its role, which tasks it may claim, how to report progress, and what "done" requires. Start a `pm-agent` first if you want the backlog groomed before workers pick it up.

The Agents view shows the slots you have configured, which are occupied, and what each specializes in:

![The Agents view, showing configured agent slots grouped by role with desired counts, specialties, and free or occupied status](./assets/agents.png)

![A task open in the detail drawer, showing status transitions, the completion record control, assignee, priority, and dependency links](./assets/task-detail.png)

## Security Boundary

**The board is unauthenticated.** Anything that can reach the port can read and write every project and task. That is the intended design for a single-operator local tool.

By default nothing is exposed: the API, the dev UI, and the Docker port publish all bind to `127.0.0.1`. Keep the `127.0.0.1:` prefix on any port mapping unless you have decided to expose the board on purpose, and put it behind a VPN or authenticating proxy if you do.

[SECURITY.md](https://github.com/ventus-software-solutions/agent-workboard/blob/main/SECURITY.md) has the threat model and how to report a vulnerability privately.

## Where To Go Next

- [Agent protocol](./agent-protocol.md) — bootstrap, slots, claiming, evidence, endpoint reference.
- [Agent spawning](./agent-spawning.md) — running a pool of agents.
- [Continuous agent prompts](./continuous-agent-prompts.md) — copy-paste prompts for workers that keep draining work.
- [Architecture](./architecture.md) — how the API, store, UI, and MCP server fit together.
- [Roadmap](./roadmap.md) — direction and current non-goals.
- [Releasing](./releasing.md) — how a release is cut.
