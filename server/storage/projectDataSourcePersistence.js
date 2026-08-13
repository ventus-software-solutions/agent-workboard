import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { TasksdirWorkboardPersistence } from "./tasksdirPersistence.js";
import { canonicalizeProjectDataSource, pathIdentity } from "./projectDataSource.js";

const PROJECT_SIDECARS_KEY = "projectTasksdirSidecars";
const PROJECT_METADATA_KEY = "projectTasksdirMetadata";
const LOCK_RETRY_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const STALE_LOCK_MS = 30_000;

export class ProjectDataSourcePersistence {
  constructor({ ops, defaultProjectKey = "" }) {
    this.mode = ops.mode;
    this.projectDataSources = true;
    this.ops = ops;
    this.path = ops.path;
    this.lockPath = ops.lockPath;
    this.dataDir = ops.dataDir;
    this.defaultProjectKey = text(defaultProjectKey);
    this.adapters = new Map();
  }

  async readLegacyData() {
    return this.ops.readLegacyData?.();
  }

  async read() {
    const data = await this.ops.read();
    if (!data) return null;
    this.needsMigrationSave = false;

    const projects = cloneArray(data.projects);
    for (const project of projects) {
      if (hasTasksDirectory(project)) project.dataSource = await canonicalizeProjectDataSource(project.dataSource, { migrating: true });
    }
    const externalProjectIds = new Set(projects.filter(hasTasksDirectory).map((project) => project.id));
    const tasks = cloneArray(data.tasks).filter((task) => !externalProjectIds.has(task.projectId));
    const sidecarsByProject = objectValue(data[PROJECT_SIDECARS_KEY]);
    const metadataByProject = objectValue(data[PROJECT_METADATA_KEY]);

    for (const project of projects) {
      if (!hasTasksDirectory(project)) continue;
      const bridge = this.bridgeFor(project, data, sidecarsByProject[project.id], metadataByProject[project.id]);
      const adapter = this.adapterFor(project, bridge);
      try {
        const projectData = await adapter.read();
        if (adapter.needsMigrationSave) this.needsMigrationSave = true;
        const projectTasks = cloneArray(projectData?.tasks);
        const occupiedIds = new Set(tasks.map((task) => task.id));
        const collisions = projectTasks.map((task) => task.id).filter((taskId) => occupiedIds.has(taskId));
        if (collisions.length > 0) {
          throw Object.assign(
            new Error(`Task id collision with another project: ${[...new Set(collisions)].sort().join(", ")}`),
            { code: "CROSS_PROJECT_TASK_ID_COLLISION" }
          );
        }
        tasks.push(...projectTasks);
        project.dataSource = withHealth(project.dataSource, {
          status: "ready",
          message: "",
          warnings: cloneArray(projectData?.tasksdirDiagnostics?.unmappedValues),
          checkedAt: new Date().toISOString()
        });
      } catch (error) {
        project.dataSource = withHealth(project.dataSource, {
          status: "error",
          message: error?.message || "Unable to read the project tasks directory.",
          code: text(error?.code || error?.reason),
          checkedAt: new Date().toISOString()
        });
      }
    }

    return {
      ...data,
      projects,
      tasks,
      [PROJECT_SIDECARS_KEY]: clone(sidecarsByProject),
      [PROJECT_METADATA_KEY]: clone(metadataByProject)
    };
  }

  async write(data) {
    const projects = cloneArray(data.projects);
    const externalProjects = projects.filter(hasTasksDirectory);
    const externalProjectIds = new Set(externalProjects.map((project) => project.id));
    const previousSidecars = objectValue(data[PROJECT_SIDECARS_KEY]);
    const previousMetadata = objectValue(data[PROJECT_METADATA_KEY]);
    const nextSidecars = {};
    const nextMetadata = {};

    for (const project of externalProjects) {
      if (project.dataSource?.health?.status === "error") {
        nextSidecars[project.id] = clone(objectValue(previousSidecars[project.id]));
        nextMetadata[project.id] = clone(objectValue(previousMetadata[project.id]));
        continue;
      }

      const bridge = this.bridgeFor(project, data, previousSidecars[project.id], previousMetadata[project.id]);
      const adapter = this.adapterFor(project, bridge);
      const projectData = {
        ...data,
        projects: [project],
        tasks: cloneArray(data.tasks).filter((task) => task.projectId === project.id),
        tasksdirSidecars: clone(objectValue(previousSidecars[project.id]))
      };

      try {
        const result = await withDirectoryLock(this.projectLockPath(project), () => adapter.write(projectData));
        const readyDataSource = withHealth(project.dataSource, {
          status: "ready",
          message: "",
          warnings: cloneArray(result?.tasksdirDiagnostics?.unmappedValues),
          checkedAt: new Date().toISOString()
        });
        project.dataSource = readyDataSource;
        const storedProject = data.projects.find((candidate) => candidate.id === project.id);
        if (storedProject) storedProject.dataSource = clone(readyDataSource);
        for (const canonicalTask of projectData.tasks) {
          const storedTask = data.tasks.find((candidate) => candidate.id === canonicalTask.id);
          if (storedTask) Object.assign(storedTask, clone(canonicalTask));
        }
      } catch (error) {
        if ((error?.status || 500) >= 500) {
          const storedProject = data.projects.find((candidate) => candidate.id === project.id);
          if (storedProject) {
            storedProject.dataSource = withHealth(storedProject.dataSource, {
              status: "error",
              message: error?.message || "Unable to write the project tasks directory.",
              code: text(error?.code || error?.reason),
              checkedAt: new Date().toISOString()
            });
          }
          await this.ops.write({
            ...data,
            tasks: cloneArray(data.tasks).filter((task) => !externalProjectIds.has(task.projectId)),
            [PROJECT_SIDECARS_KEY]: clone(previousSidecars),
            [PROJECT_METADATA_KEY]: clone(previousMetadata)
          });
        }
        throw projectStorageError(project, error);
      }
      nextSidecars[project.id] = clone(objectValue(bridge.snapshot?.tasksdirSidecars));
      nextMetadata[project.id] = {
        verificationTargetGateVersion: bridge.snapshot?.tasksdirVerificationTargetGateVersion === 1 ? 1 : 0
      };
    }

    const opsData = {
      ...data,
      projects,
      tasks: cloneArray(data.tasks).filter((task) => !externalProjectIds.has(task.projectId)),
      [PROJECT_SIDECARS_KEY]: nextSidecars,
      [PROJECT_METADATA_KEY]: nextMetadata
    };
    await this.ops.write(opsData);
    this.needsMigrationSave = false;
  }

  adapterFor(project, bridge) {
    const tasksDir = project.dataSource.tasksDir;
    const cached = this.adapters.get(project.id);
    if (cached?.tasksDirKey === pathIdentity(tasksDir)) {
      cached.bridge.setSnapshot(bridge.snapshot);
      return cached.adapter;
    }

    const adapter = new TasksdirWorkboardPersistence({
      tasksDir,
      ops: bridge,
      defaultProjectKey: project.key || this.defaultProjectKey,
      deferInitialGate: true
    });
    this.adapters.set(project.id, { tasksDir, tasksDirKey: pathIdentity(tasksDir), adapter, bridge });
    return adapter;
  }

  bridgeFor(project, data, sidecars, metadata) {
    const snapshot = {
      ...data,
      projects: [project],
      tasks: [],
      tasksdirSidecars: clone(objectValue(sidecars)),
      tasksdirVerificationTargetGateVersion: objectValue(metadata).verificationTargetGateVersion
    };
    const cached = this.adapters.get(project.id);
    if (cached?.tasksDirKey === pathIdentity(project.dataSource.tasksDir)) {
      cached.bridge.setSnapshot(snapshot);
      return cached.bridge;
    }
    return new ProjectOpsBridge(this.ops, project.id, snapshot);
  }

  projectLockPath(project) {
    const digest = createHash("sha256")
      .update(pathIdentity(project.dataSource.tasksDir))
      .digest("hex")
      .slice(0, 20);
    return path.join(this.dataDir, "project-locks", `${digest}.lock`);
  }
}

class ProjectOpsBridge {
  constructor(ops, projectId, snapshot) {
    this.mode = `project:${projectId}`;
    this.path = ops.path;
    this.lockPath = ops.lockPath;
    this.snapshot = clone(snapshot);
  }

  setSnapshot(snapshot) {
    this.snapshot = clone(snapshot);
  }

  async read() {
    return clone(this.snapshot);
  }

  async write(data) {
    this.snapshot = clone(data);
  }
}

export function hasTasksDirectory(project) {
  return Boolean(text(project?.dataSource?.tasksDir));
}

function withHealth(dataSource, health) {
  return {
    tasksDir: path.resolve(dataSource.tasksDir),
    ...(text(dataSource.repoDir) ? { repoDir: path.resolve(dataSource.repoDir) } : {}),
    health: {
      ...health,
      warnings: cloneArray(health.warnings)
    }
  };
}

function projectStorageError(project, error) {
  return Object.assign(
    new Error(`Project ${project.name || project.id} tasks directory write failed: ${error?.message || "unknown error"}`),
    {
      status: error?.status || 503,
      code: error?.code,
      reason: error?.reason || "project_tasksdir_write_failed",
      projectId: project.id,
      tasksDir: project.dataSource.tasksDir,
      cause: error
    }
  );
}

async function withDirectoryLock(lockPath, callback) {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await removeStaleLock(lockPath);
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw Object.assign(new Error("Timed out waiting for the project tasks-directory write lock."), { status: 503 });
      }
      await delay(LOCK_RETRY_MS);
    }
  }

  try {
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function removeStaleLock(lockPath) {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
      await rm(lockPath, { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cloneArray(value) {
  return Array.isArray(value) ? clone(value) : [];
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
