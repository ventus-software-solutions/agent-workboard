import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkboardStore } from "../server/storage/workboardStore.js";

let tempDir;
let store;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-"));
  store = new WorkboardStore({ dataDir: tempDir });
  await store.init();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("WorkboardStore", () => {
  it("creates projects and filters tasks by project and role", async () => {
    const project = await store.createProject({ name: "Customer Build", key: "CB" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Review checkout flow",
      role: "reviewer",
      priority: "high",
      labels: ["ux", "checkout"]
    });

    expect(store.listProjects().some((item) => item.id === project.id)).toBe(true);
    expect(store.listTasks({ projectId: project.id, role: "reviewer" })).toMatchObject([
      { id: task.id, title: "Review checkout flow", role: "reviewer" }
    ]);
    expect(store.listTasks({ projectId: project.id, role: "tester" })).toEqual([]);
  });

  it("records status changes, comments, and persisted data", async () => {
    const project = await store.createProject({ name: "Release Train" });
    const task = await store.createTask({ projectId: project.id, title: "Ship notes", role: "pm" });

    await store.updateTask(task.id, { status: "review", assignee: "review-agent" }, "pm-agent");
    await store.addComment(task.id, { author: "review-agent", body: "Needs one acceptance check." });

    const saved = JSON.parse(await readFile(path.join(tempDir, "workboard.json"), "utf8"));
    const savedTask = saved.tasks.find((item) => item.id === task.id);

    expect(savedTask.status).toBe("review");
    expect(savedTask.assignee).toBe("review-agent");
    expect(savedTask.comments[0]).toMatchObject({ author: "review-agent" });
    expect(savedTask.activity[0].type).toBe("commented");
  });

  it("claims a ready task with expected status and assignee preconditions", async () => {
    const project = await store.createProject({ name: "Claim Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Claim exactly once",
      status: "ready",
      assignee: "implementer-01"
    });

    const claimed = await store.claimTask(task.id, {
      assignee: "implementer-02",
      actor: "implementer-02",
      expectedStatus: "ready",
      expectedAssignee: "implementer-01"
    });

    expect(claimed).toMatchObject({
      id: task.id,
      status: "in_progress",
      assignee: "implementer-02"
    });
    expect(claimed.activity[0]).toMatchObject({
      actor: "implementer-02",
      type: "claimed"
    });
  });

  it("rejects stale task claims with 409", async () => {
    const project = await store.createProject({ name: "Stale Claim Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Reject stale claim",
      status: "ready",
      assignee: ""
    });

    await store.claimTask(task.id, {
      assignee: "implementer-01",
      expectedStatus: "ready",
      expectedAssignee: ""
    });

    await expect(
      store.claimTask(task.id, {
        assignee: "implementer-02",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("lets only one store instance claim a task from a shared data directory", async () => {
    const project = await store.createProject({ name: "Shared Store Claim Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Race on disk",
      status: "ready",
      assignee: ""
    });

    const firstStore = new WorkboardStore({ dataDir: tempDir });
    const secondStore = new WorkboardStore({ dataDir: tempDir });
    await firstStore.init();
    await secondStore.init();

    const results = await Promise.allSettled([
      firstStore.claimTask(task.id, { assignee: "implementer-01", expectedStatus: "ready", expectedAssignee: "" }),
      secondStore.claimTask(task.id, { assignee: "implementer-02", expectedStatus: "ready", expectedAssignee: "" })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected").reason).toMatchObject({ status: 409 });

    const saved = JSON.parse(await readFile(path.join(tempDir, "workboard.json"), "utf8"));
    const savedTask = saved.tasks.find((item) => item.id === task.id);

    expect(savedTask.status).toBe("in_progress");
    expect(["implementer-01", "implementer-02"]).toContain(savedTask.assignee);
  });

  it("stores attachments with sanitized filenames and sha256 evidence", async () => {
    const project = await store.createProject({ name: "File Project" });
    const task = await store.createTask({ projectId: project.id, title: "Read uploaded spec" });

    const attachment = await store.addAttachment(task.id, {
      originalname: "../bad spec?.txt",
      mimetype: "text/plain",
      size: 11,
      buffer: Buffer.from("hello world")
    });

    expect(attachment.filename).toBe("bad_spec_.txt");
    expect(attachment.sha256).toHaveLength(64);
    expect(store.getTask(task.id).attachments).toHaveLength(1);
  });
});
