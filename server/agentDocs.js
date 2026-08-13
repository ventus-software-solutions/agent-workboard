import { worktreePath } from "./worktreePaths.js";
import { formatAgentBootstrapPrompt } from "../shared/agentBootstrap.js";

const ROLE_RULES = {
  pm: {
    mission: "Turn operator goals into clear, prioritized, well-scoped tasks for the agent team.",
    accepts: ["ready tasks assigned to pm-agent", "ready tasks with role=pm"],
    outputs: ["roadmaps", "task breakdowns", "acceptance criteria", "follow-up tasks", "blocker decisions"],
    upstreamStages: ["backlog", "ready"],
    doneMeans: "The next agents can start without guessing scope, priority, or acceptance criteria."
  },
  implementer: {
    mission: "Build one claimed task at a time, keep progress visible, and hand finished work to review.",
    accepts: ["ready tasks assigned to your exact agent id", "ready tasks with role=implementer", "backlog tasks matching your specialty labels"],
    outputs: ["code changes", "focused tests", "implementation notes", "evidence comments"],
    upstreamStages: ["ready", "backlog"],
    doneMeans: "The task is implemented, tested, commented with evidence, and moved to review."
  },
  reviewer: {
    mission: "Review task outcomes for correctness, risk, missing tests, and readiness to merge or release.",
    accepts: ["tasks in status=review", "ready review tasks assigned to your exact agent id", "ready tasks with role=reviewer"],
    outputs: ["findings", "risk notes", "approval comments", "merge commits", "follow-up tasks"],
    upstreamStages: ["in_progress", "ready"],
    doneMeans: "Approved work is merged and marked done with a completion record, or requested changes are returned with evidence."
  },
  tester: {
    mission: "Verify behavior through reproducible tests, browser checks, fixtures, or explicit manual evidence.",
    accepts: ["ready or testing tasks assigned to your exact agent id", "testing tasks with role=tester"],
    outputs: ["test coverage", "reproduction steps", "verification notes", "failure reports"],
    upstreamStages: ["review", "in_progress"],
    doneMeans: "The task has repeatable evidence that the behavior works or a precise failure report."
  },
  researcher: {
    mission: "Collect the smallest useful evidence set that helps PMs, implementers, reviewers, or the operator decide.",
    accepts: ["ready tasks assigned to your exact agent id", "ready tasks with role=researcher"],
    outputs: ["source-backed summaries", "options", "tradeoffs", "open questions"],
    upstreamStages: ["ready", "backlog"],
    doneMeans: "The task has enough evidence for the next decision without burying the board in notes."
  },
  operator: {
    mission: "Set priorities, answer business/product decisions, and approve direction changes.",
    accepts: ["blocked tasks that need an operator decision", "high-priority planning tasks"],
    outputs: ["decisions", "priority changes", "scope approvals"],
    upstreamStages: ["blocked"],
    doneMeans: "Agents can proceed without waiting for missing business direction."
  }
};

const PLANNER_DECOMPOSER_TYPE_ID = "planner-decomposer";

const AUTONOMOUS_GO_AHEAD = {
  status: "claimed-task-implicit-go-ahead",
  ordinaryRule:
    "For an ordinary ready task, a successful claim plus a visible plan is the go-ahead to implement, test, review, or groom without waiting for a separate human yes.",
  safetyRule:
    "Still verify assumptions first; wait for explicit approval before destructive changes, scope changes, ambiguous requirements, cross-project overrides, or tasks marked as needing operator approval.",
  approvalQueueRule:
    "When explicit approval is needed, use the operator approval queue or mark the task blocked with the exact decision needed instead of silently parking in progress.",
  migrationGuidance:
    "For active tasks already waiting only for ordinary go-ahead, post an acknowledgement citing this policy and continue; if the work is ambiguous or approval-marked, convert the wait into an operator approval request or blocked status."
};

const SPECIALTY_KEYWORDS = [
  ["frontend", ["frontend", "ui", "ux", "react", "browser", "design"]],
  ["backend", ["backend", "api", "server", "storage", "data"]],
  ["mcp", ["mcp", "tool", "agent-tools"]],
  ["tests", ["test", "tester", "qa", "e2e", "coverage"]],
  ["docs", ["doc", "docs", "readme", "onboarding"]],
  ["planner", ["planner", "plan"]],
  ["decomposition", ["decomposer", "decomposition", "epic", "story"]],
  ["security", ["security", "auth", "permission", "role"]]
];

export function listAgentDocs({ roles, statuses, integrationStatus = null, deploymentSettings = null }) {
  const deploymentProcessRules = deploymentProcessRulesFromSettings(deploymentSettings);
  return {
    service: "agent-workboard",
    purpose: "Bootstrap agents from the board itself so every worker follows the same task-selection and reporting rules.",
    usage: {
      json: "/api/agent-docs/{agentId}",
      markdown: "/api/agent-docs/{agentId}?format=md",
      promptTemplate: formatAgentBootstrapPrompt({
        agentType: "{agentType}",
        origin: "http://localhost:8088"
      })
    },
    suggestedAgents: [
      "pm",
      "implementer",
      "reviewer",
      "tester",
      "planner",
      "decomposer",
      "researcher",
      "security",
      "docs",
      "release",
      "observability"
    ],
    identityModel: identityModel(),
    slotBootstrap: {
      status: "available-http",
      goal: "A worker can say 'I am implementer' and receive the next empty matching slot such as implementer-backend-1.",
      httpEndpoint: "/api/bootstrap",
      plannedMcpTool: "acquire_agent_slot",
      currentRule: "Generic workers should acquire a concrete slot before claiming tasks unless the PM/operator gave an explicit agent id."
    },
    roles,
    statuses,
    integrationStatus,
    ...(deploymentProcessRules ? { deploymentProcessRules } : {}),
    worktree: worktreeDiscipline(undefined, integrationStatus),
    autonomousGoAhead: AUTONOMOUS_GO_AHEAD,
    workflow: sharedWorkflow()
  };
}

export function buildAgentDoc({
  agentId,
  roles,
  statuses,
  agentSlots = [],
  agentTypes = [],
  baseUrl = "http://localhost:8088",
  integrationStatus = null,
  projectContext = null,
  deploymentSettings = null
}) {
  const normalizedAgentId = String(agentId || "").toLowerCase();
  const configuredSlot = agentSlots.find((slot) => slot.id === normalizedAgentId);
  const configuredType = configuredSlot ? agentTypes.find((type) => type.id === configuredSlot.typeId) : null;
  const profile = resolveAgentProfile(agentId, { slot: configuredSlot, type: configuredType });
  const role = roles.find((candidate) => candidate.id === profile.role) || roles.find((candidate) => candidate.id === "implementer");
  const isPlannerDecomposer = profile.typeId === PLANNER_DECOMPOSER_TYPE_ID;
  const rule = isPlannerDecomposer ? plannerDecomposerRule() : ROLE_RULES[profile.role] || ROLE_RULES.implementer;
  const activeProject = projectContext?.activeProject || null;
  const activeProjectId = projectContext?.activeProjectId || activeProject?.id || "";
  const activeProjectLabel = activeProject ? `${activeProject.key || activeProject.name} (${activeProject.id})` : "No active project assigned";
  const filters = taskFilters(profile, activeProjectId);
  const isReviewer = profile.role === "reviewer";
  const isTester = profile.role === "tester";
  const usesStageClaims = isReviewer || isTester;
  const workflow = isPlannerDecomposer ? plannerDecomposerWorkflow() : sharedWorkflow();
  const mcpTools = [
    "acquire_agent_slot",
    "get_next_task",
    "claim_task",
    ...(usesStageClaims ? ["claim_task_stage", "resolve_task_stage"] : []),
    ...(isPlannerDecomposer ? ["decompose_task"] : []),
    "update_presence",
    "post_talk_message",
    "list_talk_messages",
    "add_comment",
    "update_task_status",
    "release_agent_slot",
    "report_no_eligible_work"
  ];
  const deploymentProcessRules = deploymentProcessRulesFromSettings(deploymentSettings);

  return {
    agentId,
    baseUrl,
    role: role?.id || profile.role,
    roleLabel: role?.label || profile.role,
    specialties: profile.specialties,
    activeProjectId,
    activeProject,
    identity: identityModel(agentId, { agentSlots, agentTypes }),
    mission: rule.mission,
    ...(deploymentProcessRules ? { deploymentProcessRules } : {}),
    taskSelection: [
      `Use assigned project ${activeProjectLabel} unless the operator gives an explicit override.`,
      "First, list active projects if you need to confirm project names or keys.",
      "If you were spawned from a role type only, acquire a concrete slot through /api/bootstrap before claiming tasks.",
      activeProjectId
        ? `Call next-task helpers with projectId=${activeProjectId}, or omit projectId after bootstrap so the active project is applied automatically.`
        : "Call next-task helpers with an explicit projectId before claiming work.",
      "Find tasks assigned to your exact agent id.",
      ...(isReviewer ? ["Then scan tasks in status=review; review-column work takes priority over ordinary reviewer-role tasks."] : []),
      `Then find ready tasks where role=${profile.role}.`,
      "Then find ready/backlog tasks matching your specialty labels.",
      "Sort by urgent, high, normal, low. Prefer ready over backlog.",
      usesStageClaims
        ? "Claim review/testing work with the stage claim returned by next-task; this preserves the implementation assignee."
        : "Claim exactly one task before doing substantive work."
    ],
    integrationStatus,
    worktree: worktreeDiscipline(agentId, integrationStatus),
    autonomousGoAhead: AUTONOMOUS_GO_AHEAD,
    workflow,
    persistence: standingAgentPersistence(profile.role, rule.upstreamStages),
    accepts: rule.accepts,
    outputs: rule.outputs,
    doneMeans: rule.doneMeans,
    api: {
      listProjects: `${baseUrl}/api/projects`,
      listTasks: `${baseUrl}/api/tasks?${new URLSearchParams(filters).toString()}`,
      claimTask: `${baseUrl}/api/tasks/{taskId}/claim`,
      stageClaim: `${baseUrl}/api/tasks/{taskId}/stage-claim`,
      stageResolution: `${baseUrl}/api/tasks/{taskId}/stage-resolution`,
      bootstrap: `${baseUrl}/api/bootstrap`,
      agentSlots: `${baseUrl}/api/agent-slots`,
      nextTask: `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/next-task`,
      presence: `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/presence`,
      noEligibleWork: `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/no-eligible-work`,
      integrationStatus: `${baseUrl}/api/integration-status`,
      talks: activeProjectId ? `${baseUrl}/api/projects/${encodeURIComponent(activeProjectId)}/talks` : `${baseUrl}/api/projects/{projectId}/talks`,
      ...(isReviewer ? { reviewQueue: `${baseUrl}/api/tasks?status=review` } : {}),
      agentDoc: `${baseUrl}/api/agent-docs/${encodeURIComponent(agentId)}?format=md`
    },
    reviewerMerge: isReviewer ? reviewerMergeRules() : [],
    mcp: {
      firstTool: "get_agent_instructions",
      then: mcpTools
    },
    statuses: statuses.map((status) => status.id),
    cautions: [
      "Do not work unclaimed tasks.",
      usesStageClaims
        ? "Do not claim review/testing work by PATCHing assignee/status; use the stage-claim endpoint or MCP `claim_task_stage`."
        : "Do not claim tasks by PATCHing assignee/status directly; use the claim endpoint or MCP `claim_task`.",
      "Do not edit the main checkout directly for implementation work. Use a task branch/worktree first.",
      "Do not claim more than one task at a time unless the operator explicitly asks.",
      ...(isPlannerDecomposer ? ["Do not implement code from decomposition container tasks; create or propose child tasks and hand the parent off with evidence."] : []),
      "Do not park an ordinary claimed task in progress waiting for a generic go-ahead; request operator approval or block the task when explicit approval is actually needed.",
      "Wait for explicit approval before destructive changes, scope changes, ambiguous requirements, cross-project overrides, or tasks marked as needing operator approval.",
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
    `Assigned Project: ${doc.activeProject ? `${doc.activeProject.key || doc.activeProject.name} (${doc.activeProject.id})` : "none"}`,
    "",
    "## Mission",
    doc.mission,
    "",
    ...(doc.deploymentProcessRules
      ? [
          "## Deployment process rules (OVERRIDE defaults)",
          doc.deploymentProcessRules,
          ""
        ]
      : []),
    "## Identity And Slots",
    doc.identity.summary,
    doc.identity.currentRule,
    "",
    "## Where To Start",
    `1. Read this document: ${doc.api.agentDoc}`,
    `2. If you were started as a generic type, acquire a concrete slot: ${doc.api.bootstrap}`,
    `3. List projects: ${doc.api.listProjects}`,
    `4. Find your tasks: ${doc.api.listTasks}`,
    ...(doc.api.reviewQueue ? [`5. Check the review queue: ${doc.api.reviewQueue}`, "6. Claim exactly one task before doing substantive work."] : ["5. Claim exactly one task before doing substantive work."]),
    "",
    "## Task Selection",
    ...doc.taskSelection.map((line, index) => `${index + 1}. ${line}`),
    "",
    "## Branch And Worktree Discipline",
    ...doc.worktree.map((line, index) => `${index + 1}. ${line}`),
    "",
    ...(doc.integrationStatus
      ? [
          "## Integration Source",
          `Source of truth: \`${doc.integrationStatus.sourceOfTruth}\`.`,
          `Recommended worktree base: \`${doc.integrationStatus.baseRef || "reconcile-first"}\`.`,
          `Local head: \`${doc.integrationStatus.localHead || "unknown"}\`; origin head: \`${doc.integrationStatus.originHead || "unknown"}\`.`,
          `Push debt: ${doc.integrationStatus.pushDebt ? `yes (${doc.integrationStatus.ahead} ahead, ${doc.integrationStatus.behind} behind)` : "no"}.`,
          doc.integrationStatus.summary,
          ...(doc.integrationStatus.recoveryActions || []).map((line) => `- ${line}`),
          ""
        ]
      : []),
    "## Workflow",
    ...doc.workflow.map((line, index) => `${index + 1}. ${line}`),
    "",
    "## Autonomous Go-Ahead",
    `Status: \`${doc.autonomousGoAhead.status}\`.`,
    doc.autonomousGoAhead.ordinaryRule,
    doc.autonomousGoAhead.safetyRule,
    doc.autonomousGoAhead.approvalQueueRule,
    doc.autonomousGoAhead.migrationGuidance,
    "",
    "## Standing Agent Persistence",
    ...doc.persistence.map((line, index) => `${index + 1}. ${line}`),
    "",
    "## Agent Talks",
    `Use project-scoped Agent Talks for coordination: ${doc.api.talks}.`,
    "Use Talks for claim announcements, blocker broadcasts, review requests, handoffs, questions, and decisions that affect more than one task.",
    "Use task comments for evidence, plans, review findings, test output, and status-specific history for one task.",
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

function deploymentProcessRulesFromSettings(deploymentSettings) {
  return typeof deploymentSettings?.processOverrides === "string" ? deploymentSettings.processOverrides.trim() : "";
}

function identityModel(agentId = "{agentType}", { agentSlots = [], agentTypes = [] } = {}) {
  const normalized = String(agentId || "").toLowerCase();
  const configuredSlot = agentSlots.find((slot) => slot.id === normalized);
  const genericType = slotTypeForAgentDoc(normalized, agentTypes, agentSlots);
  const suggestedSlotIds = genericType?.slotIds?.length ? genericType.slotIds : [];

  if (configuredSlot) {
    return {
      status: "http-slot-bootstrap",
      suggestedAgentsAre: "role types, not unique live worker identities",
      summary: "Suggested agent names such as `implementer` and `reviewer` are role types.",
      currentRule: `HTTP slot bootstrap is available at /api/bootstrap. \`${agentId}\` is a configured concrete slot id; use that exact assignee id when claiming work, or renew it through /api/bootstrap when running continuously.`,
      futureRule: "MCP acquire_agent_slot provides the same slot acquisition path for MCP-only workers."
    };
  }

  if (genericType) {
    const slotExamples = suggestedSlotIds.map((slotId) => `\`${slotId}\``).join(" or ");
    return {
      status: "http-slot-bootstrap",
      suggestedAgentsAre: "role types, not unique live worker identities",
      summary: "Suggested agent names such as `implementer` and `reviewer` are role types.",
      currentRule: `You were started from the role type \`${agentId}\`, not a live worker identity. HTTP slot bootstrap is available at /api/bootstrap; acquire a concrete slot${slotExamples ? ` such as ${slotExamples}` : ""} before claiming tasks.`,
      futureRule: "MCP acquire_agent_slot provides the same slot acquisition path for MCP-only workers."
    };
  }

  return {
    status: "http-slot-bootstrap",
    suggestedAgentsAre: "role types, not unique live worker identities",
    summary: "Suggested agent names such as `implementer` and `reviewer` are role types.",
    currentRule: `HTTP slot bootstrap is available at /api/bootstrap. Use \`${agentId}\` as a non-slot assignee only when the PM/operator explicitly approved it; otherwise acquire an empty matching slot first.`,
    futureRule: "MCP acquire_agent_slot provides the same slot acquisition path for MCP-only workers."
  };
}

function slotTypeForAgentDoc(agentId, agentTypes, agentSlots) {
  if (!agentId) return null;
  if (agentSlots.some((slot) => slot.id === agentId)) return null;

  const directType = agentTypes.find((type) => type.id === agentId);
  if (directType) return directType;

  const roleTypes = agentTypes.filter((type) => type.role === agentId);
  if (roleTypes.length === 1) return roleTypes[0];

  const aliases = {
    backend: "implementer-backend",
    frontend: "implementer-frontend",
    implementer: "implementer-general",
    general: "implementer-general",
    review: "reviewer",
    test: "tester",
    tests: "tester",
    security: "implementer-security",
    planner: PLANNER_DECOMPOSER_TYPE_ID,
    decomposer: PLANNER_DECOMPOSER_TYPE_ID,
    decomposition: PLANNER_DECOMPOSER_TYPE_ID,
    docs: "docs",
    documentation: "docs"
  };
  const aliasedTypeId = aliases[agentId];
  return aliasedTypeId ? agentTypes.find((type) => type.id === aliasedTypeId) || null : null;
}

function resolveAgentProfile(agentId, { slot = null, type = null } = {}) {
  const normalized = String(agentId || "").toLowerCase();
  if (slot || type) {
    return {
      role: slot?.role || type?.role || inferRole(normalized),
      specialties: [...new Set(slot?.specialties?.length ? slot.specialties : type?.specialties || [])],
      typeId: type?.id || slot?.typeId || ""
    };
  }
  const role = inferRole(normalized);
  const specialties = SPECIALTY_KEYWORDS.filter(([, keywords]) => keywords.some((keyword) => normalized.includes(keyword))).map(
    ([specialty]) => specialty
  );
  return {
    role,
    specialties: [...new Set(specialties)],
    typeId: ""
  };
}

function inferRole(agentId) {
  if (agentId.includes("operator")) return "operator";
  if (agentId.includes("planner") || agentId.includes("decomposer")) return "pm";
  if (agentId.includes("pm") || agentId.includes("dispatcher") || agentId.includes("manager")) return "pm";
  if (agentId.includes("review") || agentId.includes("security")) return "reviewer";
  if (agentId.includes("test") || agentId.includes("qa")) return "tester";
  if (agentId.includes("research")) return "researcher";
  return "implementer";
}

function taskFilters(profile, activeProjectId = "") {
  const filters = {
    role: profile.role
  };
  if (activeProjectId) {
    filters.projectId = activeProjectId;
  }
  if (profile.typeId === PLANNER_DECOMPOSER_TYPE_ID) {
    delete filters.role;
    return filters;
  }
  if (profile.specialties.length > 0) {
    filters.labels = profile.specialties.join(",");
  }
  return filters;
}

function plannerDecomposerRule() {
  return {
    mission: "Break large epics, stories, and decomposition-needed containers into clear claimable tasks without implementing the code yourself.",
    accepts: [
      "ready or backlog epic/story work item containers and tasks labeled decomposition-needed, ready-for-decomposition, epic, or story",
      "container work assigned to your exact planner/decomposer slot"
    ],
    outputs: [
      "child tasks with owner role, priority, labels, acceptance criteria, evidence expectations, and sequencing notes",
      "parent decomposition summary comments that list created child task ids",
      "ready/backlog sequencing recommendations for the next agents"
    ],
    doneMeans: "The parent has a visible decomposition summary and the next agents can claim child tasks without guessing scope or evidence."
  };
}

function plannerDecomposerWorkflow() {
  return [
    "Use your assigned active project from bootstrap/docs; list projects only when you need to confirm names or operator overrides.",
    "Find only epic/story work item containers or decomposition work labeled `decomposition-needed`, `ready-for-decomposition`, `epic`, or `story`.",
    "Claim exactly one decomposition container before creating child work.",
    "Do not implement code from the parent item.",
    "Use `decompose_task` or the task decomposition API to create child tasks with role, priority, labels, acceptance criteria, evidence expectations, and sequencing notes.",
    "Post or verify the parent summary comment lists every child task id clearly until typed hierarchy support lands.",
    "Move the parent to review with evidence, or blocked if a PM/operator decision is needed."
  ];
}

function standingAgentPersistence(role, upstreamStages = []) {
  const stages = upstreamStages.length ? upstreamStages : ROLE_RULES[role]?.upstreamStages || ["ready", "backlog"];
  return [
    `After a next-task or no-eligible-work response, inspect \`upstreamSignal\` for ${role} feeder stages: ${stages.join(" + ")}.`,
    "If `upstreamSignal.total` is greater than 0, do not end the agent. Heartbeat presence with `state=waiting` and include the upstream signal you are waiting on.",
    "Wait for `recheckAfterSeconds` using your environment's wait or recurring-monitor mechanism, then re-poll the next-task helper.",
    "Repeat the waiting heartbeat, wait, and re-poll loop until work becomes eligible, `upstreamSignal.total` becomes 0, or the operator stops you.",
    "End only when the project is quiet (`upstreamSignal.total` is 0) or the operator explicitly stops you.",
    "When the pollable `/api/events` feed is available, prefer waiting on its cursor and re-checking after relevant events instead of repeatedly reading the full board."
  ];
}

function sharedWorkflow() {
  return [
    "Use your assigned active project from bootstrap/docs; list projects only when you need to confirm names or operator overrides.",
    "List candidate tasks using your exact agent id, role, and specialty labels.",
    "Ordinary implementers claim task, subtask, bug, spike, and chore work item types; leave epic/story containers for planner/decomposer agents unless an operator explicitly converts or decomposes them.",
    "Respect dependency and blocker relationships: ordinary work is claimable only when related prerequisite tasks are in review or done.",
    "Claim one task through `POST /api/tasks/{taskId}/claim` or MCP `claim_task`; include expected status/assignee when known.",
    "Create or switch to a task branch/worktree before editing files.",
    "Post a comment with your plan and expected evidence.",
    "For ordinary claimed tasks, that plan is your go-ahead to proceed; do not wait for a separate human yes unless the task needs explicit operator approval.",
    "Post an Agent Talks message for cross-task coordination, blocker broadcasts, review requests, handoffs, questions, or decisions.",
    "Do implementation work in the task worktree, not in the shared main checkout.",
    "Post evidence back to the task: files changed, tests run, findings, or blockers.",
    "Move the task to review, testing, done, or blocked according to the result. Done requires a completion record.",
    "Keep your slot lease alive: renew via bootstrap or `acquire_agent_slot` before it expires, and persist the returned `identityToken`.",
    "On restart, re-pass your persisted `identityToken` to `acquire_agent_slot`/bootstrap to reclaim the same slot instead of taking a new one.",
    "On graceful shutdown, release or pause your slot if a release/pause control exists (PATCH pause today, or the operator force-release path); otherwise stop renewing and the lease expires on its own.",
    "Only then look for another task."
  ];
}

function reviewerMergeRules() {
  return [
    "A review is not complete just because you wrote findings. It is complete when the task is merged and marked done, or returned with requested changes.",
    "Review tasks in `status=review` before taking ordinary reviewer-role backlog work.",
    "CAS-claim the review through `POST /api/tasks/{taskId}/stage-claim` or `claim_task_stage`; never replace the implementation assignee.",
    "Inspect the implementer's task comments, branch/worktree path, commit evidence, and stated test output.",
    "Run the relevant verification yourself when practical, at minimum `npm test` and `npm run build` for code changes before merge.",
    "Resolve the claim with a typed approve/request_changes verdict, findings count, reviewer, and reviewed commit. If approved, merge and mark done with completionType=merged, commitSha, branch, mergedTo, tests, and notes.",
    "For no-code planning, audit-only, or superseded closures, mark done with completionType=no-code, audit-only, or superseded and include clear notes or supersededByTaskId.",
    "If changes are needed, comment specific findings and move the original task back to `ready` or `blocked` with the reason.",
    "If you cannot merge because of permissions, conflicts, or unclear ownership, explicitly assign merge to another reviewer/operator and leave the task in `review` with the blocker."
  ];
}

function worktreeDiscipline(agentId = "<agent-id>", integrationStatus = null) {
  const safeAgentId = String(agentId || "agent").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
  const baseRef = integrationStatus?.baseRef || "origin/main";
  const worktreeTarget = worktreePath(safeAgentId, "<slug>");
  const worktreeExample = integrationStatus?.baseRef
    ? `git worktree add ${worktreeTarget} -b ${safeAgentId}/<slug> ${baseRef}`
    : `do not run git worktree add ${worktreeTarget} until local main and origin/main are reconciled`;
  return [
    "Before editing code, check `git status --short --branch` and confirm you are not doing implementation work directly on `main`.",
    `Use a task branch named like \`${safeAgentId}/<short-task-slug>\` or another operator-approved branch name.`,
    `Check ${integrationStatus ? "`/api/integration-status`" : "the current integration status"} before choosing a base ref; use the recommended worktree base instead of blindly assuming \`origin/main\`.`,
    `Prefer a separate worktree for implementation, for example \`${worktreeExample}\`.`,
    "Keep the main checkout for running/observing the local service and for operator state. Do not pile unrelated agent edits into it.",
    "Commit only your task files, run the task-specific checks, push your branch when possible, then comment the branch/commit/test evidence on the task.",
    "If you find dirty files you did not create, do not overwrite them. Report the conflict on the task or in Agent Talks."
  ];
}
