import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildProjectBackup, normalizeProjectBackup } from "./projectBackup.js";
import { createWorkboardPersistence } from "./persistence.js";

export const STATUSES = [
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "in_progress", label: "In Progress" },
  { id: "review", label: "Review" },
  { id: "testing", label: "Testing" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" }
];

export const PRIORITIES = ["low", "normal", "high", "urgent"];
export const COMPLETION_TYPES = ["merged", "no-code", "audit-only", "superseded", "legacy-needs-audit"];
export const WORK_ITEM_TYPES = [
  { id: "epic", label: "Epic", claimable: false, container: true },
  { id: "story", label: "Story", claimable: false, container: true },
  { id: "task", label: "Task", claimable: true, container: false },
  { id: "subtask", label: "Subtask", claimable: true, container: false },
  { id: "bug", label: "Bug", claimable: true, container: false },
  { id: "spike", label: "Spike", claimable: true, container: false },
  { id: "chore", label: "Chore", claimable: true, container: false }
];
export const TALK_KINDS = ["update", "blocker", "review-request", "handoff", "question", "decision", "system"];
export const CAPABILITY_STATUSES = ["proposed", "planned", "in_progress", "review", "live", "broken", "deprecated", "superseded"];
export const BLOCKER_TYPES = ["operator_approval", "dependency", "external_issue", "waiting_for_agent", "unclear_scope", "other"];
export const OPERATOR_APPROVAL_DECISIONS = ["approved", "rejected", "changes_requested"];

const WRITE_LOCK_RETRY_MS = 25;
const WRITE_LOCK_TIMEOUT_MS = 5000;
const STALE_WRITE_LOCK_MS = 30000;
const SLOT_LEASE_MS = 15 * 60 * 1000;
// Presence entries whose heartbeat is older than this window are dropped from
// /api/agents/presence responses (kept in the data store for history).
const PRESENCE_RETENTION_MS = 24 * 60 * 60 * 1000;
const PLANNER_DECOMPOSER_TYPE_ID = "planner-decomposer";
const DECOMPOSITION_LABELS = new Set(["decomposition-needed", "needs-decomposition", "ready-for-decomposition", "epic", "story"]);
const MAX_DECOMPOSITION_CHILDREN = 12;
const MAX_TASK_LABELS = 12;
const MAX_DEPLOYMENT_PROCESS_OVERRIDES_LENGTH = 50000;
const UPSTREAM_STATUSES_BY_ROLE = {
  implementer: ["ready", "backlog"],
  reviewer: ["in_progress", "ready"],
  tester: ["review", "in_progress"],
  pm: ["backlog", "ready"],
  researcher: ["ready", "backlog"],
  operator: ["blocked"]
};

export const ROLES = [
  {
    id: "pm",
    label: "PM Agent",
    summary: "Breaks goals into tasks, checks stale work, and keeps scope clear."
  },
  {
    id: "implementer",
    label: "Implementer Agent",
    summary: "Builds the assigned change and posts evidence."
  },
  {
    id: "reviewer",
    label: "Reviewer Agent",
    summary: "Reviews code, tests, risks, and merge readiness."
  },
  {
    id: "tester",
    label: "Test Agent",
    summary: "Runs focused checks, reproductions, and regression tests."
  },
  {
    id: "researcher",
    label: "Research Agent",
    summary: "Collects sources, context, options, and unanswered questions."
  },
  {
    id: "operator",
    label: "Operator",
    summary: "Owns priorities, business decisions, and final direction."
  }
];

const STATUS_IDS = new Set(STATUSES.map((status) => status.id));
const ROLE_IDS = new Set(ROLES.map((role) => role.id));
const PRIORITY_IDS = new Set(PRIORITIES);
const COMPLETION_TYPE_IDS = new Set(COMPLETION_TYPES);
const WORK_ITEM_TYPE_IDS = new Set(WORK_ITEM_TYPES.map((type) => type.id));
const CLAIMABLE_WORK_ITEM_TYPE_IDS = new Set(WORK_ITEM_TYPES.filter((type) => type.claimable).map((type) => type.id));
const CAPABILITY_STATUS_IDS = new Set(CAPABILITY_STATUSES);
const FULL_TASK_EDIT_FIELDS = [
  "title",
  "description",
  "assignee",
  "priority",
  "role",
  "labels",
  "workItemType",
  "dependsOn",
  "blockedBy",
  "parentTaskId",
  "childTaskIds"
];
const BLOCKER_TYPE_IDS = new Set(BLOCKER_TYPES);
const OPERATOR_APPROVAL_DECISION_IDS = new Set(OPERATOR_APPROVAL_DECISIONS);

const DEFAULT_CAPABILITY_SEEDS = [
  {
    id: "cap_task_relationships",
    name: "Task dependencies and subtasks",
    summary: "First-class task prerequisites, blockers, parent tasks, and child task relationships.",
    status: "planned",
    ownerRole: "implementer",
    surfaces: ["Task model", "Task drawer", "get_next_task"],
    acceptanceNotes: ["Tasks can show prerequisite state without relying on free-text comments."],
    notes: "Tracked as dependency/subtask workflow work."
  },
  {
    id: "cap_live_board_updates",
    name: "Live board updates",
    summary: "Open boards refresh when other clients claim, comment, move, or complete tasks.",
    status: "planned",
    ownerRole: "implementer",
    surfaces: ["Board UI", "Task drawer", "API"],
    acceptanceNotes: ["Operators see cross-session changes within a few seconds without losing unsaved edits."]
  },
  {
    id: "cap_mcp_workflow_tools",
    name: "MCP workflow tools",
    summary: "MCP tools let agents bootstrap, pick work, claim tasks, post comments, update presence, and report no eligible work.",
    status: "live",
    ownerRole: "implementer",
    ownerAgent: "mcp-agent",
    surfaces: ["MCP server", "Agent docs", "Continuous-work API"],
    verificationEvidence: ["Task task_6e614bf3c8dd completed with continuous-work helper evidence."],
    notes: "Local main has the rebuilt minimal helper merge."
  },
  {
    id: "cap_agent_slots_heartbeat",
    name: "Agent slots and heartbeat",
    summary: "Agents acquire typed slots and publish presence/heartbeat state for operator visibility and queue selection.",
    status: "live",
    ownerRole: "implementer",
    surfaces: ["Agent slots API", "Presence API", "Agent docs"],
    verificationEvidence: ["Slot bootstrap and presence endpoints are available in the running board."]
  },
  {
    id: "cap_agent_talks",
    name: "Agent Talks coordination channel",
    summary: "Shared coordination channel for agents and the operator to exchange lightweight progress and handoff notes.",
    status: "in_progress",
    ownerRole: "implementer",
    surfaces: ["Operator UI", "MCP tools"],
    acceptanceNotes: ["Agents can post/read shared coordination messages without abusing task comments."]
  },
  {
    id: "cap_completion_records",
    name: "Completion records",
    summary: "Done tasks require structured completion evidence such as merge commits, no-code notes, audits, or superseded links.",
    status: "live",
    ownerRole: "reviewer",
    surfaces: ["Task drawer", "Task model", "MCP update_task_status"],
    verificationEvidence: ["Store/API tests enforce completion records before done."]
  },
  {
    id: "cap_reviewer_merge_ownership",
    name: "Reviewer merge ownership",
    summary: "Reviewer agents own approve/request-changes outcomes, merge evidence, and final done transitions.",
    status: "live",
    ownerRole: "reviewer",
    surfaces: ["Agent docs", "Task workflow"],
    verificationEvidence: ["Reviewer instructions require merge evidence and completion records."]
  },
  {
    id: "cap_task_revision_stale_writes",
    name: "Task revision and stale-write protection",
    summary: "Task updates reject stale client writes and preserve operator drafts on conflict.",
    status: "planned",
    ownerRole: "implementer",
    surfaces: ["Task API", "Task drawer"],
    acceptanceNotes: ["409 conflicts show clear recovery actions without discarding local draft changes."]
  },
  {
    id: "cap_local_loopback_security",
    name: "Local loopback security boundary",
    summary: "Local deployment binds to loopback by default and documents the local-only trust boundary.",
    status: "planned",
    ownerRole: "implementer",
    surfaces: ["Docker", "Server binding", "Docs"],
    acceptanceNotes: ["The development service is not exposed broadly by default."]
  }
];

const DEFAULT_AGENT_TYPES = [
  {
    id: "pm",
    role: "pm",
    capacity: 2,
    slotIds: ["pm-agent", "pm-agent-2"],
    specialties: ["pm", "workflow", "backlog", "roadmap"],
    defaultWorkMode: "single-task"
  },
  {
    id: PLANNER_DECOMPOSER_TYPE_ID,
    role: "pm",
    capacity: 2,
    slotIds: ["planner-agent", "decomposer-agent"],
    specialties: ["pm", "planner", "decomposition", "workflow", "work-items"],
    defaultWorkMode: "single-task"
  },
  {
    id: "implementer-backend",
    role: "implementer",
    capacity: 4,
    slotIds: ["implementer-backend-1", "implementer-backend-2", "implementer-backend-3", "implementer-backend-4"],
    specialties: ["backend", "api", "storage", "concurrency", "reliability", "agents"],
    defaultWorkMode: "single-task"
  },
  {
    id: "implementer-frontend",
    role: "implementer",
    capacity: 3,
    slotIds: ["implementer-frontend-1", "implementer-frontend-2", "implementer-frontend-3"],
    specialties: ["frontend", "ui", "operator", "agents"],
    defaultWorkMode: "single-task"
  },
  {
    id: "implementer-general",
    role: "implementer",
    capacity: 1,
    slotIds: ["implementer-agent"],
    specialties: ["general"],
    defaultWorkMode: "single-task"
  },
  {
    id: "mcp",
    role: "implementer",
    capacity: 2,
    slotIds: ["mcp-agent", "mcp-agent-2"],
    specialties: ["mcp", "agent-tools", "docs"],
    defaultWorkMode: "single-task"
  },
  {
    id: "reviewer",
    role: "reviewer",
    capacity: 2,
    slotIds: ["reviewer-agent", "reviewer-agent-2"],
    specialties: ["review", "architecture", "process", "workflow"],
    defaultWorkMode: "drain-role-queue"
  },
  {
    id: "tester",
    role: "tester",
    capacity: 2,
    slotIds: ["test-agent", "test-agent-2"],
    specialties: ["tests", "e2e", "regression", "attachments"],
    defaultWorkMode: "single-task"
  },
  {
    id: "docs",
    role: "implementer",
    capacity: 2,
    slotIds: ["docs-agent", "docs-agent-2"],
    specialties: ["docs", "onboarding", "architecture", "release"],
    defaultWorkMode: "single-task"
  },
  {
    id: "security-reviewer",
    role: "reviewer",
    capacity: 1,
    slotIds: ["security-reviewer"],
    specialties: ["security", "auth", "roles", "deployment"],
    defaultWorkMode: "watch-mode"
  },
  {
    id: "implementer-security",
    role: "implementer",
    capacity: 1,
    slotIds: ["implementer-security-1"],
    specialties: ["security", "local", "deployment"],
    defaultWorkMode: "single-task"
  },
  {
    id: "release",
    role: "implementer",
    capacity: 1,
    slotIds: ["release-agent"],
    specialties: ["release", "changelog", "packaging", "opensource"],
    defaultWorkMode: "single-task"
  },
  {
    id: "observability",
    role: "implementer",
    capacity: 1,
    slotIds: ["implementer-observability-1"],
    specialties: ["observability", "audit", "operator", "telemetry"],
    defaultWorkMode: "watch-mode"
  },
  {
    id: "infra",
    role: "implementer",
    capacity: 1,
    slotIds: ["implementer-infra-1"],
    specialties: ["infra", "ci", "docker", "packaging"],
    defaultWorkMode: "single-task"
  },
  {
    id: "packaging-reviewer",
    role: "reviewer",
    capacity: 1,
    slotIds: ["packaging-reviewer"],
    specialties: ["packaging", "release", "review"],
    defaultWorkMode: "single-task"
  }
];

const AGENT_TYPE_ALIASES = new Map([
  ["backend", "implementer-backend"],
  ["frontend", "implementer-frontend"],
  ["implementer", "implementer-general"],
  ["general", "implementer-general"],
  ["security", "implementer-security"],
  ["security-implementer", "implementer-security"],
  ["test", "tester"],
  ["tests", "tester"],
  ["review", "reviewer"],
  ["planner", PLANNER_DECOMPOSER_TYPE_ID],
  ["decomposer", PLANNER_DECOMPOSER_TYPE_ID],
  ["decomposition", PLANNER_DECOMPOSER_TYPE_ID],
  ["docs-agent", "docs"],
  ["documentation", "docs"]
]);

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeDeploymentProcessOverrides(value) {
  if (typeof value !== "string") {
    throw httpError("processOverrides must be a string.", 400);
  }
  const normalized = value.replaceAll("\r\n", "\n").trim();
  if (normalized.length > MAX_DEPLOYMENT_PROCESS_OVERRIDES_LENGTH) {
    throw httpError(
      `processOverrides must be ${MAX_DEPLOYMENT_PROCESS_OVERRIDES_LENGTH} characters or fewer.`,
      400
    );
  }
  return normalized;
}

function normalizeActivityLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(Math.max(parsed, 1), 200);
}

function findActivityDetailRecord(items, event, actorField, createdAtField) {
  const actor = normalizeText(event.actor);
  const createdAt = normalizeText(event.createdAt);
  return (items || []).find((item) => item?.[actorField] === actor && item?.[createdAtField] === createdAt);
}

function taskActivityDetail(task, event) {
  const type = normalizeText(event.type);
  if (type === "commented") {
    return normalizeText(findActivityDetailRecord(task.comments, event, "author", "createdAt")?.body);
  }
  if (type === "attachment.added") {
    const attachment = findActivityDetailRecord(task.attachments, event, "uploadedBy", "createdAt");
    if (!attachment) return "";
    return `${attachment.filename} (${attachment.size} bytes)`;
  }
  if (type === "approval.requested") {
    const approval = findActivityDetailRecord(task.approvalHistory, event, "requestedBy", "requestedAt");
    return [approval?.reason, approval?.requestedAction].map(normalizeText).filter(Boolean).join(" ");
  }
  if (type === "approval.decided") {
    const approval = findActivityDetailRecord(task.approvalHistory, event, "decidedBy", "decidedAt");
    return [approval?.decision, approval?.note, approval?.nextStatus].map(normalizeText).filter(Boolean).join(" ");
  }
  if (type === "completed") {
    return normalizeText(task.completion?.notes);
  }
  return "";
}

function readCompletionInput(input) {
  if (Object.prototype.hasOwnProperty.call(input, "completion") && input.completion !== undefined) {
    return { hasCompletion: true, completionInput: input.completion };
  }
  if (Object.prototype.hasOwnProperty.call(input, "completionRecord") && input.completionRecord !== undefined) {
    return { hasCompletion: true, completionInput: input.completionRecord };
  }
  return { hasCompletion: false, completionInput: undefined };
}

function slugify(value, fallback = "project") {
  const slug = normalizeText(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 12);
  return slug || fallback.toUpperCase();
}

function safeFilename(value) {
  const base = path.posix.basename((normalizeText(value) || "attachment").replaceAll("\\", "/"));
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 160) || "attachment";
}

function defaultData() {
  const createdAt = now();
  const projectId = "project_demo";
  const firstTaskId = "task_demo_pm";
  const secondTaskId = "task_demo_impl";
  return {
    schemaVersion: 1,
    projects: [
      {
        id: projectId,
        key: "DEMO",
        name: "Demo Agent Project",
        description: "A starter project showing how PM, implementation, review, and test agents can share work.",
        createdAt,
        updatedAt: createdAt,
        archived: false
      }
    ],
    tasks: [
      {
        id: firstTaskId,
        projectId,
        title: "Shape the first release plan",
        description: "Turn the product goal into a small release plan with clear acceptance criteria.",
        status: "ready",
        priority: "high",
        role: "pm",
        workItemType: "task",
        assignee: "pm-agent",
        labels: ["planning"],
        completion: null,
        blocker: null,
        approvalHistory: [],
        createdAt,
        updatedAt: createdAt,
        revision: 1,
        comments: [],
        attachments: [],
        activity: [
          {
            id: id("event"),
            actor: "system",
            type: "created",
            message: "Seed task created.",
            createdAt
          }
        ]
      },
      {
        id: secondTaskId,
        projectId,
        title: "Implement the first useful workflow",
        description:
          "First-release slice: make the demo board useful for one complete task lifecycle. A ready task can be claimed through the first-class claim path, commented with plan/evidence, moved through review, and done requires a structured completion record.",
        status: "ready",
        priority: "high",
        role: "implementer",
        workItemType: "task",
        assignee: "",
        labels: ["mvp", "workflow", "demo"],
        completion: null,
        blocker: null,
        approvalHistory: [],
        createdAt,
        updatedAt: createdAt,
        revision: 1,
        comments: [],
        attachments: [],
        activity: [
          {
            id: id("event"),
            actor: "system",
            type: "created",
            message: "Seed task created.",
            createdAt
          }
        ]
      }
    ],
    events: [],
    capabilities: defaultCapabilities(createdAt),
    agentPresence: {},
    talkMessages: [],
    deploymentSettings: {
      processOverrides: "",
      updatedAt: "",
      updatedBy: ""
    },
    agentTypes: defaultAgentTypes(),
    agentSlots: defaultAgentSlots()
  };
}

export class WorkboardStore {
  constructor({
    dataDir,
    storageMode = process.env.WORKBOARD_STORAGE || "json",
    sqliteCommand = process.env.SQLITE3_BIN,
    defaultProjectKey = process.env.WORKBOARD_DEFAULT_PROJECT_KEY,
    tasksDir = process.env.WORKBOARD_TASKS_DIR,
    opsStorageMode = process.env.WORKBOARD_OPS_STORAGE
  }) {
    this.dataDir = dataDir;
    this.defaultProjectKey = defaultProjectKey ? slugify(defaultProjectKey, "") : "";
    this.persistence = createWorkboardPersistence({
      dataDir,
      storageMode,
      sqliteCommand,
      tasksDir,
      opsStorageMode,
      defaultProjectKey: this.defaultProjectKey
    });
    this.dbPath = this.persistence.path;
    this.lockPath = this.persistence.lockPath;
    this.uploadsDir = path.join(dataDir, "uploads");
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.uploadsDir, { recursive: true });
    const persistedData = await this.persistence.read();
    let needsSave = false;

    if (persistedData) {
      this.data = persistedData;
    } else {
      this.data = (await this.persistence.readLegacyData?.()) || defaultData();
      if (this.persistence.workItemsExternal) {
        // Work items live in the external tasks dir; never seed demo tasks into it.
        this.data.tasks = [];
      }
      needsSave = true;
    }

    if (this.migrateData()) {
      needsSave = true;
    }

    if (needsSave) {
      await this.save();
      if (this.persistence.workItemsExternal && !persistedData) {
        // First boot composes work items from the tasks dir once ops state exists.
        this.data = await this.readData();
        this.migrateData();
      }
    }
  }

  async save() {
    // A rejected write (e.g. a tasksdir stale-file 409) must fail its caller
    // without poisoning the queue for every later save.
    const attempt = this.writeQueue.then(async () => {
      await this.writeData(this.data);
    });
    this.writeQueue = attempt.catch(() => {});
    return attempt;
  }

  async readData() {
    const data = await this.persistence.read();
    if (!data) {
      throw Object.assign(new Error("Workboard data is not initialized."), { status: 500 });
    }
    return data;
  }

  async writeData(data) {
    await this.persistence.write(data);
  }

  async withWriteLock(callback) {
    await mkdir(this.dataDir, { recursive: true });
    const startedAt = Date.now();

    while (true) {
      try {
        await mkdir(this.lockPath);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw error;
        }

        await this.removeStaleWriteLock();
        if (Date.now() - startedAt > WRITE_LOCK_TIMEOUT_MS) {
          throw Object.assign(new Error("Timed out waiting for workboard write lock."), { status: 503 });
        }
        await sleep(WRITE_LOCK_RETRY_MS);
      }
    }

    try {
      return await callback();
    } finally {
      await rm(this.lockPath, { recursive: true, force: true });
    }
  }

  async removeStaleWriteLock() {
    try {
      const lockStat = await stat(this.lockPath);
      if (Date.now() - lockStat.mtimeMs > STALE_WRITE_LOCK_MS) {
        await rm(this.lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  roles() {
    return ROLES;
  }

  statuses() {
    return STATUSES;
  }

  completionTypes() {
    return COMPLETION_TYPES;
  }

  workItemTypes() {
    return WORK_ITEM_TYPES;
  }

  capabilityStatuses() {
    return CAPABILITY_STATUSES;
  }

  blockerTypes() {
    return BLOCKER_TYPES;
  }

  operatorApprovalDecisions() {
    return OPERATOR_APPROVAL_DECISIONS;
  }

  getDeploymentSettings() {
    this.ensureDeploymentSettings();
    return { ...this.data.deploymentSettings };
  }

  async updateDeploymentSettings(input = {}) {
    if (!Object.prototype.hasOwnProperty.call(input, "processOverrides")) {
      throw httpError("processOverrides is required.", 400);
    }
    const processOverrides = normalizeDeploymentProcessOverrides(input.processOverrides);
    const updatedBy = normalizeText(input.actor) || "operator";

    return this.withWriteLock(async () => {
      this.data = await this.readData();
      this.ensureDeploymentSettings();
      this.data.deploymentSettings = {
        processOverrides,
        updatedAt: now(),
        updatedBy
      };
      await this.writeData(this.data);
      return { ...this.data.deploymentSettings };
    });
  }

  migrateData() {
    let migrated = false;
    if (this.ensureDeploymentSettings()) {
      migrated = true;
    }
    if (!Array.isArray(this.data.events)) {
      this.data.events = [];
      migrated = true;
    }
    if (!this.data.agentPresence || typeof this.data.agentPresence !== "object" || Array.isArray(this.data.agentPresence)) {
      this.data.agentPresence = {};
      migrated = true;
    }
    if (!Array.isArray(this.data.talkMessages)) {
      this.data.talkMessages = [];
      migrated = true;
    }
    if (!Array.isArray(this.data.capabilities)) {
      this.data.capabilities = [];
      migrated = true;
    }

    for (const task of this.data.tasks || []) {
      if (!Array.isArray(task.comments)) {
        task.comments = [];
        migrated = true;
      }
      if (!Array.isArray(task.attachments)) {
        task.attachments = [];
        migrated = true;
      }
      if (!Array.isArray(task.activity)) {
        task.activity = [];
        migrated = true;
      }
      if (!Array.isArray(task.labels)) {
        task.labels = [];
        migrated = true;
      }
      const workItemType = normalizeWorkItemType(task.workItemType, { migrating: true });
      if (task.workItemType !== workItemType) {
        task.workItemType = workItemType;
        migrated = true;
      }
      const relationships = normalizeTaskRelationshipsForMigration(task);
      for (const [field, value] of Object.entries(relationships)) {
        if (JSON.stringify(task[field]) !== JSON.stringify(value)) {
          task[field] = value;
          migrated = true;
        }
      }
      if (!isValidTaskRevision(task.revision)) {
        task.revision = 1;
        migrated = true;
      }

      if (task.status === "done" && !task.completion) {
        const completedAt = normalizeText(task.updatedAt) || now();
        task.completion = {
          completionType: "legacy-needs-audit",
          completedBy: "legacy",
          completedAt,
          notes: "Marked done before completion records existed. Audit required."
        };
        task.activity.unshift({
          id: id("event"),
          actor: "system",
          type: "completion.backfilled",
          message: "Backfilled legacy done task as needing audit.",
          createdAt: completedAt
        });
        migrated = true;
      }

      if (task.status !== "done" && task.completion === undefined) {
        task.completion = null;
        migrated = true;
      }

      if (task.blocker === undefined) {
        task.blocker = null;
        migrated = true;
      } else if (task.blocker) {
        task.blocker = normalizeTaskBlocker(task.blocker, { actor: task.assignee || "legacy", migrating: true });
      }

      if (!Array.isArray(task.approvalHistory)) {
        task.approvalHistory = [];
        migrated = true;
      }
    }

    if (this.ensureDefaultCapabilities()) {
      migrated = true;
    }

    if (this.ensureAgentSlotSchema()) {
      migrated = true;
    }

    if (this.rebuildTaskRelationshipDerivatives()) {
      migrated = true;
    }

    return migrated;
  }

  ensureDeploymentSettings() {
    const current = this.data.deploymentSettings;
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      this.data.deploymentSettings = {
        processOverrides: "",
        updatedAt: "",
        updatedBy: ""
      };
      return true;
    }

    const normalized = {
      processOverrides: typeof current.processOverrides === "string" ? current.processOverrides : "",
      updatedAt: normalizeText(current.updatedAt),
      updatedBy: normalizeText(current.updatedBy)
    };
    if (JSON.stringify(current) === JSON.stringify(normalized)) {
      return false;
    }
    this.data.deploymentSettings = normalized;
    return true;
  }

  rebuildTaskRelationshipDerivatives() {
    const tasks = Array.isArray(this.data.tasks) ? this.data.tasks : [];
    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    let changed = false;

    for (const task of tasks) {
      const normalized = normalizeTaskRelationshipsForMigration(task);
      for (const [field, value] of Object.entries(normalized)) {
        if (JSON.stringify(task[field]) !== JSON.stringify(value)) {
          task[field] = value;
          changed = true;
        }
      }
    }

    for (const task of tasks) {
      const blocks = tasks
        .filter((candidate) => candidate.projectId === task.projectId)
        .filter((candidate) => [...candidate.dependsOn, ...candidate.blockedBy].includes(task.id))
        .map((candidate) => candidate.id)
        .sort();
      const childTaskIds = tasks
        .filter((candidate) => candidate.projectId === task.projectId && candidate.parentTaskId === task.id)
        .map((candidate) => candidate.id)
        .sort();
      const dependencyStatus = deriveTaskDependencyStatus(task, tasksById);

      for (const [field, value] of Object.entries({ blocks, childTaskIds, dependencyStatus })) {
        if (JSON.stringify(task[field]) !== JSON.stringify(value)) {
          task[field] = value;
          changed = true;
        }
      }
    }

    return changed;
  }

  normalizeTaskRelationships(task, patch = {}) {
    const projectId = task.projectId;
    const relationships = {
      dependsOn: Object.prototype.hasOwnProperty.call(patch, "dependsOn")
        ? normalizeRelationshipIdList(patch.dependsOn, "dependsOn")
        : normalizeRelationshipIdList(task.dependsOn || [], "dependsOn"),
      blockedBy: Object.prototype.hasOwnProperty.call(patch, "blockedBy")
        ? normalizeRelationshipIdList(patch.blockedBy, "blockedBy")
        : normalizeRelationshipIdList(task.blockedBy || [], "blockedBy"),
      parentTaskId: Object.prototype.hasOwnProperty.call(patch, "parentTaskId")
        ? normalizeOptionalTaskId(patch.parentTaskId)
        : normalizeOptionalTaskId(task.parentTaskId)
    };

    if (Object.prototype.hasOwnProperty.call(patch, "childTaskIds")) {
      relationships.childTaskIds = normalizeRelationshipIdList(patch.childTaskIds, "childTaskIds");
    }

    validateTaskRelationshipTargets({ task, projectId, relationships, tasks: this.data.tasks });
    validateDependencyAcyclic({ task, relationships, tasks: this.data.tasks });
    validateParentAcyclic({ task, parentTaskId: relationships.parentTaskId, tasks: this.data.tasks });

    if (relationships.childTaskIds) {
      for (const childTaskId of relationships.childTaskIds) {
        const child = this.data.tasks.find((candidate) => candidate.id === childTaskId);
        validateParentAcyclic({ task: child, parentTaskId: task.id, tasks: this.data.tasks });
      }
    }

    return relationships;
  }

  listAgentSlots({ now: nowInput } = {}) {
    this.ensureAgentSlotSchema();
    const currentTime = parseTimestamp(nowInput);
    const stats = this.agentSlotTaskStats();
    const typeById = new Map(this.data.agentTypes.map((type) => [type.id, type]));
    const slots = this.data.agentSlots.map((slot) => this.describeAgentSlot(slot, currentTime, stats.get(slot.id), typeById.get(slot.typeId)));
    const untrackedInProgressAssignees = this.untrackedInProgressAssignees();

    return {
      leaseMs: SLOT_LEASE_MS,
      types: this.data.agentTypes.map((type) => describeAgentType(type, slots)),
      slots,
      untrackedInProgressAssignees
    };
  }

  async updateAgentType(typeIdInput, input = {}) {
    const typeId = normalizeAgentType(typeIdInput);
    if (!typeId) {
      throw httpError("Agent type id is required.", 400);
    }
    const currentTime = parseTimestamp(input.now);

    return this.withWriteLock(async () => {
      this.data = await this.readData();
      this.ensureAgentSlotSchema();
      const type = this.data.agentTypes.find((candidate) => candidate.id === typeId);
      if (!type) {
        throw httpError("Agent type not found.", 404, { typeId });
      }

      if (Object.prototype.hasOwnProperty.call(input, "capacity")) {
        type.capacity = normalizeAgentCapacity(input.capacity);
        this.ensureAgentTypeSlotCapacity(type);
      }

      type.updatedAt = currentTime.toISOString();
      await this.writeData(this.data);

      const stats = this.agentSlotTaskStats();
      const slots = this.data.agentSlots
        .filter((slot) => slot.typeId === type.id)
        .map((slot) => this.describeAgentSlot(slot, currentTime, stats.get(slot.id), type));
      return describeAgentType(type, slots);
    });
  }

  async updateAgentSlot(agentIdInput, input = {}) {
    const agentId = normalizeText(agentIdInput);
    if (!agentId) {
      throw httpError("Agent slot id is required.", 400);
    }
    const currentTime = parseTimestamp(input.now);

    return this.withWriteLock(async () => {
      this.data = await this.readData();
      this.ensureAgentSlotSchema();
      const slot = this.data.agentSlots.find((candidate) => candidate.id === agentId);
      if (!slot) {
        throw httpError("Agent slot not found.", 404, { agentId });
      }

      if (Object.prototype.hasOwnProperty.call(input, "workMode")) {
        const workMode = normalizeWorkMode(input.workMode);
        if (!workMode) {
          throw httpError("Invalid workMode.", 400, { workMode: input.workMode });
        }
        slot.workMode = workMode;
      }

      if (Object.prototype.hasOwnProperty.call(input, "paused")) {
        if (typeof input.paused !== "boolean") {
          throw httpError("paused must be a boolean.", 400, { paused: input.paused });
        }
        slot.paused = input.paused;
      }

      slot.updatedAt = currentTime.toISOString();
      await this.writeData(this.data);

      return this.describeAgentSlot(slot, currentTime, this.agentSlotTaskStats().get(slot.id));
    });
  }

  async acquireAgentSlot(input = {}) {
    const currentTime = parseTimestamp(input.now);
    const runtimeId = normalizeText(input.runtimeId) || id("runtime");
    const requestedAgentId = normalizeText(input.agentId);
    const reclaimToken = normalizeText(input.identityToken || input.reclaimToken);

    return this.withWriteLock(async () => {
      this.data = await this.readData();
      this.ensureAgentSlotSchema();

      const stats = this.agentSlotTaskStats();
      const requestedRole = normalizeText(input.role);
      const validRoles = [
        ...new Set(this.data.agentTypes.filter((type) => type.capacity > 0).map((type) => type.role))
      ].sort();
      if (requestedRole && !validRoles.includes(requestedRole)) {
        throw httpError(
          `Agent role ${requestedRole} is not configured. Valid roles: ${validRoles.join(", ")}.`,
          400,
          { role: requestedRole, validRoles }
        );
      }

      const requestedSlot = requestedAgentId
        ? this.data.agentSlots.find((slot) => slot.id === requestedAgentId)
        : null;
      if (requestedAgentId && !requestedSlot) {
        throw httpError(`Agent slot ${requestedAgentId} is not configured.`, 404, { agentId: requestedAgentId });
      }

      // Resolve a persisted identity across the whole registry before inferring a
      // type. Otherwise a token-only restart can be assigned a free general slot
      // before the original specialized slot is considered.
      const identitySlot = reclaimToken
        ? this.data.agentSlots.find((slot) => slot.lease?.identityToken === reclaimToken)
        : null;
      const targetSlot = requestedSlot || identitySlot;
      const typeId = targetSlot?.typeId || this.inferAgentTypeId(input);

      const primaryType = this.data.agentTypes.find((candidate) => candidate.id === typeId);
      if (!primaryType) {
        throw httpError(`Unknown agent type ${typeId || "(none)"}.`, 400, { typeId });
      }

      // Role spill-over: when a type is at capacity but was *inferred* (bare role or
      // specialty labels), fall through to sibling types of the same role ordered by
      // free seats before failing. An explicit preference (preferredType/agentType/type)
      // or an explicit agentId is honored as-is - no spill.
      const explicitPreferred = Boolean(normalizeText(input.preferredType || input.agentType || input.type || ""));
      const candidateTypes =
        explicitPreferred || targetSlot
          ? [primaryType]
          : this.orderAgentSlotTypesForRole(primaryType, currentTime, stats);

      let selected = null;
      let selectedType = null;
      let sameRuntime = false;
      let selectedViaIdentity = false;
      let reclaimed = false;

      for (const candidateType of candidateTypes) {
        const pick = this.pickAgentSlotForType(candidateType, currentTime, stats, {
          requestedSlot: targetSlot?.typeId === candidateType.id ? targetSlot : null,
          reclaimToken,
          runtimeId
        });
        if (!pick) continue;
        selected = pick.slot;
        selectedType = candidateType;
        sameRuntime = pick.sameRuntime;
        selectedViaIdentity = pick.selectedViaIdentity;
        reclaimed = pick.reclaimed;
        break;
      }

      if (!selected) {
        throw this.buildSlotExhaustedError(candidateTypes, currentTime, stats);
      }

      if (selected.paused) {
        throw httpError(`Agent slot ${selected.id} is paused.`, 409, { agentId: selected.id, typeId: selectedType.id });
      }

      const projectContext = this.resolveAgentProjectContext(selected.id, input, {
        allowDefault: true,
        slot: selected
      });
      const heartbeatAt = currentTime.toISOString();
      const previousLease = selected.lease;
      const identityToken = previousLease?.identityToken || reclaimToken || id("tok");
      selected.lease = {
        ...(previousLease || {}),
        runtimeId,
        identityToken,
        acquiredAt: sameRuntime && previousLease?.acquiredAt ? previousLease.acquiredAt : heartbeatAt,
        heartbeatAt,
        expiresAt: new Date(currentTime.getTime() + SLOT_LEASE_MS).toISOString()
      };
      selected.workMode = normalizeWorkMode(input.workMode) || selected.workMode || selectedType.defaultWorkMode;
      selected.activeProjectId = projectContext.activeProjectId;
      selected.updatedAt = heartbeatAt;

      await this.writeData(this.data);

      return {
        acquired: true,
        renewed: Boolean(sameRuntime),
        reclaimed,
        reclaimedViaIdentity: Boolean(selectedViaIdentity && reclaimed),
        agentId: selected.id,
        typeId: selectedType.id,
        identityToken,
        role: selected.role,
        specialties: [...selected.specialties],
        slotNumber: selected.slotNumber,
        workMode: selected.workMode,
        paused: selected.paused,
        activeProjectId: projectContext.activeProjectId,
        activeProject: projectContext.activeProject,
        nextTask: this.buildNextTaskGuidance(selected.id, projectContext),
        lease: { ...selected.lease },
        capacity: selectedType.capacity
      };
    });
  }

  orderAgentSlotTypesForRole(primaryType, currentTime, stats) {
    const siblings = this.data.agentTypes.filter((type) => type.role === primaryType.role);
    return siblings.slice().sort((a, b) => {
      if (a.id === primaryType.id) return -1;
      if (b.id === primaryType.id) return 1;
      const freeA = a.capacity - this.activeSlotCountForType(a, currentTime, stats);
      const freeB = b.capacity - this.activeSlotCountForType(b, currentTime, stats);
      if (freeB !== freeA) return freeB - freeA;
      return a.id.localeCompare(b.id);
    });
  }

  activeSlotCountForType(type, currentTime, stats) {
    return this.data.agentSlots.filter(
      (slot) => slot.typeId === type.id && this.describeAgentSlot(slot, currentTime, stats.get(slot.id), type).active
    ).length;
  }

  pickAgentSlotForType(type, currentTime, stats, { requestedSlot, reclaimToken, runtimeId }) {
    const typeSlots = this.data.agentSlots
      .filter((slot) => slot.typeId === type.id)
      .sort((a, b) => a.slotNumber - b.slotNumber);
    const capacitySlots = typeSlots.filter((slot) => slot.slotNumber <= type.capacity);
    const activeSlots = typeSlots.filter((slot) => this.describeAgentSlot(slot, currentTime, stats.get(slot.id), type).active);
    const existingRuntimeSlot = runtimeId
      ? typeSlots.find((slot) => slot.lease?.runtimeId === runtimeId && this.isLeaseFresh(slot.lease, currentTime))
      : null;
    const identitySlot = reclaimToken ? typeSlots.find((slot) => slot.lease?.identityToken === reclaimToken) : null;

    let slot = requestedSlot || identitySlot || existingRuntimeSlot || null;
    const selectedViaIdentity = Boolean(identitySlot);

    if (!slot && activeSlots.length < type.capacity) {
      slot = selectAvailableSlot(capacitySlots, {
        currentTime,
        runtimeId,
        stats,
        isLeaseFresh: (lease) => this.isLeaseFresh(lease, currentTime)
      });
    }
    if (!slot) return null;

    const described = this.describeAgentSlot(slot, currentTime, stats.get(slot.id), type);
    const previousLease = slot.lease;
    const sameRuntime = previousLease?.runtimeId === runtimeId;
    const leaseFresh = this.isLeaseFresh(previousLease, currentTime);
    // Identity/restart reclaim only takes over when the existing lease is stale. A
    // heartbeating lease from the same identity is a live duplicate and must be refused.
    const sameIdentity = Boolean(selectedViaIdentity && previousLease?.identityToken === reclaimToken && !leaseFresh);
    const explicitReclaim = Boolean(requestedSlot && !leaseFresh && !sameRuntime);

    if (described.active && !sameRuntime && !sameIdentity && !explicitReclaim) {
      throw httpError(`Agent slot ${slot.id} is already active.`, 409, { agentId: slot.id, typeId: type.id });
    }

    const reclaimed = Boolean(
      previousLease && !leaseFresh && (sameIdentity || explicitReclaim || !described.inProgressTaskCount)
    );

    return { slot, sameRuntime, selectedViaIdentity: sameIdentity, reclaimed };
  }

  buildSlotExhaustedError(candidateTypes, currentTime, stats) {
    const primary = candidateTypes[0];
    const inactiveLeases = [];
    for (const type of candidateTypes) {
      for (const slot of this.data.agentSlots.filter((candidate) => candidate.typeId === type.id && candidate.lease)) {
        inactiveLeases.push({
          agentId: slot.id,
          typeId: type.id,
          runtimeId: slot.lease.runtimeId || "",
          expiresAt: slot.lease.expiresAt || "",
          leaseFresh: this.isLeaseFresh(slot.lease, currentTime)
        });
      }
    }
    inactiveLeases.sort((a, b) => Date.parse(a.expiresAt || 0) - Date.parse(b.expiresAt || 0));
    const stagedLeases = inactiveLeases.filter((lease) => !lease.leaseFresh);
    const earliestFree = inactiveLeases[0]?.expiresAt || "";
    const earliestFreeLabel =
      earliestFree && Date.parse(earliestFree) > 0
        ? new Date(earliestFree).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "";
    const leasesByType = inactiveLeases.length;
    const label = candidateTypes.length === 1 ? candidateTypes[0].id : candidateTypes.map((t) => t.id).join("/");
    const message =
      leasesByType > 0
        ? `${label} full: ${leasesByType} lease(s)${earliestFreeLabel ? `, earliest frees at ${earliestFreeLabel}` : ""}`
        : `No available agent slot for ${primary.id}; active capacity is ${this.activeSlotCountForType(primary, currentTime, stats)}/${primary.capacity}.`;
    return httpError(message, 409, {
      typeId: primary.id,
      typeIds: candidateTypes.map((t) => t.id),
      types: candidateTypes.map((t) => ({
        id: t.id,
        capacity: t.capacity,
        active: this.activeSlotCountForType(t, currentTime, stats)
      })),
      capacity: primary.capacity,
      active: this.activeSlotCountForType(primary, currentTime, stats),
      leasedSlots: inactiveLeases,
      earliestFreeAt: earliestFree,
      staleLeaseCount: stagedLeases.length
    });
  }

  listAgentPresence({ now: nowInput } = {}) {
    this.ensureAgentPresenceSchema();
    const currentTime = parseTimestamp(nowInput);
    return Object.values(this.data.agentPresence)
      .filter((presence) => this.presenceWithinRetention(presence, currentTime))
      .map((presence) => this.describeAgentPresence(presence, currentTime))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  presenceWithinRetention(presence, currentTime) {
    const heartbeatTime = Date.parse(presence.lastHeartbeat || presence.updatedAt || "");
    if (!Number.isFinite(heartbeatTime)) return false;
    return currentTime.getTime() - heartbeatTime <= PRESENCE_RETENTION_MS;
  }

  async forceReleaseAgentSlot(agentIdInput, input = {}) {
    const agentId = normalizeText(agentIdInput || input.agentId);
    if (!agentId) {
      throw Object.assign(new Error("Agent id is required."), { status: 400 });
    }
    const currentTime = parseTimestamp(input.now);
    const actor = normalizeText(input.actor) || "operator";

    return this.withWriteLock(async () => {
      this.data = await this.readData();
      this.ensureAgentSlotSchema();
      this.ensureAgentPresenceSchema();

      const slot = this.data.agentSlots.find((candidate) => candidate.id === agentId);
      if (!slot) {
        throw httpError("Agent slot not found.", 404, { agentId });
      }

      const releasedLease = slot.lease ? { ...slot.lease } : null;
      const wasActive = Boolean(releasedLease && this.isLeaseFresh(releasedLease, currentTime));
      const returnedTasks = [];

      // Return every in_progress task claimed by this slot to ready (assignee cleared).
      // Tasks in review/testing/done keep their state - work exists, only the slot frees.
      for (const task of this.data.tasks) {
        if (task.assignee !== agentId || task.status !== "in_progress") continue;
        task.status = "ready";
        task.assignee = "";
        task.updatedAt = currentTime.toISOString();
        task.revision = nextTaskRevision(task);
        task.activity.unshift({
          id: id("event"),
          actor,
          type: "force_release.returned",
          message: "Force-released by operator; task returned to queue.",
          createdAt: currentTime.toISOString()
        });
        returnedTasks.push({ taskId: task.id, title: task.title, projectId: task.projectId });
      }

      slot.lease = null;
      slot.updatedAt = currentTime.toISOString();
      slot.paused = false;
      slot.activeProjectId = "";
      delete this.data.agentPresence[agentId];

      this.data.events.unshift({
        id: id("event"),
        actor,
        type: "agent.force_release",
        message: `Force-released agent slot ${agentId}${returnedTasks.length ? `; returned ${returnedTasks.length} task(s) to the queue.` : "."}`,
        createdAt: currentTime.toISOString()
      });

      await this.writeData(this.data);

      return {
        released: true,
        agentId,
        wasActive,
        releasedLease,
        returnedTasks,
        activeProjectId: slot.activeProjectId || ""
      };
    });
  }

  listStaleInProgressTasks({ projectId, now: nowInput } = {}) {
    this.ensureAgentSlotSchema();
    this.ensureAgentPresenceSchema();
    const currentTime = parseTimestamp(nowInput);
    const scopedProjectId = normalizeText(projectId);
    const slotsById = new Map(this.data.agentSlots.map((slot) => [slot.id, slot]));

    const tasks = this.data.tasks
      .filter((task) => task.status === "in_progress")
      .filter((task) => !scopedProjectId || task.projectId === scopedProjectId)
      .map((task) => this.describeStaleInProgressTask(task, slotsById, currentTime))
      .filter(Boolean)
      .sort((a, b) => Date.parse(a.lastProgressAt) - Date.parse(b.lastProgressAt) || a.task.title.localeCompare(b.task.title));

    return {
      generatedAt: currentTime.toISOString(),
      leaseMs: SLOT_LEASE_MS,
      tasks
    };
  }

  async updateAgentPresence(agentIdInput, input = {}) {
    const agentId = normalizeText(agentIdInput || input.agentId);
    if (!agentId) {
      throw Object.assign(new Error("Agent id is required."), { status: 400 });
    }
    const currentTime = parseTimestamp(input.now);

    return this.withWriteLock(async () => {
      this.data = await this.readData();
      this.ensureAgentSlotSchema();
      this.ensureAgentPresenceSchema();

      const slotRequirement = this.agentSlotRequirement(agentId, input);
      if (slotRequirement) {
        throw httpError(
          `Agent id ${agentId} is not a configured concrete agent slot for ${slotRequirement.role} work. Acquire a concrete agent slot such as ${slotRequirement.suggestedSlotIds.join(" or ")} before reporting presence.`,
          409,
          slotRequirement
        );
      }

      const presence = this.writeAgentPresence(agentId, input, currentTime);
      await this.writeData(this.data);
      return presence;
    });
  }

  async reportNoEligibleWork(agentIdInput, input = {}) {
    const agentId = normalizeText(agentIdInput || input.agentId);
    if (!agentId) {
      throw Object.assign(new Error("Agent id is required."), { status: 400 });
    }
    const currentTime = parseTimestamp(input.now);
    const reason = normalizeText(input.reason) || "no_eligible_work";
    const filters = normalizeObject(input.filters);

    return this.withWriteLock(async () => {
      this.data = await this.readData();
      this.ensureAgentSlotSchema();
      this.ensureAgentPresenceSchema();

      const slotRequirement = this.agentSlotRequirement(agentId, input);
      if (slotRequirement) {
        throw httpError(
          `Agent id ${agentId} is not a configured concrete agent slot for ${slotRequirement.role} work. Acquire a concrete agent slot such as ${slotRequirement.suggestedSlotIds.join(" or ")} before reporting no eligible work.`,
          409,
          slotRequirement
        );
      }

      const reportedAt = currentTime.toISOString();
      const signalInput = {
        ...normalizeObject(input.filters),
        ...input,
        projectId: normalizeText(input.projectId) || normalizeText(input.filters?.projectId)
      };
      const profile = this.resolveWorkAgentProfile(agentId, signalInput);
      const allProjects = isAllProjectsScope(signalInput) && !normalizeText(signalInput.projectId);
      const projectContext = this.resolveAgentProjectContext(agentId, signalInput, {
        allowDefault: true,
        useProjectId: !allProjects
      });
      const upstreamSignal = buildUpstreamSignal(
        profile.role,
        tasksForUpstreamSignal(this.data.tasks, projectContext.activeProjectId, allProjects)
      );
      const noEligibleWork = {
        reason,
        reportedAt,
        filters,
        upstreamSignal,
        recheckAfterSeconds: upstreamSignal.recheckAfterSeconds
      };
      const message = normalizeText(input.message);
      if (message) noEligibleWork.message = message;

      const presence = this.writeAgentPresence(
        agentId,
        {
          ...input,
          state: upstreamSignal.total > 0 ? "waiting" : "idle",
          upstreamSignal,
          noEligibleWork
        },
        currentTime
      );

      this.data.events.unshift({
        id: id("event"),
        actor: agentId,
        type: "agent.no_eligible_work",
        message: message || `No eligible work reported: ${reason}.`,
        createdAt: reportedAt
      });

      await this.writeData(this.data);
      return {
        presence,
        report: { ...noEligibleWork },
        upstreamSignal,
        recheckAfterSeconds: upstreamSignal.recheckAfterSeconds
      };
    });
  }

  getNextTaskForAgent(agentIdInput, input = {}) {
    const agentId = normalizeText(agentIdInput || input.agentId);
    if (!agentId) {
      throw Object.assign(new Error("Agent id is required."), { status: 400 });
    }

    this.ensureAgentSlotSchema();
    const currentTime = parseTimestamp(input.now);
    const profile = this.resolveWorkAgentProfile(agentId, input);
    const slotRequirement = this.agentSlotRequirement(agentId, input);
    const allProjects = isAllProjectsScope(input) && !normalizeText(input.projectId);
    const projectContext = this.resolveAgentProjectContext(agentId, input, {
      allowDefault: true,
      useProjectId: !allProjects
    });
    const agent = {
      agentId,
      role: profile.role,
      specialties: [...profile.specialties],
      workMode: profile.workMode,
      paused: profile.paused,
      activeProjectId: projectContext.activeProjectId,
      activeProject: projectContext.activeProject,
      ...(profile.slot ? { slotId: profile.slot.id, typeId: profile.slot.typeId } : {})
    };
    const upstreamSignal = buildUpstreamSignal(
      profile.role,
      tasksForUpstreamSignal(this.data.tasks, projectContext.activeProjectId, allProjects)
    );
    const standingSignal = {
      upstreamSignal,
      recheckAfterSeconds: upstreamSignal.recheckAfterSeconds
    };

    if (slotRequirement) {
      return {
        ...standingSignal,
        agent: {
          ...agent,
          role: slotRequirement.role,
          specialties: [...slotRequirement.specialties],
          workMode: slotRequirement.workMode,
          typeId: slotRequirement.typeId
        },
        task: null,
        selection: {
          reason: "agent_slot_required",
          ...slotRequirement
        },
        candidates: []
      };
    }

    if (profile.paused) {
      return {
        ...standingSignal,
        agent,
        task: null,
        selection: {
          reason: "agent_paused",
          paused: true
        },
        candidates: []
      };
    }

    if (isOneActiveTaskWorkMode(profile.workMode)) {
      const activeTask = findActiveTaskForAgent(this.data.tasks, agentId);
      if (activeTask) {
        return {
          ...standingSignal,
          agent,
          task: null,
          selection: buildActiveTaskSelection(activeTask, profile.workMode),
          candidates: []
        };
      }
    }

    const scopedInput = allProjects ? input : { ...input, projectId: projectContext.activeProjectId };
    const scopedTasks = this.data.tasks.filter((task) => taskMatchesNextTaskScope(task, { ...scopedInput, tasks: this.data.tasks }));
    const relationshipBlockedCandidates = scopedTasks
      .filter((task) => taskIsEligibleForProfile(task, profile))
      .filter((task) => !taskRelationshipsAllowClaim(task))
      .map((task) => relationshipBlockedCandidate(task));
    const buckets = profile.role === "reviewer"
      ? reviewerCandidateBuckets(scopedTasks, agentId, profile)
      : workerCandidateBuckets(scopedTasks, agentId, profile);
    const candidates = uniqueTasks(buckets.flatMap((bucket) => bucket.tasks));

    for (const bucket of buckets) {
      const task = bucket.tasks[0];
      if (!task) continue;

      return {
        ...standingSignal,
        agent,
        task,
        selection: withProjectScope(buildSelection(bucket.reason, task, agentId), projectContext, allProjects),
        candidates,
        blockedCandidates: relationshipBlockedCandidates
      };
    }

    return {
      ...standingSignal,
      agent,
      task: null,
      selection: {
        reason: "no_eligible_work",
        ...selectionProjectScope(projectContext, allProjects)
      },
      candidates: [],
      blockedCandidates: relationshipBlockedCandidates
    };
  }

  listProjects({ includeArchived = false } = {}) {
    return this.data.projects
      .filter((project) => includeArchived || !project.archived)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async createProject(input) {
    const name = normalizeText(input.name);
    if (!name) {
      throw Object.assign(new Error("Project name is required."), { status: 400 });
    }

    const createdAt = now();
    const project = {
      id: id("project"),
      key: slugify(input.key || name),
      name,
      description: normalizeText(input.description),
      createdAt,
      updatedAt: createdAt,
      archived: false
    };
    this.data.projects.push(project);
    this.data.events.push({
      id: id("event"),
      projectId: project.id,
      actor: normalizeText(input.actor) || "operator",
      type: "project.created",
      message: `Created project ${project.name}.`,
      createdAt
    });
    await this.save();
    return project;
  }

  listTasks(filters = {}) {
    const q = normalizeText(filters.q).toLowerCase();
    const workItemType = normalizeOptionalWorkItemType(filters.workItemType);
    const labels = normalizeText(filters.labels)
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean);

    return this.data.tasks
      .filter((task) => !filters.projectId || task.projectId === filters.projectId)
      .filter((task) => !filters.status || task.status === filters.status)
      .filter((task) => !filters.role || task.role === filters.role)
      .filter((task) => !filters.assignee || task.assignee === filters.assignee)
      .filter((task) => !workItemType || task.workItemType === workItemType)
      .filter((task) => labels.every((label) => task.labels.includes(label)))
      .filter((task) => {
        if (!q) return true;
        return [
          task.title,
          task.description,
          task.assignee,
          task.role,
          task.priority,
          task.workItemType,
          relationshipSearchText(task, this.data.tasks),
          ...task.labels
        ]
          .join(" ")
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => {
        const statusDelta = statusRank(a.status) - statusRank(b.status);
        if (statusDelta !== 0) return statusDelta;
        return priorityRank(b.priority) - priorityRank(a.priority) || b.updatedAt.localeCompare(a.updatedAt);
      });
  }

  listProjectActivity(filters = {}) {
    const projectId = normalizeText(filters.projectId);
    const project = this.getProject(projectId);
    const q = normalizeText(filters.q).toLowerCase();
    const types = normalizeText(filters.type || filters.types)
      .split(",")
      .map((type) => type.trim())
      .filter(Boolean);
    const source = normalizeText(filters.source);
    const limit = normalizeActivityLimit(filters.limit);

    const projectEvents = (this.data.events || [])
      .filter((event) => event.projectId === project.id)
      .map((event) => ({
        id: event.id,
        projectId: project.id,
        projectName: project.name,
        source: "project",
        actor: normalizeText(event.actor) || "system",
        type: normalizeText(event.type) || "event",
        message: normalizeText(event.message) || "Project event.",
        detail: "",
        createdAt: normalizeText(event.createdAt) || project.updatedAt || project.createdAt || now(),
        taskId: "",
        taskTitle: "",
        taskStatus: "",
        taskAssignee: "",
        taskRole: "",
        taskPriority: ""
      }));

    const taskEvents = this.data.tasks
      .filter((task) => task.projectId === project.id)
      .flatMap((task) =>
        (task.activity || []).map((event) => {
          const detail = taskActivityDetail(task, event);
          return {
            id: event.id,
            projectId: project.id,
            projectName: project.name,
            source: "task",
            actor: normalizeText(event.actor) || "system",
            type: normalizeText(event.type) || "event",
            message: normalizeText(event.message) || "Task event.",
            detail,
            createdAt: normalizeText(event.createdAt) || task.updatedAt || task.createdAt || now(),
            taskId: task.id,
            taskTitle: task.title,
            taskStatus: task.status,
            taskAssignee: task.assignee,
            taskRole: task.role,
            taskPriority: task.priority
          };
        })
      );

    return [...projectEvents, ...taskEvents]
      .filter((event) => types.length === 0 || types.includes(event.type))
      .filter((event) => !source || event.source === source)
      .filter((event) => {
        if (!q) return true;
        return [
          event.actor,
          event.type,
          event.message,
          event.detail,
          event.projectName,
          event.taskId,
          event.taskTitle,
          event.taskStatus,
          event.taskAssignee,
          event.taskRole,
          event.taskPriority
        ]
          .join(" ")
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, limit);
  }

  listTalkMessages(filters = {}) {
    const projectId = normalizeText(filters.projectId);
    if (projectId) {
      this.getProject(projectId);
    }

    const kind = normalizeText(filters.kind);
    const agentId = normalizeText(filters.agentId || filters.authorAgentId);
    const taskId = normalizeText(filters.taskId || filters.relatedTaskId);
    const q = normalizeText(filters.q).toLowerCase();

    return this.data.talkMessages
      .filter((message) => !projectId || message.projectId === projectId)
      .filter((message) => !kind || message.kind === kind)
      .filter((message) => !agentId || message.authorAgentId === agentId)
      .filter((message) => !taskId || message.relatedTaskId === taskId)
      .filter((message) => {
        if (!q) return true;
        return [message.authorAgentId, message.kind, message.body, message.relatedTaskId, ...message.mentions]
          .join(" ")
          .toLowerCase()
          .includes(q);
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async addTalkMessage(projectIdInput, input) {
    const projectId = normalizeText(projectIdInput || input.projectId);
    this.getProject(projectId);

    const authorAgentId = normalizeText(input.authorAgentId || input.author);
    if (!authorAgentId) {
      throw Object.assign(new Error("Talk message authorAgentId is required."), { status: 400 });
    }

    const kind = normalizeText(input.kind) || "update";
    if (!TALK_KINDS.includes(kind)) {
      throw Object.assign(new Error(`Talk message kind must be one of: ${TALK_KINDS.join(", ")}.`), { status: 400 });
    }

    const body = normalizeText(input.body);
    if (!body) {
      throw Object.assign(new Error("Talk message body is required."), { status: 400 });
    }

    const relatedTaskId = normalizeText(input.relatedTaskId);
    if (relatedTaskId) {
      const task = this.getTask(relatedTaskId);
      if (task.projectId !== projectId) {
        throw Object.assign(new Error("Related task must belong to the same project as the talk message."), { status: 400 });
      }
    }

    const createdAt = now();
    const message = {
      id: id("talk"),
      projectId,
      authorAgentId,
      kind,
      body,
      relatedTaskId,
      mentions: normalizeMentions(input.mentions),
      createdAt
    };
    this.data.talkMessages.unshift(message);
    await this.save();
    return message;
  }

  listCapabilities(filters = {}) {
    this.ensureDefaultCapabilities();
    const projectId = normalizeText(filters.projectId);
    const status = normalizeText(filters.status);
    const ownerRole = normalizeText(filters.ownerRole);
    const ownerAgent = normalizeText(filters.ownerAgent);
    const relatedTaskId = normalizeText(filters.relatedTaskId || filters.taskId);
    const q = normalizeText(filters.q).toLowerCase();
    const hasLiveFilter = Object.prototype.hasOwnProperty.call(filters, "live");
    const liveFilter = String(filters.live).toLowerCase() === "true";

    return this.data.capabilities
      .filter((capability) => !projectId || !capability.projectId || capability.projectId === projectId)
      .filter((capability) => !status || capability.status === status)
      .filter((capability) => !ownerRole || capability.ownerRole === ownerRole)
      .filter((capability) => !ownerAgent || capability.ownerAgent === ownerAgent)
      .filter((capability) => !relatedTaskId || capability.relatedTaskIds.includes(relatedTaskId))
      .filter((capability) => !hasLiveFilter || capability.live === liveFilter)
      .filter((capability) => {
        if (!q) return true;
        return capabilitySearchText(capability).includes(q);
      })
      .sort((a, b) => capabilityStatusRank(a.status) - capabilityStatusRank(b.status) || b.updatedAt.localeCompare(a.updatedAt));
  }

  getCapability(capabilityId) {
    this.ensureDefaultCapabilities();
    const idValue = normalizeCapabilityId(capabilityId);
    const capability = this.data.capabilities.find((candidate) => candidate.id === idValue);
    if (!capability) {
      throw Object.assign(new Error("Capability not found."), { status: 404 });
    }
    return capability;
  }

  async createCapability(input) {
    this.ensureDefaultCapabilities();
    const createdAt = now();
    const capability = this.normalizeCapabilityInput(input, {
      existing: null,
      createdAt,
      updatedAt: createdAt
    });

    if (this.data.capabilities.some((candidate) => candidate.id === capability.id)) {
      throw Object.assign(new Error("Capability id already exists."), { status: 409 });
    }

    this.data.capabilities.push(capability);
    await this.save();
    return capability;
  }

  async updateCapability(capabilityId, patch) {
    this.ensureDefaultCapabilities();
    const capability = this.getCapability(capabilityId);
    const nextCapability = this.normalizeCapabilityInput(patch, {
      existing: capability,
      createdAt: capability.createdAt,
      updatedAt: now()
    });

    if (JSON.stringify(capability) === JSON.stringify(nextCapability)) {
      return capability;
    }

    Object.assign(capability, nextCapability);
    await this.save();
    return capability;
  }

  getBoardState(filters = {}) {
    const projectId = normalizeText(filters.projectId);
    const projects = projectId ? [this.getProject(projectId)] : this.data.projects;
    const projectIds = new Set(projects.map((project) => project.id));
    const tasks = this.data.tasks.filter((task) => projectIds.has(task.projectId));
    const latestUpdatedAt =
      [...projects.map((project) => project.updatedAt), ...tasks.map((task) => task.updatedAt)]
        .filter(Boolean)
        .sort()
        .at(-1) || null;
    const signature = {
      projects: projects.map((project) => ({
        id: project.id,
        key: project.key,
        name: project.name,
        description: project.description,
        archived: project.archived,
        updatedAt: project.updatedAt
      })),
      tasks: tasks.map((task) => ({
        id: task.id,
        projectId: task.projectId,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        role: task.role,
        workItemType: task.workItemType,
        assignee: task.assignee,
        labels: task.labels,
        dependsOn: task.dependsOn,
        blockedBy: task.blockedBy,
        parentTaskId: task.parentTaskId,
        blocks: task.blocks,
        childTaskIds: task.childTaskIds,
        dependencyStatus: task.dependencyStatus,
        comments: task.comments,
        attachments: task.attachments,
        completion: task.completion,
        activity: task.activity,
        revision: task.revision,
        updatedAt: task.updatedAt
      }))
    };

    return {
      projectId,
      version: createHash("sha256").update(JSON.stringify(signature)).digest("hex"),
      latestUpdatedAt,
      generatedAt: now(),
      projectCount: projects.length,
      taskCount: tasks.length
    };
  }

  listOperatorApprovals(filters = {}) {
    const projectId = normalizeText(filters.projectId);
    const taskId = normalizeText(filters.taskId);
    const status = normalizeText(filters.status) || "pending";

    return this.data.tasks
      .filter((task) => !projectId || task.projectId === projectId)
      .filter((task) => !taskId || task.id === taskId)
      .filter((task) => task.blocker?.type === "operator_approval")
      .filter((task) => !status || task.blocker.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((task) => ({
        task,
        blocker: task.blocker,
        latestComment: task.comments?.[0] || null,
        approvalHistory: task.approvalHistory || []
      }));
  }

  async requestOperatorApproval(taskId, input = {}) {
    const task = this.getTask(taskId);
    const requestedBy = normalizeText(input.requestedBy || input.actor || input.author) || "operator";
    const requestedAt = normalizeText(input.requestedAt || input.now) || now();
    const reason = normalizeText(input.reason);
    const requestedAction = normalizeText(input.requestedAction || input.action);
    const nextStatus = normalizeNextTaskStatus(input.nextStatus, "in_progress");

    if (!reason) {
      throw Object.assign(new Error("Operator approval reason is required."), { status: 400 });
    }
    if (!requestedAction) {
      throw Object.assign(new Error("Operator approval requestedAction is required."), { status: 400 });
    }
    if (nextStatus === "done") {
      throw Object.assign(new Error("Operator approval cannot move tasks directly to done."), { status: 400 });
    }

    task.status = "blocked";
    task.blocker = {
      type: "operator_approval",
      status: "pending",
      reason,
      requestedAction,
      nextStatus,
      requestedBy,
      requestedAt
    };
    task.approvalHistory = Array.isArray(task.approvalHistory) ? task.approvalHistory : [];
    task.approvalHistory.unshift({
      id: id("approval"),
      decision: "requested",
      blockerType: "operator_approval",
      requestedBy,
      requestedAt,
      reason,
      requestedAction,
      nextStatus
    });
    task.updatedAt = requestedAt;
    task.activity.unshift({
      id: id("event"),
      actor: requestedBy,
      type: "approval.requested",
      message: "Requested operator approval.",
      createdAt: requestedAt
    });
    task.revision = nextTaskRevision(task);

    await this.save();
    return task;
  }

  async decideOperatorApproval(taskId, input = {}) {
    const task = this.getTask(taskId);
    if (task.blocker?.type !== "operator_approval" || task.blocker.status !== "pending") {
      throw Object.assign(new Error("Task does not have a pending operator approval request."), { status: 400 });
    }

    const decision = normalizeText(input.decision);
    if (!OPERATOR_APPROVAL_DECISION_IDS.has(decision)) {
      throw Object.assign(new Error("Operator approval decision is invalid."), { status: 400 });
    }

    const decidedBy = normalizeText(input.decidedBy || input.actor) || "operator";
    const decidedAt = normalizeText(input.decidedAt || input.now) || now();
    const note = normalizeText(input.note || input.reason || input.body);
    if (decision !== "approved" && !note) {
      throw Object.assign(new Error("Rejected or requested-changes approvals require a note."), { status: 400 });
    }

    const requestedNextStatus = decision === "approved" ? task.blocker.nextStatus || "in_progress" : "ready";
    const nextStatus = normalizeNextTaskStatus(input.nextStatus, requestedNextStatus);
    if (nextStatus === "done") {
      throw Object.assign(new Error("Operator approval decisions cannot move tasks directly to done."), { status: 400 });
    }

    const historyRecord = {
      id: id("approval"),
      blockerType: "operator_approval",
      decision,
      decidedBy,
      decidedAt,
      note,
      nextStatus,
      requestedBy: task.blocker.requestedBy,
      requestedAt: task.blocker.requestedAt,
      requestedAction: task.blocker.requestedAction,
      reason: task.blocker.reason
    };
    task.approvalHistory = Array.isArray(task.approvalHistory) ? task.approvalHistory : [];
    task.approvalHistory.unshift(historyRecord);

    if (decision === "approved") {
      task.status = nextStatus;
      task.blocker = null;
    } else if (decision === "changes_requested") {
      task.status = nextStatus;
      task.blocker =
        nextStatus === "blocked"
          ? {
              ...task.blocker,
              status: "changes_requested",
              decidedBy,
              decidedAt,
              note
            }
          : null;
    } else {
      task.status = "blocked";
      task.blocker = {
        ...task.blocker,
        status: "rejected",
        decidedBy,
        decidedAt,
        note
      };
    }

    task.updatedAt = decidedAt;
    const commentBody = operatorApprovalDecisionComment(historyRecord);
    task.comments.unshift({
      id: id("comment"),
      author: decidedBy,
      body: commentBody,
      createdAt: decidedAt
    });
    task.activity.unshift({
      id: id("event"),
      actor: decidedBy,
      type: "approval.decided",
      message: `Operator approval ${decision}.`,
      createdAt: decidedAt
    });
    task.revision = nextTaskRevision(task);

    await this.save();
    return task;
  }

  exportProjectBackup(projectIdInput) {
    const project = this.getProject(normalizeText(projectIdInput));
    const tasks = this.data.tasks
      .filter((task) => task.projectId === project.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    const events = this.data.events
      .filter((event) => event.projectId === project.id)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));

    return buildProjectBackup({ project, tasks, events, exportedAt: now() });
  }

  async importProjectBackup(input, { actor = "operator" } = {}) {
    const backup = normalizeProjectBackup(input, {
      statusIds: STATUS_IDS,
      priorityIds: PRIORITY_IDS,
      roleIds: ROLE_IDS,
      workItemTypeIds: WORK_ITEM_TYPE_IDS,
      completionTypeIds: COMPLETION_TYPE_IDS,
      now,
      id
    });
    const existingProject = this.data.projects.find((candidate) => candidate.id === backup.project.id);
    const keyCollision = this.data.projects.find(
      (candidate) => candidate.id !== backup.project.id && candidate.key === backup.project.key
    );
    if (keyCollision) {
      throw httpError(`Project backup key ${backup.project.key} already belongs to another project.`, 409, {
        reason: "project_key_collision",
        projectId: backup.project.id,
        existingProjectId: keyCollision.id
      });
    }

    for (const task of backup.tasks) {
      if (task.projectId !== backup.project.id) {
        throw httpError("Project backup tasks must belong to the exported project.", 400, {
          reason: "task_project_mismatch",
          projectId: backup.project.id,
          taskId: task.id,
          taskProjectId: task.projectId
        });
      }

      const taskCollision = this.data.tasks.find((candidate) => candidate.id === task.id && candidate.projectId !== backup.project.id);
      if (taskCollision) {
        throw httpError(`Task backup id ${task.id} already belongs to another project.`, 409, {
          reason: "task_id_collision",
          projectId: backup.project.id,
          taskId: task.id,
          existingProjectId: taskCollision.projectId
        });
      }
    }

    if (existingProject) {
      Object.assign(existingProject, backup.project);
    } else {
      this.data.projects.push(backup.project);
    }

    for (const task of backup.tasks) {
      const existingTaskIndex = this.data.tasks.findIndex((candidate) => candidate.id === task.id);
      if (existingTaskIndex === -1) {
        this.data.tasks.push(task);
      } else {
        this.data.tasks[existingTaskIndex] = task;
      }
    }

    for (const event of backup.events) {
      const existingEventIndex = this.data.events.findIndex((candidate) => candidate.id === event.id);
      if (existingEventIndex === -1) {
        this.data.events.push(event);
      } else {
        const existingEvent = this.data.events[existingEventIndex];
        if (existingEvent.projectId !== backup.project.id) {
          throw httpError(`Project event backup id ${event.id} already belongs to another project.`, 409, {
            reason: "event_id_collision",
            projectId: backup.project.id,
            eventId: event.id,
            existingProjectId: existingEvent.projectId
          });
        }
        this.data.events[existingEventIndex] = event;
      }
    }

    this.rebuildTaskRelationshipDerivatives();

    this.data.events.push({
      id: id("event"),
      projectId: backup.project.id,
      actor: normalizeText(actor) || "operator",
      type: existingProject ? "project.imported.updated" : "project.imported.created",
      message: `Imported project backup for ${backup.project.name}.`,
      createdAt: now()
    });

    await this.save();
    return {
      created: !existingProject,
      projectId: backup.project.id,
      taskCount: backup.tasks.length,
      eventCount: backup.events.length
    };
  }

  async createTask(input) {
    const projectId = normalizeText(input.projectId);
    const project = this.data.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      throw Object.assign(new Error("Project not found."), { status: 404 });
    }

    const title = normalizeTaskTitle(input.title);
    const status = readTaskEnumField(input, "status", STATUS_IDS, "backlog");
    const priority = readTaskEnumField(input, "priority", PRIORITY_IDS, "normal");
    const role = readTaskEnumField(input, "role", ROLE_IDS, "implementer");
    const workItemType = normalizeWorkItemType(input.workItemType);
    const taskId = id("task");
    const relationships = this.normalizeTaskRelationships(
      {
        id: taskId,
        projectId,
        dependsOn: [],
        blockedBy: [],
        parentTaskId: ""
      },
      input
    );
    const createdAt = now();
    const actor = normalizeText(input.actor) || "operator";
    const { hasCompletion, completionInput } = readCompletionInput(input);

    if (status === "done" && !hasCompletion) {
      throw Object.assign(new Error("A completion record is required before creating a done task."), { status: 400 });
    }

    if (status !== "done" && hasCompletion) {
      throw Object.assign(new Error("Completion records can only be saved on done tasks."), { status: 400 });
    }

    const completion = status === "done" ? normalizeCompletionRecord(completionInput, { actor }) : null;
    if (completion) {
      this.validateCompletionCapabilityLinks(completion, projectId);
    }
    if (input.blocker && status !== "blocked") {
      throw Object.assign(new Error("Structured blockers can only be saved on blocked tasks."), { status: 400 });
    }
    const blocker = status === "blocked" && input.blocker ? normalizeTaskBlocker(input.blocker, { actor }) : null;
    const task = {
      id: taskId,
      projectId,
      title,
      description: normalizeText(input.description),
      status,
      priority,
      role,
      workItemType,
      assignee: normalizeText(input.assignee),
      labels: normalizeTaskLabels(input.labels),
      dependsOn: relationships.dependsOn,
      blockedBy: relationships.blockedBy,
      parentTaskId: relationships.parentTaskId,
      blocks: [],
      childTaskIds: [],
      dependencyStatus: emptyDependencyStatus(),
      completion,
      blocker,
      approvalHistory: [],
      createdAt,
      updatedAt: createdAt,
      revision: 1,
      comments: [],
      attachments: [],
      activity: [
        {
          id: id("event"),
          actor,
          type: "created",
          message: "Task created.",
          createdAt
        }
      ]
    };
    this.data.tasks.push(task);
    if (Array.isArray(relationships.childTaskIds) && relationships.childTaskIds.length > 0) {
      for (const childTaskId of relationships.childTaskIds) {
        const child = this.data.tasks.find((candidate) => candidate.id === childTaskId);
        if (child.parentTaskId === task.id) continue;
        child.parentTaskId = task.id;
        child.revision = nextTaskRevision(child);
        child.updatedAt = createdAt;
        child.activity.unshift({
          id: id("event"),
          actor,
          type: "updated",
          message: `Updated parentTaskId:${task.id}.`,
          createdAt
        });
      }
    }
    this.rebuildTaskRelationshipDerivatives();
    if (completion) {
      this.applyCompletionCapabilityLinks(task);
    }
    await this.save();
    return task;
  }

  async decomposeTask(parentTaskId, input = {}) {
    const parent = this.getTask(parentTaskId);
    if (!isDecompositionTask(parent)) {
      throw httpError("Task is not marked for decomposition. Add a decomposition-needed, ready-for-decomposition, epic, story, or spike label first.", 400, {
        taskId: parent.id,
        labels: parent.labels
      });
    }

    const actor = normalizeText(input.actor) || "planner-agent";
    const summary = normalizeText(input.summary);
    const children = normalizeDecompositionChildren(input.children, parent);
    const childTasks = [];

    for (const child of children) {
      const childTask = await this.createTask({
        projectId: parent.projectId,
        title: child.title,
        description: buildDecompositionChildDescription(child),
        status: child.status,
        priority: child.priority,
        role: child.role,
        workItemType: child.workItemType,
        parentTaskId: parent.id,
        assignee: child.assignee,
        labels: child.labels,
        actor
      });
      childTasks.push(childTask);
    }

    const comment = await this.addComment(parent.id, {
      author: actor,
      body: buildDecompositionSummaryComment({ parent, summary, children, childTasks })
    });

    return {
      parentTask: this.getTask(parent.id),
      childTasks,
      comment,
      decomposition: {
        parentTaskId: parent.id,
        childTaskIds: childTasks.map((task) => task.id),
        fallbackRelationship: "parent-comment"
      }
    };
  }

  getTask(taskId) {
    const task = this.data.tasks.find((candidate) => candidate.id === taskId);
    if (!task) {
      throw Object.assign(new Error("Task not found."), { status: 404 });
    }
    return task;
  }

  getProject(projectId) {
    const project = this.data.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      throw Object.assign(new Error("Project not found."), { status: 404 });
    }
    return project;
  }

  async updateTask(taskId, patch, actor = "operator") {
    patch = normalizeObject(patch);
    const task = this.getTask(taskId);
    const changes = [];
    const actorId = normalizeText(actor) || "operator";
    const expectedRevision = readExpectedTaskRevision(patch);
    const requiresRevision = isFullTaskEditPatch(patch) || expectedRevision.provided;
    const { hasCompletion: hasCompletionPatch, completionInput: completionPatch } = readCompletionInput(patch);
    let completionAppliedDuringStatusChange = false;
    const requestedStatus = Object.prototype.hasOwnProperty.call(patch, "status")
      ? readTaskEnumField(patch, "status", STATUS_IDS, task.status)
      : task.status;
    let nextCompletion = null;
    const hasBlockerPatch = Object.prototype.hasOwnProperty.call(patch, "blocker");
    const hasRelationshipPatch = ["dependsOn", "blockedBy", "parentTaskId", "childTaskIds"].some((field) =>
      Object.prototype.hasOwnProperty.call(patch, field)
    );
    const nextRelationships = hasRelationshipPatch ? this.normalizeTaskRelationships(task, patch) : null;
    const nextBlocker =
      hasBlockerPatch && patch.blocker
        ? normalizeTaskBlocker(patch.blocker, { actor: actorId })
        : hasBlockerPatch
          ? null
          : task.blocker || null;

    if ("title" in patch) {
      normalizeTaskTitle(patch.title);
    }
    if ("priority" in patch) {
      readTaskEnumField(patch, "priority", PRIORITY_IDS, task.priority);
    }
    if ("role" in patch) {
      readTaskEnumField(patch, "role", ROLE_IDS, task.role);
    }
    if ("workItemType" in patch) {
      normalizeWorkItemType(patch.workItemType);
    }
    if ("labels" in patch) {
      normalizeTaskLabels(patch.labels, { defaultValue: task.labels });
    }

    if (requiresRevision) {
      if (!expectedRevision.provided) {
        throw httpError("Task full edits require expectedRevision.", 400, {
          taskId: task.id,
          currentRevision: task.revision
        });
      }
      if (!isValidTaskRevision(expectedRevision.value)) {
        throw httpError("Task expectedRevision must be a positive integer.", 400, {
          taskId: task.id,
          currentRevision: task.revision
        });
      }
      if (expectedRevision.value !== task.revision) {
        await this.recordStaleTaskUpdateRejection(task, actorId, expectedRevision.value);
        throw staleTaskRevisionError(task, expectedRevision.value);
      }
    }

    if (task.status !== requestedStatus && requestedStatus === "done" && !hasCompletionPatch) {
      throw Object.assign(new Error("A completion record is required before moving a task to done."), { status: 400 });
    }

    if (hasCompletionPatch && requestedStatus !== "done") {
      throw Object.assign(new Error("Completion records can only be saved on done tasks."), { status: 400 });
    }

    if (hasCompletionPatch) {
      nextCompletion = normalizeCompletionRecord(completionPatch, { actor: actorId });
      this.validateCompletionCapabilityLinks(nextCompletion, task.projectId);
    }

    if (hasBlockerPatch && requestedStatus !== "blocked") {
      throw Object.assign(new Error("Structured blockers can only be saved on blocked tasks."), { status: 400 });
    }

    if ("title" in patch) {
      const next = normalizeTaskTitle(patch.title);
      if (task.title !== next) {
        task.title = next;
        changes.push("title");
      }
    }

    for (const field of ["description", "assignee"]) {
      if (field in patch) {
        const next = normalizeText(patch[field]);
        if (task[field] !== next) {
          task[field] = next;
          changes.push(field);
        }
      }
    }

    if ("status" in patch) {
      const next = requestedStatus;
      if (task.status !== next) {
        changes.push(`status:${task.status}->${next}`);
        task.status = next;
        if (next === "done") {
          task.completion = nextCompletion;
          changes.push(`completion:${task.completion.completionType}`);
          completionAppliedDuringStatusChange = true;
        } else if (task.completion) {
          task.completion = null;
          changes.push("completion:cleared");
        }
        if (next !== "blocked" && task.blocker) {
          task.blocker = null;
          changes.push("blocker:cleared");
        }
      }
    }

    if (hasCompletionPatch && task.status === "done" && !completionAppliedDuringStatusChange) {
      if (JSON.stringify(task.completion) !== JSON.stringify(nextCompletion)) {
        task.completion = nextCompletion;
        changes.push(`completion:${nextCompletion.completionType}`);
      }
    }

    if ("priority" in patch) {
      const next = readTaskEnumField(patch, "priority", PRIORITY_IDS, task.priority);
      if (task.priority !== next) {
        task.priority = next;
        changes.push("priority");
      }
    }

    if ("role" in patch) {
      const next = readTaskEnumField(patch, "role", ROLE_IDS, task.role);
      if (task.role !== next) {
        task.role = next;
        changes.push("role");
      }
    }

    if ("workItemType" in patch) {
      const next = normalizeWorkItemType(patch.workItemType);
      if (task.workItemType !== next) {
        task.workItemType = next;
        changes.push("workItemType");
      }
    }

    if ("labels" in patch) {
      const labels = normalizeTaskLabels(patch.labels, { defaultValue: task.labels });
      if (JSON.stringify(task.labels) !== JSON.stringify(labels)) {
        task.labels = labels;
        changes.push("labels");
      }
    }

    if (nextRelationships) {
      for (const field of ["dependsOn", "blockedBy", "parentTaskId"]) {
        if (JSON.stringify(task[field]) !== JSON.stringify(nextRelationships[field])) {
          task[field] = nextRelationships[field];
          changes.push(field);
        }
      }

      if (Array.isArray(nextRelationships.childTaskIds)) {
        for (const child of this.data.tasks.filter((candidate) => candidate.projectId === task.projectId && candidate.id !== task.id)) {
          const nextParentTaskId = nextRelationships.childTaskIds.includes(child.id) ? task.id : child.parentTaskId === task.id ? "" : child.parentTaskId;
          if (child.parentTaskId !== nextParentTaskId) {
            child.parentTaskId = nextParentTaskId;
            child.revision = nextTaskRevision(child);
            child.updatedAt = now();
            child.activity.unshift({
              id: id("event"),
              actor: actorId,
              type: "updated",
              message: nextParentTaskId ? `Updated parentTaskId:${task.id}.` : `Updated parentTaskId:cleared from ${task.id}.`,
              createdAt: child.updatedAt
            });
            changes.push(`childTaskIds:${child.id}`);
          }
        }
      }
    }

    if (requestedStatus === "blocked" && hasBlockerPatch) {
      if (JSON.stringify(task.blocker) !== JSON.stringify(nextBlocker)) {
        task.blocker = nextBlocker;
        changes.push(task.blocker ? `blocker:${task.blocker.type}` : "blocker:cleared");
      }
    }

    if (changes.length === 0) {
      return task;
    }

    this.rebuildTaskRelationshipDerivatives();
    task.revision = nextTaskRevision(task);
    task.updatedAt = now();
    task.activity.unshift({
      id: id("event"),
      actor: actorId,
      type: changes.some((change) => change.startsWith("completion:")) && task.status === "done" ? "completed" : "updated",
      message:
        changes.some((change) => change.startsWith("completion:")) && task.status === "done"
          ? `Completed task with ${task.completion.completionType} evidence.`
          : `Updated ${changes.join(", ")}.`,
      createdAt: task.updatedAt
    });
    if (task.status === "done" && task.completion?.capabilityIds?.length) {
      this.applyCompletionCapabilityLinks(task);
    }
    await this.save();
    return task;
  }

  async recordStaleTaskUpdateRejection(task, actorId, expectedRevision) {
    const currentRevision = task.revision;
    const rejectedAt = now();
    task.updatedAt = rejectedAt;
    task.activity.unshift({
      id: id("event"),
      actor: actorId,
      type: "update.rejected",
      message: `Rejected stale full task update: expected revision ${expectedRevision}, found ${currentRevision}.`,
      createdAt: rejectedAt
    });
    await this.save();
  }

  async claimTask(taskId, input) {
    const assignee = normalizeText(input.assignee);
    if (!assignee) {
      throw Object.assign(new Error("Claim assignee is required."), { status: 400 });
    }

    const hasExpectedStatus = Object.prototype.hasOwnProperty.call(input, "expectedStatus");
    const expectedStatus = hasExpectedStatus ? normalizeText(input.expectedStatus) : "ready";
    if (expectedStatus && !STATUS_IDS.has(expectedStatus)) {
      throw Object.assign(new Error("Expected status is invalid."), { status: 400 });
    }

    const hasExpectedAssignee = Object.prototype.hasOwnProperty.call(input, "expectedAssignee");
    const expectedAssignee = hasExpectedAssignee ? normalizeText(input.expectedAssignee) : "";
    const actor = normalizeText(input.actor) || assignee;

    return this.withWriteLock(async () => {
      this.data = await this.readData();
      this.ensureAgentSlotSchema();
      const task = this.getTask(taskId);
      const slotRequirement = this.claimSlotIdentityRequirement(assignee, task);

      if (slotRequirement) {
        throw httpError(
          `Agent id ${assignee} is not a configured concrete agent slot for ${slotRequirement.role} work. Acquire a concrete agent slot such as ${slotRequirement.suggestedSlotIds.join(" or ")} before claiming work.`,
          409,
          slotRequirement
        );
      }

      if (expectedStatus && task.status !== expectedStatus) {
        throw Object.assign(new Error(`Task claim expected status ${expectedStatus}, found ${task.status}.`), {
          status: 409
        });
      }

      if (hasExpectedAssignee) {
        if (task.assignee !== expectedAssignee) {
          throw Object.assign(
            new Error(`Task claim expected assignee ${expectedAssignee || "(unassigned)"}, found ${task.assignee || "(unassigned)"}.`),
            { status: 409 }
          );
        }
      } else if (task.assignee && task.assignee !== assignee) {
        throw Object.assign(new Error(`Task is already claimed by ${task.assignee}.`), { status: 409 });
      }

      const profile = this.resolveWorkAgentProfile(assignee, input);
      if (isOneActiveTaskWorkMode(profile.workMode)) {
        const activeTask = findActiveTaskForAgent(this.data.tasks, assignee, task.id);
        if (activeTask) {
          throw activeTaskClaimError(assignee, activeTask, profile.workMode);
        }
      }

      if (!taskIsEligibleForProfile(task, profile)) {
        throw httpError(
          `Work item type ${task.workItemType || "task"} is not directly claimable by ${profile.role} agent ${assignee}.`,
          409,
          {
            reason: "work_item_type_not_claimable",
            taskId: task.id,
            workItemType: task.workItemType || "task",
            claimableTypes: [...CLAIMABLE_WORK_ITEM_TYPE_IDS]
          }
        );
      }

      if (!taskRelationshipsAllowClaim(task)) {
        throw httpError(`Task ${task.id} is waiting on dependency or blocker relationships.`, 409, {
          reason: "task_relationships_not_satisfied",
          taskId: task.id,
          dependencyStatus: task.dependencyStatus || emptyDependencyStatus()
        });
      }

      const expectedProjectId = normalizeText(input.projectId);
      if (expectedProjectId && task.projectId !== expectedProjectId) {
        throw httpError(`Task claim expected project ${expectedProjectId}, found ${task.projectId}.`, 409, {
          expectedProjectId,
          taskProjectId: task.projectId
        });
      }

      const projectContext = this.resolveAgentProjectContext(assignee, input, {
        allowDefault: false,
        useProjectId: false
      });
      const projectOverrideReason = normalizeText(input.projectOverrideReason || input.crossProjectReason || input.overrideProjectReason);
      const crossingProjects = projectContext.activeProjectId && task.projectId !== projectContext.activeProjectId;
      if (crossingProjects && !projectOverrideReason) {
        throw httpError(
          `Task ${task.id} belongs to project ${task.projectId}, outside ${assignee}'s active project ${projectContext.activeProjectId}. Supply projectOverrideReason for an operator-approved cross-project claim.`,
          409,
          {
            reason: "cross_project_claim_requires_override",
            activeProjectId: projectContext.activeProjectId,
            activeProject: projectContext.activeProject,
            taskProjectId: task.projectId
          }
        );
      }

      const claimedAt = now();
      const previousStatus = task.status;
      const previousAssignee = task.assignee;
      task.status = "in_progress";
      task.assignee = assignee;
      task.revision = nextTaskRevision(task);
      task.updatedAt = claimedAt;
      task.activity.unshift({
        id: id("event"),
        actor,
        type: "claimed",
        message: `Claimed task (${previousStatus}/${previousAssignee || "unassigned"} -> in_progress/${assignee}).${
          crossingProjects ? ` Cross-project override: ${projectOverrideReason}` : ""
        }`,
        createdAt: claimedAt
      });

      await this.writeData(this.data);
      return task;
    });
  }

  async addComment(taskId, input) {
    const task = this.getTask(taskId);
    const body = normalizeText(input.body);
    if (!body) {
      throw Object.assign(new Error("Comment body is required."), { status: 400 });
    }
    const createdAt = now();
    const comment = {
      id: id("comment"),
      author: normalizeText(input.author) || "operator",
      body,
      createdAt
    };
    task.comments.unshift(comment);
    task.activity.unshift({
      id: id("event"),
      actor: comment.author,
      type: "commented",
      message: "Added a comment.",
      createdAt
    });
    task.revision = nextTaskRevision(task);
    task.updatedAt = createdAt;
    await this.save();
    return comment;
  }

  async addAttachment(taskId, file, actor = "operator") {
    const task = this.getTask(taskId);
    if (!file || !file.buffer || file.size === 0) {
      throw Object.assign(new Error("Attachment file is required."), { status: 400 });
    }

    const createdAt = now();
    const sha256 = createHash("sha256").update(file.buffer).digest("hex");
    const filename = safeFilename(file.originalname);
    const attachmentId = id("file");
    const storedName = `${attachmentId}-${filename}`;
    const storedPath = path.join(this.uploadsDir, storedName);
    await writeFile(storedPath, file.buffer);

    const attachment = {
      id: attachmentId,
      filename,
      mimeType: file.mimetype || "application/octet-stream",
      size: file.size,
      sha256,
      storedName,
      uploadedBy: normalizeText(actor) || "operator",
      createdAt
    };
    task.attachments.unshift(attachment);
    task.activity.unshift({
      id: id("event"),
      actor: attachment.uploadedBy,
      type: "attachment.added",
      message: `Attached ${filename}.`,
      createdAt
    });
    task.revision = nextTaskRevision(task);
    task.updatedAt = createdAt;
    await this.save();
    return attachment;
  }

  async getAttachment(taskId, attachmentId) {
    const task = this.getTask(taskId);
    const attachment = task.attachments.find((candidate) => candidate.id === attachmentId);
    if (!attachment) {
      throw Object.assign(new Error("Attachment not found."), { status: 404 });
    }
    const filePath = path.join(this.uploadsDir, attachment.storedName);
    await stat(filePath);
    return { attachment, filePath };
  }

  ensureAgentSlotSchema() {
    let changed = false;
    if (!Array.isArray(this.data.agentTypes)) {
      this.data.agentTypes = [];
      changed = true;
    }
    if (!Array.isArray(this.data.agentSlots)) {
      this.data.agentSlots = [];
      changed = true;
    }

    for (const defaultType of defaultAgentTypes()) {
      let type = this.data.agentTypes.find((candidate) => candidate.id === defaultType.id);
      if (!type) {
        this.data.agentTypes.push(defaultType);
        type = defaultType;
        changed = true;
      }

      for (const field of ["role", "capacity", "defaultWorkMode"]) {
        if (!(field in type)) {
          type[field] = defaultType[field];
          changed = true;
        }
      }
      if (!Array.isArray(type.specialties)) {
        type.specialties = [...defaultType.specialties];
        changed = true;
      }
      if (!Array.isArray(type.slotIds)) {
        type.slotIds = [...defaultType.slotIds];
        changed = true;
      }

      for (const [index, slotId] of type.slotIds.entries()) {
        let slot = this.data.agentSlots.find((candidate) => candidate.id === slotId);
        if (!slot) {
          this.data.agentSlots.push(createAgentSlot(type, slotId, index + 1));
          changed = true;
          continue;
        }

        const defaults = createAgentSlot(type, slotId, index + 1);
        for (const field of ["typeId", "slotNumber", "role", "workMode", "paused", "activeProjectId"]) {
          if (!(field in slot)) {
            slot[field] = defaults[field];
            changed = true;
          }
        }
        if (!Array.isArray(slot.specialties)) {
          slot.specialties = [...defaults.specialties];
          changed = true;
        }
        if (!("lease" in slot)) {
          slot.lease = null;
          changed = true;
        }
      }
    }
    return changed;
  }

  ensureAgentTypeSlotCapacity(type) {
    if (!Array.isArray(type.slotIds)) {
      type.slotIds = [];
    }

    while (type.slotIds.length < type.capacity) {
      const slotNumber = type.slotIds.length + 1;
      const slotId = nextAgentSlotId(type, slotNumber);
      type.slotIds.push(slotId);
      if (!this.data.agentSlots.some((slot) => slot.id === slotId)) {
        this.data.agentSlots.push(createAgentSlot(type, slotId, slotNumber));
      }
    }

    for (const [index, slotId] of type.slotIds.entries()) {
      let slot = this.data.agentSlots.find((candidate) => candidate.id === slotId);
      if (!slot) {
        slot = createAgentSlot(type, slotId, index + 1);
        this.data.agentSlots.push(slot);
        continue;
      }
      slot.slotNumber = index + 1;
      slot.typeId = type.id;
      slot.role = type.role;
      if (!Array.isArray(slot.specialties) || slot.specialties.length === 0) {
        slot.specialties = [...type.specialties];
      }
      if (!slot.workMode) {
        slot.workMode = type.defaultWorkMode;
      }
    }
  }

  ensureAgentPresenceSchema() {
    if (!this.data.agentPresence || typeof this.data.agentPresence !== "object" || Array.isArray(this.data.agentPresence)) {
      this.data.agentPresence = {};
      return true;
    }
    return false;
  }

  writeAgentPresence(agentId, input, currentTime) {
    const heartbeatAt = currentTime.toISOString();
    const existing = this.data.agentPresence[agentId] || {};
    const slot = this.data.agentSlots.find((candidate) => candidate.id === agentId);
    const state = normalizePresenceState(input.state) || existing.state || "active";
    const currentTaskId = normalizeText(input.currentTaskId || input.currentTask);
    const workMode = normalizeWorkMode(input.workMode) || existing.workMode || slot?.workMode || "";
    const message = normalizeText(input.message);
    const projectContext = this.resolveAgentProjectContext(agentId, input, {
      allowDefault: false,
      slot
    });
    const nextPresence = {
      ...existing,
      agentId,
      state,
      lastHeartbeat: heartbeatAt,
      updatedAt: heartbeatAt
    };

    if (currentTaskId) {
      nextPresence.currentTaskId = currentTaskId;
    } else if ("currentTaskId" in input || "currentTask" in input || state !== "active") {
      delete nextPresence.currentTaskId;
    }

    if (workMode) nextPresence.workMode = workMode;
    if (projectContext.activeProjectId) {
      nextPresence.activeProjectId = projectContext.activeProjectId;
    } else if ("activeProjectId" in input || "projectId" in input) {
      delete nextPresence.activeProjectId;
    }
    if (message) {
      nextPresence.message = message;
    } else if ("message" in input) {
      delete nextPresence.message;
    }

    if (input.noEligibleWork) {
      nextPresence.noEligibleWork = input.noEligibleWork;
    } else if (state === "active") {
      delete nextPresence.noEligibleWork;
    }
    const upstreamSignal = normalizeUpstreamSignal(input.upstreamSignal);
    if (upstreamSignal) {
      nextPresence.upstreamSignal = upstreamSignal;
    } else if (state !== "waiting") {
      delete nextPresence.upstreamSignal;
    }

    this.data.agentPresence[agentId] = nextPresence;
    return this.describeAgentPresence(nextPresence, currentTime);
  }

  describeAgentPresence(presence, currentTime) {
    const slot = this.data.agentSlots.find((candidate) => candidate.id === presence.agentId);
    const heartbeatTime = Date.parse(presence.lastHeartbeat || presence.updatedAt || "");
    const stale = Number.isFinite(heartbeatTime) ? currentTime.getTime() - heartbeatTime > SLOT_LEASE_MS : true;
    const paused = presence.state === "paused" || Boolean(slot?.paused);
    const offline = stale && presence.state !== "idle" && !paused;
    const status = paused
      ? "paused"
      : offline
        ? "offline"
        : presence.state === "idle"
          ? "idle"
          : presence.state === "waiting"
            ? "waiting"
            : "online";
    const activeProject = this.findActiveProject(normalizeText(presence.activeProjectId) || normalizeText(slot?.activeProjectId));
    const projectContext = activeProject ? this.decorateProjectContext(activeProject) : { activeProjectId: "", activeProject: null };

    return {
      ...presence,
      ...projectContext,
      status,
      stale,
      offline,
      paused
    };
  }

  describeStaleInProgressTask(task, slotsById, currentTime) {
    const assignee = normalizeText(task.assignee);
    const slot = assignee ? slotsById.get(assignee) : null;
    const presence = assignee && this.data.agentPresence[assignee]
      ? this.describeAgentPresence(this.data.agentPresence[assignee], currentTime)
      : null;
    const leaseFresh = Boolean(slot && this.isLeaseFresh(slot.lease, currentTime));
    const ownerProgress = assignee ? this.latestOwnerProgressForTask(task, assignee, currentTime) : null;
    const presenceFreshActive = Boolean(
      presence &&
        !presence.stale &&
        !presence.paused &&
        presence.state === "active" &&
        presence.status === "online" &&
        presence.currentTaskId === task.id
    );
    const ownerProgressFresh = Boolean(ownerProgress?.fresh);
    const freshness = {
      windowMs: SLOT_LEASE_MS,
      leaseFresh,
      leaseHeartbeatAt: slot?.lease?.heartbeatAt || "",
      leaseExpiresAt: slot?.lease?.expiresAt || "",
      presenceFreshActive,
      presenceHeartbeatAt: presence?.lastHeartbeat || presence?.updatedAt || "",
      presenceCurrentTaskId: presence?.currentTaskId || "",
      ownerProgressFresh,
      lastOwnerProgressAt: ownerProgress?.createdAt || "",
      lastOwnerProgressAuthor: ownerProgress?.author || "",
      lastOwnerProgressSource: ownerProgress?.source || ""
    };

    let reason = "";
    if (!assignee) {
      reason = "missing_assignee";
    } else if (!slot) {
      reason = "missing_slot";
    } else if (slot.paused) {
      reason = "paused_slot";
    } else if (!slot.lease && !presence) {
      reason = "missing_heartbeat";
    } else if (!leaseFresh && !presenceFreshActive && !ownerProgressFresh) {
      reason = "expired_heartbeat";
    }

    if (!reason) return null;
    freshness.summary = staleWorkFreshnessSummary(reason);

    const suggestedActions = ["comment", "requeue", "block"];
    const canAcknowledge = Boolean(slot && !slot.paused);
    if (canAcknowledge) suggestedActions.push("acknowledge");

    return {
      task: this.describeTaskSummary(task),
      projectId: task.projectId,
      assignee,
      reason,
      reasonLabel: staleWorkReasonLabel(reason),
      lastProgressAt: freshness.lastOwnerProgressAt || latestTaskProgressAt(task),
      freshness,
      canAcknowledge,
      suggestedActions,
      slot: slot
        ? {
            id: slot.id,
            typeId: slot.typeId,
            leaseFresh,
            lease: slot.lease ? { ...slot.lease } : null,
            paused: Boolean(slot.paused)
          }
        : null,
      presence
    };
  }

  describeTaskSummary(task) {
    return {
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      role: task.role,
      assignee: task.assignee,
      labels: [...task.labels],
      updatedAt: task.updatedAt,
      createdAt: task.createdAt
    };
  }

  latestOwnerProgressForTask(task, assignee, currentTime) {
    const owner = normalizeText(assignee);
    const signals = [];

    for (const comment of task.comments || []) {
      if (normalizeText(comment.author) === owner) {
        signals.push({
          source: "task_comment",
          author: comment.author,
          createdAt: comment.createdAt
        });
      }
    }

    for (const event of task.activity || []) {
      if (normalizeText(event.actor) === owner) {
        signals.push({
          source: "task_activity",
          author: event.actor,
          createdAt: event.createdAt
        });
      }
    }

    for (const message of this.data.talkMessages || []) {
      if (message.projectId === task.projectId && message.relatedTaskId === task.id && normalizeText(message.authorAgentId) === owner) {
        signals.push({
          source: "talk_message",
          author: message.authorAgentId,
          createdAt: message.createdAt
        });
      }
    }

    return latestProgressSignal(signals, currentTime);
  }

  agentSlotTaskStats() {
    const stats = new Map();
    for (const task of this.data.tasks) {
      if (!task.assignee) continue;
      const slotStats = stats.get(task.assignee) || {
        assignedTaskCount: 0,
        readyTaskCount: 0,
        backlogTaskCount: 0,
        inProgressTaskCount: 0
      };
      slotStats.assignedTaskCount += 1;
      if (task.status === "ready") slotStats.readyTaskCount += 1;
      if (task.status === "backlog") slotStats.backlogTaskCount += 1;
      if (task.status === "in_progress") slotStats.inProgressTaskCount += 1;
      stats.set(task.assignee, slotStats);
    }
    return stats;
  }

  untrackedInProgressAssignees() {
    const slotIds = new Set(this.data.agentSlots.map((slot) => slot.id));
    const grouped = new Map();

    for (const task of this.data.tasks) {
      const assignee = normalizeText(task.assignee).toLowerCase();
      if (!assignee || task.status !== "in_progress" || slotIds.has(assignee)) continue;

      const current = grouped.get(assignee) || {
        assignee,
        role: task.role,
        taskIds: [],
        taskTitles: []
      };
      current.taskIds.push(task.id);
      current.taskTitles.push(task.title);
      if (!current.role && task.role) current.role = task.role;
      grouped.set(assignee, current);
    }

    return [...grouped.values()]
      .map((item) => {
        const type = this.typeForUntrackedAssignee(item.assignee, item.role);
        return {
          ...item,
          reason: "non_slot_assignee",
          typeId: type?.id || "",
          suggestedSlotIds: type ? [...type.slotIds] : [],
          inProgressTaskCount: item.taskIds.length
        };
      })
      .sort((a, b) => a.assignee.localeCompare(b.assignee));
  }

  describeAgentSlot(slot, currentTime, taskStats = {}, type = null) {
    const stats = {
      assignedTaskCount: 0,
      readyTaskCount: 0,
      backlogTaskCount: 0,
      inProgressTaskCount: 0,
      ...(taskStats || {})
    };
    const leaseFresh = this.isLeaseFresh(slot.lease, currentTime);
    const presence = this.data.agentPresence?.[slot.id]
      ? this.describeAgentPresence(this.data.agentPresence[slot.id], currentTime)
      : null;
    const presenceFresh = Boolean(
      presence &&
        !presence.stale &&
        !presence.paused &&
        ["active", "waiting"].includes(presence.state)
    );
    const active = !slot.paused && (leaseFresh || presenceFresh || stats.inProgressTaskCount > 0);
    const withinCapacity = !type || slot.slotNumber <= type.capacity;
    const activeProject = this.findActiveProject(slot.activeProjectId);
    const projectContext = activeProject ? this.decorateProjectContext(activeProject) : { activeProjectId: "", activeProject: null };
    return {
      ...slot,
      ...projectContext,
      specialties: [...(slot.specialties || [])],
      lease: slot.lease ? { ...slot.lease } : null,
      presence,
      leaseFresh,
      presenceFresh,
      active,
      withinCapacity,
      stale: Boolean(slot.lease && !leaseFresh && !presenceFresh && stats.inProgressTaskCount === 0),
      assignedTaskCount: stats.assignedTaskCount,
      readyTaskCount: stats.readyTaskCount,
      backlogTaskCount: stats.backlogTaskCount,
      inProgressTaskCount: stats.inProgressTaskCount,
      available: withinCapacity && !slot.paused && !active
    };
  }

  isLeaseFresh(lease, currentTime) {
    if (!lease?.expiresAt) return false;
    return Date.parse(lease.expiresAt) > currentTime.getTime();
  }

  inferAgentTypeId(input = {}) {
    const preferred = normalizeAgentType(input.preferredType || input.agentType || input.type);
    if (preferred) return preferred;

    const agentId = normalizeText(input.agentId);
    const slot = this.data.agentSlots.find((candidate) => candidate.id === agentId);
    if (slot) return slot.typeId;

    const role = normalizeText(input.role);
    const specialties = normalizeLabels(input.specialties || input.labels);
    if (specialties.includes("backend") || specialties.includes("api") || specialties.includes("storage")) {
      return "implementer-backend";
    }
    if (specialties.includes("frontend") || specialties.includes("ui") || specialties.includes("ux")) {
      return "implementer-frontend";
    }
    if (specialties.includes("mcp") || specialties.includes("agent-tools")) return "mcp";
    if (specialties.includes("docs") || specialties.includes("onboarding") || specialties.includes("architecture")) return "docs";
    if (specialties.includes("security")) return role === "reviewer" ? "security-reviewer" : "implementer-security";
    if (specialties.includes("release") || specialties.includes("packaging")) return "release";
    if (specialties.includes("observability") || specialties.includes("audit")) return "observability";
    if (specialties.includes("infra") || specialties.includes("ci") || specialties.includes("docker")) return "infra";
    if (role === "pm") return "pm";
    if (role === "reviewer") return "reviewer";
    if (role === "tester") return "tester";
    return "implementer-general";
  }

  ensureDefaultCapabilities() {
    if (!Array.isArray(this.data.capabilities)) {
      this.data.capabilities = [];
    }

    let migrated = false;
    const createdAt = now();
    const existingIds = new Set(this.data.capabilities.map((capability) => capability.id));
    for (const seed of defaultCapabilities(createdAt)) {
      if (!existingIds.has(seed.id)) {
        this.data.capabilities.push(seed);
        migrated = true;
      }
    }

    for (const capability of this.data.capabilities) {
      const normalized = this.normalizeCapabilityInput(capability, {
        existing: capability,
        createdAt: capability.createdAt || createdAt,
        updatedAt: capability.updatedAt || capability.createdAt || createdAt,
        migrating: true
      });
      if (JSON.stringify(capability) !== JSON.stringify(normalized)) {
        Object.assign(capability, normalized);
        migrated = true;
      }
    }

    return migrated;
  }

  normalizeCapabilityInput(input, { existing = null, createdAt = now(), updatedAt = now(), migrating = false } = {}) {
    const source = input && typeof input === "object" ? input : {};
    const base = existing || {};
    const capabilityId = existing ? base.id : normalizeCapabilityId(source.id) || id("cap");
    const name = normalizeText(source.name ?? base.name);
    if (!name) {
      throw Object.assign(new Error("Capability name is required."), { status: 400 });
    }

    const statusInput = normalizeText(source.status ?? base.status) || "planned";
    if (!CAPABILITY_STATUS_IDS.has(statusInput)) {
      throw Object.assign(new Error("Capability status is invalid."), { status: 400 });
    }

    const relatedTaskIds = "relatedTaskIds" in source || "taskIds" in source
      ? normalizeStringList(source.relatedTaskIds || source.taskIds)
      : [...(base.relatedTaskIds || [])];
    const explicitProjectId = normalizeText(source.projectId ?? base.projectId);
    const projectId = this.resolveCapabilityProjectId(explicitProjectId, relatedTaskIds, { migrating });

    return {
      id: capabilityId,
      projectId,
      name,
      summary: normalizeText(source.summary ?? base.summary),
      status: statusInput,
      live: statusInput === "live",
      ownerRole: normalizeText(source.ownerRole ?? base.ownerRole),
      ownerAgent: normalizeText(source.ownerAgent ?? base.ownerAgent),
      relatedTaskIds,
      surfaces: "surfaces" in source ? normalizeStringList(source.surfaces) : [...(base.surfaces || [])],
      blockers: "blockers" in source ? normalizeStringList(source.blockers) : [...(base.blockers || [])],
      dependencies: "dependencies" in source ? normalizeStringList(source.dependencies) : [...(base.dependencies || [])],
      acceptanceNotes:
        "acceptanceNotes" in source ? normalizeStringList(source.acceptanceNotes) : [...(base.acceptanceNotes || [])],
      verificationEvidence:
        "verificationEvidence" in source
          ? normalizeStringList(source.verificationEvidence)
          : [...(base.verificationEvidence || [])],
      lastVerifiedAt: normalizeText(source.lastVerifiedAt ?? base.lastVerifiedAt),
      notes: normalizeText(source.notes ?? base.notes),
      createdAt: normalizeText(source.createdAt ?? base.createdAt) || createdAt,
      updatedAt: updatedAt || createdAt
    };
  }

  resolveCapabilityProjectId(projectId, relatedTaskIds, { migrating = false } = {}) {
    if (projectId && !this.data.projects.some((project) => project.id === projectId)) {
      throw Object.assign(new Error("Capability project not found."), { status: 400 });
    }

    if (relatedTaskIds.length === 0) {
      return projectId;
    }

    const tasks = relatedTaskIds.map((taskId) => this.data.tasks.find((task) => task.id === taskId));
    if (tasks.some((task) => !task)) {
      if (migrating) {
        return projectId;
      }
      throw Object.assign(new Error("Capability related task not found."), { status: 400 });
    }

    const linkedProjectIds = [...new Set(tasks.map((task) => task.projectId))];
    if (linkedProjectIds.length > 1 || (projectId && linkedProjectIds[0] !== projectId)) {
      throw Object.assign(new Error("Capability task links must stay within one project."), { status: 400 });
    }
    return projectId || linkedProjectIds[0];
  }

  validateCompletionCapabilityLinks(completion, taskProjectId) {
    for (const capabilityId of completion.capabilityIds || []) {
      const capability = this.getCapability(capabilityId);
      if (capability.projectId && capability.projectId !== taskProjectId) {
        throw Object.assign(new Error("Completion capability links must stay within the task project."), { status: 400 });
      }
    }
  }

  applyCompletionCapabilityLinks(task) {
    const completedAt = task.completion?.completedAt || task.updatedAt || now();
    for (const capabilityId of task.completion?.capabilityIds || []) {
      const capability = this.getCapability(capabilityId);
      if (!capability.projectId) {
        capability.projectId = task.projectId;
      }
      if (!capability.relatedTaskIds.includes(task.id)) {
        capability.relatedTaskIds.push(task.id);
      }
      const evidence = `Task ${task.id} completed with ${task.completion.completionType} evidence.`;
      if (!capability.verificationEvidence.includes(evidence)) {
        capability.verificationEvidence.push(evidence);
      }
      capability.lastVerifiedAt = completedAt;
      capability.updatedAt = now();
    }
  }

  slotIdentityRequirement(agentIdInput) {
    const agentId = normalizeText(agentIdInput).toLowerCase();
    if (!agentId) return null;
    if (this.data.agentSlots.some((slot) => slot.id === agentId)) return null;

    const type = this.typeForGenericSlotIdentity(agentId);
    if (!type) return null;

    return this.slotRequirementForType(agentId, type);
  }

  claimSlotIdentityRequirement(agentIdInput, task) {
    const agentId = normalizeText(agentIdInput).toLowerCase();
    if (!agentId) return null;
    if (this.data.agentSlots.some((slot) => slot.id === agentId)) return null;

    const genericRequirement = this.slotIdentityRequirement(agentId);
    if (genericRequirement) return genericRequirement;

    if (normalizeText(task.assignee).toLowerCase() === agentId) {
      return null;
    }

    const type = this.typeForUntrackedAssignee(agentId, task.role, task.labels);
    if (!type || type.role !== task.role || type.slotIds.length === 0) return null;

    return this.slotRequirementForType(agentId, type);
  }

  agentSlotRequirement(agentIdInput, input = {}) {
    const agentId = normalizeText(agentIdInput).toLowerCase();
    if (!agentId) return null;
    if (this.data.agentSlots.some((slot) => slot.id === agentId)) return null;

    const genericRequirement = this.slotIdentityRequirement(agentId);
    if (genericRequirement) return genericRequirement;

    const role = validOr(normalizeText(input.role), ROLE_IDS, inferRoleFromAgentId(agentId));
    const type = this.typeForUntrackedAssignee(agentId, role, input.specialties || input.labels);
    if (!type || type.role !== role || type.slotIds.length === 0) return null;

    return this.slotRequirementForType(agentId, type);
  }

  slotRequirementForType(agentId, type) {
    return {
      agentId,
      typeId: type.id,
      role: type.role,
      specialties: [...type.specialties],
      workMode: type.defaultWorkMode,
      suggestedSlotIds: [...type.slotIds]
    };
  }

  typeForGenericSlotIdentity(agentIdInput) {
    const agentId = normalizeText(agentIdInput).toLowerCase();
    if (!agentId) return null;

    const normalizedTypeId = normalizeAgentType(agentId);
    const directType = this.data.agentTypes.find((type) => type.id === normalizedTypeId);
    if (directType) return directType;

    const roleTypes = ROLE_IDS.has(agentId) ? this.data.agentTypes.filter((type) => type.role === agentId) : [];
    if (roleTypes.length === 1) return roleTypes[0];

    return null;
  }

  typeForUntrackedAssignee(assignee, role, labels) {
    const genericType = this.typeForGenericSlotIdentity(assignee);
    if (genericType) return genericType;

    const inferredTypeId = this.inferAgentTypeId({ agentId: assignee, role, labels });
    return this.data.agentTypes.find((type) => type.id === inferredTypeId) || null;
  }

  resolveWorkAgentProfile(agentId, input = {}) {
    const slot = this.data.agentSlots.find((candidate) => candidate.id === agentId);
    const type = slot ? this.data.agentTypes.find((candidate) => candidate.id === slot.typeId) : null;
    const role = validOr(normalizeText(input.role), ROLE_IDS, slot?.role || inferRoleFromAgentId(agentId));
    const specialtyOverride = normalizeLabels(input.specialties);
    const specialties =
      specialtyOverride.length > 0
        ? specialtyOverride
        : slot?.specialties?.length
          ? [...slot.specialties]
          : inferSpecialtiesFromAgentId(agentId);

    return {
      slot,
      type,
      role,
      specialties,
      workMode: normalizeWorkMode(input.workMode) || slot?.workMode || type?.defaultWorkMode || "single-task",
      paused: Boolean(slot?.paused)
    };
  }

  getAgentProjectContext(agentIdInput, input = {}) {
    this.ensureAgentSlotSchema();
    this.ensureAgentPresenceSchema();
    const agentId = normalizeText(agentIdInput || input.agentId);
    return this.resolveAgentProjectContext(agentId, input, { allowDefault: true });
  }

  resolveAgentProjectContext(agentId, input = {}, { allowDefault = false, slot = null, useProjectId = true } = {}) {
    const explicitProjectId = normalizeText(input.activeProjectId) || (useProjectId ? normalizeText(input.projectId) : "");
    if (explicitProjectId) {
      return this.decorateProjectContext(this.requireActiveProject(explicitProjectId), {
        source: "input",
        explicit: true
      });
    }

    const presence = agentId ? this.data.agentPresence?.[agentId] : null;
    const agentSlot = slot || (agentId ? this.data.agentSlots.find((candidate) => candidate.id === agentId) : null);
    const storedProjectId = normalizeText(presence?.activeProjectId) || normalizeText(agentSlot?.activeProjectId);
    const storedProject = this.findActiveProject(storedProjectId);
    if (storedProject) {
      return this.decorateProjectContext(storedProject, {
        source: presence?.activeProjectId ? "presence" : "slot",
        explicit: false
      });
    }

    if (allowDefault) {
      const defaultProject = this.defaultActiveProject();
      if (defaultProject) {
        return this.decorateProjectContext(defaultProject, {
          source: this.defaultProjectKey && defaultProject.key === this.defaultProjectKey ? "configured-default" : "default",
          explicit: false,
          defaulted: true
        });
      }
    }

    return {
      activeProjectId: "",
      activeProject: null,
      projectContextSource: "",
      projectContextExplicit: false,
      projectContextDefaulted: false
    };
  }

  requireActiveProject(projectId) {
    const project = this.findActiveProject(projectId);
    if (!project) {
      throw httpError(`Active project ${projectId || "(none)"} was not found or is archived.`, 400, { activeProjectId: projectId });
    }
    return project;
  }

  findActiveProject(projectId) {
    const normalized = normalizeText(projectId);
    if (!normalized) return null;
    return this.data.projects.find((project) => project.id === normalized && !project.archived) || null;
  }

  defaultActiveProject() {
    const activeProjects = this.data.projects.filter((project) => !project.archived);
    return (
      (this.defaultProjectKey ? activeProjects.find((project) => project.key === this.defaultProjectKey) : null) ||
      activeProjects.find((project) => project.id === "project_demo") ||
      [...activeProjects].sort((a, b) => a.name.localeCompare(b.name))[0] ||
      null
    );
  }

  decorateProjectContext(project, { source = "", explicit = false, defaulted = false } = {}) {
    return {
      activeProjectId: project.id,
      activeProject: {
        id: project.id,
        key: project.key,
        name: project.name
      },
      projectContextSource: source,
      projectContextExplicit: explicit,
      projectContextDefaulted: defaulted
    };
  }

  buildNextTaskGuidance(agentId, projectContext) {
    const encodedAgentId = encodeURIComponent(agentId);
    const encodedProjectId = projectContext.activeProjectId ? encodeURIComponent(projectContext.activeProjectId) : "";
    return {
      projectId: projectContext.activeProjectId,
      projectKey: projectContext.activeProject?.key || "",
      url: `/api/agents/${encodedAgentId}/next-task${encodedProjectId ? `?projectId=${encodedProjectId}` : ""}`,
      guidance: projectContext.activeProjectId
        ? `Call get_next_task without allProjects to stay inside ${projectContext.activeProject.key || projectContext.activeProjectId}. Use allProjects only with an explicit operator/admin reason.`
        : "Call get_next_task with an explicit projectId before claiming work."
    };
  }
}

function validOr(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function normalizeTaskTitle(value) {
  const title = normalizeText(value);
  if (!title) {
    throw httpError("Task title is required.", 400, { field: "title" });
  }
  return title;
}

function readTaskEnumField(source, field, allowed, fallback) {
  if (!Object.prototype.hasOwnProperty.call(source, field) || source[field] === undefined) {
    return fallback;
  }

  const value = normalizeText(source[field]);
  if (!allowed.has(value)) {
    throw httpError(`Task ${field} must be one of: ${[...allowed].join(", ")}.`, 400, {
      field,
      allowed: [...allowed],
      value
    });
  }
  return value;
}

function normalizeWorkItemType(value, { migrating = false } = {}) {
  const normalized = normalizeText(value).toLowerCase() || "task";
  if (WORK_ITEM_TYPE_IDS.has(normalized)) return normalized;
  if (migrating) return "task";
  throw httpError(`Task workItemType must be one of: ${[...WORK_ITEM_TYPE_IDS].join(", ")}.`, 400, {
    field: "workItemType",
    allowed: [...WORK_ITEM_TYPE_IDS],
    value: normalized
  });
}

function normalizeOptionalWorkItemType(value) {
  if (value === undefined || value === null || value === "") return "";
  return normalizeWorkItemType(value);
}

function normalizeTaskRelationshipsForMigration(task) {
  return {
    dependsOn: normalizeRelationshipIdListForMigration(task.dependsOn),
    blockedBy: normalizeRelationshipIdListForMigration(task.blockedBy),
    parentTaskId: normalizeOptionalTaskId(task.parentTaskId)
  };
}

function normalizeRelationshipIdList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw httpError(`Task ${field} must be an array of task ids.`, 400, { field });
  }
  const ids = value.map((item) => normalizeText(item)).filter(Boolean);
  return [...new Set(ids)].sort();
}

function normalizeRelationshipIdListForMigration(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeText(item)).filter(Boolean))].sort();
}

function normalizeOptionalTaskId(value) {
  return normalizeText(value);
}

function emptyDependencyStatus() {
  return {
    state: "clear",
    satisfiedTaskIds: [],
    waitingTaskIds: [],
    blockedTaskIds: [],
    invalidTaskIds: [],
    total: 0
  };
}

function validateTaskRelationshipTargets({ task, projectId, relationships, tasks }) {
  for (const field of ["dependsOn", "blockedBy", "childTaskIds"]) {
    for (const taskId of relationships[field] || []) {
      validateRelatedTaskTarget({ task, projectId, field, taskId, tasks });
    }
  }
  if (relationships.parentTaskId) {
    validateRelatedTaskTarget({ task, projectId, field: "parentTaskId", taskId: relationships.parentTaskId, tasks });
  }
}

function validateRelatedTaskTarget({ task, projectId, field, taskId, tasks }) {
  if (taskId === task.id) {
    throw httpError("Task relationships cannot link a task to itself.", 400, {
      field,
      reason: "self_link",
      taskId
    });
  }
  const target = tasks.find((candidate) => candidate.id === taskId);
  if (!target) {
    throw httpError(`Related task ${taskId} does not exist.`, 400, {
      field,
      reason: "missing_task",
      taskId
    });
  }
  if (target.projectId !== projectId) {
    throw httpError(`Related task ${taskId} belongs to a different project.`, 400, {
      field,
      reason: "cross_project",
      taskId,
      taskProjectId: target.projectId,
      expectedProjectId: projectId
    });
  }
}

function validateDependencyAcyclic({ task, relationships, tasks }) {
  const graph = new Map();
  for (const candidate of tasks) {
    graph.set(candidate.id, [...normalizeRelationshipIdListForMigration(candidate.dependsOn), ...normalizeRelationshipIdListForMigration(candidate.blockedBy)]);
  }
  graph.set(task.id, [...relationships.dependsOn, ...relationships.blockedBy]);

  for (const field of ["dependsOn", "blockedBy"]) {
    for (const taskId of relationships[field]) {
      if (dependencyPathExists(taskId, task.id, graph, new Set())) {
        throw httpError("Task dependency relationships cannot form a cycle.", 400, {
          field,
          reason: "cycle",
          taskId
        });
      }
    }
  }
}

function dependencyPathExists(currentId, targetId, graph, seen) {
  if (currentId === targetId) return true;
  if (seen.has(currentId)) return false;
  seen.add(currentId);
  for (const nextId of graph.get(currentId) || []) {
    if (dependencyPathExists(nextId, targetId, graph, seen)) return true;
  }
  return false;
}

function validateParentAcyclic({ task, parentTaskId, tasks }) {
  let currentId = parentTaskId;
  const seen = new Set();
  while (currentId) {
    if (currentId === task.id) {
      throw httpError("Task parent relationships cannot form a cycle.", 400, {
        field: "parentTaskId",
        reason: "cycle",
        taskId: currentId
      });
    }
    if (seen.has(currentId)) return;
    seen.add(currentId);
    const current = tasks.find((candidate) => candidate.id === currentId);
    currentId = normalizeText(current?.parentTaskId);
  }
}

function deriveTaskDependencyStatus(task, tasksById) {
  const status = emptyDependencyStatus();
  const addSatisfied = (taskId) => {
    if (!status.satisfiedTaskIds.includes(taskId)) status.satisfiedTaskIds.push(taskId);
  };
  const addWaiting = (taskId) => {
    if (!status.waitingTaskIds.includes(taskId)) status.waitingTaskIds.push(taskId);
  };
  const addBlocked = (taskId) => {
    if (!status.blockedTaskIds.includes(taskId)) status.blockedTaskIds.push(taskId);
  };
  const addInvalid = (taskId) => {
    if (!status.invalidTaskIds.includes(taskId)) status.invalidTaskIds.push(taskId);
  };

  for (const taskId of task.dependsOn || []) {
    const target = tasksById.get(taskId);
    if (!target || target.projectId !== task.projectId) {
      addInvalid(taskId);
    } else if (relationshipTargetSatisfied(target)) {
      addSatisfied(taskId);
    } else {
      addWaiting(taskId);
    }
  }

  for (const taskId of task.blockedBy || []) {
    const target = tasksById.get(taskId);
    if (!target || target.projectId !== task.projectId) {
      addInvalid(taskId);
    } else if (relationshipTargetSatisfied(target)) {
      addSatisfied(taskId);
    } else {
      addBlocked(taskId);
    }
  }

  for (const key of ["satisfiedTaskIds", "waitingTaskIds", "blockedTaskIds", "invalidTaskIds"]) {
    status[key].sort();
  }
  status.total =
    status.satisfiedTaskIds.length + status.waitingTaskIds.length + status.blockedTaskIds.length + status.invalidTaskIds.length;
  status.state =
    status.invalidTaskIds.length > 0
      ? "invalid"
      : status.blockedTaskIds.length > 0
        ? "blocked"
        : status.waitingTaskIds.length > 0
          ? "waiting"
          : "clear";
  return status;
}

function relationshipTargetSatisfied(task) {
  return ["review", "done"].includes(task.status);
}

function taskRelationshipsAllowClaim(task) {
  const state = task.dependencyStatus?.state || "clear";
  return state === "clear" || task.status === "review";
}

function relationshipBlockedCandidate(task) {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    assignee: task.assignee,
    dependencyStatus: task.dependencyStatus || emptyDependencyStatus()
  };
}

function relationshipSearchText(task, tasks) {
  const ids = [...(task.dependsOn || []), ...(task.blockedBy || []), task.parentTaskId, ...(task.blocks || []), ...(task.childTaskIds || [])].filter(Boolean);
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  return ids
    .map((taskId) => {
      const target = byId.get(taskId);
      return target ? `${taskId} ${target.title} ${target.status} ${target.assignee}` : taskId;
    })
    .join(" ");
}

function normalizeTaskLabels(value, { defaultValue = [] } = {}) {
  if (value === undefined) {
    return [...defaultValue];
  }
  if (!Array.isArray(value)) {
    throw httpError("Task labels must be an array of non-empty strings.", 400, { field: "labels" });
  }
  if (value.length > MAX_TASK_LABELS) {
    throw httpError(`Task labels cannot contain more than ${MAX_TASK_LABELS} labels.`, 400, {
      field: "labels",
      max: MAX_TASK_LABELS,
      count: value.length
    });
  }

  const labels = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") {
      throw httpError("Task labels must be an array of non-empty strings.", 400, { field: "labels", index });
    }
    const label = normalizeText(item).toLowerCase();
    if (!label) {
      throw httpError("Task labels must be non-empty strings.", 400, { field: "labels", index });
    }
    labels.push(label);
  }
  return [...new Set(labels)];
}

function normalizeDecompositionChildren(value, parent) {
  if (!Array.isArray(value) || value.length === 0) {
    throw httpError("Decomposition children must be a non-empty array.", 400, { field: "children" });
  }
  if (value.length > MAX_DECOMPOSITION_CHILDREN) {
    throw httpError(`Decomposition cannot create more than ${MAX_DECOMPOSITION_CHILDREN} child tasks at once.`, 400, {
      field: "children",
      max: MAX_DECOMPOSITION_CHILDREN,
      count: value.length
    });
  }

  return value.map((childInput, index) => {
    const child = normalizeObject(childInput);
    return {
      title: normalizeTaskTitle(child.title),
      description: normalizeText(child.description),
      status: readTaskEnumField(child, "status", STATUS_IDS, "backlog"),
      priority: readTaskEnumField(child, "priority", PRIORITY_IDS, parent.priority || "normal"),
      role: readTaskEnumField(child, "role", ROLE_IDS, "implementer"),
      workItemType: normalizeWorkItemType(child.workItemType),
      assignee: normalizeText(child.assignee),
      labels: normalizeTaskLabels(child.labels, { defaultValue: [] }),
      acceptanceCriteria: normalizeStringList(child.acceptanceCriteria || child.acceptance || child.criteria),
      dependencies: normalizeStringList(child.dependencies),
      evidence: normalizeText(child.evidence || child.evidenceExpectations),
      sequencing: normalizeText(child.sequencing || child.sequencingNotes),
      index
    };
  });
}

function normalizeLabels(value) {
  const list = Array.isArray(value) ? value : normalizeText(value).split(",");
  return [...new Set(list.map((label) => normalizeText(label).toLowerCase()).filter(Boolean))].slice(0, 12);
}

function normalizeMentions(value) {
  const list = Array.isArray(value) ? value : normalizeText(value).split(",");
  return [...new Set(list.map((mention) => normalizeText(mention).replace(/^@+/, "")).filter(Boolean))].slice(0, 24);
}

function normalizeCapabilityId(value) {
  const text = normalizeText(value);
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map(normalizeText).filter(Boolean))];
  }
  return normalizeText(value)
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function normalizeNextTaskStatus(value, fallback = "in_progress") {
  const normalized = normalizeText(value) || fallback;
  if (!STATUS_IDS.has(normalized)) {
    throw Object.assign(new Error("Operator approval nextStatus must be valid."), { status: 400 });
  }
  return normalized;
}

function normalizeTaskBlocker(value, { actor = "operator", migrating = false } = {}) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const requestedType = normalizeText(input.type || input.blockerType).toLowerCase();
  const type = BLOCKER_TYPE_IDS.has(requestedType) ? requestedType : migrating ? "other" : "";

  if (!type) {
    throw Object.assign(new Error("Blocker type is required and must be valid."), { status: 400 });
  }

  const reason = normalizeText(input.reason || input.message || input.note);
  const requestedAction = normalizeText(input.requestedAction || input.action);
  const requestedBy = normalizeText(input.requestedBy || input.actor || input.author) || normalizeText(actor) || "operator";
  const requestedAt = normalizeText(input.requestedAt || input.createdAt || input.now) || now();
  const status = normalizeText(input.status) || (type === "operator_approval" ? "pending" : "active");
  const blocker = {
    type,
    status,
    reason,
    requestedBy,
    requestedAt
  };

  if (requestedAction) blocker.requestedAction = requestedAction;
  if (type === "operator_approval") {
    blocker.requestedAction = requestedAction;
    blocker.nextStatus = normalizeNextTaskStatus(input.nextStatus, "in_progress");
  } else if (input.nextStatus) {
    blocker.nextStatus = normalizeNextTaskStatus(input.nextStatus, "in_progress");
  }

  const decidedBy = normalizeText(input.decidedBy);
  const decidedAt = normalizeText(input.decidedAt);
  const note = normalizeText(input.note);
  if (decidedBy) blocker.decidedBy = decidedBy;
  if (decidedAt) blocker.decidedAt = decidedAt;
  if (note) blocker.note = note;

  return blocker;
}

function operatorApprovalDecisionComment(record) {
  const lead =
    record.decision === "approved"
      ? `Operator approval approved; moved task to ${record.nextStatus}.`
      : record.decision === "changes_requested"
        ? `Operator requested changes; moved task to ${record.nextStatus}.`
        : "Operator approval rejected; task remains blocked.";
  return record.note ? `${lead} Note: ${record.note}` : lead;
}

function normalizePresenceState(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["active", "waiting", "idle", "paused"].includes(normalized) ? normalized : "";
}

function tasksForUpstreamSignal(tasks, activeProjectId, allProjects) {
  if (allProjects || !activeProjectId) return tasks;
  return tasks.filter((task) => task.projectId === activeProjectId);
}

function buildUpstreamSignal(roleInput, tasks = []) {
  const role = normalizeText(roleInput) || "implementer";
  const statuses = UPSTREAM_STATUSES_BY_ROLE[role] || UPSTREAM_STATUSES_BY_ROLE.implementer;
  const counts = Object.fromEntries(statuses.map((status) => [status, tasks.filter((task) => task.status === status).length]));
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const recheckAfterSeconds = total >= 5 ? 60 : total >= 2 ? 90 : total === 1 ? 120 : 180;

  return {
    role,
    statuses: [...statuses],
    counts,
    total,
    active: total > 0,
    recheckAfterSeconds
  };
}

function normalizeUpstreamSignal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const role = normalizeText(value.role);
  const statuses = normalizeLabels(value.statuses);
  const counts = normalizeObject(value.counts);
  const total = Number.parseInt(value.total, 10);
  const recheckAfterSeconds = Number.parseInt(value.recheckAfterSeconds, 10);
  if (!role || statuses.length === 0 || !Number.isFinite(total) || !Number.isFinite(recheckAfterSeconds)) return null;
  return {
    role,
    statuses,
    counts: Object.fromEntries(statuses.map((status) => [status, Math.max(0, Number.parseInt(counts[status], 10) || 0)])),
    total: Math.max(0, total),
    active: total > 0,
    recheckAfterSeconds: Math.max(1, recheckAfterSeconds)
  };
}

function isAllProjectsScope(input = {}) {
  const scope = normalizeText(input.projectScope || input.scope).toLowerCase();
  return input.allProjects === true || input.allProjects === "true" || scope === "all" || scope === "all-projects";
}

function taskMatchesNextTaskScope(task, input = {}) {
  const projectId = normalizeText(input.projectId);
  const labels = normalizeLabels(input.labels);
  const workItemType = normalizeOptionalWorkItemType(input.workItemType);
  const q = normalizeText(input.q).toLowerCase();

  if (projectId && task.projectId !== projectId) return false;
  if (workItemType && task.workItemType !== workItemType) return false;
  if (labels.length > 0 && !labels.every((label) => task.labels.includes(label))) return false;
  if (q) {
    const haystack = [task.title, task.description, task.assignee, task.role, task.priority, task.workItemType, relationshipSearchText(task, input.tasks || []), ...task.labels]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  return !["done", "blocked"].includes(task.status);
}

function isDecompositionTask(task) {
  if (!CLAIMABLE_WORK_ITEM_TYPE_IDS.has(task.workItemType || "task")) return true;
  return task.labels.some((label) => DECOMPOSITION_LABELS.has(label));
}

function isPlannerDecomposerProfile(profile) {
  return profile.type?.id === PLANNER_DECOMPOSER_TYPE_ID;
}

function taskIsEligibleForProfile(task, profile) {
  const decompositionTask = isDecompositionTask(task);
  if (isPlannerDecomposerProfile(profile)) return decompositionTask;
  return !decompositionTask;
}

function reviewerCandidateBuckets(tasks, agentId, profile) {
  return [
    {
      reason: "review_queue",
      tasks: sortNextTasks(tasks.filter((task) => task.status === "review"))
    },
    {
      reason: "assigned_to_agent",
      tasks: sortNextTasks(tasks.filter((task) => task.status === "ready" && task.assignee === agentId))
    },
    {
      reason: "role_queue",
      tasks: sortNextTasks(tasks.filter((task) => task.status === "ready" && task.role === profile.role && isUnassignedOrMine(task, agentId)))
    },
    {
      reason: "specialty_match",
      tasks: sortNextTasks(
        tasks.filter(
          (task) =>
            ["ready", "backlog"].includes(task.status) &&
            isUnassignedOrMine(task, agentId) &&
            labelsIntersect(task.labels, profile.specialties)
        )
      )
    }
  ];
}

function workerCandidateBuckets(tasks, agentId, profile) {
  const eligibleTasks = tasks.filter((task) => taskIsEligibleForProfile(task, profile) && taskRelationshipsAllowClaim(task));
  const specialtyTasks = isPlannerDecomposerProfile(profile)
    ? eligibleTasks.filter((task) => ["ready", "backlog"].includes(task.status) && isUnassignedOrMine(task, agentId))
    : eligibleTasks.filter(
        (task) =>
          ["ready", "backlog"].includes(task.status) &&
          isUnassignedOrMine(task, agentId) &&
          labelsIntersect(task.labels, profile.specialties)
      );
  return [
    {
      reason: "assigned_to_agent",
      tasks: sortNextTasks(eligibleTasks.filter((task) => isClaimableStatus(task.status, profile.role) && task.assignee === agentId))
    },
    {
      reason: "role_queue",
      tasks: sortNextTasks(
        eligibleTasks.filter(
          (task) => isClaimableStatus(task.status, profile.role) && task.role === profile.role && isUnassignedOrMine(task, agentId)
        )
      )
    },
    {
      reason: "specialty_match",
      tasks: sortNextTasks(specialtyTasks)
    }
  ];
}

function buildDecompositionChildDescription(child) {
  const sections = [];
  if (child.description) sections.push(child.description);
  if (child.acceptanceCriteria.length > 0) {
    sections.push(["Acceptance criteria:", ...child.acceptanceCriteria.map((item) => `- ${item}`)].join("\n"));
  }
  if (child.evidence) {
    sections.push(["Evidence expectations:", child.evidence].join("\n"));
  }
  if (child.dependencies.length > 0) {
    sections.push(["Dependencies:", ...child.dependencies.map((item) => `- ${item}`)].join("\n"));
  }
  if (child.sequencing) {
    sections.push(["Sequencing notes:", child.sequencing].join("\n"));
  }
  return sections.join("\n\n");
}

function buildDecompositionSummaryComment({ summary, children, childTasks }) {
  const lines = ["Decomposition summary:", summary || "Created child tasks from this decomposition pass.", "", "Child tasks:"];
  childTasks.forEach((task, index) => {
    const child = children[index];
    lines.push(`- ${task.id}: ${task.title} (role=${task.role}, priority=${task.priority}, status=${task.status})`);
    if (child.sequencing) lines.push(`  Sequencing: ${child.sequencing}`);
    if (child.evidence) lines.push(`  Evidence: ${child.evidence}`);
  });
  lines.push("", "Fallback relationship: child task ids are listed here until typed hierarchy support lands.");
  return lines.join("\n");
}

function sortNextTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const statusDelta = nextTaskStatusRank(a.status) - nextTaskStatusRank(b.status);
    if (statusDelta !== 0) return statusDelta;
    return priorityRank(b.priority) - priorityRank(a.priority) || b.updatedAt.localeCompare(a.updatedAt);
  });
}

function nextTaskStatusRank(status) {
  if (status === "review") return 0;
  if (status === "ready") return 1;
  if (status === "testing") return 2;
  if (status === "backlog") return 3;
  return 4;
}

function uniqueTasks(tasks) {
  const seen = new Set();
  return tasks.filter((task) => {
    if (seen.has(task.id)) return false;
    seen.add(task.id);
    return true;
  });
}

function isOneActiveTaskWorkMode(workMode) {
  return workMode === "single-task" || workMode === "drain-role-queue";
}

function findActiveTaskForAgent(tasks, agentId, excludedTaskId = "") {
  return tasks
    .filter((task) => task.status === "in_progress" && task.assignee === agentId && task.id !== excludedTaskId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title))[0];
}

function buildActiveTaskSelection(activeTask, workMode) {
  return {
    reason: "active_task_in_progress",
    workMode,
    activeTask: {
      id: activeTask.id,
      title: activeTask.title,
      status: activeTask.status,
      projectId: activeTask.projectId,
      updatedAt: activeTask.updatedAt
    },
    message: `Active task ${activeTask.id} is still in progress. Finish, hand off, or requeue it before taking another task.`
  };
}

function activeTaskClaimError(agentId, activeTask, workMode) {
  return httpError(
    `Agent ${agentId} already has active task ${activeTask.id} (${activeTask.title}). Finish, hand off, or requeue it before claiming another task.`,
    409,
    {
      reason: "active_task_in_progress",
      workMode,
      activeTask: {
        id: activeTask.id,
        title: activeTask.title,
        status: activeTask.status,
        projectId: activeTask.projectId,
        updatedAt: activeTask.updatedAt
      }
    }
  );
}

function isFullTaskEditPatch(patch) {
  return FULL_TASK_EDIT_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(patch, field));
}

function readExpectedTaskRevision(patch) {
  if (Object.prototype.hasOwnProperty.call(patch, "expectedRevision")) {
    return { provided: true, value: normalizeTaskRevisionInput(patch.expectedRevision) };
  }
  if (Object.prototype.hasOwnProperty.call(patch, "revision")) {
    return { provided: true, value: normalizeTaskRevisionInput(patch.revision) };
  }
  return { provided: false, value: null };
}

function normalizeTaskRevisionInput(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return NaN;
}

function isValidTaskRevision(value) {
  return Number.isInteger(value) && value > 0;
}

function nextTaskRevision(task) {
  return (isValidTaskRevision(task.revision) ? task.revision : 1) + 1;
}

function staleTaskRevisionError(task, expectedRevision) {
  return httpError("Task was changed by another client. Reload before saving full edits.", 409, {
    taskId: task.id,
    expectedRevision,
    currentRevision: task.revision,
    actualRevision: task.revision,
    reason: "stale_task_revision"
  });
}

function buildSelection(reason, task, agentId) {
  if (reason === "review_queue") {
    return {
      reason,
      review: {
        taskId: task.id,
        reviewer: agentId,
        originalAssignee: task.assignee || "",
        status: task.status
      }
    };
  }

  return {
    reason,
    claim: {
      taskId: task.id,
      assignee: agentId,
      expectedStatus: task.status,
      expectedAssignee: task.assignee || ""
    }
  };
}

function withProjectScope(selection, projectContext, allProjects) {
  return {
    ...selection,
    ...selectionProjectScope(projectContext, allProjects)
  };
}

function selectionProjectScope(projectContext, allProjects) {
  return {
    projectScope: allProjects ? "all" : "active",
    activeProjectId: projectContext.activeProjectId,
    activeProject: projectContext.activeProject
  };
}

function isUnassignedOrMine(task, agentId) {
  return !task.assignee || task.assignee === agentId;
}

function isClaimableStatus(status, role) {
  if (role === "tester") return status === "ready" || status === "testing";
  return status === "ready";
}

function labelsIntersect(left = [], right = []) {
  return left.some((label) => right.includes(label));
}

function inferRoleFromAgentId(agentId) {
  const normalized = normalizeText(agentId).toLowerCase();
  if (normalized.includes("planner") || normalized.includes("decomposer")) return "pm";
  if (normalized.includes("pm")) return "pm";
  if (normalized.includes("review") || normalized.includes("security-reviewer")) return "reviewer";
  if (normalized.includes("test") || normalized.includes("qa")) return "tester";
  if (normalized.includes("research")) return "researcher";
  return "implementer";
}

function inferSpecialtiesFromAgentId(agentId) {
  const normalized = normalizeText(agentId).toLowerCase();
  const specialties = [];
  if (normalized.includes("backend") || normalized.includes("api")) specialties.push("backend", "api");
  if (normalized.includes("frontend") || normalized.includes("ui")) specialties.push("frontend", "ui");
  if (normalized.includes("mcp")) specialties.push("mcp", "agent-tools");
  if (normalized.includes("planner") || normalized.includes("decomposer")) specialties.push("planner", "decomposition");
  if (normalized.includes("docs")) specialties.push("docs");
  if (normalized.includes("security")) specialties.push("security");
  if (normalized.includes("release")) specialties.push("release");
  if (normalized.includes("observability")) specialties.push("observability");
  if (normalized.includes("infra")) specialties.push("infra");
  return [...new Set(specialties)];
}

function normalizeCompletionRecord(value, { actor } = {}) {
  const input = value && typeof value === "object" ? value : {};
  const completionType = normalizeText(input.completionType || input.type);

  if (!COMPLETION_TYPE_IDS.has(completionType)) {
    throw Object.assign(new Error("Completion type is required and must be valid."), { status: 400 });
  }

  if (completionType === "legacy-needs-audit") {
    throw Object.assign(new Error("Legacy completion records are created only by migration."), { status: 400 });
  }

  const record = {
    completionType,
    completedBy: normalizeText(input.completedBy) || normalizeText(actor) || "operator",
    completedAt: normalizeText(input.completedAt) || now()
  };

  const branch = normalizeText(input.branch);
  const commitSha = normalizeText(input.commitSha || input.sha);
  const mergedTo = normalizeText(input.mergedTo);
  const reviewTaskId = normalizeText(input.reviewTaskId);
  const supersededByTaskId = normalizeText(input.supersededByTaskId);
  const notes = normalizeText(input.notes);
  const tests = normalizeStringList(input.tests);
  const capabilityIds = normalizeStringList(input.capabilityIds).map(normalizeCapabilityId).filter(Boolean);

  if (branch) record.branch = branch;
  if (commitSha) record.commitSha = commitSha;
  if (mergedTo) record.mergedTo = mergedTo;
  if (reviewTaskId) record.reviewTaskId = reviewTaskId;
  if (supersededByTaskId) record.supersededByTaskId = supersededByTaskId;
  if (notes) record.notes = notes;
  if (tests.length > 0) record.tests = tests;
  if (capabilityIds.length > 0) record.capabilityIds = capabilityIds;

  if (completionType === "merged") {
    if (!record.commitSha) {
      throw Object.assign(new Error("Merged completion requires a commit SHA."), { status: 400 });
    }
    record.mergedTo = record.mergedTo || "main";
  }

  if ((completionType === "no-code" || completionType === "audit-only") && !record.notes) {
    throw Object.assign(new Error(`${completionType} completion requires notes.`), { status: 400 });
  }

  if (completionType === "superseded" && !record.supersededByTaskId && !record.notes) {
    throw Object.assign(new Error("Superseded completion requires supersededByTaskId or notes."), { status: 400 });
  }

  return record;
}

function latestTaskProgressAt(task) {
  const timestamps = [task.updatedAt, task.createdAt];
  for (const comment of task.comments || []) {
    timestamps.push(comment.createdAt);
  }
  for (const event of task.activity || []) {
    timestamps.push(event.createdAt);
  }

  return timestamps
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || task.updatedAt || task.createdAt || now();
}

function latestProgressSignal(signals, currentTime) {
  return signals
    .map((signal) => {
      const timestamp = Date.parse(signal.createdAt || "");
      if (!Number.isFinite(timestamp) || timestamp > currentTime.getTime()) return null;
      return {
        ...signal,
        fresh: currentTime.getTime() - timestamp <= SLOT_LEASE_MS
      };
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] || null;
}

function staleWorkReasonLabel(reason) {
  return (
    {
      missing_assignee: "Missing assignee",
      missing_slot: "Missing slot",
      paused_slot: "Paused slot",
      missing_heartbeat: "Missing heartbeat",
      expired_heartbeat: "Expired heartbeat"
    }[reason] || "Needs attention"
  );
}

function staleWorkFreshnessSummary(reason) {
  return (
    {
      missing_assignee: "Task has no assignee",
      missing_slot: "Assignee has no configured slot",
      paused_slot: "Agent slot is paused",
      missing_heartbeat: "No heartbeat recorded",
      expired_heartbeat: "No fresh heartbeat or owner progress"
    }[reason] || "Needs attention"
  );
}

function statusRank(status) {
  return STATUSES.findIndex((candidate) => candidate.id === status);
}

function priorityRank(priority) {
  return PRIORITIES.indexOf(priority);
}

function capabilityStatusRank(status) {
  const index = CAPABILITY_STATUSES.indexOf(status);
  return index === -1 ? CAPABILITY_STATUSES.length : index;
}

function capabilitySearchText(capability) {
  return [
    capability.id,
    capability.name,
    capability.summary,
    capability.status,
    capability.ownerRole,
    capability.ownerAgent,
    capability.notes,
    ...(capability.relatedTaskIds || []),
    ...(capability.surfaces || []),
    ...(capability.blockers || []),
    ...(capability.dependencies || []),
    ...(capability.acceptanceNotes || []),
    ...(capability.verificationEvidence || [])
  ]
    .join(" ")
    .toLowerCase();
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function defaultAgentTypes() {
  return DEFAULT_AGENT_TYPES.map((type) => ({
    ...type,
    slotIds: [...type.slotIds],
    specialties: [...type.specialties]
  }));
}

function defaultAgentSlots(types = DEFAULT_AGENT_TYPES) {
  return types.flatMap((type) => type.slotIds.map((slotId, index) => createAgentSlot(type, slotId, index + 1)));
}

function defaultCapabilities(timestamp = now()) {
  return DEFAULT_CAPABILITY_SEEDS.map((capability) => ({
    id: capability.id,
    projectId: capability.projectId || "",
    name: capability.name,
    summary: capability.summary || "",
    status: capability.status,
    live: capability.status === "live",
    ownerRole: capability.ownerRole || "",
    ownerAgent: capability.ownerAgent || "",
    relatedTaskIds: [...(capability.relatedTaskIds || [])],
    surfaces: [...(capability.surfaces || [])],
    blockers: [...(capability.blockers || [])],
    dependencies: [...(capability.dependencies || [])],
    acceptanceNotes: [...(capability.acceptanceNotes || [])],
    verificationEvidence: [...(capability.verificationEvidence || [])],
    lastVerifiedAt: capability.lastVerifiedAt || "",
    notes: capability.notes || "",
    createdAt: timestamp,
    updatedAt: timestamp
  }));
}

function createAgentSlot(type, slotId, slotNumber) {
  return {
    id: slotId,
    typeId: type.id,
    slotNumber,
    role: type.role,
    specialties: [...type.specialties],
    workMode: type.defaultWorkMode,
    paused: false,
    activeProjectId: "",
    lease: null,
    updatedAt: null
  };
}

function describeAgentType(type, slots) {
  const typeSlots = slots
    .filter((slot) => slot.typeId === type.id)
    .sort((a, b) => a.slotNumber - b.slotNumber || a.id.localeCompare(b.id));
  const active = typeSlots.filter((slot) => slot.active).length;
  const available = typeSlots.filter((slot) => slot.available).length;
  return {
    ...type,
    slotIds: [...(type.slotIds || [])],
    specialties: [...(type.specialties || [])],
    configured: typeSlots.length,
    active,
    occupied: active,
    available,
    free: available,
    stale: typeSlots.filter((slot) => slot.stale).length,
    paused: typeSlots.filter((slot) => slot.paused).length,
    slots: typeSlots.map((slot) => ({
      id: slot.id,
      slotNumber: slot.slotNumber,
      active: slot.active,
      available: slot.available,
      stale: slot.stale,
      paused: slot.paused,
      withinCapacity: slot.withinCapacity,
      inProgressTaskCount: slot.inProgressTaskCount,
      readyTaskCount: slot.readyTaskCount,
      backlogTaskCount: slot.backlogTaskCount
    }))
  };
}

function parseTimestamp(value) {
  if (!value) return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw httpError("Invalid timestamp.", 400);
  }
  return date;
}

function normalizeAgentType(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return "";
  return AGENT_TYPE_ALIASES.get(normalized) || normalized;
}

function normalizeAgentCapacity(value) {
  const capacity = Number(value);
  if (!Number.isInteger(capacity) || capacity < 0 || capacity > 20) {
    throw httpError("Agent type capacity must be an integer between 0 and 20.", 400, { capacity: value });
  }
  return capacity;
}

function nextAgentSlotId(type, slotNumber) {
  const existing = type.slotIds?.[slotNumber - 1];
  if (existing) return existing;
  const firstSlotId = type.slotIds?.[0] || type.id;
  const base = firstSlotId.replace(/-\d+$/, "");
  return slotNumber === 1 ? base : `${base}-${slotNumber}`;
}

function normalizeWorkMode(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["single-task", "drain-role-queue", "watch-mode", "blocked-only"].includes(normalized) ? normalized : "";
}

function selectAvailableSlot(slots, { currentTime, runtimeId, stats, isLeaseFresh }) {
  return slots
    .filter((slot) => {
      const slotStats = stats.get(slot.id) || {};
      const leaseFresh = isLeaseFresh(slot.lease, currentTime);
      const sameRuntime = runtimeId && slot.lease?.runtimeId === runtimeId;
      return !slot.paused && !(slotStats.inProgressTaskCount > 0) && (!leaseFresh || sameRuntime);
    })
    .sort((a, b) => {
      const aStats = stats.get(a.id) || {};
      const bStats = stats.get(b.id) || {};
      return (bStats.readyTaskCount || 0) - (aStats.readyTaskCount || 0) || a.slotNumber - b.slotNumber;
    })[0];
}

function httpError(message, status, details) {
  return Object.assign(new Error(message), { status, details });
}
