import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WorkboardStore } from "../server/storage/workboardStore.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tasksdir");

describe("per-project tasks-directory persistence", () => {
  let dataDir;
  let tasksDir;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-project-source-"));
    tasksDir = path.join(dataDir, "external-tasks");
    await cp(fixturesDir, tasksDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("keeps folder-backed and ops-backed projects together without mixing their work items", async () => {
    const store = new WorkboardStore({ dataDir, storageMode: "json" });
    await store.init();
    const folderProject = await store.createProject({
      name: "Folder Project",
      key: "FOLDER",
      dataSource: { tasksDir, repoDir: dataDir }
    });
    const opsProject = await store.createProject({ name: "Ops Project", key: "OPS" });

    expect(folderProject.dataSource).toMatchObject({
      tasksDir: path.resolve(tasksDir),
      repoDir: path.resolve(dataDir),
      health: { status: "ready" }
    });
    expect(store.listTasks({ projectId: folderProject.id })).toHaveLength(4);
    expect(store.listTasks({ projectId: opsProject.id })).toHaveLength(0);

    const opsTask = await store.createTask({ projectId: opsProject.id, title: "Stored in ops" });
    const folderTask = await store.createTask({ projectId: folderProject.id, title: "Stored in task.md" });
    expect(store.listTasks({ projectId: opsProject.id }).map((task) => task.id)).toEqual([opsTask.id]);
    expect(store.listTasks({ projectId: folderProject.id }).map((task) => task.id)).toContain(folderTask.id);
    expect(await readFile(path.join(tasksDir, folderTask.id, "task.md"), "utf8")).toContain("Stored in task.md");

    const persistedOps = JSON.parse(await readFile(path.join(dataDir, "workboard.json"), "utf8"));
    expect(persistedOps.tasks.map((task) => task.id)).toContain(opsTask.id);
    expect(persistedOps.tasks.map((task) => task.id)).not.toContain(folderTask.id);
    expect(persistedOps.projectTasksdirSidecars[folderProject.id]).toHaveProperty(folderTask.id);

    const reloaded = new WorkboardStore({ dataDir, storageMode: "json" });
    await reloaded.init();
    expect(reloaded.listTasks({ projectId: opsProject.id }).map((task) => task.id)).toEqual([opsTask.id]);
    expect(reloaded.listTasks({ projectId: folderProject.id }).map((task) => task.id)).toContain(folderTask.id);
  });

  it("migrates pre-gate testing tasks once and persists the per-project target gate", async () => {
    const taskFile = path.join(tasksDir, "fbr_20260812143216_78750600c", "task.md");
    await writeFile(taskFile, (await readFile(taskFile, "utf8")).replace("status: todo", "status: testing"));

    const store = new WorkboardStore({ dataDir, storageMode: "json" });
    await store.init();
    const project = await store.createProject({ name: "Legacy Testing Folder", dataSource: { tasksDir } });

    expect(store.getTask("fbr_20260812143216_78750600c")).toMatchObject({
      projectId: project.id,
      status: "testing",
      verificationTarget: {
        artifactNote: expect.stringMatching(/before verification targets were required/i)
      }
    });
    expect(await readFile(taskFile, "utf8")).toContain("verificationTarget:");
    const persisted = JSON.parse(await readFile(path.join(dataDir, "workboard.json"), "utf8"));
    expect(persisted.projectTasksdirMetadata[project.id]).toEqual({ verificationTargetGateVersion: 1 });
  });

  it("quarantines a new per-project testing task without a verification target", async () => {
    const store = new WorkboardStore({ dataDir, storageMode: "json" });
    await store.init();
    const project = await store.createProject({ name: "Strict Testing Folder", dataSource: { tasksDir } });
    const externalDir = path.join(tasksDir, "external_testing");
    await mkdir(externalDir);
    await writeFile(
      path.join(externalDir, "task.md"),
      "---\nid: external_testing\ntitle: External testing task\nowner: unassigned\nstatus: testing\ntype: task\npriority: normal\nlabels:\ncreated: 2026-08-13\n---\nNo target.\n"
    );

    const refreshed = await store.refreshProjectDataSource(project.id);
    expect(refreshed.dataSource.health).toMatchObject({
      status: "error",
      code: "verification_target_required",
      message: expect.stringMatching(/verification target/i)
    });
    expect(store.listTasks({ projectId: project.id })).toHaveLength(0);
  });

  it("composes project task folders over the SQLite ops store", async () => {
    const store = new WorkboardStore({ dataDir, storageMode: "sqlite" });
    await store.init();
    const folderProject = await store.createProject({ name: "SQLite folder project", dataSource: { tasksDir } });
    const opsProject = await store.createProject({ name: "SQLite ops project" });
    const folderTask = await store.createTask({ projectId: folderProject.id, title: "SQLite external task" });
    const opsTask = await store.createTask({ projectId: opsProject.id, title: "SQLite internal task" });

    const reloaded = new WorkboardStore({ dataDir, storageMode: "sqlite" });
    await reloaded.init();
    expect(reloaded.listTasks({ projectId: folderProject.id }).map((task) => task.id)).toContain(folderTask.id);
    expect(reloaded.listTasks({ projectId: opsProject.id }).map((task) => task.id)).toEqual([opsTask.id]);
  });

  it("isolates an unreadable project folder and keeps healthy projects writable", async () => {
    const store = new WorkboardStore({ dataDir, storageMode: "json" });
    await store.init();
    const missingTasksDir = path.join(dataDir, "missing-tasks");
    const degraded = await store.createProject({
      name: "Degraded Folder Project",
      dataSource: { tasksDir: missingTasksDir }
    });
    const healthy = await store.createProject({ name: "Healthy Ops Project" });

    expect(degraded.dataSource.health).toMatchObject({ status: "error" });
    expect(degraded.dataSource.health.message).toContain("does not exist");
    await expect(store.createTask({ projectId: degraded.id, title: "Must not disappear" })).rejects.toMatchObject({
      status: 503,
      reason: "project_tasksdir_unavailable"
    });

    const task = await store.createTask({ projectId: healthy.id, title: "Healthy write" });
    expect(store.getTask(task.id).title).toBe("Healthy write");
    expect(store.getProject(degraded.id).dataSource.health.status).toBe("error");

    await cp(fixturesDir, missingTasksDir, { recursive: true });
    const recovered = await store.refreshProjectDataSource(degraded.id);
    expect(recovered.dataSource.health.status).toBe("ready");
    expect(store.listTasks({ projectId: degraded.id })).toHaveLength(4);
  });

  it("degrades only a project whose runtime task file has malformed frontmatter", async () => {
    const store = new WorkboardStore({ dataDir, storageMode: "json" });
    await store.init();
    const folderProject = await store.createProject({ name: "Malformed Folder Project", dataSource: { tasksDir } });
    const healthy = await store.createProject({ name: "Healthy Sibling" });
    await writeFile(
      path.join(tasksDir, "task_docs_cleanup", "task.md"),
      "---\nid: task_docs_cleanup\ntitle: Malformed nested metadata\nstatus: ready\nboard:\n  role implementer\n---\nBody\n"
    );

    const degraded = await store.refreshProjectDataSource(folderProject.id);
    expect(degraded.dataSource.health).toMatchObject({
      status: "error",
      code: "INVALID_TASK_FILE",
      message: expect.stringContaining("child key followed by a colon")
    });
    expect(store.listTasks({ projectId: folderProject.id })).toHaveLength(0);
    const healthyTask = await store.createTask({ projectId: healthy.id, title: "Sibling remains writable" });
    expect(store.getTask(healthyTask.id).title).toBe("Sibling remains writable");
  });

  it("isolates unsafe touch hints while a healthy folder project still lists collisions", async () => {
    const unsafeTasksDir = path.join(dataDir, "unsafe-touch-tasks");
    const healthyTasksDir = path.join(dataDir, "healthy-touch-tasks");
    await mkdir(path.join(unsafeTasksDir, "unsafe"), { recursive: true });
    await mkdir(path.join(healthyTasksDir, "healthy-glob"), { recursive: true });
    await mkdir(path.join(healthyTasksDir, "healthy-file"), { recursive: true });
    await writeFile(
      path.join(unsafeTasksDir, "unsafe", "task.md"),
      '---\nid: unsafe\ntitle: Unsafe touch\nstatus: ready\ntype: task\nboard:\n  touches: ["src/**"]\n---\nBody\n'
    );
    await writeFile(
      path.join(healthyTasksDir, "healthy-glob", "task.md"),
      '---\nid: healthy-glob\ntitle: Healthy glob\nstatus: ready\ntype: task\nboard:\n  touches: ["src/**"]\n---\nBody\n'
    );
    await writeFile(
      path.join(healthyTasksDir, "healthy-file", "task.md"),
      '---\nid: healthy-file\ntitle: Healthy file\nstatus: ready\ntype: task\nboard:\n  touches: ["src/App.jsx"]\n---\nBody\n'
    );

    const store = new WorkboardStore({ dataDir, storageMode: "json" });
    await store.init();
    const unsafeProject = await store.createProject({ name: "Unsafe touch project", dataSource: { tasksDir: unsafeTasksDir } });
    const healthyProject = await store.createProject({ name: "Healthy touch project", dataSource: { tasksDir: healthyTasksDir } });

    await writeFile(
      path.join(unsafeTasksDir, "unsafe", "task.md"),
      '---\nid: unsafe\ntitle: Unsafe touch\nstatus: ready\ntype: task\nboard:\n  touches: ["../outside.js"]\n---\nBody\n'
    );

    const degraded = await store.refreshProjectDataSource(unsafeProject.id);
    expect(degraded.dataSource.health).toMatchObject({
      status: "error",
      code: "INVALID_TASK_FILE",
      message: expect.stringContaining("touches path hints must stay within the repository")
    });
    expect(store.listTasks({ projectId: unsafeProject.id })).toEqual([]);

    const healthy = store.listTasks({ projectId: healthyProject.id });
    expect(healthy).toHaveLength(2);
    expect(healthy.map((task) => task.touches)).toEqual(expect.arrayContaining([["src/**"], ["src/App.jsx"]]));
    expect(healthy.every((task) => task.collision.detected)).toBe(true);
  });

  it("keeps unknown enum tasks available and exposes project-scoped mapping warnings", async () => {
    const unknownTasksDir = path.join(dataDir, "unknown-enum-tasks");
    const taskDir = path.join(unknownTasksDir, "future-task");
    await mkdir(taskDir, { recursive: true });
    await writeFile(
      path.join(taskDir, "task.md"),
      "---\nid: future-task\ntitle: Future task\nstatus: someday\ntype: gizmo\npriority: extreme\n---\nBody\n"
    );
    const store = new WorkboardStore({ dataDir, storageMode: "json" });
    await store.init();
    const project = await store.createProject({ name: "Tolerant Folder Project", dataSource: { tasksDir: unknownTasksDir } });

    expect(project.dataSource.health).toMatchObject({
      status: "ready",
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: "UNMAPPED_TASK_VALUE", kind: "status", value: "someday", target: "backlog" }),
        expect.objectContaining({ code: "UNMAPPED_TASK_VALUE", kind: "type", value: "gizmo", target: "task" }),
        expect.objectContaining({ code: "UNMAPPED_TASK_VALUE", kind: "priority", value: "extreme", target: "none" })
      ])
    });
    expect(store.listTasks({ projectId: project.id })).toEqual([
      expect.objectContaining({
        id: "future-task",
        status: "backlog",
        workItemType: "task",
        priority: null,
        labels: ["unmapped-value"]
      })
    ]);
  });

  it("keeps stale-file CAS failures inside the folder-backed project revision space", async () => {
    const store = new WorkboardStore({ dataDir, storageMode: "json" });
    await store.init();
    const folderProject = await store.createProject({ name: "CAS Folder Project", dataSource: { tasksDir } });
    const opsProject = await store.createProject({ name: "CAS Ops Project" });
    const external = store.listTasks({ projectId: folderProject.id }).find((task) => task.id === "task_docs_cleanup");
    const taskFile = path.join(tasksDir, "task_docs_cleanup", "task.md");
    const before = await readFile(taskFile, "utf8");
    await writeFile(
      taskFile,
      before.replace("Rewrite the onboarding guide for the new tariff flow", "Externally renamed documentation flow")
    );

    await expect(
      store.updateTask(external.id, { title: "Board rename", expectedRevision: external.revision }, "operator")
    ).rejects.toMatchObject({ status: 409, reason: "stale_task_file", projectId: folderProject.id });

    const opsTask = await store.createTask({ projectId: opsProject.id, title: "Independent revision" });
    const updated = await store.updateTask(
      opsTask.id,
      { title: "Independent revision updated", expectedRevision: opsTask.revision },
      "operator"
    );
    expect(updated).toMatchObject({ title: "Independent revision updated", revision: 2 });
  });

  it("rejects binding the same tasks directory to two projects", async () => {
    const store = new WorkboardStore({ dataDir, storageMode: "json" });
    await store.init();
    await store.createProject({ name: "First Binding", dataSource: { tasksDir } });
    await expect(store.createProject({ name: "Second Binding", dataSource: { tasksDir } })).rejects.toMatchObject({
      status: 409,
      details: { reason: "tasksdir_already_bound" }
    });
  });

  it("rejects filesystem aliases for an already-bound tasks directory", async () => {
    const aliasDir = path.join(dataDir, "external-tasks-alias");
    await symlink(tasksDir, aliasDir, process.platform === "win32" ? "junction" : "dir");
    const store = new WorkboardStore({ dataDir, storageMode: "json" });
    await store.init();
    const first = await store.createProject({ name: "Canonical Binding", dataSource: { tasksDir } });
    await expect(store.createProject({ name: "Alias Binding", dataSource: { tasksDir: aliasDir } })).rejects.toMatchObject({
      status: 409,
      details: { reason: "tasksdir_already_bound" }
    });
    expect(first.dataSource.tasksDir).toBe(await realpath(tasksDir));
  });

  it("omits bindings from portable backups and rejects binding injection on import", async () => {
    const store = new WorkboardStore({ dataDir, storageMode: "json" });
    await store.init();
    const project = await store.createProject({ name: "Portable Folder Project", dataSource: { tasksDir } });
    const backup = store.exportProjectBackup(project.id);
    expect(backup.project).not.toHaveProperty("dataSource");

    await store.importProjectBackup({ ...backup, tasks: [] }, { actor: "restore-agent" });
    expect(store.getProject(project.id).dataSource.tasksDir).toBe(project.dataSource.tasksDir);

    await expect(
      store.importProjectBackup(
        { ...backup, tasks: [], project: { ...backup.project, dataSource: { tasksDir: path.join(dataDir, "injected") } } },
        { actor: "restore-agent" }
      )
    ).rejects.toMatchObject({
      status: 409,
      details: { reason: "project_backup_data_source_forbidden", field: "project.dataSource" }
    });
  });

  it("degrades only the later folder project when task ids collide across sources", async () => {
    const secondTasksDir = path.join(dataDir, "second-external-tasks");
    await cp(fixturesDir, secondTasksDir, { recursive: true });
    const store = new WorkboardStore({ dataDir, storageMode: "json" });
    await store.init();
    const first = await store.createProject({ name: "First ID space", dataSource: { tasksDir } });
    const second = await store.createProject({ name: "Second ID space", dataSource: { tasksDir: secondTasksDir } });

    expect(store.getProject(first.id).dataSource.health.status).toBe("ready");
    expect(second.dataSource.health).toMatchObject({
      status: "error",
      code: "CROSS_PROJECT_TASK_ID_COLLISION",
      message: expect.stringContaining("task_docs_cleanup")
    });
    expect(store.listTasks({ projectId: first.id })).toHaveLength(4);
    expect(store.listTasks({ projectId: second.id })).toHaveLength(0);
  });
});
