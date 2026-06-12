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
