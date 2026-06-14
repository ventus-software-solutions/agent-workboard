import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkboardStore } from "../server/storage/workboardStore.js";

const execFileAsync = promisify(execFile);

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-sqlite-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("WorkboardStore SQLite persistence", () => {
  it("persists new board data in SQLite and reloads it", async () => {
    const store = new WorkboardStore({ dataDir: tempDir, storageMode: "sqlite" });
    await store.init();

    const project = await store.createProject({ name: "SQLite Project", key: "SQL" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Persist O'Brien's task",
      status: "ready",
      role: "implementer"
    });

    const persisted = await readSqliteState(tempDir);
    expect(persisted.schema_version).toBe(1);
    expect(persisted.data.projects.some((item) => item.id === project.id)).toBe(true);
    expect(persisted.data.tasks.find((item) => item.id === task.id)).toMatchObject({
      title: "Persist O'Brien's task",
      status: "ready"
    });

    const reloaded = new WorkboardStore({ dataDir: tempDir, storageMode: "sqlite" });
    await reloaded.init();
    expect(reloaded.listTasks({ projectId: project.id })).toEqual([
      expect.objectContaining({ id: task.id, title: "Persist O'Brien's task" })
    ]);
  });

  it("migrates an existing workboard.json snapshot without deleting the rollback file", async () => {
    const jsonStore = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
    await jsonStore.init();
    const project = await jsonStore.createProject({ name: "Migrated JSON Project", key: "MJP" });
    const task = await jsonStore.createTask({
      projectId: project.id,
      title: "Move JSON board into SQLite",
      status: "ready",
      role: "tester"
    });

    const jsonPath = path.join(tempDir, "workboard.json");
    const raw = JSON.parse(await readFile(jsonPath, "utf8"));
    delete raw.talkMessages;
    await writeFile(jsonPath, JSON.stringify(raw, null, 2));

    const sqliteStore = new WorkboardStore({ dataDir: tempDir, storageMode: "sqlite" });
    await sqliteStore.init();

    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(path.join(tempDir, "workboard.sqlite"))).toBe(true);
    expect(sqliteStore.listTasks({ projectId: project.id })).toEqual([
      expect.objectContaining({ id: task.id, title: "Move JSON board into SQLite" })
    ]);
    expect(sqliteStore.listTalkMessages({ projectId: project.id })).toEqual([]);

    const persisted = await readSqliteState(tempDir);
    expect(persisted.data.tasks.find((item) => item.id === task.id)).toMatchObject({
      title: "Move JSON board into SQLite"
    });
    expect(Array.isArray(persisted.data.talkMessages)).toBe(true);
  });

  it("keeps stale-safe claim behavior when two SQLite stores share one data directory", async () => {
    const setupStore = new WorkboardStore({ dataDir: tempDir, storageMode: "sqlite" });
    await setupStore.init();
    const project = await setupStore.createProject({ name: "SQLite Claim Project" });
    const task = await setupStore.createTask({
      projectId: project.id,
      title: "Claim once in SQLite",
      status: "ready",
      role: "implementer",
      assignee: ""
    });

    const firstStore = new WorkboardStore({ dataDir: tempDir, storageMode: "sqlite" });
    const secondStore = new WorkboardStore({ dataDir: tempDir, storageMode: "sqlite" });
    await firstStore.init();
    await secondStore.init();

    const results = await Promise.allSettled([
      firstStore.claimTask(task.id, {
        assignee: "implementer-backend-1",
        expectedStatus: "ready",
        expectedAssignee: ""
      }),
      secondStore.claimTask(task.id, {
        assignee: "implementer-backend-2",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected").reason).toMatchObject({ status: 409 });

    const persisted = await readSqliteState(tempDir);
    const savedTask = persisted.data.tasks.find((item) => item.id === task.id);
    expect(savedTask.status).toBe("in_progress");
    expect(["implementer-backend-1", "implementer-backend-2"]).toContain(savedTask.assignee);
  });
});

async function readSqliteState(dataDir) {
  const dbPath = path.join(dataDir, "workboard.sqlite");
  const { stdout } = await execFileAsync(
    "sqlite3",
    ["-batch", "-json", dbPath, "SELECT schema_version, json FROM workboard_state WHERE id = 1;"],
    { maxBuffer: 100 * 1024 * 1024, windowsHide: true }
  );
  const rows = JSON.parse(stdout.trim() || "[]");
  expect(rows).toHaveLength(1);
  return {
    schema_version: rows[0].schema_version,
    data: JSON.parse(rows[0].json)
  };
}
