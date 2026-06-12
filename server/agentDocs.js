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
    accepts: ["tasks in status=review", "ready review tasks assigned to your exact agent id", "ready tasks with role=reviewer"],
    outputs: ["findings", "risk notes", "approval comments", "merge commits", "follow-up tasks"],
    doneMeans: "Approved work is merged and marked done with a completion record, or requested changes are returned with evidence."
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
      promptTemplate: "You are {agentType}. Read http://localhost:8088/api/agent-docs/{agentType}?format=md and do what it tells you."
    },
    suggestedAgents: [
      "pm",
      "implementer",
      "reviewer",
      "tester",
      "researcher",
      "security",
      "docs",
      "release",
      "observability"
    ],
    identityModel: identityModel(),
    slotBootstrap: {
      status: "planned",
      goal: "A worker should be able to say 'I am implementer' and receive the next empty slot such as implementer-04.",
      plannedEndpoint: "/api/bootstrap",
      plannedMcpTool: "acquire_agent_slot",
      currentFallback: "Until this exists, a PM/operator must assign each live worker a concrete temporary id such as implementer-a."
    },
    roles,
    statuses,
    worktree: worktreeDiscipline(),
    workflow: sharedWorkflow()
  };
}

export function buildAgentDoc({ agentId, roles, statuses, baseUrl = "http://localhost:8088" }) {
  const profile = resolveAgentProfile(agentId);
  const role = roles.find((candidate) => candidate.id === profile.role) || roles.find((candidate) => candidate.id === "implementer");
  const rule = ROLE_RULES[profile.role] || ROLE_RULES.implementer;
  const filters = taskFilters(profile);
  const isReviewer = profile.role === "reviewer";

  return {
    agentId,
    baseUrl,
    role: role?.id || profile.role,
    roleLabel: role?.label || profile.role,
    specialties: profile.specialties,
    identity: identityModel(agentId),
    mission: rule.mission,
    taskSelection: [
      "First, list active projects.",
      "If you were spawned from a role type only, use the concrete assignee/task the PM or operator gave you.",
      "Prefer the DOGFOOD project when it exists unless the operator named another project.",
      "Find tasks assigned to your exact agent id.",
      ...(isReviewer ? ["Then scan tasks in status=review; review-column work takes priority over ordinary reviewer-role tasks."] : []),
      `Then find ready tasks where role=${profile.role}.`,
      "Then find ready/backlog tasks matching your specialty labels.",
      "Sort by urgent, high, normal, low. Prefer ready over backlog.",
      "Claim exactly one task before doing substantive work."
    ],
    worktree: worktreeDiscipline(agentId),
    workflow: sharedWorkflow(),
    accepts: rule.accepts,
    outputs: rule.outputs,
    doneMeans: rule.doneMeans,
    api: {
      listProjects: `${baseUrl}/api/projects`,
      listTasks: `${baseUrl}/api/tasks?${new URLSearchParams(filters).toString()}`,
      claimTask: `${baseUrl}/api/tasks/{taskId}/claim`,
      ...(isReviewer ? { reviewQueue: `${baseUrl}/api/tasks?status=review` } : {}),
      agentDoc: `${baseUrl}/api/agent-docs/${encodeURIComponent(agentId)}?format=md`
    },
    reviewerMerge: isReviewer ? reviewerMergeRules() : [],
    mcp: {
      firstTool: "get_agent_instructions",
      then: ["list_projects", "list_tasks", "claim_task", "add_comment", "update_task_status"]
    },
    statuses: statuses.map((status) => status.id),
    cautions: [
      "Do not work unclaimed tasks.",
      "Do not claim tasks by PATCHing assignee/status directly; use the claim endpoint or MCP `claim_task`.",
      "Do not edit the main checkout directly for implementation work. Use a task branch/worktree first.",
      "Do not claim more than one task at a time unless the operator explicitly asks.",
      "Post a short progress comment before long work.",
      "Move blocked tasks to blocked with the exact decision or dependency needed.",
      "Do not move a task to done without a completion record.",
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
    "## Identity And Slots",
    doc.identity.summary,
    doc.identity.currentRule,
    "",
    "## Where To Start",
    `1. Read this document: ${doc.api.agentDoc}`,
    `2. List projects: ${doc.api.listProjects}`,
    `3. Find your tasks: ${doc.api.listTasks}`,
    ...(doc.api.reviewQueue ? [`4. Check the review queue: ${doc.api.reviewQueue}`, "5. Claim exactly one task before doing substantive work."] : ["4. Claim exactly one task before doing substantive work."]),
    "",
    "## Task Selection",
    ...doc.taskSelection.map((line, index) => `${index + 1}. ${line}`),
    "",
    "## Branch And Worktree Discipline",
    ...doc.worktree.map((line, index) => `${index + 1}. ${line}`),
    "",
    "## Workflow",
    ...doc.workflow.map((line, index) => `${index + 1}. ${line}`),
    "",
    ...(doc.reviewerMerge.length
      ? [
          "## Reviewer Merge Responsibility",
          ...doc.reviewerMerge.map((line, index) => `${index + 1}. ${line}`),
          ""
        ]
      : []),
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

function identityModel(agentId = "{agentType}") {
  return {
    status: "manual-slots",
    suggestedAgentsAre: "role types, not unique live worker identities",
    summary: "Suggested agent names such as `implementer` and `reviewer` are role types.",
    currentRule: `Automatic slot assignment is not implemented yet. Until /api/bootstrap exists, the PM/operator must give each live worker a concrete assignee id such as implementer-a, reviewer-a, or ${agentId}.`,
    futureRule: "After slot bootstrap lands, agents will be able to start from a role type and acquire an empty slot automatically."
  };
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
    "Claim one task through `POST /api/tasks/{taskId}/claim` or MCP `claim_task`; include expected status/assignee when known.",
    "Create or switch to a task branch/worktree before editing files.",
    "Post a comment with your plan and expected evidence.",
    "Do implementation work in the task worktree, not in the shared main checkout.",
    "Post evidence back to the task: files changed, tests run, findings, or blockers.",
    "Move the task to review, testing, done, or blocked according to the result. Done requires a completion record.",
    "Only then look for another task."
  ];
}

function reviewerMergeRules() {
  return [
    "A review is not complete just because you wrote findings. It is complete when the task is merged and marked done, or returned with requested changes.",
    "Review tasks in `status=review` before taking ordinary reviewer-role backlog work.",
    "Inspect the implementer's task comments, branch/worktree path, commit evidence, and stated test output.",
    "Run the relevant verification yourself when practical, at minimum `npm test` and `npm run build` for code changes before merge.",
    "If approved, merge the branch or commit according to the current repo workflow, then mark the original task done with completionType=merged, commitSha, branch, mergedTo, tests, and notes.",
    "For no-code planning, audit-only, or superseded closures, mark done with completionType=no-code, audit-only, or superseded and include clear notes or supersededByTaskId.",
    "If changes are needed, comment specific findings and move the original task back to `ready` or `blocked` with the reason.",
    "If you cannot merge because of permissions, conflicts, or unclear ownership, explicitly assign merge to another reviewer/operator and leave the task in `review` with the blocker."
  ];
}

function worktreeDiscipline(agentId = "<agent-id>") {
  const safeAgentId = String(agentId || "agent").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  return [
    "Before editing code, check `git status --short --branch` and confirm you are not doing implementation work directly on `main`.",
    `Use a task branch named like \`${safeAgentId}/<short-task-slug>\` or another operator-approved branch name.`,
    `Prefer a separate worktree for implementation, for example \`git worktree add C:/git/wt-agent-workboard-${safeAgentId}-<slug> -b ${safeAgentId}/<slug> origin/main\`.`,
    "Keep the main checkout for running/observing the local service and for operator state. Do not pile unrelated agent edits into it.",
    "Commit only your task files, run the task-specific checks, push your branch when possible, then comment the branch/commit/test evidence on the task.",
    "If you find dirty files you did not create, do not overwrite them. Report the conflict on the task or in Agent Talks."
  ];
}
