import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("requires a completion record before moving a task to done", async () => {
    const project = await store.createProject({ name: "Done Gate Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Ship audited code",
      role: "implementer",
      status: "review",
      assignee: "implementer-01"
    });

    await expect(
      store.updateTask(task.id, { status: "done", title: "Should not mutate" }, "reviewer-01")
    ).rejects.toMatchObject({ status: 400 });
    expect(store.getTask(task.id)).toMatchObject({
      status: "review",
      title: "Ship audited code"
    });
  });

  it("treats undefined completion in a status patch as omitted", async () => {
    const project = await store.createProject({ name: "MCP Status Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Move through MCP",
      role: "implementer",
      status: "ready"
    });

    const moved = await store.updateTask(
      task.id,
      { status: "in_progress", completion: undefined },
      "implementer-01"
    );

    expect(moved).toMatchObject({
      status: "in_progress",
      completion: null
    });
  });

  it("leaves a task unchanged when completion validation fails", async () => {
    const project = await store.createProject({ name: "Atomic Done Gate Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Original title",
      role: "implementer",
      status: "review",
      assignee: "implementer-01"
    });

    await expect(
      store.updateTask(
        task.id,
        {
          title: "Mutated through failed completion",
          status: "done",
          completion: {
            completionType: "merged"
          }
        },
        "reviewer-01"
      )
    ).rejects.toMatchObject({ status: 400 });

    expect(store.getTask(task.id)).toMatchObject({
      title: "Original title",
      status: "review",
      completion: null
    });
  });

  it("requires completion evidence when creating an already-done task", async () => {
    const project = await store.createProject({ name: "Create Done Gate Project" });

    await expect(
      store.createTask({
        projectId: project.id,
        title: "Created already done",
        status: "done"
      })
    ).rejects.toMatchObject({ status: 400 });

    const completed = await store.createTask({
      projectId: project.id,
      title: "Created done with evidence",
      status: "done",
      role: "pm",
      actor: "pm-agent",
      completion: {
        completionType: "no-code",
        notes: "Seeded as an already completed planning task."
      }
    });

    expect(completed).toMatchObject({
      status: "done",
      completion: {
        completionType: "no-code",
        completedBy: "pm-agent",
        notes: "Seeded as an already completed planning task."
      }
    });
  });

  it("records merged completion evidence when a task moves to done", async () => {
    const project = await store.createProject({ name: "Completion Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Merge feature branch",
      role: "implementer",
      status: "review",
      assignee: "implementer-01"
    });

    const completed = await store.updateTask(
      task.id,
      {
        status: "done",
        completion: {
          completionType: "merged",
          branch: "implementer-01/feature",
          commitSha: "abc1234",
          mergedTo: "main",
          tests: ["npm test", "npm run build"],
          reviewTaskId: "task_review_123",
          notes: "Approved by reviewer-01."
        }
      },
      "reviewer-01"
    );

    expect(completed.completion).toMatchObject({
      completionType: "merged",
      completedBy: "reviewer-01",
      branch: "implementer-01/feature",
      commitSha: "abc1234",
      mergedTo: "main",
      tests: ["npm test", "npm run build"],
      reviewTaskId: "task_review_123"
    });
    expect(completed.activity[0]).toMatchObject({
      actor: "reviewer-01",
      type: "completed"
    });
  });

  it("allows explicit no-code completion for planning work", async () => {
    const project = await store.createProject({ name: "Planning Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Define rollout plan",
      role: "pm",
      status: "review",
      assignee: "pm-agent"
    });

    const completed = await store.updateTask(
      task.id,
      {
        status: "done",
        completion: {
          completionType: "no-code",
          notes: "Acceptance criteria and follow-up tasks posted in comments."
        }
      },
      "reviewer-01"
    );

    expect(completed.completion).toMatchObject({
      completionType: "no-code",
      completedBy: "reviewer-01",
      notes: "Acceptance criteria and follow-up tasks posted in comments."
    });
  });

  it("backfills legacy done tasks as needing audit", async () => {
    const raw = JSON.parse(await readFile(path.join(tempDir, "workboard.json"), "utf8"));
    raw.tasks[0].status = "done";
    raw.tasks[0].updatedAt = "2026-06-12T12:00:00.000Z";
    delete raw.tasks[0].completion;
    await writeFile(path.join(tempDir, "workboard.json"), JSON.stringify(raw, null, 2));

    const reloaded = new WorkboardStore({ dataDir: tempDir });
    await reloaded.init();

    const task = reloaded.getTask(raw.tasks[0].id);
    expect(task.completion).toMatchObject({
      completionType: "legacy-needs-audit",
      completedBy: "legacy"
    });
    expect(task.completion.notes).toContain("Marked done before completion records existed");
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

  it("initializes default agent types and stable slots", () => {
    const registry = store.listAgentSlots({ now: "2026-06-12T15:00:00.000Z" });
    const backendType = registry.types.find((type) => type.id === "implementer-backend");
    const backendSlots = registry.slots.filter((slot) => slot.typeId === "implementer-backend");

    expect(backendType).toMatchObject({
      role: "implementer",
      capacity: 4,
      available: 4
    });
    expect(backendSlots.map((slot) => slot.id)).toEqual([
      "implementer-backend-1",
      "implementer-backend-2",
      "implementer-backend-3",
      "implementer-backend-4"
    ]);
    expect(backendSlots[0]).toMatchObject({
      slotNumber: 1,
      active: false,
      available: true,
      paused: false
    });
  });

  it("lets two store instances acquire distinct slots from a shared data directory", async () => {
    const firstStore = new WorkboardStore({ dataDir: tempDir });
    const secondStore = new WorkboardStore({ dataDir: tempDir });
    await firstStore.init();
    await secondStore.init();

    const results = await Promise.all([
      firstStore.acquireAgentSlot({
        preferredType: "implementer-backend",
        runtimeId: "runtime-a",
        now: "2026-06-12T15:00:00.000Z"
      }),
      secondStore.acquireAgentSlot({
        preferredType: "implementer-backend",
        runtimeId: "runtime-b",
        now: "2026-06-12T15:00:00.000Z"
      })
    ]);

    expect(results.map((result) => result.agentId).sort()).toEqual([
      "implementer-backend-1",
      "implementer-backend-2"
    ]);

    const saved = JSON.parse(await readFile(path.join(tempDir, "workboard.json"), "utf8"));
    const activeBackendSlots = saved.agentSlots.filter(
      (slot) => slot.typeId === "implementer-backend" && slot.lease
    );
    expect(activeBackendSlots.map((slot) => slot.id).sort()).toEqual([
      "implementer-backend-1",
      "implementer-backend-2"
    ]);
  });

  it("rejects agent slot acquisition when active capacity is full", async () => {
    for (const slotNumber of [1, 2, 3, 4]) {
      await store.acquireAgentSlot({
        preferredType: "implementer-backend",
        runtimeId: `runtime-${slotNumber}`,
        now: "2026-06-12T15:00:00.000Z"
      });
    }

    await expect(
      store.acquireAgentSlot({
        preferredType: "implementer-backend",
        runtimeId: "runtime-5",
        now: "2026-06-12T15:00:00.000Z"
      })
    ).rejects.toMatchObject({
      status: 409,
      details: {
        typeId: "implementer-backend",
        capacity: 4,
        active: 4
      }
    });
  });

  it("does not count assigned backlog work as active slot capacity", async () => {
    const project = await store.createProject({ name: "Backlog Assignment Project" });
    for (const slotNumber of [1, 2, 3, 4]) {
      await store.createTask({
        projectId: project.id,
        title: `Backlog task ${slotNumber}`,
        status: "backlog",
        assignee: `implementer-backend-${slotNumber}`
      });
    }

    const acquired = [];
    for (const slotNumber of [1, 2, 3, 4]) {
      acquired.push(
        await store.acquireAgentSlot({
          preferredType: "implementer-backend",
          runtimeId: `runtime-${slotNumber}`,
          now: "2026-06-12T15:00:00.000Z"
        })
      );
    }

    expect(acquired.map((slot) => slot.agentId)).toEqual([
      "implementer-backend-1",
      "implementer-backend-2",
      "implementer-backend-3",
      "implementer-backend-4"
    ]);
  });

  it("reclaims stale leases while preserving slots with in-progress work", async () => {
    const project = await store.createProject({ name: "Stale Slot Project" });

    await store.acquireAgentSlot({
      preferredType: "implementer-backend",
      runtimeId: "runtime-stale",
      now: "2026-06-12T15:00:00.000Z"
    });

    const reclaimed = await store.acquireAgentSlot({
      preferredType: "implementer-backend",
      runtimeId: "runtime-new",
      now: "2026-06-12T15:16:00.000Z"
    });

    expect(reclaimed).toMatchObject({
      agentId: "implementer-backend-1",
      reclaimed: true
    });

    await store.createTask({
      projectId: project.id,
      title: "Keep occupied slot",
      status: "in_progress",
      assignee: "implementer-backend-1"
    });

    const nextSlot = await store.acquireAgentSlot({
      preferredType: "implementer-backend",
      runtimeId: "runtime-next",
      now: "2026-06-12T15:32:00.000Z"
    });

    expect(nextSlot.agentId).toBe("implementer-backend-2");
  });

  it("stores attachments with sanitized filenames and sha256 evidence", async () => {
    const project = await store.createProject({ name: "File Project" });
    const task = await store.createTask({ projectId: project.id, title: "Read uploaded spec" });

    const firstAttachment = await store.addAttachment(task.id, {
      originalname: "../bad spec?.txt",
      mimetype: "text/plain",
      size: 11,
      buffer: Buffer.from("hello world")
    });
    const secondAttachment = await store.addAttachment(task.id, {
      originalname: "..\\nested\\evil<>.txt",
      mimetype: "text/plain",
      size: 6,
      buffer: Buffer.from("second")
    });

    expect(firstAttachment.filename).toBe("bad_spec_.txt");
    expect(firstAttachment.sha256).toHaveLength(64);
    expect(secondAttachment.filename).toBe("evil_.txt");
    expect(secondAttachment.storedName).not.toMatch(/[\\/]/);
    expect(secondAttachment.sha256).toHaveLength(64);
    expect(store.getTask(task.id).attachments).toHaveLength(2);
  });
});
