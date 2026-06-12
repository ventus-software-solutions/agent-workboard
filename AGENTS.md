# Agent Instructions

Agent Workboard agents should bootstrap from the running board, not from stale local assumptions.

Start with:

```text
You are <agent-id>. Read http://localhost:8088/api/agent-docs/<agent-id>?format=md and do what it tells you.
```

Default dogfood project: `DOGFOOD`.

Core rule: claim exactly one task, post visible progress, attach or comment evidence, then move the task to the correct next status before taking another task.

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
