const ROLE_RULES = {
  pm: {
    mission: "Turn operator goals into clear, prioritized, well-scoped tasks for the agent team.",
    accepts: ["ready tasks assigned to pm-agent", "ready tasks with role=pm"],
    outputs: ["roadmaps", "task breakdowns", "acceptance criteria", "follow-up tasks", "blocker decisions"],
    doneMeans: "The next agents can start without guessing scope, priority, or acceptance criteria."
  },
  implementer: {
    mission: "Build one claimed task at a time, keep progress visible, and hand finished work to review.",
    accepts: ["ready tasks assigned to your exact agent id", "ready tasks with role=implementer", "backlog tasks matching your specialty labels"],
    outputs: ["code changes", "focused tests", "implementation notes", "evidence comments"],
    doneMeans: "The task is implemented, tested, commented with evidence, and moved to review."
  },
  reviewer: {
    mission: "Review task outcomes for correctness, risk, missing tests, and readiness to merge or release.",
    accepts: ["ready or review tasks assigned to your exact agent id", "review tasks with role=reviewer"],
    outputs: ["findings", "risk notes", "approval comments", "follow-up tasks"],
    doneMeans: "The task has a clear approve/request-changes outcome with evidence."
  },
  tester: {
    mission: "Verify behavior through reproducible tests, browser checks, fixtures, or explicit manual evidence.",
    accepts: ["ready or testing tasks assigned to your exact agent id", "testing tasks with role=tester"],
    outputs: ["test coverage", "reproduction steps", "verification notes", "failure reports"],
    doneMeans: "The task has repeatable evidence that the behavior works or a precise failure report."
  },
  researcher: {
    mission: "Collect the smallest useful evidence set that helps PMs, implementers, reviewers, or the operator decide.",
    accepts: ["ready tasks assigned to your exact agent id", "ready tasks with role=researcher"],
    outputs: ["source-backed summaries", "options", "tradeoffs", "open questions"],
    doneMeans: "The task has enough evidence for the next decision without burying the board in notes."
  },
  operator: {
    mission: "Set priorities, answer business/product decisions, and approve direction changes.",
    accepts: ["blocked tasks that need an operator decision", "high-priority planning tasks"],
    outputs: ["decisions", "priority changes", "scope approvals"],
    doneMeans: "Agents can proceed without waiting for missing business direction."
  }
};

const SPECIALTY_KEYWORDS = [
  ["frontend", ["frontend", "ui", "ux", "react", "browser", "design"]],
  ["backend", ["backend", "api", "server", "storage", "data"]],
  ["mcp", ["mcp", "tool", "agent-tools"]],
  ["tests", ["test", "tester", "qa", "e2e", "coverage"]],
  ["docs", ["doc", "docs", "readme", "onboarding"]],
  ["security", ["security", "auth", "permission", "role"]]
];

export function listAgentDocs({ roles, statuses }) {
  return {
    service: "agent-workboard",
    purpose: "Bootstrap agents from the board itself so every worker follows the same task-selection and reporting rules.",
    usage: {
      json: "/api/agent-docs/{agentId}",
      markdown: "/api/agent-docs/{agentId}?format=md",
      promptTemplate: "You are {agentId}. Read http://localhost:8088/api/agent-docs/{agentId}?format=md and do what it tells you."
    },
    suggestedAgents: [
      "pm-agent",
      "reviewer-agent",
      "test-agent",
      "implementer-frontend-1",
      "implementer-backend-1",
      "mcp-agent",
      "security-reviewer"
    ],
    roles,
    statuses,
    workflow: sharedWorkflow()
  };
}

export function buildAgentDoc({ agentId, roles, statuses, baseUrl = "http://localhost:8088" }) {
  const profile = resolveAgentProfile(agentId);
  const role = roles.find((candidate) => candidate.id === profile.role) || roles.find((candidate) => candidate.id === "implementer");
  const rule = ROLE_RULES[profile.role] || ROLE_RULES.implementer;
  const filters = taskFilters(profile);

  return {
    agentId,
    baseUrl,
    role: role?.id || profile.role,
    roleLabel: role?.label || profile.role,
    specialties: profile.specialties,
    mission: rule.mission,
    taskSelection: [
      "First, list active projects.",
      "Prefer the DOGFOOD project when it exists unless the operator named another project.",
      "Find tasks assigned to your exact agent id.",
      `Then find ready tasks where role=${profile.role}.`,
      "Then find ready/backlog tasks matching your specialty labels.",
      "Sort by urgent, high, normal, low. Prefer ready over backlog.",
      "Claim exactly one task before doing substantive work."
    ],
    workflow: sharedWorkflow(),
    accepts: rule.accepts,
    outputs: rule.outputs,
    doneMeans: rule.doneMeans,
    api: {
      listProjects: `${baseUrl}/api/projects`,
      listTasks: `${baseUrl}/api/tasks?${new URLSearchParams(filters).toString()}`,
      agentDoc: `${baseUrl}/api/agent-docs/${encodeURIComponent(agentId)}?format=md`
    },
    mcp: {
      firstTool: "get_agent_instructions",
      then: ["list_projects", "list_tasks", "claim_task", "add_comment", "update_task_status"]
    },
    statuses: statuses.map((status) => status.id),
    cautions: [
      "Do not work unclaimed tasks.",
      "Do not claim more than one task at a time unless the operator explicitly asks.",
      "Post a short progress comment before long work.",
      "Move blocked tasks to blocked with the exact decision or dependency needed.",
      "Move finished implementation to review, not directly to done, unless your role is reviewer/tester and the task asks for that."
    ]
  };
}

export function renderAgentDocMarkdown(doc) {
  return [
    `# Agent Workboard Instructions: ${doc.agentId}`,
    "",
    `You are **${doc.agentId}**.`,
    "",
    `Role: **${doc.roleLabel}** (${doc.role})`,
    `Specialties: ${doc.specialties.length ? doc.specialties.join(", ") : "general"}`,
    "",
    "## Mission",
    doc.mission,
    "",
    "## Where To Start",
    `1. Read this document: ${doc.api.agentDoc}`,
    `2. List projects: ${doc.api.listProjects}`,
    `3. Find your tasks: ${doc.api.listTasks}`,
    "4. Claim exactly one task before doing substantive work.",
    "",
    "## Task Selection",
    ...doc.taskSelection.map((line, index) => `${index + 1}. ${line}`),
    "",
    "## Workflow",
    ...doc.workflow.map((line, index) => `${index + 1}. ${line}`),
    "",
    "## Good Outputs",
    ...doc.outputs.map((line) => `- ${line}`),
    "",
    "## Done Means",
    doc.doneMeans,
    "",
    "## Cautions",
    ...doc.cautions.map((line) => `- ${line}`),
    "",
    "## MCP Path",
    `Use \`${doc.mcp.firstTool}\` first, then ${doc.mcp.then.map((tool) => `\`${tool}\``).join(", ")}.`,
    ""
  ].join("\n");
}

function resolveAgentProfile(agentId) {
  const normalized = String(agentId || "").toLowerCase();
  const role = inferRole(normalized);
  const specialties = SPECIALTY_KEYWORDS.filter(([, keywords]) => keywords.some((keyword) => normalized.includes(keyword))).map(
    ([specialty]) => specialty
  );
  return {
    role,
    specialties: [...new Set(specialties)]
  };
}

function inferRole(agentId) {
  if (agentId.includes("operator")) return "operator";
  if (agentId.includes("pm") || agentId.includes("dispatcher") || agentId.includes("manager")) return "pm";
  if (agentId.includes("review") || agentId.includes("security")) return "reviewer";
  if (agentId.includes("test") || agentId.includes("qa")) return "tester";
  if (agentId.includes("research")) return "researcher";
  return "implementer";
}

function taskFilters(profile) {
  const filters = {
    role: profile.role
  };
  if (profile.specialties.length > 0) {
    filters.labels = profile.specialties.join(",");
  }
  return filters;
}

function sharedWorkflow() {
  return [
    "List projects and choose the operator-named project, or DOGFOOD when no project is named.",
    "List candidate tasks using your exact agent id, role, and specialty labels.",
    "Claim one task by setting yourself as assignee and moving it to in_progress.",
    "Post a comment with your plan and expected evidence.",
    "Do the work outside the board when needed.",
    "Post evidence back to the task: files changed, tests run, findings, or blockers.",
    "Move the task to review, testing, done, or blocked according to the result.",
    "Only then look for another task."
  ];
}
