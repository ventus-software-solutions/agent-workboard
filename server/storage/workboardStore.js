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

const WRITE_LOCK_RETRY_MS = 25;
const WRITE_LOCK_TIMEOUT_MS = 5000;
const STALE_WRITE_LOCK_MS = 30000;

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

function now() {
  return new Date().toISOString();
}

function id(prefix) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
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
  const base = path.basename(normalizeText(value) || "attachment");
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
    events: []
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

  migrateData() {
    let migrated = false;
    if (!Array.isArray(this.data.events)) {
      this.data.events = [];
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

    return migrated;
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
    const hasCompletion =
      Object.prototype.hasOwnProperty.call(input, "completion") || Object.prototype.hasOwnProperty.call(input, "completionRecord");
    const completionInput = Object.prototype.hasOwnProperty.call(input, "completion") ? input.completion : input.completionRecord;

    if (status === "done" && !hasCompletion) {
      throw Object.assign(new Error("A completion record is required before creating a done task."), { status: 400 });
    }

    if (status !== "done" && hasCompletion) {
      throw Object.assign(new Error("Completion records can only be saved on done tasks."), { status: 400 });
    }

    const completion = status === "done" ? normalizeCompletionRecord(completionInput, { actor }) : null;
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

  async updateTask(taskId, patch, actor = "operator") {
    const task = this.getTask(taskId);
    const changes = [];
    const actorId = normalizeText(actor) || "operator";
    const hasCompletionPatch =
      Object.prototype.hasOwnProperty.call(patch, "completion") || Object.prototype.hasOwnProperty.call(patch, "completionRecord");
    const completionPatch = Object.prototype.hasOwnProperty.call(patch, "completion") ? patch.completion : patch.completionRecord;
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
}

function validOr(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function normalizeLabels(value) {
  const list = Array.isArray(value) ? value : normalizeText(value).split(",");
  return [...new Set(list.map((label) => normalizeText(label).toLowerCase()).filter(Boolean))].slice(0, 12);
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

  if (branch) record.branch = branch;
  if (commitSha) record.commitSha = commitSha;
  if (mergedTo) record.mergedTo = mergedTo;
  if (reviewTaskId) record.reviewTaskId = reviewTaskId;
  if (supersededByTaskId) record.supersededByTaskId = supersededByTaskId;
  if (notes) record.notes = notes;
  if (tests.length > 0) record.tests = tests;

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

function statusRank(status) {
  return STATUSES.findIndex((candidate) => candidate.id === status);
}

function priorityRank(priority) {
  return PRIORITIES.indexOf(priority);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
