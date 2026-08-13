// tasksdir storage mode: work items live as task folders (task.md with YAML-ish
// frontmatter + markdown body) in a git-tracked tasks/ directory, while all ops
// state (agent slots, presence, talks, capabilities, projects, and per-task
// sidecar data that has no frontmatter home) stays in the wrapped ops snapshot
// store under WORKBOARD_DATA_DIR. The adapter is storage only — workflow rules
// stay in workboardStore.js. It never runs git commands and never bulk-rewrites:
// a write touches only task folders whose mapped file content actually changed.

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getBoardValue,
  getValue,
  parseTaskFile,
  validateTaskFileStructure,
  renderList,
  serializeTaskFile,
  setBoardValue,
  setValue
} from "./frontmatterTaskFile.js";
import { normalizeVerificationTarget, verificationTargetRequiredError } from "./verificationTarget.js";
import { normalizeTaskTouches } from "../../shared/taskTouches.js";

const BOARD_STATUSES = new Set(["backlog", "ready", "in_progress", "review", "testing", "blocked", "done"]);
const BOARD_TYPES = new Set(["epic", "story", "task", "subtask", "bug", "spike", "chore"]);
const BOARD_PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const DEFAULT_ROLE = "implementer";
const LEGACY_TYPE_MAPPINGS = new Map([
  ["feature", { target: "task", labels: [] }],
  ["docs", { target: "chore", labels: ["docs"] }],
  ["idea", { target: "spike", labels: ["idea"] }],
  ["improvement", { target: "task", labels: ["improvement"] }],
  ["infrastructure", { target: "task", labels: ["infrastructure"] }],
  ["investigation", { target: "task", labels: ["investigation"] }],
  ["security", { target: "task", labels: ["security"] }],
  ["test", { target: "task", labels: ["test"] }],
  ["verification", { target: "task", labels: ["verification"] }],
  ["decision", { target: "spike", labels: [] }]
]);
const LEGACY_STATUS_MAPPINGS = new Map([
  ["todo", { target: "ready" }],
  ["wont_do", { target: "done", completionType: "no-code" }],
  ["not_relevant", { target: "done", completionType: "superseded" }],
  ["cancelled", { target: "done", completionType: "superseded" }],
  ["in-review", { target: "review" }]
]);
const LEGACY_PRIORITY_MAPPINGS = new Map([
  ["critical", "urgent"],
  ["p1", "urgent"],
  ["medium", "normal"],
  ["-", null],
  ["unset", null]
]);

// Fixed key set of the file-mapped projection used for diffing and merging.
const VIEW_KEYS = [
  "title",
  "status",
  "assignee",
  "workItemType",
  "priority",
  "labels",
  "touches",
  "description",
  "role",
  "revision",
  "createdAt",
  "updatedAt",
  "completion",
  "verificationTarget",
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

function parseVerificationTarget(value) {
  try {
    return normalizeVerificationTarget(value);
  } catch {
    return null;
  }
}

function invalidExternalVerificationTarget(taskId, filePath) {
  const error = verificationTargetRequiredError();
  return Object.assign(error, {
    status: 409,
    reason: "verification_target_required",
    taskId,
    filePath
  });
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
  let typeKnown = !rawType;
  if (BOARD_TYPES.has(rawType)) {
    workItemType = rawType;
    typeKnown = true;
  } else if (LEGACY_TYPE_MAPPINGS.has(rawType)) {
    const mappedType = LEGACY_TYPE_MAPPINGS.get(rawType);
    workItemType = mappedType.target;
    extraLabels.push(...mappedType.labels);
    typeKnown = true;
  }

  let status = "backlog";
  let legacyClosed = "";
  let statusKnown = false;
  if (BOARD_STATUSES.has(rawStatus)) {
    status = rawStatus;
    statusKnown = true;
  } else if (LEGACY_STATUS_MAPPINGS.has(rawStatus)) {
    const mappedStatus = LEGACY_STATUS_MAPPINGS.get(rawStatus);
    status = mappedStatus.target;
    legacyClosed = mappedStatus.completionType ? rawStatus : "";
    statusKnown = true;
  }
  // Ideas need operator approval before they are claimable: legacy `todo`
  // lands in backlog instead of ready. Board-written `ready` is authoritative,
  // so an operator promotion sticks across restarts.
  if (rawType === "idea" && rawStatus === "todo") {
    status = "backlog";
  }

  const owner = asText(getValue(doc, "owner"));
  const assignee = !owner || owner === "unassigned" ? "" : owner;

  const rawPriority = asText(getValue(doc, "priority")).toLowerCase();
  const priority = BOARD_PRIORITIES.has(rawPriority)
    ? rawPriority
    : LEGACY_PRIORITY_MAPPINGS.has(rawPriority)
      ? LEGACY_PRIORITY_MAPPINGS.get(rawPriority)
      : null;
  const priorityKnown = !rawPriority || BOARD_PRIORITIES.has(rawPriority) || LEGACY_PRIORITY_MAPPINGS.has(rawPriority);

  const unmappedValues = [
    ...(!statusKnown ? [{ kind: "status", value: rawStatus || "(missing)", target: status }] : []),
    ...(!typeKnown ? [{ kind: "type", value: rawType || "(missing)", target: workItemType }] : []),
    ...(!priorityKnown ? [{ kind: "priority", value: rawPriority || "(missing)", target: priority }] : [])
  ];
  if (unmappedValues.length > 0) extraLabels.push("unmapped-value");

  const labels = [...new Set([...readLabels(getValue(doc, "labels")), ...extraLabels])];
  const touches = normalizeTaskTouches(readLabels(getBoardValue(doc, "touches")));

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
    } else if (["not_relevant", "cancelled"].includes(legacyClosed)) {
      completion = {
        completionType: "superseded",
        completedBy: "tasksdir",
        completedAt: updatedAt,
        notes: `Closed as ${legacyClosed} in the tasks directory.`
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

  const boardVerificationTarget = getBoardValue(doc, "verificationTarget");
  const verificationTarget = status === "testing" ? parseVerificationTarget(boardVerificationTarget) : null;

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
    touches,
    description: String(doc.body ?? "").trim(),
    role: boardRole || DEFAULT_ROLE,
    revision,
    createdAt,
    updatedAt,
    completion,
    verificationTarget,
    blocker,
    dependsOn,
    blockedBy,
    parentTaskId: asText(getBoardValue(doc, "parentTaskId"))
  };
  return {
    id,
    view,
    mapping: {
      status: {
        source: rawStatus || null,
        target: view.status,
        completionType: asText(view.completion?.completionType) || null,
        known: statusKnown
      },
      type: {
        source: rawType || null,
        target: view.workItemType,
        known: typeKnown
      },
      priority: {
        source: rawPriority || null,
        target: view.priority,
        known: priorityKnown
      }
    },
    unmappedValues
  };
}

// Read-only description of the exact legacy mapping applied by mapFileTask.
// Import tooling uses this instead of maintaining a second, drift-prone copy
// of the accepted values and special cases.
export function previewFileTaskMapping(doc, folderName, options = {}) {
  return mapFileTask(doc, folderName, options);
}

export function fileViewFromBoardTask(task) {
  return {
    title: asText(task.title),
    status: asText(task.status) || "backlog",
    assignee: asText(task.assignee),
    workItemType: asText(task.workItemType) || "task",
    priority: BOARD_PRIORITIES.has(task.priority) ? task.priority : null,
    labels: Array.isArray(task.labels) ? task.labels.map((item) => asText(item)).filter(Boolean) : [],
    touches: normalizeTaskTouches(task.touches),
    description: asText(task.description),
    role: asText(task.role) || DEFAULT_ROLE,
    revision: Number.isInteger(task.revision) && task.revision >= 1 ? task.revision : 1,
    createdAt: asText(task.createdAt),
    updatedAt: asText(task.updatedAt),
    completion: task.completion && typeof task.completion === "object" ? JSON.parse(JSON.stringify(task.completion)) : null,
    verificationTarget:
      task.verificationTarget && typeof task.verificationTarget === "object"
        ? JSON.parse(JSON.stringify(task.verificationTarget))
        : null,
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
    touches: [...view.touches],
    dependsOn: [...view.dependsOn],
    blockedBy: [...view.blockedBy],
    parentTaskId: view.parentTaskId,
    blocks: [],
    childTaskIds: [],
    dependencyStatus: emptyDependencyStatus(),
    completion: view.completion ? { ...view.completion } : null,
    verificationTarget: view.verificationTarget ? { ...view.verificationTarget } : null,
    blocker: view.blocker ? { ...view.blocker } : null,
    approvalHistory: [],
    reviewedBy: "",
    testedBy: "",
    reviewVerdict: null,
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
  task.touches = [...view.touches];
  task.description = view.description;
  task.role = view.role;
  task.revision = view.revision;
  task.createdAt = view.createdAt;
  task.updatedAt = view.updatedAt;
  task.completion = view.completion ? { ...view.completion } : null;
  task.verificationTarget = view.verificationTarget ? { ...view.verificationTarget } : null;
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
  if (!sameValue(baseView.touches, nextView.touches)) {
    setBoardValue(doc, "touches", nextView.touches.length ? JSON.stringify(nextView.touches) : "");
  }
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
  if (!sameValue(baseView.verificationTarget, nextView.verificationTarget)) {
    setBoardValue(doc, "verificationTarget", nextView.verificationTarget ? JSON.stringify(nextView.verificationTarget) : "");
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
  constructor({ tasksDir, ops, defaultProjectKey = "", deferInitialGate = false }) {
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
    this.defaultProjectKey = asText(defaultProjectKey);
    this.entries = new Map(); // folder -> { folder, filePath, fingerprint, doc, view, id }
    this.byId = new Map(); // task id -> entry
    this.sidecarCache = new Map(); // task id -> last persisted sidecar (rollback base for stale rejects)
    this.initialCompositionPending = Boolean(deferInitialGate);
    this.needsMigrationSave = false;
  }

  async read() {
    const opsData = await this.ops.read();
    await this.scanTaskFiles();
    if (!opsData) {
      this.initialCompositionPending = this.byId.size > 0;
      this.needsMigrationSave = false;
      return null;
    }

    if (Array.isArray(opsData.tasks) && opsData.tasks.length > 0 && !process.env.WORKBOARD_TASKSDIR_IGNORE_SNAPSHOT_TASKS) {
      throw storageError(
        `Refusing to run tasksdir mode over ${this.path}: the ops store already contains ${opsData.tasks.length} stored work item(s) from a previous json/sqlite board, and the first tasksdir write would silently discard them. Point WORKBOARD_DATA_DIR at a fresh directory (or export/migrate the stored tasks first), or set WORKBOARD_TASKSDIR_IGNORE_SNAPSHOT_TASKS=1 to knowingly discard them.`
      );
    }

    const sidecars =
      opsData.tasksdirSidecars && typeof opsData.tasksdirSidecars === "object" && !Array.isArray(opsData.tasksdirSidecars)
        ? opsData.tasksdirSidecars
        : {};
    const verificationTargetMigration = opsData.tasksdirVerificationTargetGateVersion !== 1;
    this.needsMigrationSave = verificationTargetMigration;
    this.initialCompositionPending = verificationTargetMigration && this.byId.size > 0;
    const fallbackProjectId = this.resolveFallbackProjectId(opsData);
    const tasks = [];
    this.sidecarCache = new Map();
    for (const entry of this.byId.values()) {
      if (!verificationTargetMigration && entry.view.status === "testing" && !entry.view.verificationTarget) {
        throw invalidExternalVerificationTarget(entry.id, entry.filePath);
      }
      const sidecar = sidecars[entry.id] || {};
      const task = boardTaskFromView(entry.id, entry.view, asText(sidecar.projectId) || fallbackProjectId);
      task.comments = cloneArray(sidecar.comments);
      task.attachments = cloneArray(sidecar.attachments);
      task.activity = cloneArray(sidecar.activity);
      task.approvalHistory = cloneArray(sidecar.approvalHistory);
      task.reviewedBy = asText(sidecar.reviewedBy);
      task.testedBy = asText(sidecar.testedBy);
      task.reviewVerdict = sidecar.reviewVerdict && typeof sidecar.reviewVerdict === "object" ? clone(sidecar.reviewVerdict) : null;
      task.pullRequestUrl = asText(sidecar.pullRequestUrl);
      task.branch = asText(sidecar.branch);
      task.externalSource = sidecar.externalSource && typeof sidecar.externalSource === "object" ? clone(sidecar.externalSource) : null;
      tasks.push(task);
      this.sidecarCache.set(entry.id, clone(sidecarOfTask(task)));
    }

    const { tasksdirSidecars, ...rest } = opsData;
    return { ...rest, tasks, tasksdirDiagnostics: { unmappedValues: this.collectUnmappedValues() } };
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

    // Detect all external edits before writing anything (requirement 3), so a
    // conflict on one task never leaves another task's file write behind.
    const conflicted = [];
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
      const freshDoc = parseValidatedTaskFile(raw, plan.entry.filePath);
      const baseView = plan.entry.view;
      const { view: freshView } = mapFileTask(freshDoc, plan.entry.folder, { fallbackTimestamp: baseView.createdAt });
      if (freshView.status === "testing" && !freshView.verificationTarget) {
        applyViewToTask(plan.task, baseView);
        this.restoreSidecar(plan.task);
        plan.task.activity.unshift({
          id: eventId(),
          actor: "tasksdir",
          type: "update.rejected",
          message: "Rejected external testing transition without a verification target.",
          createdAt: nowIso()
        });
        plan.type = "conflict";
        conflicted.push({
          taskId: plan.task.id,
          conflicts: ["verificationTarget"],
          reason: "verification_target_required",
          message: `Task ${plan.task.id} entered testing externally without a verification target.`
        });
        continue;
      }
      const { merged, conflicts } = threeWayMergeViews(baseView, plan.nextView, freshView);
      const externalKeys = VIEW_KEYS.filter((key) => !sameValue(baseView[key], freshView[key]));
      plan.entry.doc = freshDoc;
      plan.entry.view = freshView;
      plan.entry.fingerprint = fingerprint;

      if (conflicts.length > 0) {
        // Keep the file's version: roll the in-memory task back to the file
        // state and the last persisted sidecar, so the failed mutation's own
        // events do not linger next to the rejection record.
        applyViewToTask(plan.task, freshView);
        this.restoreSidecar(plan.task);
        plan.task.activity.unshift({
          id: eventId(),
          actor: "tasksdir",
          type: "update.rejected",
          message: `Rejected stale write: task.md changed externally since the last read (conflicting keys: ${conflicts.join(", ")}).`,
          createdAt: nowIso()
        });
        plan.type = "conflict";
        conflicted.push({ taskId: plan.task.id, conflicts });
        continue;
      }

      plan.nextView = merged;
      applyViewToTask(plan.task, merged);
      if (externalKeys.length > 0) {
        plan.task.activity.unshift({
          id: eventId(),
          actor: "tasksdir",
          type: "external.reconciled",
          message: `Reconciled an external task.md edit with the board update (external keys kept: ${externalKeys.join(", ")}).`,
          createdAt: nowIso()
        });
      }
      if (sameValue(plan.nextView, plan.entry.view)) plan.type = "noop";
    }

    for (const plan of plans) {
      if (plan.type === "create") await this.createTaskFile(plan);
      else if (plan.type === "patch") await this.patchTaskFile(plan);
    }

    const establishVerificationTargetGate = !(this.initialCompositionPending && tasks.length === 0);
    const opsData = buildOpsData(data, { establishVerificationTargetGate });
    await this.ops.write(opsData);
    if (establishVerificationTargetGate) {
      this.initialCompositionPending = false;
      this.needsMigrationSave = false;
    }
    this.sidecarCache = new Map(Object.entries(opsData.tasksdirSidecars).map(([id, sidecar]) => [id, clone(sidecar)]));

    if (conflicted.length > 0) {
      const first = conflicted[0];
      throw Object.assign(
        new Error(first.message || `Task ${first.taskId} was modified externally in the tasks directory. Reload and retry.`),
        {
          status: 409,
          reason: first.reason || "stale_task_file",
          taskId: first.taskId,
          conflicts: first.conflicts,
          conflictedTaskIds: conflicted.map((item) => item.taskId)
        }
      );
    }

    return { tasksdirDiagnostics: { unmappedValues: this.collectUnmappedValues() } };
  }

  restoreSidecar(task) {
    const cached = this.sidecarCache.get(task.id);
    task.comments = cloneArray(cached?.comments);
    task.attachments = cloneArray(cached?.attachments);
    task.activity = cloneArray(cached?.activity);
    task.approvalHistory = cloneArray(cached?.approvalHistory);
    task.reviewedBy = asText(cached?.reviewedBy);
    task.testedBy = asText(cached?.testedBy);
    task.reviewVerdict = cached?.reviewVerdict && typeof cached.reviewVerdict === "object" ? clone(cached.reviewVerdict) : null;
    task.pullRequestUrl = asText(cached?.pullRequestUrl);
    task.branch = asText(cached?.branch);
    task.externalSource = cached?.externalSource && typeof cached.externalSource === "object" ? clone(cached.externalSource) : null;
  }

  async createTaskFile(plan) {
    const folder = safeFolderName(plan.task.id);
    const dirPath = path.join(this.tasksDir, folder);
    const filePath = path.join(dirPath, "task.md");
    await mkdir(dirPath, { recursive: true });
    const doc = newTaskDoc(plan.nextView, plan.task.id);
    await atomicWrite(filePath, serializeTaskFile(doc));
    const entry = await this.cacheEntry(folder, filePath, doc, plan.nextView, plan.task.id);
    applyViewToTask(plan.task, entry.view);
  }

  async patchTaskFile(plan) {
    const { entry } = plan;
    applyViewToDoc(entry.doc, entry.view, plan.nextView);
    await atomicWrite(entry.filePath, serializeTaskFile(entry.doc));
    const cached = await this.cacheEntry(entry.folder, entry.filePath, entry.doc, plan.nextView, entry.id);
    applyViewToTask(plan.task, cached.view);
  }

  resolveFallbackProjectId(opsData) {
    const projects = Array.isArray(opsData.projects) ? opsData.projects : [];
    const byKey = this.defaultProjectKey ? projects.find((project) => project.key === this.defaultProjectKey) : null;
    const active = projects.find((project) => !project.archived);
    return byKey?.id || active?.id || projects[0]?.id || "";
  }

  async cacheEntry(folder, filePath, doc, view, id) {
    const fileStat = await stat(filePath);
    const { view: mappedView, mapping } = mapFileTask(doc, folder, { fallbackTimestamp: view.createdAt });
    const entry = { folder, filePath, fingerprint: `${fileStat.mtimeMs}:${fileStat.size}`, doc, view: mappedView, mapping, id };
    this.entries.set(folder, entry);
    this.byId.set(id, entry);
    return entry;
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
        const doc = parseValidatedTaskFile(raw, filePath);
        let mapped;
        try {
          mapped = mapFileTask(doc, folder, {
            fallbackTimestamp: entry?.view.createdAt || nowIso()
          });
        } catch (error) {
          throw storageError(`Invalid task file ${filePath}: ${error.message}`, {
            code: "INVALID_TASK_FILE",
            filePath
          });
        }
        const { id, view, mapping } = mapped;
        entry = { folder, filePath, fingerprint, doc, view, mapping, id };
        this.entries.set(folder, entry);
      }
      const existing = this.byId.get(entry.id);
      if (existing) {
        // Duplicate frontmatter id (e.g. a copied folder with a stale id:).
        // The folder whose name equals the id is canonical — board-created
        // folders guarantee folder == id — so writes never land in the copy.
        if (entry.folder === entry.id && existing.folder !== existing.id) {
          console.warn(`[tasksdir] Duplicate task id ${entry.id}: using ${entry.folder}, ignoring ${existing.folder}.`);
          this.byId.set(entry.id, entry);
        } else {
          console.warn(`[tasksdir] Duplicate task id ${entry.id} in ${folder}; keeping ${existing.folder}.`);
        }
        continue;
      }
      this.byId.set(entry.id, entry);
    }

    for (const folder of [...this.entries.keys()]) {
      if (!seenFolders.has(folder)) this.entries.delete(folder);
    }
  }

  collectUnmappedValues() {
    const grouped = new Map();
    for (const entry of this.byId.values()) {
      for (const [kind, item] of Object.entries(entry.mapping || {}).filter(([, candidate]) => !candidate.known)) {
        const value = item.source || "(missing)";
        const target = item.target || "none";
        const key = `${kind}\0${value}\0${target}`;
        const warning = grouped.get(key) || { code: "UNMAPPED_TASK_VALUE", kind, value, target, count: 0, files: [] };
        warning.count += 1;
        warning.files.push(`${entry.folder}/task.md`);
        grouped.set(key, warning);
      }
    }
    return [...grouped.values()].sort((a, b) => `${a.kind}\0${a.value}`.localeCompare(`${b.kind}\0${b.value}`));
  }
}

function buildOpsData(data, { establishVerificationTargetGate = true } = {}) {
  const sidecars = {};
  for (const task of Array.isArray(data.tasks) ? data.tasks : []) {
    sidecars[task.id] = sidecarOfTask(task);
  }
  const { tasks, tasksdirSidecars, ...rest } = data;
  const result = { ...rest, tasks: [], tasksdirSidecars: sidecars };
  if (establishVerificationTargetGate) result.tasksdirVerificationTargetGateVersion = 1;
  else delete result.tasksdirVerificationTargetGateVersion;
  return result;
}

function sidecarOfTask(task) {
  return {
    projectId: task.projectId,
    comments: task.comments || [],
    attachments: task.attachments || [],
    activity: task.activity || [],
    approvalHistory: task.approvalHistory || [],
    reviewedBy: asText(task.reviewedBy),
    testedBy: asText(task.testedBy),
    reviewVerdict: task.reviewVerdict && typeof task.reviewVerdict === "object" ? clone(task.reviewVerdict) : null,
    pullRequestUrl: asText(task.pullRequestUrl),
    branch: asText(task.branch),
    externalSource: task.externalSource && typeof task.externalSource === "object" ? clone(task.externalSource) : null
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneArray(value) {
  return Array.isArray(value) ? clone(value) : [];
}

function safeFolderName(id) {
  const cleaned = String(id).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "");
  return cleaned || `task-${randomUUID().slice(0, 8)}`;
}

// Atomic write plus tmp hygiene: sweep crash litter from earlier attempts in
// this folder, and never leave our own tmp behind on failure.
async function atomicWrite(filePath, content) {
  await removeStaleTmpFiles(filePath);
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, content);
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true });
    throw error;
  }
}

async function removeStaleTmpFiles(filePath) {
  const dirPath = path.dirname(filePath);
  const base = path.basename(filePath);
  let names;
  try {
    names = await readdir(dirPath);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(`${base}.`) && name.endsWith(".tmp")) {
      await rm(path.join(dirPath, name), { force: true });
    }
  }
}

async function statOrNull(filePath) {
  try {
    return await stat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function parseValidatedTaskFile(raw, filePath) {
  const [failure] = validateTaskFileStructure(raw);
  if (failure) {
    throw storageError(`Invalid task file ${filePath}:${failure.line}: ${failure.reason}`, {
      code: "INVALID_TASK_FILE",
      filePath,
      line: failure.line
    });
  }
  return parseTaskFile(raw);
}
