import path from "node:path";
import { realpath } from "node:fs/promises";

export function normalizeProjectDataSource(value, { migrating = false } = {}) {
  if (value === undefined || value === null || value === "") return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (migrating) return null;
    throw validationError("Project dataSource must be an object.", { field: "dataSource" });
  }

  const tasksDir = text(value.tasksDir);
  if (!tasksDir) {
    if (migrating) return null;
    throw validationError("Project dataSource.tasksDir is required.", { field: "dataSource.tasksDir" });
  }

  const repoDir = text(value.repoDir);
  const normalized = {
    tasksDir: path.resolve(tasksDir),
    ...(repoDir ? { repoDir: path.resolve(repoDir) } : {})
  };
  if (migrating && value.health && typeof value.health === "object" && !Array.isArray(value.health)) {
    normalized.health = {
      status: value.health.status === "error" ? "error" : "ready",
      message: text(value.health.message),
      code: text(value.health.code),
      checkedAt: text(value.health.checkedAt)
    };
  }
  return normalized;
}

export async function canonicalizeProjectDataSource(value, options = {}) {
  const normalized = normalizeProjectDataSource(value, options);
  if (!normalized) return null;
  return {
    ...normalized,
    tasksDir: await canonicalPath(normalized.tasksDir),
    ...(normalized.repoDir ? { repoDir: await canonicalPath(normalized.repoDir) } : {})
  };
}

export async function canonicalPath(value) {
  const resolved = path.resolve(String(value || ""));
  try {
    return await realpath(resolved);
  } catch (error) {
    if (error.code === "ENOENT") return resolved;
    throw error;
  }
}

export function pathIdentity(value) {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function assertProjectDataSourceAvailable(project) {
  if (project?.dataSource?.health?.status !== "error") return;
  throw Object.assign(
    new Error(`Project tasks directory is unavailable: ${project.dataSource.health.message || project.dataSource.tasksDir}`),
    {
      status: 503,
      reason: "project_tasksdir_unavailable",
      projectId: project.id,
      tasksDir: project.dataSource.tasksDir
    }
  );
}

function validationError(message, details) {
  return Object.assign(new Error(message), { status: 400, details });
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
