const CLAIMABLE_WORK_ITEM_TYPES = new Set(["task", "subtask", "bug", "spike", "chore"]);
const GROOMING_STALE_DAYS = 7;

const CATEGORY_RANK = {
  approval: 90,
  merge: 80,
  blocker: 70,
  stalled: 60,
  role_gap: 50,
  grooming: 30,
  cleanup: 20
};

export function buildOperatorAttention({
  tasks = [],
  agentRegistry = {},
  staleWork = [],
  worktreeCleanup = {},
  promptTemplate = "",
  origin = "http://localhost:8088",
  projectId = "",
  now = new Date()
} = {}) {
  const agents = Array.isArray(agentRegistry.agents) ? agentRegistry.agents : [];
  const activeAgents = agents.filter(
    (agent) =>
      agent.source === "slot" &&
      agent.active &&
      !agent.paused &&
      (!projectId || !agent.activeProjectId || agent.activeProjectId === projectId)
  );
  const activeRoles = countActiveRoles(activeAgents);
  const actions = [];
  const stalledTaskIds = new Set();

  for (const task of tasks) {
    if (isPendingOperatorApproval(task)) {
      actions.push(
        taskAction({
          task,
          kind: "approval",
          title: task.title,
          detail: task.blocker.requestedAction || task.blocker.reason || "An agent needs an operator decision.",
          remedy: "decide",
          tasks
        })
      );
      continue;
    }

    if (task.status === "review" && approvedReviewVerdict(task)) {
      actions.push(
        taskAction({
          task,
          kind: "merge",
          title: task.title,
          detail: "Review approved; merge or route the delivery according to the deployment process.",
          remedy: "open_task",
          tasks
        })
      );
      continue;
    }

    if (task.status === "blocked") {
      const blockerType = task.blocker?.type || "missing blocker type";
      const blockerDetail = task.blocker?.reason || task.blocker?.requestedAction || "Add the exact decision or dependency needed.";
      actions.push(
        taskAction({
          task,
          kind: "blocker",
          title: task.title,
          detail: `${humanize(blockerType)}: ${blockerDetail}`,
          remedy: "open_task",
          tasks
        })
      );
    }
  }

  for (const item of staleWork) {
    const task = item.task || tasks.find((candidate) => candidate.id === item.taskId);
    if (!task || task.status !== "in_progress" || stalledTaskIds.has(task.id)) continue;
    stalledTaskIds.add(task.id);
    actions.push(
      taskAction({
        task,
        kind: "stalled",
        title: task.title,
        detail: item.reason || "The task owner has stopped reporting fresh progress.",
        remedy: "open_coordination",
        tasks
      })
    );
  }

  const activeAgentIds = new Set(activeAgents.map((agent) => agent.id));
  for (const task of tasks) {
    if (task.status !== "in_progress" || stalledTaskIds.has(task.id)) continue;
    if (!task.assignee || !activeAgentIds.has(task.assignee)) {
      stalledTaskIds.add(task.id);
      actions.push(
        taskAction({
          task,
          kind: "stalled",
          title: task.title,
          detail: task.assignee
            ? `${task.assignee} has no active slot lease; recover or reassign this claim.`
            : "In-progress work has no owner; assign or requeue it.",
          remedy: "open_coordination",
          tasks
        })
      );
    }
  }

  const waitingByRole = collectWaitingWork(tasks);
  for (const [role, waitingTasks] of waitingByRole) {
    if (waitingTasks.length === 0 || (activeRoles.get(role) || 0) > 0) continue;
    const prompt = buildBootstrapPrompt({ template: promptTemplate, agentType: role, origin });
    const downstreamCount = waitingTasks.reduce((total, task) => total + downstreamImpact(task, tasks), 0);
    actions.push({
      id: `role-gap:${role}`,
      kind: "role_gap",
      title: `${waitingTasks.length} ${role} ${waitingTasks.length === 1 ? "item is" : "items are"} waiting`,
      detail: `No active ${role} agent can advance ${waitingStatusSummary(waitingTasks)}.`,
      remedy: "copy_prompt",
      prompt,
      role,
      taskId: waitingTasks[0]?.id || "",
      downstreamCount
    });
  }

  const groomingTasks = tasks.filter((task) => task.status === "backlog" && groomingReasons(task, now).length > 0);
  if (groomingTasks.length > 0) {
    const reasonCounts = countGroomingReasons(groomingTasks, now);
    actions.push({
      id: "grooming:backlog",
      kind: "grooming",
      title: `${groomingTasks.length} backlog ${groomingTasks.length === 1 ? "item needs" : "items need"} grooming`,
      detail: groomingSummary(reasonCounts),
      remedy: "groom",
      taskId: groomingTasks[0].id,
      prompt: buildBootstrapPrompt({ template: promptTemplate, agentType: "pm", origin }),
      downstreamCount: groomingTasks.reduce((total, task) => total + downstreamImpact(task, tasks), 0)
    });
  }

  const cleanupItems = (worktreeCleanup.items || []).filter((item) => item.status === "cleanup-ready" && item.cleanupEligible);
  for (const item of cleanupItems) {
    const commands = [item.commands?.removeWorktree, item.commands?.deleteBranch].filter(Boolean);
    const mutationsEnabled = worktreeCleanup.cleanup?.mutationsEnabled !== false;
    actions.push({
      id: `cleanup:${item.worktreePath}:${item.branch}`,
      kind: "cleanup",
      title: `Remove stray worktree ${item.branch}`,
      detail: mutationsEnabled
        ? "The branch is merged and the worktree is clean. Remove both as the final delivery step."
        : `Run on host: ${worktreeCleanup.cleanup?.reason || "cleanup mutations are disabled in this deployment."}`,
      remedy: mutationsEnabled ? "cleanup" : "copy_commands",
      cleanupItem: item,
      commands,
      taskId: item.task?.id || "",
      downstreamCount: 0
    });
  }

  actions.sort(compareActions);

  return {
    actions,
    activeAgentCount: activeAgents.length,
    nextExpectedEvent: describeNextExpectedEvent({ tasks, activeAgents }),
    groomingStaleDays: GROOMING_STALE_DAYS
  };
}

export function buildBootstrapPrompt({ template, agentType, origin }) {
  if (!template || !agentType) return "";
  return template
    .replaceAll("{agentType}", agentType)
    .replaceAll("{origin}", origin)
    .replace(/https?:\/\/localhost(?::\d+)?/g, origin);
}

function taskAction({ task, kind, title, detail, remedy, tasks = [] }) {
  return {
    id: `${kind}:${task.id}`,
    kind,
    title,
    detail,
    remedy,
    taskId: task.id,
    task,
    downstreamCount: downstreamImpact(task, tasks)
  };
}

function isPendingOperatorApproval(task) {
  return task.blocker?.type === "operator_approval" && task.blocker.status === "pending";
}

function approvedReviewVerdict(task) {
  const verdicts = Array.isArray(task.reviewVerdicts) ? task.reviewVerdicts : task.reviewVerdict ? [task.reviewVerdict] : [];
  if (verdicts[0]) {
    return ["approve", "approved"].includes(String(verdicts[0].decision || verdicts[0].verdict).toLowerCase());
  }

  for (const comment of task.comments || []) {
    const body = comment.body || "";
    if (/(?:changes requested|request_changes|verdict:\s*(?:reject|changes)|\[not approved\])/i.test(body)) return false;
    if (/(?:verdict:\s*approve|\[approved\])/i.test(body)) return true;
  }
  return false;
}

function countActiveRoles(agents) {
  const result = new Map();
  for (const agent of agents) result.set(agent.role, (result.get(agent.role) || 0) + 1);
  return result;
}

function collectWaitingWork(tasks) {
  const byRole = new Map();
  for (const task of tasks) {
    const role = waitingRole(task);
    if (!role) continue;
    const current = byRole.get(role) || [];
    current.push(task);
    byRole.set(role, current);
  }
  return byRole;
}

function waitingRole(task) {
  if (task.status === "review" && !approvedReviewVerdict(task)) return "reviewer";
  if (task.status === "testing") return "tester";
  if (!["ready", "backlog"].includes(task.status) || !isClaimable(task) || !task.role || !task.priority) return "";
  if (task.blocker?.status === "pending") return "";
  return task.role || "implementer";
}

function isClaimable(task) {
  return CLAIMABLE_WORK_ITEM_TYPES.has(task.workItemType || "task") && (task.dependencyStatus?.state || "clear") === "clear";
}

function downstreamImpact(task, tasks = []) {
  const direct = new Set(task.blocks || []);
  for (const candidate of tasks) {
    if ((candidate.dependsOn || []).includes(task.id) || (candidate.blockedBy || []).includes(task.id)) direct.add(candidate.id);
  }
  return 1 + direct.size;
}

function groomingReasons(task, now) {
  const reasons = [];
  if (!task.priority) reasons.push("priority");
  if (!task.role) reasons.push("role");
  const updatedAt = new Date(task.updatedAt || task.createdAt || 0);
  if (!Number.isNaN(updatedAt.getTime()) && now.getTime() - updatedAt.getTime() > GROOMING_STALE_DAYS * 24 * 60 * 60 * 1000) {
    reasons.push("stale");
  }
  return reasons;
}

function countGroomingReasons(tasks, now) {
  const counts = { priority: 0, role: 0, stale: 0 };
  for (const task of tasks) for (const reason of groomingReasons(task, now)) counts[reason] += 1;
  return counts;
}

function groomingSummary(counts) {
  return [
    counts.priority ? `${counts.priority} without priority` : "",
    counts.role ? `${counts.role} without role` : "",
    counts.stale ? `${counts.stale} untouched for more than ${GROOMING_STALE_DAYS} days` : ""
  ]
    .filter(Boolean)
    .join("; ");
}

function waitingStatusSummary(tasks) {
  const counts = new Map();
  for (const task of tasks) counts.set(task.status, (counts.get(task.status) || 0) + 1);
  return [...counts.entries()].map(([status, count]) => `${count} ${humanize(status)}`).join(" and ");
}

function describeNextExpectedEvent({ tasks, activeAgents }) {
  if (tasks.some((task) => task.status === "review")) return "a review verdict";
  if (tasks.some((task) => task.status === "testing")) return "a verification result";
  if (tasks.some((task) => task.status === "in_progress")) return "agent progress or delivery evidence";
  if (tasks.some((task) => ["ready", "backlog"].includes(task.status)) && activeAgents.length > 0) return "the next task claim";
  return tasks.some((task) => task.status !== "done") ? "the next workflow update" : "new work arriving";
}

function compareActions(left, right) {
  return (
    (right.downstreamCount || 0) - (left.downstreamCount || 0) ||
    (CATEGORY_RANK[right.kind] || 0) - (CATEGORY_RANK[left.kind] || 0) ||
    left.title.localeCompare(right.title)
  );
}

function humanize(value = "") {
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
