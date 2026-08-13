import { normalizeProjectDataSource } from "./projectDataSource.js";

export const PROJECT_BACKUP_PACKAGE_TYPE = "agent-workboard.project-backup";
export const PROJECT_BACKUP_PACKAGE_VERSION = 1;

const MAX_TASK_LABELS = 12;

export function buildProjectBackup({ project, tasks, events, exportedAt }) {
  return {
    packageType: PROJECT_BACKUP_PACKAGE_TYPE,
    packageVersion: PROJECT_BACKUP_PACKAGE_VERSION,
    exportedAt,
    project: cloneJson(project),
    tasks: cloneJson(tasks),
    events: cloneJson(events)
  };
}

export function normalizeProjectBackup(input, { statusIds, priorityIds, roleIds, workItemTypeIds, completionTypeIds, now, id }) {
  const source = normalizeObject(input);
  if (source.packageType !== PROJECT_BACKUP_PACKAGE_TYPE) {
    throw httpError(`Project backup packageType must be ${PROJECT_BACKUP_PACKAGE_TYPE}.`, 400, {
      field: "packageType",
      expected: PROJECT_BACKUP_PACKAGE_TYPE
    });
  }
  if (source.packageVersion !== PROJECT_BACKUP_PACKAGE_VERSION) {
    throw httpError(`Project backup packageVersion must be ${PROJECT_BACKUP_PACKAGE_VERSION}.`, 400, {
      field: "packageVersion",
      expected: PROJECT_BACKUP_PACKAGE_VERSION
    });
  }

  const helpers = { statusIds, priorityIds, roleIds, workItemTypeIds, completionTypeIds, now, id };
  const project = normalizeBackupProject(source.project, helpers);
  if (!Array.isArray(source.tasks)) {
    throw httpError("Project backup tasks must be an array.", 400, { field: "tasks" });
  }
  const tasks = source.tasks.map((task, index) => normalizeBackupTask(task, project.id, index, helpers));
  const events = Array.isArray(source.events)
    ? source.events.map((event, index) => normalizeBackupEvent(event, project.id, index, helpers))
    : [];

  return { project, tasks, events };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeBackupProject(value, { now }) {
  const source = normalizeObject(value);
  const projectId = normalizeText(source.id);
  if (!projectId) {
    throw httpError("Project backup project.id is required.", 400, { field: "project.id" });
  }

  const name = normalizeText(source.name);
  if (!name) {
    throw httpError("Project backup project.name is required.", 400, { field: "project.name" });
  }

  const createdAt = normalizeText(source.createdAt) || now();
  const dataSource = normalizeProjectDataSource(source.dataSource);
  return {
    id: projectId,
    key: slugify(source.key || name),
    name,
    description: normalizeText(source.description),
    ...(dataSource ? { dataSource } : {}),
    createdAt,
    updatedAt: normalizeText(source.updatedAt) || createdAt,
    archived: source.archived === true
  };
}

function normalizeBackupTask(value, projectId, index, helpers) {
  const source = normalizeObject(value);
  const taskId = normalizeText(source.id);
  if (!taskId) {
    throw httpError("Project backup task.id is required.", 400, { field: "tasks.id", index });
  }
  const taskProjectId = normalizeText(source.projectId);
  if (!taskProjectId) {
    throw httpError("Project backup task.projectId is required.", 400, { field: "tasks.projectId", index, taskId });
  }
  if (taskProjectId !== projectId) {
    throw httpError("Project backup task.projectId must match project.id.", 400, {
      reason: "task_project_mismatch",
      field: "tasks.projectId",
      index,
      taskId,
      projectId,
      taskProjectId
    });
  }

  const status = readEnumField(source, "status", helpers.statusIds, "backlog", "Task");
  const completionInput = Object.prototype.hasOwnProperty.call(source, "completion")
    ? source.completion
    : source.completionRecord;
  const hasCompletion = completionInput !== undefined && completionInput !== null;
  if (status === "done" && !hasCompletion) {
    throw httpError("Done tasks in a project backup require a completion record.", 400, { field: "tasks.completion", index, taskId });
  }
  if (status !== "done" && hasCompletion) {
    throw httpError("Completion records can only be imported on done tasks.", 400, { field: "tasks.completion", index, taskId });
  }

  const createdAt = normalizeText(source.createdAt) || helpers.now();
  return {
    id: taskId,
    projectId: taskProjectId,
    title: normalizeTaskTitle(source.title),
    description: normalizeText(source.description),
    pullRequestUrl: normalizeHttpUrl(source.pullRequestUrl, { field: "tasks.pullRequestUrl", index, taskId }),
    branch: normalizeText(source.branch),
    status,
    priority: readEnumField(source, "priority", helpers.priorityIds, "normal", "Task"),
    role: readEnumField(source, "role", helpers.roleIds, "implementer", "Task"),
    workItemType: readEnumField(source, "workItemType", helpers.workItemTypeIds, "task", "Task"),
    dependsOn: normalizeTaskIdList(source.dependsOn),
    blockedBy: normalizeTaskIdList(source.blockedBy),
    parentTaskId: normalizeText(source.parentTaskId),
    blocks: normalizeTaskIdList(source.blocks),
    childTaskIds: normalizeTaskIdList(source.childTaskIds),
    dependencyStatus: normalizeDependencyStatus(source.dependencyStatus),
    assignee: normalizeText(source.assignee),
    reviewedBy: normalizeText(source.reviewedBy),
    testedBy: normalizeText(source.testedBy),
    reviewVerdict: normalizeReviewVerdict(source.reviewVerdict),
    labels: normalizeTaskLabels(source.labels),
    completion: status === "done" ? normalizeCompletionRecord(completionInput, helpers) : null,
    createdAt,
    updatedAt: normalizeText(source.updatedAt) || createdAt,
    revision: isValidTaskRevision(source.revision) ? source.revision : 1,
    comments: normalizeBackupComments(source.comments, { index, taskId }, helpers),
    attachments: normalizeBackupAttachments(source.attachments, { index, taskId }, helpers),
    activity: normalizeBackupActivity(source.activity, { index, taskId }, helpers)
  };
}

function normalizeReviewVerdict(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const decision = normalizeText(value.decision);
  if (!["approve", "request_changes"].includes(decision)) return null;
  const findingsCount = Number(value.findingsCount ?? 0);
  return {
    decision,
    findingsCount: Number.isInteger(findingsCount) && findingsCount >= 0 ? findingsCount : 0,
    reviewer: normalizeText(value.reviewer),
    commitSha: normalizeText(value.commitSha),
    createdAt: normalizeText(value.createdAt)
  };
}

function normalizeTaskIdList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeText(item)).filter(Boolean))].sort();
}

function normalizeDependencyStatus(value) {
  const source = normalizeObject(value);
  const state = ["clear", "waiting", "blocked", "invalid"].includes(normalizeText(source.state)) ? normalizeText(source.state) : "clear";
  return {
    state,
    satisfiedTaskIds: normalizeTaskIdList(source.satisfiedTaskIds),
    waitingTaskIds: normalizeTaskIdList(source.waitingTaskIds),
    blockedTaskIds: normalizeTaskIdList(source.blockedTaskIds),
    invalidTaskIds: normalizeTaskIdList(source.invalidTaskIds),
    total: Number.isInteger(source.total) && source.total >= 0 ? source.total : 0
  };
}

function normalizeBackupComments(value, { index, taskId }, { id, now }) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw httpError("Project backup task comments must be an array.", 400, { field: "tasks.comments", index, taskId });
  }
  return value.map((entry, commentIndex) => {
    const source = normalizeObject(entry);
    const body = normalizeText(source.body);
    if (!body) {
      throw httpError("Project backup comments require body text.", 400, {
        field: "tasks.comments.body",
        index,
        commentIndex,
        taskId
      });
    }
    return {
      id: normalizeText(source.id) || id("comment"),
      author: normalizeText(source.author) || "operator",
      body,
      createdAt: normalizeText(source.createdAt) || now()
    };
  });
}

function normalizeBackupAttachments(value, { index, taskId }, { now }) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw httpError("Project backup task attachments must be an array.", 400, { field: "tasks.attachments", index, taskId });
  }
  return value.map((entry, attachmentIndex) => {
    const source = normalizeObject(entry);
    const attachmentId = normalizeText(source.id);
    const filename = safeFilename(source.filename || source.originalname);
    if (!attachmentId) {
      throw httpError("Project backup attachments require an id.", 400, {
        field: "tasks.attachments.id",
        index,
        attachmentIndex,
        taskId
      });
    }
    return {
      id: attachmentId,
      filename,
      mimeType: normalizeText(source.mimeType) || "application/octet-stream",
      size: Number.isFinite(Number(source.size)) && Number(source.size) >= 0 ? Number(source.size) : 0,
      sha256: normalizeText(source.sha256),
      storedName: safeFilename(source.storedName || `${attachmentId}-${filename}`),
      uploadedBy: normalizeText(source.uploadedBy) || "operator",
      createdAt: normalizeText(source.createdAt) || now()
    };
  });
}

function normalizeBackupActivity(value, { index, taskId }, { id, now }) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw httpError("Project backup task activity must be an array.", 400, { field: "tasks.activity", index, taskId });
  }
  return value.map((entry) => {
    const source = normalizeObject(entry);
    return {
      id: normalizeText(source.id) || id("event"),
      actor: normalizeText(source.actor) || "operator",
      type: normalizeText(source.type) || "updated",
      message: normalizeText(source.message),
      createdAt: normalizeText(source.createdAt) || now()
    };
  });
}

function normalizeBackupEvent(value, projectId, index, { id, now }) {
  const source = normalizeObject(value);
  const eventProjectId = normalizeText(source.projectId);
  if (eventProjectId && eventProjectId !== projectId) {
    throw httpError("Project backup events must belong to the exported project.", 400, {
      field: "events.projectId",
      index,
      projectId,
      eventProjectId
    });
  }
  return {
    id: normalizeText(source.id) || id("event"),
    projectId,
    actor: normalizeText(source.actor) || "operator",
    type: normalizeText(source.type) || "project.event",
    message: normalizeText(source.message),
    createdAt: normalizeText(source.createdAt) || now()
  };
}

function normalizeCompletionRecord(value, { completionTypeIds, now }) {
  const input = normalizeObject(value);
  const completionType = normalizeText(input.completionType || input.type);
  if (!completionTypeIds.has(completionType)) {
    throw httpError(`Completion type must be one of: ${[...completionTypeIds].join(", ")}.`, 400, {
      field: "completionType",
      allowed: [...completionTypeIds],
      value: completionType
    });
  }

  const record = {
    completionType,
    completedBy: normalizeText(input.completedBy) || "operator",
    completedAt: normalizeText(input.completedAt) || now()
  };

  for (const field of ["branch", "commitSha", "mergedTo", "reviewTaskId", "supersededByTaskId", "notes"]) {
    const value = normalizeText(input[field]);
    if (value) {
      record[field] = value;
    }
  }
  if (Array.isArray(input.tests)) {
    record.tests = normalizeStringList(input.tests);
  }
  if (Array.isArray(input.capabilityIds)) {
    record.capabilityIds = normalizeStringList(input.capabilityIds);
  }
  return record;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeHttpUrl(value, details) {
  const url = normalizeText(value);
  if (!url) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return url;
  } catch {
    // Fall through to the structured backup validation error.
  }
  throw httpError("Project backup task pullRequestUrl must be an http or https URL.", 400, details);
}

function normalizeObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function normalizeTaskTitle(value) {
  const title = normalizeText(value);
  if (!title) {
    throw httpError("Task title is required.", 400, { field: "title" });
  }
  return title;
}

function readEnumField(source, field, allowed, fallback, label) {
  if (!Object.prototype.hasOwnProperty.call(source, field) || source[field] === undefined) {
    return fallback;
  }

  const value = normalizeText(source[field]);
  if (!allowed.has(value)) {
    throw httpError(`${label} ${field} must be one of: ${[...allowed].join(", ")}.`, 400, {
      field,
      allowed: [...allowed],
      value
    });
  }
  return value;
}

function normalizeTaskLabels(value) {
  if (value === undefined) {
    return [];
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

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map(normalizeText).filter(Boolean))];
  }
  return normalizeText(value)
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
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
  const base = normalizeText(value).replaceAll("\\", "/").split("/").at(-1) || "attachment";
  return base.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 160) || "attachment";
}

function isValidTaskRevision(value) {
  return Number.isInteger(value) && value > 0;
}

function httpError(message, status, details) {
  return Object.assign(new Error(message), { status, details });
}
