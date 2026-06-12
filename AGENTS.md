# Agent Instructions

Agent Workboard agents should bootstrap from the running board, not from stale local assumptions.

Start with:

```text
You are <agent-type-or-id>. Read http://localhost:8088/api/agent-docs/<agent-type-or-id>?format=md and do what it tells you.
```

Default dogfood project: `DOGFOOD`.

Core rule: claim exactly one task, post visible progress, attach or comment evidence, then move the task to the correct next status before taking another task.

Preferred spawn language is an agent type such as `implementer`, `reviewer`, `tester`, or `pm`, not a hand-numbered worker name. Slot acquisition is the target workflow: a generic worker should claim the next available slot like `implementer-04` before doing implementation work. Until `/api/bootstrap` or `acquire_agent_slot` exists, the operator may still assign an explicit temporary id.

## Reviewer Merge Responsibility

Reviewer agents own the final transition for implementation work.

Reviewers must scan `status=review` tasks before ordinary reviewer-role backlog work. If a reviewer approves a task, the reviewer is responsible for merging it, commenting the merge commit and verification evidence, and moving the original task to `done`. If the task is not ready, the reviewer comments specific findings and moves it back to `ready` or `blocked`.

A review is incomplete until the work is either merged and marked `done`, returned with requested changes, or explicitly handed to another reviewer/operator with the blocker stated.

## Branch And Worktree Discipline

Implementation agents must not edit the shared `main` checkout directly.

Before changing files:

```bash
git status --short --branch
git fetch origin main
git worktree add C:/git/wt-agent-workboard-<agent-id>-<slug> -b <agent-id>/<slug> origin/main
cd C:/git/wt-agent-workboard-<agent-id>-<slug>
```

Use the task worktree for code/docs changes, tests, commits, and branch pushes. Leave the main checkout for the running local service, operator state, and observation. If you see dirty files you did not create, do not overwrite them; report the conflict on the task or in Agent Talks.
