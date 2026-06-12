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

  it("seeds searchable product capabilities", () => {
    const capabilities = store.listCapabilities({ q: "MCP" });

    expect(capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cap_mcp_workflow_tools",
          name: "MCP workflow tools",
          status: "live",
          live: true,
          ownerRole: "implementer"
        })
      ])
    );
    expect(store.capabilityStatuses()).toEqual(
      expect.arrayContaining(["proposed", "planned", "in_progress", "review", "live", "broken", "deprecated", "superseded"])
    );
  });

  it("creates, filters, reads, and updates capabilities with validated task links", async () => {
    const project = await store.createProject({ name: "Capability Project", key: "CAP" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Ship live updates",
      labels: ["realtime"]
    });

    const capability = await store.createCapability({
      id: "cap_live_updates_test",
      projectId: project.id,
      name: "Live board updates",
      summary: "Operators see changes across sessions without refreshing.",
      status: "planned",
      ownerRole: "implementer",
      ownerAgent: "implementer-frontend-2",
      relatedTaskIds: [task.id],
      surfaces: ["Board"],
      acceptanceNotes: ["Refreshes within a few seconds"],
      verificationEvidence: ["Pending implementation"],
      notes: "Seeded from task acceptance."
    });

    expect(store.getCapability(capability.id)).toMatchObject({
      id: "cap_live_updates_test",
      live: false,
      relatedTaskIds: [task.id]
    });
    expect(store.listCapabilities({ projectId: project.id, status: "planned", q: "sessions" })).toHaveLength(1);

    const updated = await store.updateCapability(capability.id, {
      status: "live",
      blockers: ["None"],
      lastVerifiedAt: "2026-06-12T20:00:00.000Z"
    });

    expect(updated).toMatchObject({
      status: "live",
      live: true,
      blockers: ["None"],
      lastVerifiedAt: "2026-06-12T20:00:00.000Z"
    });

    await expect(
      store.createCapability({
        name: "Broken link",
        summary: "Should reject missing task ids.",
        relatedTaskIds: ["task_missing"]
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(store.updateCapability(capability.id, { status: "unknown" })).rejects.toMatchObject({ status: 400 });
  });

  it("links completion records back to capabilities as verification evidence", async () => {
    const project = await store.createProject({ name: "Capability Completion Project", key: "CCP" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Merge stale-write protection",
      role: "implementer",
      status: "review",
      assignee: "implementer-backend-3"
    });
    const capability = await store.createCapability({
      id: "cap_revision_test",
      projectId: project.id,
      name: "Task revision protection",
      summary: "Rejects stale task writes.",
      status: "review"
    });

    const completed = await store.updateTask(
      task.id,
      {
        status: "done",
        completion: {
          completionType: "merged",
          commitSha: "abc1234",
          tests: ["npm test"],
          capabilityIds: [capability.id]
        }
      },
      "reviewer-01"
    );

    expect(completed.completion.capabilityIds).toEqual([capability.id]);
    expect(store.getCapability(capability.id)).toMatchObject({
      relatedTaskIds: [task.id],
      lastVerifiedAt: completed.completion.completedAt
    });
    expect(store.getCapability(capability.id).verificationEvidence.join("\n")).toContain(task.id);
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

  it("posts and filters project-scoped Agent Talks messages", async () => {
    const project = await store.createProject({ name: "Talks Project" });
    const task = await store.createTask({ projectId: project.id, title: "Needs review", status: "review" });

    const message = await store.addTalkMessage(project.id, {
      authorAgentId: "implementer-01",
      kind: "review-request",
      body: "Ready for reviewer-agent.",
      relatedTaskId: task.id,
      mentions: ["reviewer-agent"]
    });
    await store.addTalkMessage(project.id, {
      authorAgentId: "pm-agent",
      kind: "decision",
      body: "Reviewer queue takes priority."
    });

    expect(message).toMatchObject({
      id: expect.stringMatching(/^talk_/),
      projectId: project.id,
      authorAgentId: "implementer-01",
      kind: "review-request",
      body: "Ready for reviewer-agent.",
      relatedTaskId: task.id,
      mentions: ["reviewer-agent"]
    });
    expect(store.listTalkMessages({ projectId: project.id, kind: "review-request" })).toEqual([message]);
    expect(store.listTalkMessages({ projectId: project.id, agentId: "pm-agent" })).toHaveLength(1);
    expect(store.listTalkMessages({ projectId: project.id, taskId: task.id })).toEqual([message]);
  });

  it("rejects Agent Talks messages for missing projects, invalid kinds, and unrelated tasks", async () => {
    const project = await store.createProject({ name: "Talk Validation Project" });
    const otherProject = await store.createProject({ name: "Other Talk Project" });
    const otherTask = await store.createTask({ projectId: otherProject.id, title: "Wrong project" });

    await expect(
      store.addTalkMessage(project.id, {
        authorAgentId: "agent-01",
        kind: "not-a-kind",
        body: "Bad kind"
      })
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      store.addTalkMessage(project.id, {
        authorAgentId: "agent-01",
        kind: "question",
        body: "Can I link this?",
        relatedTaskId: otherTask.id
      })
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      store.addTalkMessage("missing-project", {
        authorAgentId: "agent-01",
        kind: "question",
        body: "Anyone here?"
      })
    ).rejects.toMatchObject({ status: 404 });
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

  it("prefers idle slots with assigned ready work without mutating task assignees", async () => {
    const project = await store.createProject({ name: "Assigned Slot Project" });
    const assignedTask = await store.createTask({
      projectId: project.id,
      title: "Ready work for backend slot 3",
      status: "ready",
      role: "implementer",
      assignee: "implementer-backend-3",
      labels: ["backend"]
    });
    await store.createTask({
      projectId: project.id,
      title: "Backlog work for backend slot 1",
      status: "backlog",
      role: "implementer",
      assignee: "implementer-backend-1",
      labels: ["backend"]
    });

    const acquired = await store.acquireAgentSlot({
      preferredType: "implementer-backend",
      runtimeId: "runtime-assigned-ready",
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(acquired).toMatchObject({
      agentId: "implementer-backend-3",
      slotNumber: 3
    });
    expect(store.getTask(assignedTask.id)).toMatchObject({
      status: "ready",
      assignee: "implementer-backend-3"
    });
  });

  it("does not duplicate slot assignment under parallel acquisition pressure", async () => {
    const stores = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const nextStore = new WorkboardStore({ dataDir: tempDir });
        await nextStore.init();
        return nextStore;
      })
    );

    const results = await Promise.allSettled(
      stores.map((nextStore, index) =>
        nextStore.acquireAgentSlot({
          preferredType: "implementer-backend",
          runtimeId: `runtime-parallel-${index + 1}`,
          now: "2026-06-12T15:00:00.000Z"
        })
      )
    );

    const fulfilled = results.filter((result) => result.status === "fulfilled").map((result) => result.value);
    const rejected = results.filter((result) => result.status === "rejected").map((result) => result.reason);
    expect(fulfilled).toHaveLength(4);
    expect(new Set(fulfilled.map((result) => result.agentId))).toEqual(
      new Set(["implementer-backend-1", "implementer-backend-2", "implementer-backend-3", "implementer-backend-4"])
    );
    expect(rejected).toHaveLength(2);
    expect(rejected.every((error) => error.status === 409)).toBe(true);

    const saved = JSON.parse(await readFile(path.join(tempDir, "workboard.json"), "utf8"));
    const leasedBackendSlots = saved.agentSlots.filter((slot) => slot.typeId === "implementer-backend" && slot.lease);
    expect(leasedBackendSlots.map((slot) => slot.id).sort()).toEqual([
      "implementer-backend-1",
      "implementer-backend-2",
      "implementer-backend-3",
      "implementer-backend-4"
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

  it("returns the next claimable task with stale-safe claim preconditions", async () => {
    const project = await store.createProject({ name: "Next Task Project" });
    const assigned = await store.createTask({
      projectId: project.id,
      title: "Assigned MCP task",
      status: "ready",
      priority: "normal",
      role: "implementer",
      assignee: "mcp-agent",
      labels: ["mcp"]
    });
    const unassigned = await store.createTask({
      projectId: project.id,
      title: "Higher priority unassigned task",
      status: "ready",
      priority: "urgent",
      role: "implementer",
      labels: ["mcp"]
    });

    const next = store.getNextTaskForAgent("mcp-agent", {
      projectId: project.id,
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(next.task).toMatchObject({ id: assigned.id, title: "Assigned MCP task" });
    expect(next.selection).toMatchObject({
      reason: "assigned_to_agent",
      claim: {
        taskId: assigned.id,
        assignee: "mcp-agent",
        expectedStatus: "ready",
        expectedAssignee: "mcp-agent"
      }
    });
    expect(next.candidates.map((candidate) => candidate.id)).toContain(unassigned.id);
  });

  it("falls back to role queue work and respects priority order", async () => {
    const project = await store.createProject({ name: "Role Queue Project" });
    const lowPriority = await store.createTask({
      projectId: project.id,
      title: "Low priority implementer work",
      status: "ready",
      priority: "low",
      role: "implementer"
    });
    const urgent = await store.createTask({
      projectId: project.id,
      title: "Urgent implementer work",
      status: "ready",
      priority: "urgent",
      role: "implementer"
    });

    const next = store.getNextTaskForAgent("mcp-agent", {
      projectId: project.id,
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(next.task).toMatchObject({ id: urgent.id, title: "Urgent implementer work" });
    expect(next.selection).toMatchObject({
      reason: "role_queue",
      claim: {
        taskId: urgent.id,
        assignee: "mcp-agent",
        expectedStatus: "ready",
        expectedAssignee: ""
      }
    });
    expect(next.candidates.map((candidate) => candidate.id)).toEqual([urgent.id, lowPriority.id]);
  });

  it("falls back to specialty matches after assigned and role queues", async () => {
    const project = await store.createProject({ name: "Specialty Queue Project" });
    const specialtyTask = await store.createTask({
      projectId: project.id,
      title: "Research MCP behavior",
      status: "ready",
      priority: "high",
      role: "researcher",
      labels: ["mcp"]
    });

    const next = store.getNextTaskForAgent("mcp-agent", {
      projectId: project.id,
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(next.task).toMatchObject({ id: specialtyTask.id, title: "Research MCP behavior" });
    expect(next.selection).toMatchObject({
      reason: "specialty_match",
      claim: {
        taskId: specialtyTask.id,
        assignee: "mcp-agent",
        expectedStatus: "ready",
        expectedAssignee: ""
      }
    });
  });

  it("uses stale-safe claim metadata so parallel helper claims do not duplicate work", async () => {
    const project = await store.createProject({ name: "Parallel Helper Claim Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Single unassigned implementer task",
      status: "ready",
      priority: "normal",
      role: "implementer"
    });

    const firstStore = new WorkboardStore({ dataDir: tempDir });
    const secondStore = new WorkboardStore({ dataDir: tempDir });
    await firstStore.init();
    await secondStore.init();

    const firstNext = firstStore.getNextTaskForAgent("implementer-backend-1", {
      projectId: project.id,
      now: "2026-06-12T15:00:00.000Z"
    });
    const secondNext = secondStore.getNextTaskForAgent("implementer-backend-2", {
      projectId: project.id,
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(firstNext.selection.claim).toMatchObject({
      taskId: task.id,
      expectedStatus: "ready",
      expectedAssignee: ""
    });
    expect(secondNext.selection.claim).toMatchObject({
      taskId: task.id,
      expectedStatus: "ready",
      expectedAssignee: ""
    });

    const results = await Promise.allSettled([
      firstStore.claimTask(task.id, firstNext.selection.claim),
      secondStore.claimTask(task.id, secondNext.selection.claim)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected").reason).toMatchObject({ status: 409 });

    const saved = JSON.parse(await readFile(path.join(tempDir, "workboard.json"), "utf8"));
    const savedTask = saved.tasks.find((item) => item.id === task.id);
    expect(savedTask.status).toBe("in_progress");
    expect(["implementer-backend-1", "implementer-backend-2"]).toContain(savedTask.assignee);
  });

  it("makes no eligible work explicit when no bucket can produce a task", async () => {
    const project = await store.createProject({ name: "Empty Queue Project" });
    await store.createTask({
      projectId: project.id,
      title: "Blocked work is not eligible",
      status: "blocked",
      role: "implementer",
      labels: ["mcp"]
    });
    await store.createTask({
      projectId: project.id,
      title: "Done work is not eligible",
      status: "done",
      role: "implementer",
      completion: {
        completionType: "no-code",
        notes: "Already handled."
      }
    });

    const next = store.getNextTaskForAgent("mcp-agent", {
      projectId: project.id,
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(next.task).toBeNull();
    expect(next.candidates).toEqual([]);
    expect(next.selection).toEqual({ reason: "no_eligible_work" });
  });

  it("prioritizes review-column work over assigned ready reviewer wrappers", async () => {
    const project = await store.createProject({ name: "Reviewer Queue Project" });
    const reviewTask = await store.createTask({
      projectId: project.id,
      title: "Original implementation in review",
      status: "review",
      priority: "normal",
      role: "implementer",
      assignee: "implementer-backend-1"
    });
    await store.createTask({
      projectId: project.id,
      title: "Legacy assigned reviewer wrapper",
      status: "ready",
      priority: "urgent",
      role: "reviewer",
      assignee: "reviewer-agent"
    });

    const next = store.getNextTaskForAgent("reviewer-agent", {
      projectId: project.id,
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(next.task).toMatchObject({ id: reviewTask.id, assignee: "implementer-backend-1" });
    expect(next.selection).toMatchObject({
      reason: "review_queue",
      review: {
        taskId: reviewTask.id,
        originalAssignee: "implementer-backend-1"
      }
    });
    expect(next.selection.claim).toBeUndefined();
  });

  it("does not offer next work to paused agent slots", async () => {
    const project = await store.createProject({ name: "Paused Agent Project" });
    await store.createTask({
      projectId: project.id,
      title: "Ready but paused",
      status: "ready",
      role: "implementer",
      assignee: "mcp-agent",
      labels: ["mcp"]
    });
    store.data.agentSlots.find((slot) => slot.id === "mcp-agent").paused = true;

    const next = store.getNextTaskForAgent("mcp-agent", {
      projectId: project.id,
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(next.task).toBeNull();
    expect(next.selection).toMatchObject({
      reason: "agent_paused",
      paused: true
    });
  });

  it("records agent presence and no-eligible-work reports", async () => {
    const active = await store.updateAgentPresence("mcp-agent", {
      state: "active",
      currentTaskId: "task_123",
      workMode: "single-task",
      message: "Working the claimed helper task.",
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(active).toMatchObject({
      agentId: "mcp-agent",
      state: "active",
      status: "online",
      currentTaskId: "task_123",
      workMode: "single-task",
      message: "Working the claimed helper task.",
      stale: false,
      offline: false
    });

    const report = await store.reportNoEligibleWork("mcp-agent", {
      reason: "no_ready_work",
      message: "No eligible MCP tasks remain.",
      filters: { role: "implementer", labels: ["mcp"] },
      now: "2026-06-12T15:01:00.000Z"
    });

    expect(report.presence).toMatchObject({
      agentId: "mcp-agent",
      state: "idle",
      status: "idle",
      message: "No eligible MCP tasks remain."
    });
    expect(report.report).toMatchObject({
      reason: "no_ready_work",
      filters: { role: "implementer", labels: ["mcp"] }
    });

    const saved = JSON.parse(await readFile(path.join(tempDir, "workboard.json"), "utf8"));
    expect(saved.agentPresence["mcp-agent"].noEligibleWork).toMatchObject({
      reason: "no_ready_work"
    });
  });

  it("identifies stale in-progress work from missing slots and stale heartbeats", async () => {
    const project = await store.createProject({ name: "Stale Work Project" });
    await store.acquireAgentSlot({
      agentId: "implementer-backend-1",
      runtimeId: "stale-runtime",
      now: "2026-06-12T15:00:00.000Z"
    });
    await store.acquireAgentSlot({
      agentId: "implementer-backend-2",
      runtimeId: "fresh-runtime",
      now: "2026-06-12T15:10:00.000Z"
    });
    const missingSlotTask = await store.createTask({
      projectId: project.id,
      title: "Assigned to vanished worker",
      status: "in_progress",
      role: "implementer",
      assignee: "implementer-backend-99"
    });
    const expiredHeartbeatTask = await store.createTask({
      projectId: project.id,
      title: "Assigned to expired backend slot",
      status: "in_progress",
      role: "implementer",
      assignee: "implementer-backend-1"
    });
    const freshTask = await store.createTask({
      projectId: project.id,
      title: "Assigned to fresh backend slot",
      status: "in_progress",
      role: "implementer",
      assignee: "implementer-backend-2"
    });

    await store.updateAgentPresence("implementer-backend-2", {
      state: "active",
      currentTaskId: freshTask.id,
      now: "2026-06-12T15:10:30.000Z"
    });

    const stale = store.listStaleInProgressTasks({
      projectId: project.id,
      now: "2026-06-12T15:20:01.000Z"
    });

    expect(stale.tasks.map((item) => item.task.id)).toEqual([missingSlotTask.id, expiredHeartbeatTask.id]);
    expect(stale.tasks[0]).toMatchObject({
      reason: "missing_slot",
      assignee: "implementer-backend-99",
      canAcknowledge: false,
      suggestedActions: ["comment", "requeue", "block"]
    });
    expect(stale.tasks[1]).toMatchObject({
      reason: "expired_heartbeat",
      assignee: "implementer-backend-1",
      canAcknowledge: true,
      suggestedActions: ["comment", "requeue", "block", "acknowledge"]
    });
    expect(stale.tasks[1].lastProgressAt).toBe(expiredHeartbeatTask.updatedAt);
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
