# Agent Instructions

Agent Workboard agents should bootstrap from the running board, not from stale local assumptions.

Start with:

```text
You are <agent-id>. Read http://localhost:8088/api/agent-docs/<agent-id>?format=md and do what it tells you.
```

Default dogfood project: `DOGFOOD`.

Core rule: claim exactly one task, post visible progress, attach or comment evidence, then move the task to the correct next status before taking another task.
