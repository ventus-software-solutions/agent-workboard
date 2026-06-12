import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

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
export const TALK_KINDS = ["update", "blocker", "review-request", "handoff", "question", "decision", "system"];
export const CAPABILITY_STATUSES = ["proposed", "planned", "in_progress", "review", "live", "broken", "deprecated", "superseded"];

const WRITE_LOCK_RETRY_MS = 25;
const WRITE_LOCK_TIMEOUT_MS = 5000;
const STALE_WRITE_LOCK_MS = 30000;
const SLOT_LEASE_MS = 15 * 60 * 1000;

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
const CAPABILITY_STATUS_IDS = new Set(CAPABILITY_STATUSES);

const DEFAULT_CAPABILITY_SEEDS = [
  {
    id: "cap_task_relationships",
    name: "Task dependencies and subtasks",
    summary: "First-class task prerequisites, blockers, parent tasks, and child task relationships.",
    status: "planned",
    ownerRole: "implementer",
    surfaces: ["Task model", "Task drawer", "get_next_task"],
    acceptanceNotes: ["Tasks can show prerequisite state without relying on free-text comments."],
    notes: "Tracked as DOGFOOD dependency/subtask workflow work."
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
        assignee: "pm-agent",
        labels: ["planning"],
        completion: null,
        createdAt,
        updatedAt: createdAt,
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
        description: "Build one end-to-end slice, then hand it to review and testing.",
        status: "backlog",
        priority: "normal",
        role: "implementer",
        assignee: "",
        labels: ["mvp"],
        completion: null,
        createdAt,
        updatedAt: createdAt,
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
    agentTypes: defaultAgentTypes(),
    agentSlots: defaultAgentSlots()
  };
}

export class WorkboardStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, "workboard.json");
    this.lockPath = path.join(dataDir, "workboard.json.lock");
    this.uploadsDir = path.join(dataDir, "uploads");
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.uploadsDir, { recursive: true });
    try {
      const raw = await readFile(this.dbPath, "utf8");
      this.data = JSON.parse(raw);
      if (this.migrateData()) {
        await this.save();
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      this.data = defaultData();
      await this.save();
    }
  }

  async save() {
    this.writeQueue = this.writeQueue.then(async () => {
      await this.writeData(this.data);
    });
    return this.writeQueue;
  }

  async readData() {
    const raw = await readFile(this.dbPath, "utf8");
    return JSON.parse(raw);
  }

  async writeData(data) {
    await mkdir(this.dataDir, { recursive: true });
    const tmpPath = `${this.dbPath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2));
    await rename(tmpPath, this.dbPath);
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

  capabilityStatuses() {
    return CAPABILITY_STATUSES;
  }

  migrateData() {
    let migrated = false;
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
    }

    if (this.ensureDefaultCapabilities()) {
      migrated = true;
    }

    if (this.ensureAgentSlotSchema()) {
      migrated = true;
    }

    return migrated;
  }

  listAgentSlots({ now: nowInput } = {}) {
    this.ensureAgentSlotSchema();
    const currentTime = parseTimestamp(nowInput);
    const stats = this.agentSlotTaskStats();
    const slots = this.data.agentSlots.map((slot) => this.describeAgentSlot(slot, currentTime, stats.get(slot.id)));
    const activeByType = new Map();

    for (const slot of slots) {
      if (slot.active) {
        activeByType.set(slot.typeId, (activeByType.get(slot.typeId) || 0) + 1);
      }
    }

    return {
      leaseMs: SLOT_LEASE_MS,
      types: this.data.agentTypes.map((type) => ({
        ...type,
        slotIds: [...type.slotIds],
        specialties: [...type.specialties],
        active: activeByType.get(type.id) || 0,
        available: Math.max(0, type.capacity - (activeByType.get(type.id) || 0))
      })),
      slots
    };
  }

  async acquireAgentSlot(input = {}) {
    const currentTime = parseTimestamp(input.now);
    const runtimeId = normalizeText(input.runtimeId) || id("runtime");
    const requestedAgentId = normalizeText(input.agentId);

    return this.withWriteLock(async () => {
      this.data = await this.readData();
      this.ensureAgentSlotSchema();

      const stats = this.agentSlotTaskStats();
      const requestedSlot = requestedAgentId
        ? this.data.agentSlots.find((slot) => slot.id === requestedAgentId)
        : null;
      const typeId = requestedSlot?.typeId || this.inferAgentTypeId(input);
      const type = this.data.agentTypes.find((candidate) => candidate.id === typeId);

      if (!type) {
        throw httpError(`Unknown agent type ${typeId || "(none)"}.`, 400, { typeId });
      }
      if (requestedAgentId && !requestedSlot) {
        throw httpError(`Agent slot ${requestedAgentId} is not configured.`, 404, { agentId: requestedAgentId });
      }

      const typeSlots = this.data.agentSlots
        .filter((slot) => slot.typeId === type.id)
        .sort((a, b) => a.slotNumber - b.slotNumber);
      const existingRuntimeSlot = runtimeId
        ? typeSlots.find((slot) => slot.lease?.runtimeId === runtimeId && this.isLeaseFresh(slot.lease, currentTime))
        : null;
      const selected =
        requestedSlot ||
        existingRuntimeSlot ||
        selectAvailableSlot(typeSlots, {
          currentTime,
          runtimeId,
          stats,
          isLeaseFresh: (lease) => this.isLeaseFresh(lease, currentTime)
        });

      if (!selected) {
        const active = typeSlots.filter((slot) => this.describeAgentSlot(slot, currentTime, stats.get(slot.id)).active);
        throw httpError(`No available agent slot for ${type.id}; active capacity is ${active.length}/${type.capacity}.`, 409, {
          typeId: type.id,
          capacity: type.capacity,
          active: active.length,
          activeSlotIds: active.map((slot) => slot.id)
        });
      }

      const described = this.describeAgentSlot(selected, currentTime, stats.get(selected.id));
      const sameRuntime = selected.lease?.runtimeId === runtimeId;
      if (selected.paused) {
        throw httpError(`Agent slot ${selected.id} is paused.`, 409, { agentId: selected.id, typeId: type.id });
      }
      if (described.active && !sameRuntime) {
        throw httpError(`Agent slot ${selected.id} is already active.`, 409, { agentId: selected.id, typeId: type.id });
      }

      const heartbeatAt = currentTime.toISOString();
      const previousLease = selected.lease;
      const reclaimed = Boolean(previousLease && !this.isLeaseFresh(previousLease, currentTime) && !described.inProgressTaskCount);
      selected.lease = {
        runtimeId,
        acquiredAt: sameRuntime && previousLease?.acquiredAt ? previousLease.acquiredAt : heartbeatAt,
        heartbeatAt,
        expiresAt: new Date(currentTime.getTime() + SLOT_LEASE_MS).toISOString()
      };
      selected.workMode = normalizeWorkMode(input.workMode) || selected.workMode || type.defaultWorkMode;
      selected.updatedAt = heartbeatAt;

      await this.writeData(this.data);

      return {
        acquired: true,
        renewed: Boolean(sameRuntime),
        reclaimed,
        agentId: selected.id,
        typeId: type.id,
        role: selected.role,
        specialties: [...selected.specialties],
        slotNumber: selected.slotNumber,
        workMode: selected.workMode,
        paused: selected.paused,
        lease: { ...selected.lease },
        capacity: type.capacity
      };
    });
  }

  listAgentPresence({ now: nowInput } = {}) {
    this.ensureAgentPresenceSchema();
    const currentTime = parseTimestamp(nowInput);
    return Object.values(this.data.agentPresence)
      .map((presence) => this.describeAgentPresence(presence, currentTime))
      .sort((a, b) => a.agentId.localeCompare(b.agentId));
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

      const reportedAt = currentTime.toISOString();
      const noEligibleWork = {
        reason,
        reportedAt,
        filters
      };
      const message = normalizeText(input.message);
      if (message) noEligibleWork.message = message;

      const presence = this.writeAgentPresence(
        agentId,
        {
          ...input,
          state: "idle",
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
        report: { ...noEligibleWork }
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
    const agent = {
      agentId,
      role: profile.role,
      specialties: [...profile.specialties],
      workMode: profile.workMode,
      paused: profile.paused,
      ...(profile.slot ? { slotId: profile.slot.id, typeId: profile.slot.typeId } : {})
    };

    if (profile.paused) {
      return {
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
          agent,
          task: null,
          selection: buildActiveTaskSelection(activeTask, profile.workMode),
          candidates: []
        };
      }
    }

    const scopedTasks = this.data.tasks.filter((task) => taskMatchesNextTaskScope(task, input));
    const buckets = profile.role === "reviewer"
      ? reviewerCandidateBuckets(scopedTasks, agentId, profile)
      : workerCandidateBuckets(scopedTasks, agentId, profile);
    const candidates = uniqueTasks(buckets.flatMap((bucket) => bucket.tasks));

    for (const bucket of buckets) {
      const task = bucket.tasks[0];
      if (!task) continue;

      return {
        agent,
        task,
        selection: buildSelection(bucket.reason, task, agentId),
        candidates
      };
    }

    return {
      agent,
      task: null,
      selection: {
        reason: "no_eligible_work"
      },
      candidates: []
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
    const labels = normalizeText(filters.labels)
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean);

    return this.data.tasks
      .filter((task) => !filters.projectId || task.projectId === filters.projectId)
      .filter((task) => !filters.status || task.status === filters.status)
      .filter((task) => !filters.role || task.role === filters.role)
      .filter((task) => !filters.assignee || task.assignee === filters.assignee)
      .filter((task) => labels.every((label) => task.labels.includes(label)))
      .filter((task) => {
        if (!q) return true;
        return [task.title, task.description, task.assignee, task.role, task.priority, ...task.labels]
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
        assignee: task.assignee,
        labels: task.labels,
        comments: task.comments,
        attachments: task.attachments,
        completion: task.completion,
        activity: task.activity,
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

  async createTask(input) {
    const projectId = normalizeText(input.projectId);
    const project = this.data.projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      throw Object.assign(new Error("Project not found."), { status: 404 });
    }

    const title = normalizeText(input.title);
    if (!title) {
      throw Object.assign(new Error("Task title is required."), { status: 400 });
    }

    const status = validOr(input.status, STATUS_IDS, "backlog");
    const priority = validOr(input.priority, PRIORITY_IDS, "normal");
    const role = validOr(input.role, ROLE_IDS, "implementer");
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
    const task = {
      id: id("task"),
      projectId,
      title,
      description: normalizeText(input.description),
      status,
      priority,
      role,
      assignee: normalizeText(input.assignee),
      labels: normalizeLabels(input.labels),
      completion,
      createdAt,
      updatedAt: createdAt,
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
    if (completion) {
      this.applyCompletionCapabilityLinks(task);
    }
    await this.save();
    return task;
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
    const task = this.getTask(taskId);
    const changes = [];
    const actorId = normalizeText(actor) || "operator";
    const { hasCompletion: hasCompletionPatch, completionInput: completionPatch } = readCompletionInput(patch);
    let completionAppliedDuringStatusChange = false;
    const requestedStatus = Object.prototype.hasOwnProperty.call(patch, "status") ? validOr(patch.status, STATUS_IDS, task.status) : task.status;
    let nextCompletion = null;

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

    for (const field of ["title", "description", "assignee"]) {
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
      }
    }

    if (hasCompletionPatch && task.status === "done" && !completionAppliedDuringStatusChange) {
      if (JSON.stringify(task.completion) !== JSON.stringify(nextCompletion)) {
        task.completion = nextCompletion;
        changes.push(`completion:${nextCompletion.completionType}`);
      }
    }

    if ("priority" in patch) {
      const next = validOr(patch.priority, PRIORITY_IDS, task.priority);
      if (task.priority !== next) {
        task.priority = next;
        changes.push("priority");
      }
    }

    if ("role" in patch) {
      const next = validOr(patch.role, ROLE_IDS, task.role);
      if (task.role !== next) {
        task.role = next;
        changes.push("role");
      }
    }

    if ("labels" in patch) {
      const labels = normalizeLabels(patch.labels);
      if (JSON.stringify(task.labels) !== JSON.stringify(labels)) {
        task.labels = labels;
        changes.push("labels");
      }
    }

    if (changes.length === 0) {
      return task;
    }

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
      const task = this.getTask(taskId);

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

      const claimedAt = now();
      const previousStatus = task.status;
      const previousAssignee = task.assignee;
      task.status = "in_progress";
      task.assignee = assignee;
      task.updatedAt = claimedAt;
      task.activity.unshift({
        id: id("event"),
        actor,
        type: "claimed",
        message: `Claimed task (${previousStatus}/${previousAssignee || "unassigned"} -> in_progress/${assignee}).`,
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
        for (const field of ["typeId", "slotNumber", "role", "workMode", "paused"]) {
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

    this.data.agentPresence[agentId] = nextPresence;
    return this.describeAgentPresence(nextPresence, currentTime);
  }

  describeAgentPresence(presence, currentTime) {
    const slot = this.data.agentSlots.find((candidate) => candidate.id === presence.agentId);
    const heartbeatTime = Date.parse(presence.lastHeartbeat || presence.updatedAt || "");
    const stale = Number.isFinite(heartbeatTime) ? currentTime.getTime() - heartbeatTime > SLOT_LEASE_MS : true;
    const paused = presence.state === "paused" || Boolean(slot?.paused);
    const offline = stale && presence.state !== "idle" && !paused;
    const status = paused ? "paused" : offline ? "offline" : presence.state === "idle" ? "idle" : "online";

    return {
      ...presence,
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

  describeAgentSlot(slot, currentTime, taskStats = {}) {
    const stats = {
      assignedTaskCount: 0,
      readyTaskCount: 0,
      backlogTaskCount: 0,
      inProgressTaskCount: 0,
      ...(taskStats || {})
    };
    const leaseFresh = this.isLeaseFresh(slot.lease, currentTime);
    const active = !slot.paused && (leaseFresh || stats.inProgressTaskCount > 0);
    return {
      ...slot,
      specialties: [...(slot.specialties || [])],
      lease: slot.lease ? { ...slot.lease } : null,
      leaseFresh,
      active,
      stale: Boolean(slot.lease && !leaseFresh && stats.inProgressTaskCount === 0),
      assignedTaskCount: stats.assignedTaskCount,
      readyTaskCount: stats.readyTaskCount,
      backlogTaskCount: stats.backlogTaskCount,
      inProgressTaskCount: stats.inProgressTaskCount,
      available: !slot.paused && !active
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
}

function validOr(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
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

function normalizePresenceState(value) {
  const normalized = normalizeText(value).toLowerCase();
  return ["active", "idle", "paused"].includes(normalized) ? normalized : "";
}

function taskMatchesNextTaskScope(task, input = {}) {
  const projectId = normalizeText(input.projectId);
  const labels = normalizeLabels(input.labels);
  const q = normalizeText(input.q).toLowerCase();

  if (projectId && task.projectId !== projectId) return false;
  if (labels.length > 0 && !labels.every((label) => task.labels.includes(label))) return false;
  if (q) {
    const haystack = [task.title, task.description, task.assignee, task.role, task.priority, ...task.labels]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }

  return !["done", "blocked"].includes(task.status);
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
  return [
    {
      reason: "assigned_to_agent",
      tasks: sortNextTasks(tasks.filter((task) => isClaimableStatus(task.status, profile.role) && task.assignee === agentId))
    },
    {
      reason: "role_queue",
      tasks: sortNextTasks(
        tasks.filter(
          (task) => isClaimableStatus(task.status, profile.role) && task.role === profile.role && isUnassignedOrMine(task, agentId)
        )
      )
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
    lease: null,
    updatedAt: null
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
