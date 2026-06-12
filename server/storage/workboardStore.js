import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
    this.uploadsDir = path.join(dataDir, "uploads");
    this.data = null;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.uploadsDir, { recursive: true });
    try {
      const raw = await readFile(this.dbPath, "utf8");
      this.data = JSON.parse(raw);
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
      await mkdir(this.dataDir, { recursive: true });
      const tmpPath = `${this.dbPath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(this.data, null, 2));
      await rename(tmpPath, this.dbPath);
    });
    return this.writeQueue;
  }

  roles() {
    return ROLES;
  }

  statuses() {
    return STATUSES;
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
      createdAt,
      updatedAt: createdAt,
      comments: [],
      attachments: [],
      activity: [
        {
          id: id("event"),
          actor: normalizeText(input.actor) || "operator",
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
      const next = validOr(patch.status, STATUS_IDS, task.status);
      if (task.status !== next) {
        changes.push(`status:${task.status}->${next}`);
        task.status = next;
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
      actor: normalizeText(actor) || "operator",
      type: "updated",
      message: `Updated ${changes.join(", ")}.`,
      createdAt: task.updatedAt
    });
    await this.save();
    return task;
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

function statusRank(status) {
  return STATUSES.findIndex((candidate) => candidate.id === status);
}

function priorityRank(priority) {
  return PRIORITIES.indexOf(priority);
}
