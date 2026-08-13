// tasksdir storage mode: work items live as task folders (task.md with YAML-ish
// frontmatter + markdown body) in a git-tracked tasks/ directory, while all ops
// state (agent slots, presence, talks, capabilities, projects, and per-task
// sidecar data that has no frontmatter home) stays in the wrapped ops snapshot
// store under WORKBOARD_DATA_DIR. The adapter is storage only — workflow rules
// stay in workboardStore.js. It never runs git commands and never bulk-rewrites:
// a write touches only task folders whose mapped file content actually changed.

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getBoardValue,
  getValue,
  parseTaskFile,
  renderList,
  serializeTaskFile,
  setBoardValue,
  setValue
} from "./frontmatterTaskFile.js";

const BOARD_STATUSES = new Set(["backlog", "ready", "in_progress", "review", "testing", "blocked", "done"]);
const BOARD_TYPES = new Set(["epic", "story", "task", "subtask", "bug", "spike", "chore"]);
const BOARD_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const DEFAULT_ROLE = "implementer";

// Fixed key set of the file-mapped projection used for diffing and merging.
const VIEW_KEYS = [
  "title",
  "status",
  "assignee",
  "workItemType",
  "priority",
  "labels",
  "description",
  "role",
  "revision",
  "createdAt",
  "updatedAt",
  "completion",
  "blocker",
  "dependsOn",
  "blockedBy",
  "parentTaskId"
];

function nowIso() {
  return new Date().toISOString();
}

function eventId() {
  return `event_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function storageError(message, extra = {}) {
  return Object.assign(new Error(message), { status: 500, ...extra });
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function sameValue(a, b) {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

function asText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toIsoDate(value) {
  const text = asText(value);
  if (!text) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return `${text}T00:00:00.000Z`;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString();
}

function readLabels(value) {
  if (Array.isArray(value)) return value.map((item) => asText(item)).filter(Boolean);
  const text = asText(value);
  if (!text) return [];
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

// D: legacy mapping table from the task spec. Read-side only — files are never
// rewritten because of it; board vocabulary is written only when a mutation
// actually changes the key.
export function mapFileTask(doc, folderName, { fallbackTimestamp = nowIso() } = {}) {
  const id = asText(getValue(doc, "id")) || folderName;
  const rawType = asText(getValue(doc, "type")).toLowerCase();
  const rawStatus = asText(getValue(doc, "status")).toLowerCase();

  let workItemType = "task";
  const extraLabels = [];
  if (BOARD_TYPES.has(rawType)) {
    workItemType = rawType;
  } else if (rawType === "feature") {
    workItemType = "task";
  } else if (rawType === "docs") {
    workItemType = "chore";
    extraLabels.push("docs");
  } else if (rawType === "idea") {
    workItemType = "spike";
    extraLabels.push("idea");
  }

  let status = "backlog";
  let legacyClosed = "";
  if (BOARD_STATUSES.has(rawStatus)) {
    status = rawStatus;
  } else if (rawStatus === "todo") {
    status = "ready";
  } else if (rawStatus === "wont_do") {
    status = "done";
    legacyClosed = "wont_do";
  } else if (rawStatus === "not_relevant") {
    status = "done";
    legacyClosed = "not_relevant";
  }
  // Ideas need operator approval before they are claimable: keep them out of
  // the ready pool instead of inventing a per-task claimable flag.
  if (rawType === "idea" && status === "ready") {
    status = "backlog";
  }

  const owner = asText(getValue(doc, "owner"));
  const assignee = !owner || owner === "unassigned" ? "" : owner;

  const rawPriority = asText(getValue(doc, "priority")).toLowerCase();
  const priority = BOARD_PRIORITIES.has(rawPriority) ? rawPriority : null;

  const labels = [...new Set([...readLabels(getValue(doc, "labels")), ...extraLabels])];

  const boardRevision = Number.parseInt(getBoardValue(doc, "revision"), 10);
  const revision = Number.isInteger(boardRevision) && boardRevision >= 1 ? boardRevision : 1;
  const createdAt = asText(getBoardValue(doc, "createdAt")) || toIsoDate(getValue(doc, "created")) || fallbackTimestamp;
  const updatedAt = asText(getBoardValue(doc, "updatedAt")) || createdAt;

  const boardCompletion = getBoardValue(doc, "completion");
  let completion = boardCompletion && typeof boardCompletion === "object" ? boardCompletion : null;
  if (!completion && status === "done") {
    if (legacyClosed === "wont_do") {
      completion = {
        completionType: "no-code",
        completedBy: "tasksdir",
        completedAt: updatedAt,
        notes: "Closed as wont_do in the tasks directory."
      };
    } else if (legacyClosed === "not_relevant") {
      completion = {
        completionType: "superseded",
        completedBy: "tasksdir",
        completedAt: updatedAt,
        notes: "Closed as not_relevant in the tasks directory."
      };
    } else {
      completion = {
        completionType: "legacy-needs-audit",
        completedBy: "legacy",
        completedAt: updatedAt,
        notes: "Marked done before completion records existed. Audit required."
      };
    }
  }
  if (status !== "done") {
    completion = null;
  }

  const boardBlocker = getBoardValue(doc, "blocker");
  const blocker = status === "blocked" && boardBlocker && typeof boardBlocker === "object" ? boardBlocker : null;

  const boardRole = asText(getBoardValue(doc, "role"));
  const dependsOn = Array.isArray(getBoardValue(doc, "dependsOn")) ? getBoardValue(doc, "dependsOn").map(String) : [];
  const blockedBy = Array.isArray(getBoardValue(doc, "blockedBy")) ? getBoardValue(doc, "blockedBy").map(String) : [];

  const view = {
    title: asText(getValue(doc, "title")) || id,
    status,
    assignee,
    workItemType,
    priority,
    labels,
    description: String(doc.body ?? "").trim(),
    role: boardRole || DEFAULT_ROLE,
    revision,
    createdAt,
    updatedAt,
    completion,
    blocker,
    dependsOn,
    blockedBy,
    parentTaskId: asText(getBoardValue(doc, "parentTaskId"))
  };
  return { id, view };
}

export function fileViewFromBoardTask(task) {
  return {
    title: asText(task.title),
    status: asText(task.status) || "backlog",
    assignee: asText(task.assignee),
    workItemType: asText(task.workItemType) || "task",
    priority: BOARD_PRIORITIES.has(task.priority) ? task.priority : null,
    labels: Array.isArray(task.labels) ? task.labels.map((item) => asText(item)).filter(Boolean) : [],
    description: asText(task.description),
    role: asText(task.role) || DEFAULT_ROLE,
    revision: Number.isInteger(task.revision) && task.revision >= 1 ? task.revision : 1,
    createdAt: asText(task.createdAt),
    updatedAt: asText(task.updatedAt),
    completion: task.completion && typeof task.completion === "object" ? JSON.parse(JSON.stringify(task.completion)) : null,
    blocker: task.blocker && typeof task.blocker === "object" ? JSON.parse(JSON.stringify(task.blocker)) : null,
    dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : [],
    blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : [],
    parentTaskId: asText(task.parentTaskId)
  };
}

function emptyDependencyStatus() {
  return { state: "clear", satisfiedTaskIds: [], waitingTaskIds: [], blockedTaskIds: [], invalidTaskIds: [], total: 0 };
}

export function boardTaskFromView(id, view, projectId) {
  return {
    id,
    projectId,
    title: view.title,
    description: view.description,
    status: view.status,
    priority: view.priority,
    role: view.role,
    workItemType: view.workItemType,
    assignee: view.assignee,
    labels: [...view.labels],
    dependsOn: [...view.dependsOn],
    blockedBy: [...view.blockedBy],
    parentTaskId: view.parentTaskId,
    blocks: [],
    childTaskIds: [],
    dependencyStatus: emptyDependencyStatus(),
    completion: view.completion ? { ...view.completion } : null,
    blocker: view.blocker ? { ...view.blocker } : null,
    approvalHistory: [],
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    revision: view.revision,
    comments: [],
    attachments: [],
    activity: []
  };
}

function applyViewToTask(task, view) {
  task.title = view.title;
  task.status = view.status;
  task.assignee = view.assignee;
  task.workItemType = view.workItemType;
  task.priority = view.priority;
  task.labels = [...view.labels];
  task.description = view.description;
  task.role = view.role;
  task.revision = view.revision;
  task.createdAt = view.createdAt;
  task.updatedAt = view.updatedAt;
  task.completion = view.completion ? { ...view.completion } : null;
  task.blocker = view.blocker ? { ...view.blocker } : null;
  task.dependsOn = [...view.dependsOn];
  task.blockedBy = [...view.blockedBy];
  task.parentTaskId = view.parentTaskId;
}

// Applies only the keys where nextView differs from the doc's current view, so
// unknown frontmatter keys and untouched lines stay byte-for-byte identical.
export function applyViewToDoc(doc, baseView, nextView) {
  const nl = doc.newline;
  if (!sameValue(baseView.title, nextView.title)) setValue(doc, "title", JSON.stringify(nextView.title));
  if (!sameValue(baseView.status, nextView.status)) setValue(doc, "status", nextView.status);
  if (!sameValue(baseView.assignee, nextView.assignee)) setValue(doc, "owner", nextView.assignee || "unassigned");
  if (!sameValue(baseView.workItemType, nextView.workItemType)) setValue(doc, "type", nextView.workItemType);
  if (!sameValue(baseView.priority, nextView.priority)) setValue(doc, "priority", nextView.priority ?? "unset");
  if (!sameValue(baseView.labels, nextView.labels)) setValue(doc, "labels", renderList(nextView.labels));
  if (!sameValue(baseView.description, nextView.description)) {
    doc.body = nextView.description ? `${nextView.description}${nl}` : "";
  }
  if (!sameValue(baseView.role, nextView.role)) {
    setBoardValue(doc, "role", nextView.role === DEFAULT_ROLE ? "" : nextView.role);
  }
  if (!sameValue(baseView.revision, nextView.revision)) setBoardValue(doc, "revision", String(nextView.revision));
  if (!sameValue(baseView.createdAt, nextView.createdAt)) setBoardValue(doc, "createdAt", nextView.createdAt);
  if (!sameValue(baseView.updatedAt, nextView.updatedAt)) setBoardValue(doc, "updatedAt", nextView.updatedAt);
  if (!sameValue(baseView.completion, nextView.completion)) {
    setBoardValue(doc, "completion", nextView.completion ? JSON.stringify(nextView.completion) : "");
  }
  if (!sameValue(baseView.blocker, nextView.blocker)) {
    setBoardValue(doc, "blocker", nextView.blocker ? JSON.stringify(nextView.blocker) : "");
  }
  if (!sameValue(baseView.dependsOn, nextView.dependsOn)) {
    setBoardValue(doc, "dependsOn", nextView.dependsOn.length ? JSON.stringify(nextView.dependsOn) : "");
  }
  if (!sameValue(baseView.blockedBy, nextView.blockedBy)) {
    setBoardValue(doc, "blockedBy", nextView.blockedBy.length ? JSON.stringify(nextView.blockedBy) : "");
  }
  if (!sameValue(baseView.parentTaskId, nextView.parentTaskId)) {
    setBoardValue(doc, "parentTaskId", nextView.parentTaskId || "");
  }
}

// Key-level three-way merge: base = last file state the board saw, ours = the
// board mutation, theirs = the file as edited externally. Disjoint changes
// merge; a key changed on both sides conflicts (revision/updatedAt excepted —
// they move on every mutation, so the merge takes the larger/later value).
export function threeWayMergeViews(base, ours, theirs) {
  const merged = {};
  const conflicts = [];
  for (const key of VIEW_KEYS) {
    const unchangedByBoard = sameValue(base[key], ours[key]);
    const unchangedExternally = sameValue(base[key], theirs[key]);
    if (unchangedByBoard) {
      merged[key] = theirs[key];
    } else if (unchangedExternally || sameValue(ours[key], theirs[key])) {
      merged[key] = ours[key];
    } else if (key === "revision") {
      merged[key] = Math.max(ours[key], theirs[key]);
    } else if (key === "updatedAt") {
      merged[key] = ours[key] > theirs[key] ? ours[key] : theirs[key];
    } else {
      conflicts.push(key);
      merged[key] = theirs[key];
    }
  }
  return { merged, conflicts };
}

function newTaskDoc(view, id, newline = "\n") {
  const doc = { entries: [], body: "", newline, hadFrontmatter: false };
  setValue(doc, "id", id);
  setValue(doc, "title", JSON.stringify(view.title));
  setValue(doc, "owner", view.assignee || "unassigned");
  setValue(doc, "status", view.status);
  setValue(doc, "type", view.workItemType);
  setValue(doc, "priority", view.priority ?? "unset");
  setValue(doc, "labels", renderList(view.labels));
  setValue(doc, "created", view.createdAt.slice(0, 10));
  applyViewToDoc(doc, {}, view);
  doc.body = view.description ? `${view.description}${newline}` : "";
  return doc;
}

export class TasksdirWorkboardPersistence {
  constructor({ tasksDir, ops }) {
    const normalized = asText(tasksDir);
    if (!normalized) {
      throw storageError(
        'WORKBOARD_STORAGE=tasksdir requires WORKBOARD_TASKS_DIR to point at the git-tracked tasks/ directory.'
      );
    }
    this.mode = "tasksdir";
    this.workItemsExternal = true;
    this.tasksDir = path.resolve(normalized);
    this.ops = ops;
    this.path = ops.path;
    this.lockPath = ops.lockPath;
    this.entries = new Map(); // folder -> { folder, filePath, fingerprint, doc, view, id }
    this.byId = new Map(); // task id -> entry
  }

  async read() {
    const opsData = await this.ops.read();
    await this.scanTaskFiles();
    if (!opsData) return null;

    const sidecars =
      opsData.tasksdirSidecars && typeof opsData.tasksdirSidecars === "object" && !Array.isArray(opsData.tasksdirSidecars)
        ? opsData.tasksdirSidecars
        : {};
    const fallbackProjectId = resolveFallbackProjectId(opsData);
    const tasks = [];
    for (const entry of this.byId.values()) {
      const sidecar = sidecars[entry.id] || {};
      const task = boardTaskFromView(entry.id, entry.view, asText(sidecar.projectId) || fallbackProjectId);
      task.comments = cloneArray(sidecar.comments);
      task.attachments = cloneArray(sidecar.attachments);
      task.activity = cloneArray(sidecar.activity);
      task.approvalHistory = cloneArray(sidecar.approvalHistory);
      tasks.push(task);
    }

    const { tasksdirSidecars, ...rest } = opsData;
    return { ...rest, tasks };
  }

  async write(data) {
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const plans = [];
    for (const task of tasks) {
      const nextView = fileViewFromBoardTask(task);
      const entry = this.byId.get(task.id);
      if (!entry) {
        plans.push({ type: "create", task, nextView });
      } else if (!sameValue(nextView, entry.view)) {
        plans.push({ type: "patch", task, nextView, entry });
      }
    }

    // Detect external edits before writing anything (requirement 3).
    for (const plan of plans) {
      if (plan.type !== "patch") continue;
      const fileStat = await statOrNull(plan.entry.filePath);
      if (!fileStat) {
        // Folder removed externally while the board mutated the task: recreate.
        this.dropEntry(plan.entry);
        plan.type = "create";
        continue;
      }
      const fingerprint = `${fileStat.mtimeMs}:${fileStat.size}`;
      if (fingerprint === plan.entry.fingerprint) continue;

      const raw = await readFile(plan.entry.filePath, "utf8");
      const freshDoc = parseTaskFile(raw);
      const baseView = plan.entry.view;
      const { view: freshView } = mapFileTask(freshDoc, plan.entry.folder, { fallbackTimestamp: baseView.createdAt });
      const { merged, conflicts } = threeWayMergeViews(baseView, plan.nextView, freshView);
      const externalKeys = VIEW_KEYS.filter((key) => !sameValue(baseView[key], freshView[key]));
      plan.entry.doc = freshDoc;
      plan.entry.view = freshView;
      plan.entry.fingerprint = fingerprint;

      if (conflicts.length > 0) {
        await this.rejectStaleWrite(data, plan, conflicts);
      }

      plan.nextView = merged;
      applyViewToTask(plan.task, merged);
      plan.task.activity.unshift({
        id: eventId(),
        actor: "tasksdir",
        type: "external.reconciled",
        message: `Reconciled an external task.md edit with the board update (external keys kept: ${externalKeys.join(", ") || "none"}).`,
        createdAt: nowIso()
      });
      if (sameValue(plan.nextView, plan.entry.view)) plan.type = "noop";
    }

    for (const plan of plans) {
      if (plan.type === "create") await this.createTaskFile(plan);
      else if (plan.type === "patch") await this.patchTaskFile(plan);
    }

    await this.ops.write(buildOpsData(data));
  }

  // Same-key conflict with an external edit: keep the file's version, record
  // the rejection on the task, persist ops state, and surface the existing
  // stale-write shape (409) to the caller.
  async rejectStaleWrite(data, plan, conflicts) {
    applyViewToTask(plan.task, plan.entry.view);
    plan.task.activity.unshift({
      id: eventId(),
      actor: "tasksdir",
      type: "update.rejected",
      message: `Rejected stale write: task.md changed externally since the last read (conflicting keys: ${conflicts.join(", ")}).`,
      createdAt: nowIso()
    });
    await this.ops.write(buildOpsData(data));
    throw Object.assign(
      new Error(`Task ${plan.task.id} was modified externally in the tasks directory. Reload and retry.`),
      { status: 409, reason: "stale_task_file", taskId: plan.task.id, conflicts }
    );
  }

  async createTaskFile(plan) {
    const folder = safeFolderName(plan.task.id);
    const dirPath = path.join(this.tasksDir, folder);
    const filePath = path.join(dirPath, "task.md");
    await mkdir(dirPath, { recursive: true });
    const doc = newTaskDoc(plan.nextView, plan.task.id);
    await atomicWrite(filePath, serializeTaskFile(doc));
    await this.cacheEntry(folder, filePath, doc, plan.nextView, plan.task.id);
  }

  async patchTaskFile(plan) {
    const { entry } = plan;
    applyViewToDoc(entry.doc, entry.view, plan.nextView);
    await atomicWrite(entry.filePath, serializeTaskFile(entry.doc));
    await this.cacheEntry(entry.folder, entry.filePath, entry.doc, plan.nextView, entry.id);
  }

  async cacheEntry(folder, filePath, doc, view, id) {
    const fileStat = await stat(filePath);
    const entry = { folder, filePath, fingerprint: `${fileStat.mtimeMs}:${fileStat.size}`, doc, view, id };
    this.entries.set(folder, entry);
    this.byId.set(id, entry);
  }

  dropEntry(entry) {
    this.entries.delete(entry.folder);
    if (this.byId.get(entry.id) === entry) this.byId.delete(entry.id);
  }

  async scanTaskFiles() {
    let dirents;
    try {
      dirents = await readdir(this.tasksDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        throw storageError(`WORKBOARD_TASKS_DIR does not exist: ${this.tasksDir}`);
      }
      throw error;
    }

    const seenFolders = new Set();
    this.byId = new Map();
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
      const folder = dirent.name;
      const filePath = path.join(this.tasksDir, folder, "task.md");
      const fileStat = await statOrNull(filePath);
      if (!fileStat) continue;
      seenFolders.add(folder);

      const fingerprint = `${fileStat.mtimeMs}:${fileStat.size}`;
      let entry = this.entries.get(folder);
      if (!entry || entry.fingerprint !== fingerprint) {
        const raw = await readFile(filePath, "utf8");
        const doc = parseTaskFile(raw);
        const { id, view } = mapFileTask(doc, folder, {
          fallbackTimestamp: entry?.view.createdAt || nowIso()
        });
        entry = { folder, filePath, fingerprint, doc, view, id };
        this.entries.set(folder, entry);
      }
      if (this.byId.has(entry.id)) {
        console.warn(`[tasksdir] Duplicate task id ${entry.id} in ${folder}; keeping ${this.byId.get(entry.id).folder}.`);
        continue;
      }
      this.byId.set(entry.id, entry);
    }

    for (const folder of [...this.entries.keys()]) {
      if (!seenFolders.has(folder)) this.entries.delete(folder);
    }
  }
}

function buildOpsData(data) {
  const sidecars = {};
  for (const task of Array.isArray(data.tasks) ? data.tasks : []) {
    sidecars[task.id] = {
      projectId: task.projectId,
      comments: task.comments || [],
      attachments: task.attachments || [],
      activity: task.activity || [],
      approvalHistory: task.approvalHistory || []
    };
  }
  const { tasks, tasksdirSidecars, ...rest } = data;
  return { ...rest, tasks: [], tasksdirSidecars: sidecars };
}

function resolveFallbackProjectId(opsData) {
  const projects = Array.isArray(opsData.projects) ? opsData.projects : [];
  const defaultKey = asText(process.env.WORKBOARD_DEFAULT_PROJECT_KEY).toUpperCase().replace(/[^A-Z0-9]+/g, "-");
  const byKey = defaultKey ? projects.find((project) => project.key === defaultKey) : null;
  const active = projects.find((project) => !project.archived);
  return byKey?.id || active?.id || projects[0]?.id || "";
}

function cloneArray(value) {
  return Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : [];
}

function safeFolderName(id) {
  const cleaned = String(id).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return cleaned || `task-${randomUUID().slice(0, 8)}`;
}

async function atomicWrite(filePath, content) {
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmpPath, content);
  await rename(tmpPath, filePath);
}

async function statOrNull(filePath) {
  try {
    return await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
