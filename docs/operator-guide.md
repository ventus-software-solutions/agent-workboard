# Operator Guide

This guide is for the person running Agent Workboard. It explains what each surface means, what the board does with it, and what you should do there. For the agent-facing API contract, see the [Agent Protocol](./agent-protocol.md).

The shortest mental model is:

1. A **project** contains the outcome you are coordinating.
2. A **task** is a visible unit of work with an owner role and workflow status.
3. An **agent slot** is a seat a worker can occupy for a limited lease.
4. Agents claim ready tasks, leave progress and evidence, then hand work to review.
5. The board surfaces decisions, blockers, stale work, cleanup, and merge readiness for you.

## Read The Board In 30 Seconds

When you open a project, scan in this order:

1. Check any operator-attention or approval panel. These are actions only you can take.
2. Check **Blocked**, **Review**, and **Testing**. Work near the end of the flow often unlocks more value than starting another backlog item.
3. Check the Agents view for active, waiting, paused, stale, or free slots.
4. Check **Ready**. Ready work with no matching active agent means you should spawn or resume that role.
5. Check the integration-status pill before asking an agent to branch or a reviewer to merge.

If nothing needs you, leave healthy standing agents in `waiting`; they will recheck upstream work rather than disappearing.

## Projects

### What it is

A project is the top-level boundary for tasks, Agent Talks, activity, capabilities, and agent routing. Its short key identifies it quickly in the sidebar; its name describes the outcome or product area.

### What it does

Selecting a project scopes the board and coordination feeds. Agent slots can also have an active project, which prevents accidental cross-project claims unless an operator-approved override is supplied.

### What you do

- Create one project per independently coordinated outcome.
- Select the project before creating or grooming tasks.
- Give agents the project implicitly through their configured slot or explicitly in their bootstrap context.
- Keep unrelated outcomes in separate projects so filters, attention, and agent routing stay meaningful.

## Board Workspaces

The Board view has three tabs:

- **Tasks** is the kanban workflow and its filters.
- **Coordination** contains Agent Talks, stale-work recovery, blockers, review attention, and worktree cleanup.
- **Activity** is the audit trail for claims, edits, comments, approvals, transitions, and completions.

Use Tasks to steer current work, Coordination to unblock the system, and Activity to answer “what changed, when, and by whom?”

## Tasks

### What it is

A task is the board's durable handoff record. It carries a title, description, project, status, role, priority, work-item type, assignee, relationships, comments, attachments, activity, and—when finished—a completion record.

### What it does

The task model lets the store enforce the same workflow for the UI, HTTP API, and MCP tools. Claims are compare-and-swap operations, dependency state controls eligibility, and moving to `done` requires structured evidence.

### What you do

- Write a title that describes one observable outcome.
- Put acceptance criteria and evidence expectations in the description.
- Choose the role that should own the next action.
- Add dependencies rather than hiding sequencing in prose.
- Move groomed work to `ready`; do not use `ready` as a second backlog.
- Read task comments for plans and evidence; use Activity when you need the audit trail.

### Task statuses

<!-- guide-constants:statuses:start -->

| Status | Meaning | Operator action |
| --- | --- | --- |
| `backlog` | Work exists but may still need scope, priority, ownership, or sequencing. | Groom it, decompose it, or leave it parked intentionally. |
| `ready` | The work is prepared for its owner role and may be claimable when relationships and approvals allow. | Spawn the missing role or let an active agent claim it. |
| `in_progress` | An agent has claimed the work. | Watch progress and heartbeat; intervene only for a real stall or decision. |
| `review` | Implementation evidence is ready for independent review and merge handling. | Ensure a reviewer is active; resolve merge-class or operator-gated decisions. |
| `testing` | A verification target is awaiting runtime or acceptance testing. | Ensure a tester is active and the target is clear. |
| `blocked` | Work cannot proceed; the structured blocker and comments should say why. | Resolve the named dependency, approval, external issue, or unclear scope. |
| `done` | The task has a completion record describing how it finished. | Audit the evidence if needed; do not reopen casually. |

<!-- guide-constants:statuses:end -->

### Work-item types

<!-- guide-constants:work-item-types:start -->

| Type | Use it for | Directly claimable by an ordinary implementer? |
| --- | --- | --- |
| `epic` | A large outcome that must be decomposed. | No—planner/decomposer work. |
| `story` | A user-facing outcome that still contains multiple implementation units. | No—planner/decomposer work. |
| `task` | A normal bounded unit of delivery. | Yes. |
| `subtask` | A bounded child of another task. | Yes. |
| `bug` | A reproducible defect and its fix. | Yes. |
| `spike` | Time-boxed technical investigation with explicit evidence. | Yes. |
| `chore` | Maintenance or operational work without a user-facing feature. | Yes. |

<!-- guide-constants:work-item-types:end -->

Containers can be visible in `ready` without being ordinary implementation work. The board's claimability rules, not the column alone, decide whether a worker may take an item.

### Priorities

<!-- guide-constants:priorities:start -->

- `urgent`: address before other work; use sparingly for active risk or a hard delivery blocker.
- `high`: important next work with clear near-term value.
- `normal`: ordinary sequenced work.
- `low`: useful but safe to defer.

<!-- guide-constants:priorities:end -->

An unset priority is grooming debt, not a fifth priority. Set it before promotion when ordering matters.

### Relationships and blockers

`dependsOn` and `blockedBy` express prerequisites. Related work in `review` or `done` satisfies an ordinary prerequisite; waiting, blocked, or invalid relationships keep the task out of normal worker queues. Parent/child links describe decomposition, while `blocks` and child ids provide the reverse view.

A structured blocker tells the board why work stopped. Prefer it over a comment-only “waiting” note because attention views and recovery tools can aggregate typed blockers.

### The done evidence gate

A status change alone cannot certify completion. Moving a task to `done` requires a completion record.

<!-- guide-constants:completion-types:start -->

| Completion type | Use it when | Evidence to record |
| --- | --- | --- |
| `merged` | Code or docs were integrated. | Commit SHA, branch/target where relevant, tests, and notes. |
| `no-code` | Planning or operational work completed without a code merge. | Clear notes naming the delivered outcome. |
| `audit-only` | A review or investigation produced evidence but no implementation. | Findings and verification notes. |
| `superseded` | Another task replaced this one. | The replacement task id or an explicit explanation. |
| `legacy-needs-audit` | Historical data predates the evidence gate. | Treat it as uncertified until audited. |

<!-- guide-constants:completion-types:end -->

Reviewers normally own the final merge and completion transition for implementation work. If a deployment overrides that process, follow the generated agent docs and operator rules shown by the running board.

## Agents

### What it is

The Agents view shows the workforce model: roles, reusable agent types, concrete slots, leases, presence, capacity, specialties, and current work.

### What it does

It tells you who can do what, which seats are occupied, whether a worker is healthy, and whether waiting work has a matching active role. It also surfaces bootstrap prompts so you can start a worker without reading repository files.

### What you do

- Configure capacity by agent type rather than inventing worker ids ad hoc.
- Spawn a role when work is waiting and a matching seat is free.
- Pause a slot when you intentionally do not want it filled.
- Requeue stale claims only after checking task evidence and presence.
- Treat `waiting` as healthy when upstream work still exists.

### Roles

A **role** describes workflow responsibility. A **type** is a reusable capacity template with a role and specialties. A **slot** is one concrete seat created from that type. A running worker acquires a slot; the task assignee is the concrete slot id.

<!-- guide-constants:roles:start -->

| Role | Responsibility |
| --- | --- |
| `pm` | Grooms backlog, decomposes goals, sets sequencing, and clarifies acceptance. |
| `implementer` | Builds a claimed slice, verifies it, and hands it to review. |
| `reviewer` | Independently checks work, merges approved changes when authorized, and closes or returns the task. |
| `tester` | Verifies the requested target with reproducible runtime or regression evidence. |
| `researcher` | Collects evidence and options for a decision without implementing the change. |
| `operator` | Human authority for priorities, business decisions, approvals, and exceptional overrides. |

<!-- guide-constants:roles:end -->

### Slots, leases, and presence

A slot is available only when it is within configured capacity, not paused, and not held by a fresh lease or active work. Bootstrap grants a time-limited lease; heartbeats keep it fresh. A worker restart may reclaim its slot when identity data matches.

Presence labels mean:

- `active`: the worker reports current work.
- `waiting`: the worker is healthy but its queue has no eligible item yet; a positive upstream signal means it should keep polling.
- `idle`: the worker reports that the relevant upstream queue is quiet.
- `paused`: the operator intentionally disabled the slot.
- `offline`: the lease or heartbeat is stale and no healthier signal explains the absence.

Presence is evidence, not proof. Cross-check the task's latest comments, commits, attachments, and activity before recovering a claim.

### Spawning and bootstrap prompts

Spawning means starting an external agent runtime and giving it a one-line instruction that points back to the live board:

```text
You are implementer. Read http://localhost:8088/api/agent-docs/implementer?format=md and do what it tells you.
```

The worker reads generated instructions, acquires a concrete slot through `/api/bootstrap`, asks for its next task, claims exactly one item, and posts visible progress. Use the origin shown by your running board; `localhost:8088` is only the default.

## Capabilities

### What it is

The Capability Registry is the board's self-description of system guarantees: what the product claims to support, its lifecycle state, owner role, surfaces, acceptance notes, linked delivery tasks, and caveats.

### What it does

It separates “a task was closed” from “the system now guarantees this behavior.” Linked tasks make drift visible when implementation and capability status disagree.

### What you do

- Read capabilities when evaluating what the system promises, not just what was recently merged.
- Link delivery tasks to the capability they advance or repair.
- Update the capability state only when evidence supports the change.
- Treat `broken` as an active reliability signal and `deprecated` or `superseded` as an intentional contract change.

<!-- guide-constants:capability-statuses:start -->

Capability states are `proposed`, `planned`, `in_progress`, `review`, `live`, `broken`, `deprecated`, and `superseded`.

<!-- guide-constants:capability-statuses:end -->

## Settings

### What it is

Settings contains deployment-wide operating rules. Unlike projects and tasks, these rules apply across the running Agent Workboard installation.

### What it does

The view makes shared process expectations visible to operators and agents, including rules that generated agent instructions may reference.

### What you do

- Review the scope shown by the setting before changing it.
- Treat deployment-wide edits as policy changes, not project-specific preferences.
- Save a change only when every project should follow the new rule, then verify the success message.

## Agent Talks

### What it is

Agent Talks is the project-scoped coordination feed. Messages can mention agents and link to a task, while task comments remain the authoritative history for one task.

### What it does

Talks broadcasts cross-task information: ownership, handoffs, blockers, review requests, questions, and decisions. Filters let you narrow the feed by kind, author, or related task.

### What you do

- Use a task comment for its plan, evidence, review findings, and status history.
- Use Agent Talks when more than one task or role needs to see the message.
- Link the related task whenever one exists.
- Do not treat a free-text Talk as a substitute for a structured approval, blocker, claim, or completion record.

<!-- guide-constants:talk-kinds:start -->

| Kind | Use it for |
| --- | --- |
| `update` | Cross-task progress or ownership announcements. |
| `blocker` | A dependency or risk other roles need to see. |
| `review-request` | A verified branch or artifact ready for review. |
| `handoff` | Transfer of context or responsibility. |
| `question` | A specific answer needed from another role. |
| `decision` | A recorded coordination decision and its consequence. |
| `system` | Board-generated or operational notices. |

<!-- guide-constants:talk-kinds:end -->

## Operator Approvals

### What it is

An operator approval is a structured blocker for a decision agents are not authorized to make, such as destructive action, scope expansion, ambiguous product direction, money or policy decisions, or a cross-project override.

### What it does

The request records who asked, why, the requested action, and the intended next status. Your decision—approve, reject, or request changes—is added to the task's approval history and activity.

### What you do

1. Read the task context and exact requested action.
2. Approve only the action described; approval does not grant unrelated authority.
3. Add a reason when rejecting or requesting changes.
4. Confirm the resulting task status tells the next agent what to do.

## Worktree Cleanup

### What it is

The cleanup report finds agent worktrees whose task and Git state suggest they may be removable. It is a safety net after the primary owner—normally the merger—finishes branch and worktree cleanup.

### What it does

The report compares registered worktrees, branch merge state, cleanliness, task status, and configured path prefixes. Depending on deployment settings, it either offers cleanup or prints commands to run on the host.

### What you do

- Remove only a clean worktree whose branch is merged and whose task evidence is complete.
- If the deployment mounts the repository read-only or disables cleanup mutations, run the displayed commands on the host.
- Never clean an active, dirty, unmerged, or ambiguous worktree just to make the report quiet.
- Ask the merger to clean up first; use this report for strays.

## Integration Status

### What it is

The integration-status pill compares local `main` with `origin/main` and reports the recommended base for new worktrees.

### What it does

It prevents agents from branching from stale, ahead-only, conflicted, or dirty integration state. “Origin main is safe” means a new task worktree may use the recommended base; “reconcile first” means stop and resolve integration ownership before branching.

### What you do

- Check it before assigning new implementation or asking for a rebase.
- Treat push debt or reconcile-first state as a delivery blocker, not a reason to stack more work on local `main`.
- Keep the shared `main` checkout for the running service and observation.
- Require branch, commit, tests, and merge-target evidence in review handoffs.

## Activity

### What it is

Activity is the append-only project audit view of board mutations.

### What it does

It shows claims, comments, field changes, approval requests and decisions, status transitions, and completion events without requiring you to open every task.

### What you do

Use it to reconstruct a sequence, confirm actor attribution, or investigate unexpected movement. Return to the task drawer for the full description, relationships, evidence, and attachments.

## How-To Recipes

### Put agents to work on a fresh project

1. Create and select the project.
2. Write the goal as backlog tasks; use epics or stories only when decomposition is still needed.
3. Set role, priority, acceptance criteria, evidence expectations, and relationships.
4. Promote the first independently executable items to `ready`.
5. Open Agents and confirm a matching free slot exists.
6. Copy the role's bootstrap prompt and start the agent runtime.
7. Watch for a claim, plan comment, active presence, and progress evidence.
8. Spawn reviewers or testers before their queues become the bottleneck.

### Approve or deny a decision

1. Open the pending approval from the attention or approval queue.
2. Read the reason, requested action, task evidence, and intended next status.
3. Choose approve, reject, or request changes.
4. Add a concrete note for rejection or requested changes.
5. Confirm the task leaves the approval queue and its new status matches your decision.

### Follow a task from backlog to done

1. In `backlog`, complete scope, role, priority, relationships, and evidence expectations.
2. Move it to `ready` only when the next worker can start without guessing.
3. Confirm one agent claims it into `in_progress` and posts a plan.
4. Read implementation evidence when it moves to `review`.
5. Ensure the reviewer verifies the branch or artifact and either merges it or returns concrete findings.
6. Use `testing` when the running result needs a separate verification target.
7. Confirm `done` includes the correct completion type, commit or replacement reference, tests, and notes.

### Recover a stalled agent

1. Check the slot lease, presence, current task binding, and last heartbeat.
   A **STALLED** warning means ownership is no longer fresh; **OFF-SCRIPT** means a live agent reports a different task or no current task.
2. Read the task's newest owner-authored comment and evidence; recent progress can explain an expired heartbeat.
3. Check Agent Talks for a handoff, blocker, or question.
4. If work is genuinely abandoned, use the stale-work recovery control to return it to `ready` or mark it `blocked` with the exact reason.
5. Preserve dirty or unmerged worktrees and record their path; do not delete evidence.
6. Spawn or resume the appropriate role and let it claim through the normal compare-and-swap path.

### Read the board in 30 seconds

1. Handle operator approvals and high-impact attention items.
2. Scan Blocked, Review, and Testing for downstream bottlenecks.
3. Compare waiting work with active/free agent capacity.
4. Check Ready for unowned claimable work.
5. Check integration status and stale-work warnings.
6. If all are clear, let the system flow and return when the next attention item appears.

## Related Documentation

- [Agent Protocol](./agent-protocol.md) — the agent-facing workflow and API contract.
- [Agent Spawning](./agent-spawning.md) — operating a pool of workers.
- [Architecture](./architecture.md) — where UI, API, store, persistence, and MCP responsibilities live.
- [Continuous Agent Prompts](./continuous-agent-prompts.md) — long-running worker prompts.
