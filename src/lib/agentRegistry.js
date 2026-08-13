import { countClaimableReadyTasks } from "./agentBootstrap.js";

const STATUS_LABELS = {
  busy: "Busy",
  blocked: "Blocked",
  review: "Review",
  assigned: "Assigned",
  stale: "Stale",
  active: "Active",
  waiting: "Waiting",
  idle: "Idle",
  paused: "Paused"
};

const STATUS_RANK = {
  busy: 0,
  blocked: 1,
  review: 2,
  assigned: 3,
  stale: 4,
  waiting: 5,
  active: 6,
  idle: 7,
  paused: 8
};

export function buildAgentRegistry({ agentSlots = {}, tasks = [], roles = [], workItemTypes = [] } = {}) {
  const types = Array.isArray(agentSlots.types) ? agentSlots.types : [];
  const slots = Array.isArray(agentSlots.slots) ? agentSlots.slots : [];
  const typeById = new Map(types.map((type) => [type.id, type]));
  const roleById = new Map(roles.map((role) => [role.id, role]));
  const agentsById = new Map();

  for (const slot of slots) {
    const type = typeById.get(slot.typeId);
    const role = slot.role || type?.role || inferRoleFromAgentId(slot.id);
    agentsById.set(slot.id, {
      id: slot.id,
      source: "slot",
      role,
      roleLabel: roleById.get(role)?.label || titleize(role),
      typeId: slot.typeId || type?.id || "",
      typeLabel: titleize(slot.typeId || type?.id || role),
      slotNumber: slot.slotNumber || 0,
      specialties: normalizeList(slot.specialties?.length ? slot.specialties : type?.specialties),
      workMode: slot.workMode || type?.defaultWorkMode || "",
      slot,
      tasks: []
    });
  }

  for (const task of tasks) {
    if (!task.assignee) continue;

    if (!agentsById.has(task.assignee)) {
      const role = task.role || inferRoleFromAgentId(task.assignee);
      agentsById.set(task.assignee, {
        id: task.assignee,
        source: "task-assignee",
        role,
        roleLabel: roleById.get(role)?.label || titleize(role),
        typeId: "task-assignee",
        typeLabel: "Task Assignee",
        slotNumber: 0,
        specialties: [],
        workMode: "",
        slot: null,
        tasks: []
      });
    }

    const agent = agentsById.get(task.assignee);
    agent.tasks.push(task);
    if (agent.source === "task-assignee") {
      agent.role = mostCommonRole(agent.tasks) || agent.role;
      agent.roleLabel = roleById.get(agent.role)?.label || titleize(agent.role);
      agent.specialties = normalizeList([...agent.specialties, ...(task.labels || [])]);
    }
  }

  const agents = [...agentsById.values()].map(finalizeAgent).sort(compareAgents);
  const configuredAgents = agents.filter(isConfiguredAgent);
  const historicalAgents = agents.filter(isHistoricalAssignee);
  const typeSummaries = types.map((type) => summarizeAgentType(type, configuredAgents, roleById)).sort(compareTypeSummaries);
  const roleOrder = orderedRoles(roles, agents);
  const groups = roleOrder.map((role) => {
    const groupAgents = agents.filter((agent) => agent.role === role);
    const configuredGroupAgents = groupAgents.filter(isConfiguredAgent);
    const historicalGroupAgents = groupAgents.filter(isHistoricalAssignee);
    const withinCapacityAgents = configuredGroupAgents.filter((agent) => agent.withinCapacity);
    const activeAgents = configuredGroupAgents.filter((agent) => agent.presenceFresh && !agent.paused);
    const unresponsiveAgents = configuredGroupAgents.filter((agent) => agent.unresponsive);
    const problemAgents = groupAgents.filter((agent) => agent.problem);
    const visibleAgents = groupAgents.filter((agent) => agent.presenceFresh || agent.problem);
    const hiddenAgents = groupAgents.filter((agent) => !visibleAgents.includes(agent));
    const roleTypes = typeSummaries.filter((type) => type.role === role);
    const queuedWork = countClaimableReadyTasks(
      tasks.filter((task) => task.role === role),
      workItemTypes
    );
    return {
      role,
      label: roleById.get(role)?.label || titleize(role),
      agents: groupAgents,
      configuredAgents: configuredGroupAgents,
      historicalAgents: historicalGroupAgents,
      types: roleTypes,
      activeAgents,
      unresponsiveAgents,
      problemAgents,
      visibleAgents,
      hiddenAgents,
      total: groupAgents.length,
      configured: withinCapacityAgents.length,
      historical: historicalGroupAgents.length,
      active: activeAgents.length,
      unresponsive: unresponsiveAgents.length,
      available: withinCapacityAgents.filter((agent) => agent.available).length,
      queuedWork,
      needsAttention: queuedWork > 0 && activeAgents.length === 0,
      canFill: roleTypes.some((type) => type.capacity > 0),
      busy: groupAgents.filter((agent) => agent.status === "busy").length,
      blocked: groupAgents.filter((agent) => agent.status === "blocked").length,
      waiting: groupAgents.filter((agent) => agent.status === "waiting").length,
      idle: groupAgents.filter((agent) => agent.status === "idle").length
    };
  });

  return {
    agents,
    typeSummaries,
    groups,
    totalAgents: agents.length,
    configuredAgentCount: configuredAgents.length,
    historicalAssigneeCount: historicalAgents.length,
    activeAgents: configuredAgents.filter((agent) => agent.presenceFresh && !agent.paused).length,
    unresponsiveAgents: configuredAgents.filter((agent) => agent.unresponsive).length,
    availableAgents: configuredAgents.filter((agent) => agent.withinCapacity && agent.available).length,
    problemAgents: agents.filter((agent) => agent.problem).length,
    busyAgents: agents.filter((agent) => agent.status === "busy").length,
    blockedAgents: agents.filter((agent) => agent.status === "blocked").length,
    waitingAgents: agents.filter((agent) => agent.status === "waiting").length,
    idleAgents: agents.filter((agent) => agent.status === "idle").length
  };
}

function summarizeAgentType(type, agents, roleById) {
  const slots = agents.filter((agent) => agent.source === "slot" && agent.typeId === type.id).sort((a, b) => a.slotNumber - b.slotNumber);
  const active = Number.isInteger(type.active) ? type.active : slots.filter((agent) => agent.active).length;
  const available = Number.isInteger(type.available) ? type.available : slots.filter((agent) => agent.available).length;
  const configured = Number.isInteger(type.configured) ? type.configured : slots.length;
  return {
    id: type.id,
    label: titleize(type.id),
    role: type.role,
    roleLabel: roleById.get(type.role)?.label || titleize(type.role),
    capacity: Number.isInteger(type.capacity) ? type.capacity : configured,
    configured,
    active,
    occupied: Number.isInteger(type.occupied) ? type.occupied : active,
    available,
    free: Number.isInteger(type.free) ? type.free : available,
    stale: Number.isInteger(type.stale) ? type.stale : slots.filter((agent) => agent.stale).length,
    paused: Number.isInteger(type.paused) ? type.paused : slots.filter((agent) => agent.paused).length,
    specialties: normalizeList(type.specialties),
    defaultWorkMode: type.defaultWorkMode || "",
    slotIds: normalizeList(type.slotIds),
    slots
  };
}

function compareTypeSummaries(left, right) {
  return left.role.localeCompare(right.role) || left.id.localeCompare(right.id);
}

function isConfiguredAgent(agent) {
  return agent.source === "slot";
}

function isHistoricalAssignee(agent) {
  return agent.source === "task-assignee";
}

function finalizeAgent(agent) {
  const assignedTasks = [...agent.tasks].sort(compareTasksForAgent);
  const openTasks = assignedTasks.filter((task) => task.status !== "done");
  const currentTask = openTasks.find((task) => task.status === "in_progress") || null;
  const blockedTaskCount = openTasks.filter((task) => task.status === "blocked").length;
  const reviewTaskCount = openTasks.filter((task) => task.status === "review").length;
  const status = agentStatus({ agent, currentTask, openTasks, blockedTaskCount, reviewTaskCount });
  const presenceFresh = Boolean(agent.slot?.presenceFresh);
  const leaseFresh = Boolean(agent.slot?.leaseFresh);
  const unresponsive = Boolean(agent.source === "slot" && leaseFresh && !presenceFresh && !agent.slot?.paused);
  const stalled = Boolean(currentTask && !presenceFresh && !leaseFresh);
  const problem = Boolean(
    unresponsive || stalled || agent.slot?.stale || agent.slot?.paused || status === "blocked"
  );
  const heartbeatAt =
    agent.slot?.presence?.lastHeartbeat ||
    agent.slot?.presence?.updatedAt ||
    agent.slot?.lease?.heartbeatAt ||
    agent.slot?.lease?.acquiredAt ||
    "";

  return {
    id: agent.id,
    source: agent.source,
    role: agent.role,
    roleLabel: agent.roleLabel,
    typeId: agent.typeId,
    typeLabel: agent.typeLabel,
    slotNumber: agent.slotNumber,
    specialties: normalizeList(agent.specialties),
    workMode: agent.workMode,
    status,
    statusLabel: STATUS_LABELS[status] || titleize(status),
    active: Boolean(agent.slot?.active),
    activeProjectId: agent.slot?.activeProjectId || "",
    presenceFresh,
    leaseFresh,
    unresponsive,
    stalled,
    problem,
    heartbeatAt,
    presenceMessage: agent.slot?.presence?.message || agent.slot?.presence?.noEligibleWork?.message || "",
    paused: Boolean(agent.slot?.paused),
    stale: Boolean(agent.slot?.stale),
    waiting: agent.slot?.presence?.state === "waiting" && agent.slot?.presence?.status === "waiting",
    upstreamSignal: agent.slot?.presence?.upstreamSignal || null,
    available: Boolean(agent.slot?.available),
    withinCapacity: agent.slot?.withinCapacity !== false,
    currentTask,
    assignedTasks: openTasks,
    assignedTaskCount: assignedTasks.length,
    openTaskCount: openTasks.length,
    blockedTaskCount,
    reviewTaskCount,
    inProgressTaskCount: openTasks.filter((task) => task.status === "in_progress").length,
    lastActivityAt: latestTimestamp([
      agent.slot?.updatedAt,
      agent.slot?.lease?.heartbeatAt,
      agent.slot?.lease?.acquiredAt,
      ...assignedTasks.flatMap((task) => [task.updatedAt, task.createdAt, ...(task.activity || []).map((event) => event.createdAt)])
    ])
  };
}

export function buildAgentBootstrapPrompt(role, baseUrl = "http://127.0.0.1:8088") {
  const normalizedRole = String(role || "").trim();
  const normalizedBaseUrl = String(baseUrl || "http://127.0.0.1:8088").replace(/\/$/, "");
  if (!normalizedRole) return "";
  return `You are ${normalizedRole}. Read ${normalizedBaseUrl}/api/agent-docs/${encodeURIComponent(normalizedRole)}?format=md and do what it tells you.`;
}

function agentStatus({ agent, currentTask, openTasks, blockedTaskCount, reviewTaskCount }) {
  if (agent.slot?.paused) return "paused";
  if (currentTask) return "busy";
  if (blockedTaskCount > 0) return "blocked";
  if (reviewTaskCount > 0) return "review";
  if (openTasks.length > 0) return "assigned";
  if (agent.slot?.stale) return "stale";
  if (agent.slot?.presence?.state === "waiting" && agent.slot?.presence?.status === "waiting") return "waiting";
  if (agent.slot?.active) return "active";
  return "idle";
}

function compareAgents(left, right) {
  return (
    (STATUS_RANK[left.status] ?? 99) - (STATUS_RANK[right.status] ?? 99) ||
    left.role.localeCompare(right.role) ||
    left.typeId.localeCompare(right.typeId) ||
    left.id.localeCompare(right.id)
  );
}

function compareTasksForAgent(left, right) {
  const statusDelta = taskStatusRank(left.status) - taskStatusRank(right.status);
  if (statusDelta !== 0) return statusDelta;
  return (right.updatedAt || "").localeCompare(left.updatedAt || "") || left.title.localeCompare(right.title);
}

function taskStatusRank(status) {
  if (status === "in_progress") return 0;
  if (status === "blocked") return 1;
  if (status === "review") return 2;
  if (status === "testing") return 3;
  if (status === "ready") return 4;
  if (status === "backlog") return 5;
  if (status === "done") return 6;
  return 7;
}

function orderedRoles(roles, agents) {
  const seen = new Set();
  const ordered = [];
  for (const role of roles) {
    if (!seen.has(role.id)) {
      seen.add(role.id);
      ordered.push(role.id);
    }
  }
  for (const agent of agents) {
    if (!seen.has(agent.role)) {
      seen.add(agent.role);
      ordered.push(agent.role);
    }
  }
  return ordered;
}

function mostCommonRole(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    if (!task.role) continue;
    counts.set(task.role, (counts.get(task.role) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || "";
}

function latestTimestamp(values) {
  return values.filter(Boolean).sort((a, b) => String(b).localeCompare(String(a)))[0] || "";
}

function normalizeList(value = []) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean))];
}

function titleize(value = "") {
  return String(value)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function inferRoleFromAgentId(agentId = "") {
  const normalized = agentId.toLowerCase();
  if (normalized.includes("pm")) return "pm";
  if (normalized.includes("review") || normalized.includes("security-reviewer")) return "reviewer";
  if (normalized.includes("test") || normalized.includes("qa")) return "tester";
  if (normalized.includes("research")) return "researcher";
  return "implementer";
}
