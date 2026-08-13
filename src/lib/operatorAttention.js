const CLAIMABLE_WORK_ITEM_TYPES = new Set(["task", "subtask", "bug", "spike", "chore"]);
const GROOMING_STALE_DAYS = 7;
const DEFAULT_PROMPT_TEMPLATE =
  "You are {agentType}. Read {origin}/api/agent-docs/{agentType}?format=md and do what it tells you.";

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
        tasks,
        staleReason: item.reason || "",
        staleItem: item
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
          tasks,
          staleReason: task.assignee ? "missing_slot" : "missing_assignee"
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
      waitingCount: waitingTasks.length,
      waitingSummary: waitingStatusSummary(waitingTasks),
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
      role: "pm",
      itemCount: groomingTasks.length,
      reasonCounts,
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
  const presentedActions = actions.map((action) => ({
    ...action,
    ...describeOperatorAction(action, { activeRoles, promptTemplate, origin, now })
  }));

  return {
    actions: presentedActions,
    activeAgentCount: activeAgents.length,
    nextExpectedEvent: describeNextExpectedEvent({ tasks, activeAgents }),
    groomingStaleDays: GROOMING_STALE_DAYS
  };
}

export function buildBootstrapPrompt({ template, agentType, origin }) {
  if (!agentType) return "";
  return (template || DEFAULT_PROMPT_TEMPLATE)
    .replaceAll("{agentType}", agentType)
    .replaceAll("{origin}", origin)
    .replace(/https?:\/\/localhost(?::\d+)?/g, origin);
}

export function describeOperatorAction(
  action,
  { activeRoles = new Map(), promptTemplate = "", origin = "http://localhost:8088", now = new Date() } = {}
) {
  const requiredRole = requiredRoleForAction(action);
  const requiredRoleLabel = displayRole(requiredRole);
  const liveRoleCount = activeRoleCount(activeRoles, requiredRole);
  const spawnPrompt =
    requiredRole && liveRoleCount === 0
      ? buildBootstrapPrompt({ template: promptTemplate, agentType: requiredRole, origin })
      : "";
  const copy = actionSentenceSet(action, now);

  return {
    ...copy,
    requiredRole,
    requiredRoleLabel,
    liveRoleCount,
    spawnPrompt,
    spawnLeadIn: spawnPrompt ? `Then spawn ${indefiniteArticle(requiredRole)} ${requiredRoleLabel} with:` : ""
  };
}

function actionSentenceSet(action, now) {
  if (action.kind === "approval") {
    const request = action.task?.blocker?.requestedAction || action.task?.blocker?.reason || "an operator decision";
    return {
      what: `An agent needs your decision: ${asSentence(request)}`,
      why: "The task cannot continue until you approve or deny the request.",
      doThis: "Approve or deny the request and leave a short decision note."
    };
  }

  if (action.kind === "merge") {
    return {
      what: "Review approved this delivery, and it is waiting for its final merge.",
      why: "The finished work will not reach the shared branch until someone completes delivery.",
      doThis: "Click Open delivery, confirm the green checks, and merge it under the deployment rules."
    };
  }

  if (action.kind === "blocker") {
    const blockerType = humanize(action.task?.blocker?.type || "unspecified").toLowerCase();
    const blockerDetail = action.task?.blocker?.reason || action.task?.blocker?.requestedAction || "the exact blocker is not recorded";
    return {
      what: `This task is blocked by ${blockerType}: ${asSentence(blockerDetail)}`,
      why: "No agent can advance it until the blocker is resolved or the task is rerouted.",
      doThis: "Click Fix blocker, resolve or precisely update the blocker, and return the task to the right queue."
    };
  }

  if (action.kind === "stalled") {
    return {
      what: staleWhatHappened(action, now),
      why: "This task is stuck until someone returns it to the queue or records a blocker.",
      doThis: "Click Recover to return it to the queue or record the exact blocker."
    };
  }

  if (action.kind === "role_gap") {
    const count = action.waitingCount || 1;
    const role = action.role || "required";
    const roleLabel = displayRole(role);
    return {
      what: `${count} ${roleLabel} ${count === 1 ? "item is" : "items are"} waiting, but no ${roleLabel} agent is running.`,
      why: `${action.waitingSummary || "The waiting work"} cannot advance until that role is staffed.`,
      doThis: "Copy the spawn prompt."
    };
  }

  if (action.kind === "grooming") {
    const count = action.itemCount || 1;
    return {
      what: `${count} backlog ${count === 1 ? "item is" : "items are"} missing routing details or have gone stale.`,
      why: "Implementers cannot reliably choose or claim this work until its priority and ownership are clear.",
      doThis: "Click Groom now and assign the missing priority, role, or current scope."
    };
  }

  if (action.kind === "cleanup") {
    const branch = action.cleanupItem?.branch || "a merged branch";
    if (action.remedy === "copy_commands") {
      return {
        what: `The clean worktree for ${branch} is ready to remove, but this deployment cannot modify the host.`,
        why: "Leaving merged worktrees behind consumes disk space and makes active delivery state harder to read.",
        doThis: "Copy the host commands and run them in the repository checkout."
      };
    }
    return {
      what: `The merged branch ${branch} still has a clean worktree on disk.`,
      why: "Leaving merged worktrees behind consumes disk space and makes active delivery state harder to read.",
      doThis: "Click Clean to remove the worktree and its merged local branch."
    };
  }

  return {
    what: "The workboard found an attention item that it does not yet know how to explain.",
    why: "It may need action, but the board cannot safely infer the impact from this unfamiliar item.",
    doThis: action.taskId
      ? "Open the related task and inspect its full history before acting."
      : "Inspect the item details and ask the owning role to clarify the required action."
  };
}

function staleWhatHappened(action, now) {
  const assignee = action.task?.assignee || action.staleItem?.assignee || "The assigned agent";
  if (action.staleReason === "missing_assignee") {
    return "This task is marked in progress, but nobody owns it.";
  }
  if (action.staleReason === "missing_slot") {
    return `${assignee} owns this task, but no configured agent slot exists for that assignee.`;
  }
  if (action.staleReason === "paused_slot") {
    return `${assignee}'s slot is paused while this task is still marked in progress.`;
  }
  if (action.staleReason === "missing_heartbeat") {
    return `${assignee}'s slot never sent a heartbeat for this in-progress task.`;
  }
  if (action.staleReason === "expired_heartbeat") {
    const elapsed = staleElapsed(action.staleItem, now);
    return `The agent working on this stopped reporting progress${elapsed ? ` (no heartbeat for ${elapsed})` : ""}.`;
  }
  return "The workboard marked this in-progress task as stale, but it does not recognize the reason.";
}

function staleElapsed(item, now) {
  if (!item) return "";
  const candidates = [
    item.freshness?.leaseHeartbeatAt,
    item.freshness?.presenceHeartbeatAt,
    item.freshness?.lastOwnerProgressAt,
    item.lastProgressAt
  ]
    .map((value) => Date.parse(value || ""))
    .filter(Number.isFinite);
  if (candidates.length === 0) return "";
  const elapsedMs = now.getTime() - Math.max(...candidates);
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "";
  const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function requiredRoleForAction(action) {
  if (action.kind === "role_gap") return action.role || "";
  if (action.kind === "grooming") return "pm";
  if (action.kind === "merge") return "reviewer";
  if (action.kind === "cleanup") return "";
  return action.role || action.task?.role || "";
}

function activeRoleCount(activeRoles, role) {
  if (!role) return 0;
  if (activeRoles instanceof Map) return activeRoles.get(role) || 0;
  return Number(activeRoles?.[role]) || 0;
}

function indefiniteArticle(value) {
  return /^[aeiou]/i.test(String(value || "")) ? "an" : "a";
}

function displayRole(role) {
  return role === "pm" ? "PM" : role;
}

function asSentence(value) {
  const text = String(value || "").trim();
  if (!text) return "The exact detail is not recorded.";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function taskAction({ task, kind, title, detail, remedy, tasks = [], ...metadata }) {
  return {
    id: `${kind}:${task.id}`,
    kind,
    title,
    detail,
    remedy,
    taskId: task.id,
    task,
    downstreamCount: downstreamImpact(task, tasks),
    ...metadata
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
  const tasksById = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  const downstreamByTaskId = new Map(tasks.map((candidate) => [candidate.id, new Set(candidate.blocks || [])]));

  for (const candidate of tasks) {
    for (const prerequisiteId of [...(candidate.dependsOn || []), ...(candidate.blockedBy || [])]) {
      const downstreamIds = downstreamByTaskId.get(prerequisiteId) || new Set();
      downstreamIds.add(candidate.id);
      downstreamByTaskId.set(prerequisiteId, downstreamIds);
    }
  }

  const reachable = new Set([task.id]);
  const pending = [...(downstreamByTaskId.get(task.id) || task.blocks || [])];
  while (pending.length > 0) {
    const downstreamTaskId = pending.pop();
    if (!downstreamTaskId || reachable.has(downstreamTaskId)) continue;
    reachable.add(downstreamTaskId);

    if (!tasksById.has(downstreamTaskId)) continue;
    for (const nextTaskId of downstreamByTaskId.get(downstreamTaskId) || []) {
      if (!reachable.has(nextTaskId)) pending.push(nextTaskId);
    }
  }

  return reachable.size;
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
  return [...counts.entries()]
    .map(([status, count]) => `${count} ${humanize(status).toLowerCase()} ${count === 1 ? "item" : "items"}`)
    .join(" and ");
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
