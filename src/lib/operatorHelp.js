export const OPERATOR_HELP_TOPICS = Object.freeze({
  projects: Object.freeze({
    label: "Projects",
    concept: "Projects keep related tasks, agents, talks, and activity in one operating scope.",
    board: "The board uses the selected project to filter every project-level workspace.",
    operator: "Select the project you intend to operate before creating or changing work.",
    anchor: "projects"
  }),
  tasks: Object.freeze({
    label: "Board and tasks",
    concept: "The task board is the authoritative workflow for planned and active work.",
    board: "It groups tasks by status and enforces claims, blockers, review, and completion evidence.",
    operator: "Use it to set priority, inspect evidence, and move work only when the next state is justified.",
    anchor: "tasks"
  }),
  coordination: Object.freeze({
    label: "Coordination",
    concept: "Coordination is the project-wide Agent Talks feed for cross-task communication.",
    board: "It broadcasts updates, blockers, handoffs, questions, and review requests with task links.",
    operator: "Use it when several roles need the same context; keep task-specific evidence on the task.",
    anchor: "agent-talks"
  }),
  activity: Object.freeze({
    label: "Activity",
    concept: "Activity is the chronological audit trail of board events.",
    board: "It records claims, edits, comments, approvals, completion, and validation failures.",
    operator: "Use it to reconstruct what changed and who acted before recovering or overriding work.",
    anchor: "activity"
  }),
  agents: Object.freeze({
    label: "Agents",
    concept: "Agents shows roles, reusable worker types, concrete slots, leases, presence, and current work.",
    board: "It separates workforce capacity from the individual workers currently occupying that capacity.",
    operator: "Adjust type capacity, start a matching role, or recover a stale claim only after checking evidence.",
    anchor: "agents"
  }),
  capabilities: Object.freeze({
    label: "Capabilities",
    concept: "Capabilities describe the product guarantees the workboard claims to support.",
    board: "The registry links each guarantee to lifecycle state, owner, surfaces, caveats, and delivery tasks.",
    operator: "Use it to spot drift between completed work and what the product can actually guarantee.",
    anchor: "capabilities"
  }),
  settings: Object.freeze({
    label: "Settings",
    concept: "Settings contains deployment-wide operating rules rather than project-specific task data.",
    board: "It publishes the process rules agents and operators should follow across this installation.",
    operator: "Change these rules deliberately because every project and generated agent instruction may rely on them.",
    anchor: "settings"
  }),
  attention: Object.freeze({
    label: "Operator attention",
    concept: "Needs you is the operator inbox for decisions and recovery actions that should not be automated.",
    board: "It consolidates approvals, blockers, stale ownership, review pressure, and safe cleanup prompts.",
    operator: "Read the reason and evidence, then take the named action or leave the item queued.",
    anchor: "read-the-board-in-30-seconds"
  }),
  cleanup: Object.freeze({
    label: "Worktree cleanup",
    concept: "Worktree cleanup identifies task branches and worktrees that may be safe to remove.",
    board: "It checks task state, merge evidence, repository state, and the expected commit before offering cleanup.",
    operator: "Clean only eligible entries and investigate dirty, unmerged, inaccessible, or unknown entries first.",
    anchor: "worktree-cleanup"
  }),
  integration: Object.freeze({
    label: "Integration status",
    concept: "Integration status compares the running checkout with its configured upstream branch.",
    board: "It summarizes clean state, push debt, divergence, and reconcile-first recovery guidance.",
    operator: "Inspect it before trusting a local deployment or merging when the pill reports debt or reconciliation.",
    anchor: "integration-status"
  })
});

export const REQUIRED_OPERATOR_HELP_TOPICS = Object.freeze(Object.keys(OPERATOR_HELP_TOPICS));

export function getOperatorHelpTopic(topicId) {
  const topic = OPERATOR_HELP_TOPICS[topicId];
  if (!topic) throw new Error(`Unknown operator help topic: ${topicId}`);
  return topic;
}

export function operatorGuideHref(topicId, basePath = "/") {
  const topic = getOperatorHelpTopic(topicId);
  const safeBase = `/${String(basePath || "/")
    .split("/")
    .filter(Boolean)
    .join("/")}/`;
  return `${safeBase === "//" ? "/" : safeBase}operator-guide#${topic.anchor}`;
}
