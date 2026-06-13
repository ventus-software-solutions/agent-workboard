# Agent Spawning Guide

Use this guide when running Agent Workboard as a dogfood board with multiple Codex agents. The running board is the source of truth: every agent should read its live instructions before claiming work.

## Start The Board

Start the local service first:

```bash
npm run dev
```

Open `http://localhost:8088` and select the DOGFOOD project unless the operator explicitly names another project.

## Start PM First

Start one PM agent before spawning implementers, testers, or reviewers:

```text
You are pm-agent. Read http://localhost:8088/api/agent-docs/pm-agent?format=md and do what it tells you.
```

The PM should groom backlog, assign configured slots, clarify sequencing, and keep stale or blocked work visible. Do not start a large worker pool before PM has made the ready queue understandable.

## Spawn Specialist Agents

Prefer role types when starting a generic worker. The worker will acquire a concrete slot through `/api/bootstrap` when the board supports it:

```text
You are implementer. Read http://localhost:8088/api/agent-docs/implementer?format=md and do what it tells you.
```

Use configured slot ids when the operator has chosen an exact lane:

```text
You are implementer-backend-1. Read http://localhost:8088/api/agent-docs/implementer-backend-1?format=md and do what it tells you.
```

Useful specialist prompts:

```text
You are docs-agent. Read http://localhost:8088/api/agent-docs/docs-agent?format=md and do what it tells you.
```

```text
You are mcp-agent. Read http://localhost:8088/api/agent-docs/mcp-agent?format=md and do what it tells you.
```

```text
You are test-agent. Read http://localhost:8088/api/agent-docs/test-agent?format=md and do what it tells you.
```

```text
You are reviewer-agent. Read http://localhost:8088/api/agent-docs/reviewer-agent?format=md and do what it tells you.
```

## What Agents Should Do

For ordinary implementation, PM, docs, MCP, and tester work:

1. Read live agent docs.
2. Acquire or use a configured concrete slot.
3. Get the next eligible task from the board.
4. Claim exactly one normal ready task through `POST /api/tasks/:taskId/claim` or MCP `claim_task`.
5. Create a task branch/worktree before editing.
6. Post a plan comment and any cross-task coordination note.
7. Implement, verify, commit, and push when credentials allow.
8. Comment evidence on the task.
9. Move finished implementation to `review`, testing work to the requested status, or blocked work to `blocked` with a specific blocker.
10. Only then look for another task.

## Autonomous Go-Ahead

A normal ready task does not need a second human "go" after an agent has claimed it. The successful claim plus a visible plan comment is the go-ahead for PM, implementer, tester, docs, MCP, and reviewer work to proceed inside the task scope.

Agents must still verify assumptions before acting. They should wait for explicit operator approval before destructive changes, scope changes, ambiguous requirements, cross-project overrides, or tasks marked as needing approval. Use the operator approval queue when approval is needed so the wait is visible and actionable.

For active tasks already waiting only for ordinary go-ahead, post a short acknowledgement of this policy and continue. If the actual blocker is unclear scope or an operator decision, request approval or move the task to `blocked` with the exact decision needed.

Reviewer agents are the exception. They should scan original tasks already in `status=review` before ordinary reviewer-role ready tasks. For review-column work, preserve the original assignee and do not create duplicate `Review:` wrapper tasks. Claim the review pass with a visible comment or first-class review metadata when available, then either merge and mark the original task `done`, or return it to `ready` or `blocked` with specific findings.

## How To Spot Blocked Agents

Check the board before assuming an agent is still working:

- The task is `blocked` with a recent comment naming the needed decision or dependency.
- The agent presence panel shows idle, stale, paused, or offline.
- The task has not received comments, commits, attachments, or status changes after its slot lease expired.
- Agent Talks has a blocker, handoff, review request, or question involving the task.
- The worktree exists but the branch is dirty, uncommitted, or behind current `main`.

When the blocker is an operator decision, answer on the task or move it through the structured approval flow if one exists. When the blocker is stale ownership, PM or reviewer should requeue, block, or explicitly acknowledge the task with evidence.

## Evidence Checklist

Ask agents to leave enough evidence for the next role to continue without this chat:

- Branch and worktree path.
- Commit SHA, or a clear reason no commit exists.
- Files changed.
- Tests, build, browser checks, screenshots, or smoke checks run.
- Known caveats such as GitHub credential prompts, sandbox write failures, or skipped checks.
- Final status transition and who should act next.

## Shutdown And Cleanup

Before stopping a worker:

1. Make sure it owns no unreported `in_progress` work.
2. Move completed implementation to `review` with evidence.
3. Move genuinely stuck work to `blocked` with the exact dependency.
4. Report no eligible work when the slot has nothing appropriate to claim.
5. Leave dirty or unmerged worktrees in place with a task comment; only remove clean merged worktrees after reviewer/operator confirmation.

The shared `main` checkout should stay reserved for the running board and observation. Task branches and task worktrees are where implementation belongs.
