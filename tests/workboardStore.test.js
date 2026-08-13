import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkboardStore } from "../server/storage/workboardStore.js";

let tempDir;
let store;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-"));
  store = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
  await store.init();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("WorkboardStore", () => {
  it("persists deployment process overrides independently of project data", async () => {
    expect(store.getDeploymentSettings()).toEqual({
      processOverrides: "",
      updatedAt: "",
      updatedBy: ""
    });

    const saved = await store.updateDeploymentSettings({
      processOverrides: "\r\n- Deliver through a branch and PR.\r\n- Coordinator merges foundation changes.\r\n",
      actor: "operator-ui"
    });

    expect(saved).toMatchObject({
      processOverrides: "- Deliver through a branch and PR.\n- Coordinator merges foundation changes.",
      updatedBy: "operator-ui"
    });
    expect(saved.updatedAt).toBeTruthy();

    const reloaded = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
    await reloaded.init();
    expect(reloaded.getDeploymentSettings()).toEqual(saved);

    await expect(store.updateDeploymentSettings({ processOverrides: null })).rejects.toMatchObject({ status: 400 });
  });

  it("seeds the DEMO project with a ready first workflow implementation task", () => {
    const demoTasks = store.listTasks({ projectId: "project_demo" });
    const releasePlan = demoTasks.find((task) => task.id === "task_demo_pm");
    const workflowTask = demoTasks.find((task) => task.id === "task_demo_impl");

    expect(releasePlan).toMatchObject({
      title: "Shape the first release plan",
      status: "ready",
      priority: "high",
      role: "pm",
      assignee: "pm-agent"
    });
    expect(workflowTask).toMatchObject({
      title: "Implement the first useful workflow",
      status: "ready",
      priority: "high",
      role: "implementer",
      assignee: "",
      labels: ["mvp", "workflow", "demo"]
    });
    expect(workflowTask.description).toContain("ready task can be claimed");
    expect(workflowTask.description).toContain("done requires a structured completion record");
  });

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

  it("rejects invalid task creation fields instead of silently falling back", async () => {
    const project = await store.createProject({ name: "Task Validation Project", key: "TVP" });

    await expect(
      store.createTask({
        projectId: project.id,
        title: "Invalid status task",
        status: "almost_ready"
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("status")
    });
    await expect(
      store.createTask({
        projectId: project.id,
        title: "Invalid priority task",
        priority: "eventually"
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("priority")
    });
    await expect(
      store.createTask({
        projectId: project.id,
        title: "Invalid role task",
        role: "wizard"
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("role")
    });
    await expect(
      store.createTask({
        projectId: project.id,
        title: "Malformed labels task",
        labels: "backend"
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("labels")
    });
    await expect(
      store.createTask({
        projectId: project.id,
        title: "Too many labels task",
        labels: Array.from({ length: 13 }, (_item, index) => `label-${index}`)
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("labels")
    });
  });

  it("rejects invalid task updates without mutating the task", async () => {
    const project = await store.createProject({ name: "Task Update Validation Project", key: "TUV" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Valid update target",
      status: "ready",
      priority: "normal",
      role: "implementer",
      labels: ["backend"]
    });

    await expect(store.updateTask(task.id, { status: "finished" }, "tester")).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("status")
    });
    await expect(store.updateTask(task.id, { priority: "sometime" }, "tester")).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("priority")
    });
    await expect(store.updateTask(task.id, { role: "dragon" }, "tester")).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("role")
    });
    await expect(store.updateTask(task.id, { title: "   " }, "tester")).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("title")
    });
    await expect(store.updateTask(task.id, { labels: ["backend", ""] }, "tester")).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("labels")
    });
    await expect(
      store.updateTask(
        task.id,
        {
          labels: Array.from({ length: 13 }, (_item, index) => `label-${index}`)
        },
        "tester"
      )
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("labels")
    });

    expect(store.getTask(task.id)).toMatchObject({
      title: "Valid update target",
      status: "ready",
      priority: "normal",
      role: "implementer",
      labels: ["backend"]
    });
  });

  it("stores, filters, migrates, and validates work item types", async () => {
    const project = await store.createProject({ name: "Work Item Type Project" });
    const defaultTask = await store.createTask({
      projectId: project.id,
      title: "Default claimable work"
    });
    const epic = await store.createTask({
      projectId: project.id,
      title: "Roadmap container",
      workItemType: "epic",
      status: "ready",
      role: "implementer",
      labels: ["frontend"]
    });

    expect(defaultTask).toMatchObject({ workItemType: "task" });
    expect(epic).toMatchObject({ workItemType: "epic" });
    expect(store.listTasks({ projectId: project.id, workItemType: "epic" })).toMatchObject([
      {
        id: epic.id,
        workItemType: "epic"
      }
    ]);
    expect(store.listTasks({ projectId: project.id, q: "epic" }).map((task) => task.id)).toContain(epic.id);
    let listError;
    try {
      store.listTasks({ projectId: project.id, workItemType: "idea" });
    } catch (error) {
      listError = error;
    }
    expect(listError).toMatchObject({
      status: 400,
      details: { field: "workItemType" }
    });

    const startingRevision = defaultTask.revision;
    const bug = await store.updateTask(
      defaultTask.id,
      { workItemType: "bug", expectedRevision: startingRevision },
      "operator-ui"
    );
    expect(bug).toMatchObject({ workItemType: "bug", revision: startingRevision + 1 });
    expect(bug.activity[0].message).toContain("workItemType");

    await expect(
      store.createTask({
        projectId: project.id,
        title: "Unknown type",
        workItemType: "idea"
      })
    ).rejects.toMatchObject({
      status: 400,
      details: { field: "workItemType" }
    });
    await expect(
      store.updateTask(defaultTask.id, { workItemType: "idea", expectedRevision: bug.revision }, "operator-ui")
    ).rejects.toMatchObject({
      status: 400,
      details: { field: "workItemType" }
    });

    const raw = JSON.parse(await readFile(path.join(tempDir, "workboard.json"), "utf8"));
    delete raw.tasks.find((item) => item.id === epic.id).workItemType;
    await writeFile(path.join(tempDir, "workboard.json"), JSON.stringify(raw, null, 2));

    const reloaded = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
    await reloaded.init();
    expect(reloaded.getTask(epic.id)).toMatchObject({ workItemType: "task" });
  });

  it("keeps non-claimable container types out of implementer queues while planner decomposers can claim them", async () => {
    const project = await store.createProject({ name: "Work Item Claimability Project" });
    const epic = await store.createTask({
      projectId: project.id,
      title: "Decompose the roadmap epic",
      workItemType: "epic",
      status: "ready",
      role: "implementer",
      labels: ["frontend", "workflow"]
    });
    const bug = await store.createTask({
      projectId: project.id,
      title: "Fix claimable bug",
      workItemType: "bug",
      status: "ready",
      role: "implementer",
      labels: ["frontend"]
    });

    const implementerNext = store.getNextTaskForAgent("implementer-frontend-1", {
      projectId: project.id,
      now: "2026-06-13T20:30:00.000Z"
    });
    expect(implementerNext.task).toMatchObject({ id: bug.id, workItemType: "bug" });
    expect(implementerNext.candidates.map((task) => task.id)).not.toContain(epic.id);

    await expect(
      store.claimTask(epic.id, {
        assignee: "implementer-frontend-1",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
    ).rejects.toMatchObject({
      status: 409,
      details: {
        reason: "work_item_type_not_claimable",
        workItemType: "epic"
      }
    });

    const plannerNext = store.getNextTaskForAgent("planner-agent", {
      projectId: project.id,
      now: "2026-06-13T20:30:00.000Z"
    });
    expect(plannerNext.task).toMatchObject({ id: epic.id, workItemType: "epic" });
    expect(plannerNext.selection.claim).toMatchObject({
      taskId: epic.id,
      assignee: "planner-agent",
      expectedStatus: "ready",
      expectedAssignee: ""
    });
  });

  it("stores, validates, derives, and gates task relationships", async () => {
    const project = await store.createProject({ name: "Relationship Project" });
    const otherProject = await store.createProject({ name: "Other Relationship Project" });
    const foundation = await store.createTask({
      projectId: project.id,
      title: "Ship foundation",
      status: "review",
      role: "implementer",
      labels: ["backend"]
    });
    const parent = await store.createTask({
      projectId: project.id,
      title: "Parent story",
      status: "ready",
      role: "implementer",
      labels: ["backend"]
    });
    const otherTask = await store.createTask({ projectId: otherProject.id, title: "Other project task" });

    const child = await store.createTask({
      projectId: project.id,
      title: "Build child task",
      status: "ready",
      role: "implementer",
      labels: ["backend"],
      parentTaskId: parent.id,
      dependsOn: [foundation.id]
    });

    expect(child).toMatchObject({
      parentTaskId: parent.id,
      dependsOn: [foundation.id],
      blockedBy: [],
      childTaskIds: [],
      blocks: [],
      dependencyStatus: {
        state: "clear",
        satisfiedTaskIds: [foundation.id],
        waitingTaskIds: [],
        blockedTaskIds: [],
        invalidTaskIds: []
      }
    });
    expect(store.getTask(parent.id).childTaskIds).toContain(child.id);
    expect(store.getTask(foundation.id).blocks).toContain(child.id);

    const waiting = await store.createTask({
      projectId: project.id,
      title: "Wait for parent",
      status: "ready",
      role: "implementer",
      labels: ["backend"],
      dependsOn: [parent.id]
    });
    expect(waiting.dependencyStatus).toMatchObject({
      state: "waiting",
      waitingTaskIds: [parent.id]
    });
    expect(
      store.getNextTaskForAgent("implementer-backend-2", {
        projectId: project.id,
        labels: "backend",
        now: "2026-06-13T21:00:00.000Z"
      }).candidates.map((task) => task.id)
    ).not.toContain(waiting.id);

    const reviewedParent = await store.updateTask(parent.id, { status: "review" }, "operator-ui");
    expect(reviewedParent.blocks).toContain(waiting.id);
    expect(store.getTask(waiting.id).dependencyStatus).toMatchObject({
      state: "clear",
      satisfiedTaskIds: [parent.id]
    });
    expect(
      store.getNextTaskForAgent("implementer-backend-2", {
        projectId: project.id,
        labels: "backend",
        now: "2026-06-13T21:00:00.000Z"
      }).candidates.map((task) => task.id)
    ).toContain(waiting.id);

    const blocked = await store.createTask({
      projectId: project.id,
      title: "Blocked by child",
      status: "ready",
      role: "implementer",
      labels: ["backend"],
      blockedBy: [child.id]
    });
    expect(blocked.dependencyStatus).toMatchObject({
      state: "blocked",
      blockedTaskIds: [child.id]
    });

    await expect(
      store.updateTask(child.id, { dependsOn: [child.id], expectedRevision: child.revision }, "operator-ui")
    ).rejects.toMatchObject({
      status: 400,
      details: { field: "dependsOn", reason: "self_link" }
    });
    await expect(
      store.updateTask(child.id, { dependsOn: [otherTask.id], expectedRevision: child.revision }, "operator-ui")
    ).rejects.toMatchObject({
      status: 400,
      details: { field: "dependsOn", reason: "cross_project" }
    });
    await expect(
      store.updateTask(parent.id, { parentTaskId: child.id, expectedRevision: reviewedParent.revision }, "operator-ui")
    ).rejects.toMatchObject({
      status: 400,
      details: { field: "parentTaskId", reason: "cycle" }
    });
    await expect(
      store.updateTask(parent.id, { dependsOn: [waiting.id], expectedRevision: reviewedParent.revision }, "operator-ui")
    ).rejects.toMatchObject({
      status: 400,
      details: { field: "dependsOn", reason: "cycle" }
    });

    const raw = JSON.parse(await readFile(path.join(tempDir, "workboard.json"), "utf8"));
    delete raw.tasks.find((item) => item.id === parent.id).dependsOn;
    delete raw.tasks.find((item) => item.id === parent.id).blockedBy;
    delete raw.tasks.find((item) => item.id === parent.id).parentTaskId;
    await writeFile(path.join(tempDir, "workboard.json"), JSON.stringify(raw, null, 2));

    const reloaded = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
    await reloaded.init();
    expect(reloaded.getTask(parent.id)).toMatchObject({
      dependsOn: [],
      blockedBy: [],
      parentTaskId: ""
    });
  });

  it("links create-time childTaskIds to existing children", async () => {
    const project = await store.createProject({ name: "Create Child Relationship Project" });
    const child = await store.createTask({
      projectId: project.id,
      title: "Existing child",
      status: "ready",
      role: "implementer",
      labels: ["backend"]
    });

    const parent = await store.createTask({
      projectId: project.id,
      title: "New parent",
      status: "ready",
      role: "implementer",
      labels: ["backend"],
      childTaskIds: [child.id],
      actor: "operator-ui"
    });

    expect(parent.childTaskIds).toEqual([child.id]);
    expect(store.getTask(child.id)).toMatchObject({
      parentTaskId: parent.id
    });
    expect(store.getTask(child.id).activity[0]).toMatchObject({
      actor: "operator-ui",
      message: `Updated parentTaskId:${parent.id}.`
    });
  });

  it("rebuilds task relationship derivatives when importing project backups", async () => {
    const projectId = "project_relationship_import";
    const parentId = "task_relationship_import_parent";
    const childId = "task_relationship_import_child";

    await store.importProjectBackup({
      packageType: "agent-workboard.project-backup",
      packageVersion: 1,
      exportedAt: "2026-06-13T00:00:00.000Z",
      project: {
        id: projectId,
        key: "RELIMPORT",
        name: "Relationship Import",
        description: "",
        createdAt: "2026-06-13T00:00:00.000Z",
        updatedAt: "2026-06-13T00:00:00.000Z",
        archived: false
      },
      tasks: [
        {
          id: parentId,
          projectId,
          title: "Imported prerequisite",
          description: "",
          status: "ready",
          priority: "normal",
          role: "implementer",
          workItemType: "task",
          assignee: "",
          labels: ["backend"],
          createdAt: "2026-06-13T00:00:00.000Z",
          updatedAt: "2026-06-13T00:00:00.000Z",
          revision: 1,
          comments: [],
          attachments: [],
          activity: []
        },
        {
          id: childId,
          projectId,
          title: "Imported dependent child",
          description: "",
          status: "ready",
          priority: "normal",
          role: "implementer",
          workItemType: "task",
          dependsOn: [parentId],
          parentTaskId: parentId,
          assignee: "",
          labels: ["backend"],
          createdAt: "2026-06-13T00:00:00.000Z",
          updatedAt: "2026-06-13T00:00:00.000Z",
          revision: 1,
          comments: [],
          attachments: [],
          activity: []
        }
      ],
      events: []
    });

    expect(store.getTask(parentId)).toMatchObject({
      blocks: [childId],
      childTaskIds: [childId]
    });
    expect(store.getTask(childId).dependencyStatus).toMatchObject({
      state: "waiting",
      waitingTaskIds: [parentId]
    });
    expect(
      store.getNextTaskForAgent("implementer-backend-2", {
        projectId,
        labels: "backend",
        now: "2026-06-13T21:00:00.000Z"
      }).candidates.map((task) => task.id)
    ).not.toContain(childId);
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

  it.each(["no-code", "audit-only", "superseded"])(
    "does not report capability status drift for a done %s task",
    async (completionType) => {
      const project = await store.createProject({ name: `Non-shipping ${completionType} Capability Project` });
      const task = await store.createTask({
        projectId: project.id,
        title: `Close ${completionType} work without shipping implementation`,
        status: "done",
        role: "implementer",
        completion: {
          completionType,
          notes: `${completionType} work intentionally shipped no implementation.`
        }
      });
      const capability = await store.createCapability({
        id: `cap_non_shipping_${completionType.replace(/-/g, "_")}`,
        projectId: project.id,
        name: `Non-shipping ${completionType} capability`,
        summary: "A planned capability must not drift without merged implementation evidence.",
        status: "planned",
        relatedTaskIds: [task.id]
      });

      expect(store.getCapability(capability.id)).toMatchObject({
        linkedTasks: [{ id: task.id, status: "done", completionType }],
        statusDrift: {
          detected: false,
          reason: "",
          completedTaskIds: [],
          summary: ""
        }
      });
    }
  );

  it("records status changes, comments, and persisted data", async () => {
    const project = await store.createProject({ name: "Release Train" });
    const task = await store.createTask({ projectId: project.id, title: "Ship notes", role: "pm" });

    await store.updateTask(task.id, { status: "review", assignee: "review-agent", expectedRevision: task.revision }, "pm-agent");
    await store.addComment(task.id, { author: "review-agent", body: "Needs one acceptance check." });

    const saved = JSON.parse(await readFile(path.join(tempDir, "workboard.json"), "utf8"));
    const savedTask = saved.tasks.find((item) => item.id === task.id);

    expect(savedTask.status).toBe("review");
    expect(savedTask.assignee).toBe("review-agent");
    expect(savedTask.comments[0]).toMatchObject({ author: "review-agent" });
    expect(savedTask.activity[0].type).toBe("commented");
  });

  it("rejects stale full task edits and records the rejection reason", async () => {
    const project = await store.createProject({ name: "Revision Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Original title",
      role: "implementer",
      status: "ready",
      assignee: "implementer-backend-1"
    });
    const startingRevision = task.revision;

    const firstSave = await store.updateTask(
      task.id,
      { title: "Client A title", expectedRevision: startingRevision },
      "operator-a"
    );

    expect(firstSave.revision).toBe(startingRevision + 1);

    await expect(
      store.updateTask(task.id, { title: "Client B title", expectedRevision: startingRevision }, "operator-b")
    ).rejects.toMatchObject({
      status: 409,
      details: {
        taskId: task.id,
        expectedRevision: startingRevision,
        currentRevision: firstSave.revision
      }
    });

    const current = store.getTask(task.id);
    expect(current).toMatchObject({
      title: "Client A title",
      revision: firstSave.revision
    });
    expect(current.activity[0]).toMatchObject({
      actor: "operator-b",
      type: "update.rejected"
    });
    expect(current.activity[0].message).toMatch(/expected revision 1, found 2/i);
  });

  it("lists project activity across project and task audit events", async () => {
    const project = await store.createProject({ name: "Audit Feed Project", actor: "pm-agent" });
    const otherProject = await store.createProject({ name: "Other Audit Feed Project", actor: "other-agent" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Ship audit trail",
      status: "ready",
      assignee: "",
      role: "implementer",
      actor: "pm-agent"
    });
    await store.createTask({
      projectId: otherProject.id,
      title: "Wrong project audit noise",
      actor: "other-agent"
    });

    const staleRevision = task.revision;
    await store.claimTask(task.id, {
      assignee: "implementer-backend-1",
      expectedStatus: "ready",
      expectedAssignee: "",
      actor: "implementer-backend-1"
    });
    await expect(
      store.updateTask(task.id, { title: "Stale audit title", expectedRevision: staleRevision }, "operator-stale")
    ).rejects.toMatchObject({ status: 409 });
    await store.addComment(task.id, { author: "reviewer-agent", body: "Audit evidence comment." });
    await store.addAttachment(
      task.id,
      {
        buffer: Buffer.from("audit evidence\n"),
        originalname: "audit-note.txt",
        mimetype: "text/plain",
        size: Buffer.byteLength("audit evidence\n")
      },
      "tester-agent"
    );
    await store.requestOperatorApproval(task.id, {
      requestedBy: "implementer-backend-1",
      reason: "Need operator approval before audit release.",
      requestedAction: "Approve audit release",
      nextStatus: "in_progress"
    });

    const activity = store.listProjectActivity({ projectId: project.id, limit: 50 });
    expect(activity.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "project.created",
        "created",
        "claimed",
        "update.rejected",
        "commented",
        "attachment.added",
        "approval.requested"
      ])
    );
    expect(activity).not.toContainEqual(expect.objectContaining({ projectId: otherProject.id }));
    expect(activity.find((event) => event.type === "project.created")).toMatchObject({
      projectId: project.id,
      source: "project",
      taskId: "",
      taskTitle: ""
    });
    expect(activity.find((event) => event.type === "claimed")).toMatchObject({
      source: "task",
      taskId: task.id,
      taskTitle: "Ship audit trail",
      taskStatus: "blocked",
      taskAssignee: "implementer-backend-1"
    });
    expect(activity[0].createdAt >= activity[1].createdAt).toBe(true);

    expect(store.listProjectActivity({ projectId: project.id, type: "commented" })).toMatchObject([
      {
        type: "commented",
        actor: "reviewer-agent",
        taskId: task.id
      }
    ]);
    expect(store.listProjectActivity({ projectId: project.id, q: "operator approval before audit release" })).toMatchObject([
      {
        type: "approval.requested",
        taskId: task.id
      }
    ]);
    expect(store.listProjectActivity({ projectId: project.id, limit: 2 })).toHaveLength(2);
  });

  it("requires an expected revision for full task edits", async () => {
    const project = await store.createProject({ name: "Revision Required Project" });
    const task = await store.createTask({ projectId: project.id, title: "Needs guarded edits" });

    await expect(store.updateTask(task.id, { description: "Unguarded drawer save" }, "operator-a")).rejects.toMatchObject({
      status: 400,
      details: {
        taskId: task.id,
        currentRevision: task.revision
      }
    });
  });

  it("advances revisions for operator approval mutations before stale full edits", async () => {
    const project = await store.createProject({ name: "Approval Revision Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Approval guarded by revision",
      status: "in_progress",
      role: "implementer",
      assignee: "implementer-01"
    });
    const startingRevision = task.revision;

    const requested = await store.requestOperatorApproval(task.id, {
      requestedBy: "implementer-01",
      reason: "Need approval before review.",
      requestedAction: "Approve review handoff.",
      nextStatus: "review"
    });

    expect(requested.revision).toBe(startingRevision + 1);
    const requestedRevision = requested.revision;
    await expect(
      store.updateTask(task.id, { title: "Stale after request", expectedRevision: startingRevision }, "operator-stale")
    ).rejects.toMatchObject({
      status: 409,
      details: {
        taskId: task.id,
        expectedRevision: startingRevision,
        currentRevision: requestedRevision
      }
    });

    const approved = await store.decideOperatorApproval(task.id, {
      decision: "approved",
      decidedBy: "operator",
      note: "Approved after stale save was rejected.",
      nextStatus: "review"
    });

    expect(approved.revision).toBe(requestedRevision + 1);
    await expect(
      store.updateTask(task.id, { title: "Stale after approval", expectedRevision: requestedRevision }, "operator-stale")
    ).rejects.toMatchObject({
      status: 409,
      details: {
        taskId: task.id,
        expectedRevision: requestedRevision,
        currentRevision: approved.revision
      }
    });
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

  it("creates structured operator approval blockers and lists pending approvals", async () => {
    const project = await store.createProject({ name: "Approval Queue Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Commit finished implementation",
      role: "implementer",
      status: "in_progress",
      assignee: "implementer-01"
    });
    await store.addComment(task.id, { author: "implementer-01", body: "Tests and browser smoke are green." });

    const blocked = await store.requestOperatorApproval(task.id, {
      requestedBy: "implementer-01",
      reason: "Need operator approval before committing the verified diff.",
      requestedAction: "Approve commit `feat: ship implementation`.",
      nextStatus: "review"
    });

    expect(store.blockerTypes()).toEqual(
      expect.arrayContaining(["operator_approval", "dependency", "external_issue", "waiting_for_agent", "unclear_scope", "other"])
    );
    expect(blocked).toMatchObject({
      status: "blocked",
      blocker: {
        type: "operator_approval",
        status: "pending",
        reason: "Need operator approval before committing the verified diff.",
        requestedAction: "Approve commit `feat: ship implementation`.",
        nextStatus: "review",
        requestedBy: "implementer-01"
      }
    });
    expect(blocked.approvalHistory[0]).toMatchObject({
      decision: "requested",
      blockerType: "operator_approval",
      requestedBy: "implementer-01"
    });

    const pending = store.listOperatorApprovals({ projectId: project.id });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      task: {
        id: task.id,
        title: "Commit finished implementation"
      },
      blocker: {
        requestedAction: "Approve commit `feat: ship implementation`."
      },
      latestComment: {
        author: "implementer-01",
        body: "Tests and browser smoke are green."
      }
    });
  });

  it("approves operator approval blockers and preserves audit history", async () => {
    const project = await store.createProject({ name: "Approval Decision Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Hand approved work to review",
      status: "in_progress",
      assignee: "implementer-01"
    });
    await store.requestOperatorApproval(task.id, {
      requestedBy: "implementer-01",
      reason: "Verified and waiting to commit.",
      requestedAction: "Commit and move to review.",
      nextStatus: "review"
    });

    const approved = await store.decideOperatorApproval(task.id, {
      decision: "approved",
      decidedBy: "operator",
      note: "Commit approved.",
      nextStatus: "review"
    });

    expect(approved).toMatchObject({
      status: "review",
      blocker: null
    });
    expect(approved.approvalHistory[0]).toMatchObject({
      decision: "approved",
      decidedBy: "operator",
      note: "Commit approved.",
      nextStatus: "review"
    });
    expect(approved.comments[0]).toMatchObject({
      author: "operator",
      body: expect.stringContaining("approved")
    });
    expect(store.listOperatorApprovals({ projectId: project.id })).toEqual([]);
  });

  it("requires rejection notes and keeps rejected approvals auditable", async () => {
    const project = await store.createProject({ name: "Rejected Approval Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Needs more evidence",
      status: "in_progress",
      assignee: "implementer-01"
    });
    await store.requestOperatorApproval(task.id, {
      requestedBy: "implementer-01",
      reason: "Need approval.",
      requestedAction: "Commit now."
    });

    await expect(
      store.decideOperatorApproval(task.id, {
        decision: "rejected",
        decidedBy: "operator"
      })
    ).rejects.toMatchObject({ status: 400 });

    const rejected = await store.decideOperatorApproval(task.id, {
      decision: "rejected",
      decidedBy: "operator",
      note: "Please add browser evidence first."
    });

    expect(rejected).toMatchObject({
      status: "blocked",
      blocker: {
        type: "operator_approval",
        status: "rejected"
      }
    });
    expect(rejected.approvalHistory[0]).toMatchObject({
      decision: "rejected",
      decidedBy: "operator",
      note: "Please add browser evidence first."
    });
    expect(store.listOperatorApprovals({ projectId: project.id })).toEqual([]);
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
      store.updateTask(task.id, { status: "done", title: "Should not mutate", expectedRevision: task.revision }, "reviewer-01")
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
          expectedRevision: task.revision,
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

    const reloaded = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
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
      assignee: "implementer-backend-1"
    });

    const claimed = await store.claimTask(task.id, {
      assignee: "implementer-backend-2",
      actor: "implementer-backend-2",
      expectedStatus: "ready",
      expectedAssignee: "implementer-backend-1"
    });

    expect(claimed).toMatchObject({
      id: task.id,
      status: "in_progress",
      assignee: "implementer-backend-2"
    });
    expect(claimed.activity[0]).toMatchObject({
      actor: "implementer-backend-2",
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
      assignee: "implementer-backend-1",
      expectedStatus: "ready",
      expectedAssignee: ""
    });

    await expect(
      store.claimTask(task.id, {
        assignee: "implementer-backend-2",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rejects a second active claim for one-active-at-a-time agents", async () => {
    const project = await store.createProject({ name: "Single Active Claim Project" });
    const active = await store.createTask({
      projectId: project.id,
      title: "Already in progress",
      status: "in_progress",
      role: "implementer",
      assignee: "mcp-agent"
    });
    const next = await store.createTask({
      projectId: project.id,
      title: "Second active claim",
      status: "ready",
      role: "implementer",
      assignee: ""
    });

    await expect(
      store.claimTask(next.id, {
        assignee: "mcp-agent",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining(active.id)
    });
    await expect(
      store.claimTask(next.id, {
        assignee: "mcp-agent",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
    ).rejects.toThrow(/finish, hand off, or requeue/i);
  });

  it("lets one-active-at-a-time agents claim work when their previous task is only in review", async () => {
    const project = await store.createProject({ name: "Review Does Not Block Claims Project" });
    await store.createTask({
      projectId: project.id,
      title: "Implementation awaiting review",
      status: "review",
      role: "implementer",
      assignee: "implementer-backend-1"
    });
    const next = await store.createTask({
      projectId: project.id,
      title: "Next implementation task",
      status: "ready",
      role: "implementer",
      assignee: ""
    });

    const claimed = await store.claimTask(next.id, {
      assignee: "implementer-backend-1",
      expectedStatus: "ready",
      expectedAssignee: ""
    });

    expect(claimed).toMatchObject({
      id: next.id,
      status: "in_progress",
      assignee: "implementer-backend-1"
    });
  });

  it("rejects slot-managed role-type task claims before they bypass slot accounting", async () => {
    const project = await store.createProject({ name: "Role Type Claim Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Review with a slot",
      status: "ready",
      role: "reviewer",
      assignee: ""
    });

    await expect(
      store.claimTask(task.id, {
        assignee: "reviewer",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
    ).rejects.toMatchObject({
      status: 409,
      details: {
        agentId: "reviewer",
        typeId: "reviewer",
        suggestedSlotIds: ["reviewer-agent", "reviewer-agent-2"]
      }
    });

    expect(store.getTask(task.id)).toMatchObject({
      status: "ready",
      assignee: ""
    });

    const claimed = await store.claimTask(task.id, {
      assignee: "reviewer-agent",
      expectedStatus: "ready",
      expectedAssignee: ""
    });

    expect(claimed).toMatchObject({
      status: "in_progress",
      assignee: "reviewer-agent"
    });
  });

  it("rejects slot-managed task claims from non-configured slot assignees", async () => {
    const project = await store.createProject({ name: "Non Slot Claim Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Reviewer must use configured slot",
      status: "ready",
      role: "reviewer",
      assignee: ""
    });

    await expect(
      store.claimTask(task.id, {
        assignee: "reviewer-01",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
    ).rejects.toMatchObject({
      status: 409,
      details: {
        agentId: "reviewer-01",
        role: "reviewer",
        typeId: "reviewer",
        suggestedSlotIds: ["reviewer-agent", "reviewer-agent-2"]
      }
    });

    expect(store.getTask(task.id)).toMatchObject({
      status: "ready",
      assignee: ""
    });
  });

  it("allows explicitly assigned non-slot assignees to claim their assigned task", async () => {
    const project = await store.createProject({ name: "Operator Assigned Non Slot Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Operator assigned temporary worker",
      status: "ready",
      role: "implementer",
      assignee: "implementer-1"
    });

    const claimed = await store.claimTask(task.id, {
      assignee: "implementer-1",
      expectedStatus: "ready",
      expectedAssignee: "implementer-1"
    });

    expect(claimed).toMatchObject({
      status: "in_progress",
      assignee: "implementer-1"
    });
  });

  it("lets only one store instance claim a task from a shared data directory", async () => {
    const project = await store.createProject({ name: "Shared Store Claim Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Race on disk",
      status: "ready",
      assignee: ""
    });

    const firstStore = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
    const secondStore = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
    await firstStore.init();
    await secondStore.init();

    const results = await Promise.allSettled([
      firstStore.claimTask(task.id, { assignee: "implementer-backend-1", expectedStatus: "ready", expectedAssignee: "" }),
      secondStore.claimTask(task.id, { assignee: "implementer-backend-2", expectedStatus: "ready", expectedAssignee: "" })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected").reason).toMatchObject({ status: 409 });

    const saved = JSON.parse(await readFile(path.join(tempDir, "workboard.json"), "utf8"));
    const savedTask = saved.tasks.find((item) => item.id === task.id);

    expect(savedTask.status).toBe("in_progress");
    expect(["implementer-backend-1", "implementer-backend-2"]).toContain(savedTask.assignee);
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

  it("reports untracked in-progress role-type assignees in the slot registry", async () => {
    const project = await store.createProject({ name: "Untracked Slot Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Invisible reviewer claim",
      status: "in_progress",
      role: "reviewer",
      assignee: "reviewer"
    });

    const registry = store.listAgentSlots({ now: "2026-06-12T15:00:00.000Z" });

    expect(registry.types.find((type) => type.id === "reviewer")).toMatchObject({
      active: 0,
      available: 2
    });
    expect(registry.untrackedInProgressAssignees).toEqual([
      expect.objectContaining({
        assignee: "reviewer",
        role: "reviewer",
        typeId: "reviewer",
        inProgressTaskCount: 1,
        taskIds: [task.id],
        suggestedSlotIds: ["reviewer-agent", "reviewer-agent-2"]
      })
    ]);
  });

  it("lets two store instances acquire distinct slots from a shared data directory", async () => {
    const firstStore = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
    const secondStore = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
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
        const nextStore = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
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

  it("reclaims the same slot on restart via a client-persistable identity token", async () => {
    const project = await store.createProject({ name: "Restart Reclaim Project" });
    const acquired = await store.acquireAgentSlot({
      preferredType: "implementer-backend",
      runtimeId: "first-runtime",
      now: "2026-06-01T10:00:00.000Z"
    });
    expect(acquired).toMatchObject({ agentId: "implementer-backend-1", reclaimed: false });
    expect(acquired.identityToken).toBeTruthy();

    // Keep the slot busy with in-progress work that a restarted agent should resume.
    const task = await store.createTask({
      projectId: project.id,
      title: "Resume me after restart",
      status: "in_progress",
      assignee: acquired.agentId
    });

    // Restart = new runtimeId but same persisted identityToken. Lease is stale.
    const restarted = await store.acquireAgentSlot({
      preferredType: "implementer-backend",
      runtimeId: "second-runtime",
      identityToken: acquired.identityToken,
      now: "2026-06-01T15:00:00.000Z"
    });
    expect(restarted).toMatchObject({
      agentId: acquired.agentId,
      reclaimed: true,
      reclaimedViaIdentity: true,
      identityToken: acquired.identityToken
    });
    expect(restarted.lease.runtimeId).toBe("second-runtime");
    expect(store.getTask(task.id)).toMatchObject({ status: "in_progress", assignee: acquired.agentId });
  });

  it("resolves identity tokens globally before inferred type selection", async () => {
    const project = await store.createProject({ name: "Token-only Restart Project" });
    const acquired = await store.acquireAgentSlot({
      preferredType: "implementer-backend",
      runtimeId: "token-only-first-runtime",
      now: "2026-06-01T10:00:00.000Z"
    });
    await store.createTask({
      projectId: project.id,
      title: "Resume token-only restart",
      status: "in_progress",
      assignee: acquired.agentId
    });

    const restarted = await store.acquireAgentSlot({
      identityToken: acquired.identityToken,
      runtimeId: "token-only-second-runtime",
      now: "2026-06-01T15:00:00.000Z"
    });

    expect(restarted).toMatchObject({
      agentId: "implementer-backend-1",
      typeId: "implementer-backend",
      identityToken: acquired.identityToken,
      reclaimed: true,
      reclaimedViaIdentity: true
    });
  });

  it("refuses identity reclaim over a fresh heartbeating lease (live duplicate)", async () => {
    const acquired = await store.acquireAgentSlot({
      preferredType: "implementer-backend",
      runtimeId: "live-runtime",
      now: "2026-06-12T15:00:00.000Z"
    });

    await expect(
      store.acquireAgentSlot({
        preferredType: "implementer-backend",
        runtimeId: "duplicate-runtime",
        identityToken: acquired.identityToken,
        now: "2026-06-12T15:02:00.000Z"
      })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("already active")
    });
  });

  it("rejects requested roles without a configured slot pool", async () => {
    for (const role of ["researcher", "arbitrary-unknown-role"]) {
      await expect(
        store.acquireAgentSlot({
          role,
          runtimeId: `invalid-role-${role}`,
          now: "2026-06-12T15:00:00.000Z"
        })
      ).rejects.toMatchObject({
        status: 400,
        message: expect.stringMatching(/configured.*valid roles/i),
        details: {
          role,
          validRoles: ["implementer", "pm", "reviewer", "tester"]
        }
      });
    }
  });

  it("spills over to sibling types of the same role (ordered by free seats) for inferred acquires", async () => {
    for (let i = 0; i < 4; i++) {
      await store.acquireAgentSlot({
        preferredType: "implementer-backend",
        runtimeId: `fill-backend-${i + 1}`
      });
    }

    // Inferred (bare role, no preferred type) when backend is full spills to a sibling
    // implementer type rather than failing.
    const spilled = await store.acquireAgentSlot({
      role: "implementer",
      specialties: ["backend"],
      runtimeId: "spill-runtime"
    });
    expect(spilled.typeId).not.toBe("implementer-backend");
    expect(spilled.agentId).not.toMatch(/^implementer-backend/);
    expect(store.data.agentTypes.find((t) => t.id === spilled.typeId).role).toBe("implementer");
    expect(spilled).toMatchObject({ acquired: true });
  });

  it("reports an honest exhausted error naming leased slots and earliest expiry", async () => {
    for (let i = 0; i < 4; i++) {
      await store.acquireAgentSlot({ preferredType: "implementer-backend", runtimeId: `full-${i + 1}`, now: "2026-06-12T15:00:00.000Z" });
    }

    let error;
    try {
      // Same lease window so the pool is genuinely at capacity (fresh leases).
      await store.acquireAgentSlot({ preferredType: "implementer-backend", runtimeId: "over", now: "2026-06-12T15:10:00.000Z" });
    } catch (caught) {
      error = caught;
    }
    expect(error.status).toBe(409);
    expect(error.message).toContain("implementer-backend");
    expect(error.message).toMatch(/lease/);
    expect(error.details.leasedSlots).toHaveLength(4);
    expect(error.details.leasedSlots[0]).toMatchObject({
      agentId: "implementer-backend-1"
    });
    expect(error.details.leasedSlots[0].expiresAt).toBeTruthy();
    expect(error.details.earliestFreeAt).toBeTruthy();
    expect(error.details.staleLeaseCount).toBe(0);
  });

  it("drops stale presence older than the retention window from presence listings", async () => {
    await store.acquireAgentSlot({ preferredType: "implementer-backend", runtimeId: "presence-fresh" });
    await store.updateAgentPresence("implementer-backend-1", {
      state: "active",
      message: "fresh heartbeat",
      now: "2026-06-10T12:00:00.000Z"
    });

    // Same day - within retention window, still listed.
    expect(
      store.listAgentPresence({ now: "2026-06-10T18:00:00.000Z" }).map((p) => p.agentId)
    ).toContain("implementer-backend-1");

    // Two days later - beyond the 24h retention window, dropped from the response.
    expect(
      store.listAgentPresence({ now: "2026-06-12T12:00:00.000Z" }).map((p) => p.agentId)
    ).not.toContain("implementer-backend-1");

    // But the raw presence record is retained in the data store (history is preserved).
    expect(store.data.agentPresence["implementer-backend-1"]).toBeTruthy();
  });

  it("force-releases a slot: returns in-progress claims to ready, keeps review work, clears presence", async () => {
    const project = await store.createProject({ name: "Force Release Project" });
    await store.acquireAgentSlot({ agentId: "implementer-backend-1", runtimeId: "release-runtime", now: "2026-06-12T15:00:00.000Z" });
    const inProgress = await store.createTask({
      projectId: project.id,
      title: "Return me",
      status: "in_progress",
      assignee: "implementer-backend-1",
      role: "implementer",
      now: "2026-06-12T15:00:00.000Z"
    });
    const inReview = await store.createTask({
      projectId: project.id,
      title: "Keep review state",
      status: "review",
      assignee: "implementer-backend-1",
      role: "implementer",
      now: "2026-06-12T15:00:00.000Z"
    });
    await store.updateAgentPresence("implementer-backend-1", { state: "active", now: "2026-06-12T15:00:00.000Z" });

    const result = await store.forceReleaseAgentSlot("implementer-backend-1", {
      actor: "operator",
      now: "2026-06-12T15:10:00.000Z"
    });

    expect(result).toMatchObject({ released: true, agentId: "implementer-backend-1", wasActive: true });
    expect(result.returnedTasks.map((task) => task.taskId)).toEqual([inProgress.id]);
    expect(store.getTask(inProgress.id)).toMatchObject({ status: "ready", assignee: "" });
    expect(store.getTask(inProgress.id).activity[0]).toMatchObject({
      type: "force_release.returned",
      message: "Force-released by operator; task returned to queue."
    });
    expect(store.getTask(inReview.id)).toMatchObject({ status: "review", assignee: "implementer-backend-1" });
    expect(store.data.agentPresence["implementer-backend-1"]).toBeUndefined();
    expect(store.data.agentSlots.find((s) => s.id === "implementer-backend-1").lease).toBeNull();
  });

  it("no-ops a stale rendered recovery after the task is reclaimed", async () => {
    const project = await store.createProject({ name: "Recovery Race Project" });
    await store.acquireAgentSlot({
      agentId: "implementer-backend-1",
      activeProjectId: project.id,
      runtimeId: "recovery-race-runtime",
      now: "2026-06-12T15:00:00.000Z"
    });
    const ready = await store.createTask({
      projectId: project.id,
      title: "Do not steal the fresh claim",
      status: "ready",
      role: "implementer",
      now: "2026-06-12T15:00:00.000Z"
    });
    const firstClaim = await store.claimTask(ready.id, {
      assignee: "implementer-backend-1",
      actor: "implementer-backend-1",
      expectedStatus: "ready",
      expectedAssignee: "",
      now: "2026-06-12T15:00:01.000Z"
    });
    const rendered = store.listStaleInProgressTasks({ projectId: project.id, now: "2026-06-12T15:20:00.000Z" }).tasks[0];
    expect(rendered.claim).toMatchObject({ assignee: "implementer-backend-1", revision: firstClaim.revision });

    const returned = await store.updateTask(
      ready.id,
      {
        status: "ready",
        assignee: "",
        expectedRevision: firstClaim.revision,
        actor: "system-recovery"
      },
      "system-recovery"
    );
    const freshClaim = await store.claimTask(ready.id, {
      assignee: "implementer-backend-1",
      actor: "implementer-backend-1",
      expectedStatus: "ready",
      expectedAssignee: "",
      now: "2026-06-12T15:20:02.000Z"
    });
    expect(freshClaim.revision).toBeGreaterThan(returned.revision);

    const result = await store.recoverStaleInProgressTask(ready.id, {
      action: "requeue",
      actor: "operator",
      expectedRevision: rendered.claim.revision,
      expectedAssignee: rendered.claim.assignee,
      expectedClaimedAt: rendered.claim.claimedAt,
      now: "2026-06-12T15:20:03.000Z"
    });

    expect(result).toMatchObject({
      applied: false,
      reason: "claim_changed",
      notice: expect.stringContaining("nothing was changed")
    });
    expect(store.getTask(ready.id)).toMatchObject({
      status: "in_progress",
      assignee: "implementer-backend-1",
      revision: freshClaim.revision
    });
  });

  it("no-ops force release when the rendered lease instance changed", async () => {
    await store.acquireAgentSlot({
      agentId: "implementer-backend-1",
      runtimeId: "fresh-runtime",
      now: "2026-06-12T15:00:00.000Z"
    });
    const result = await store.forceReleaseAgentSlot("implementer-backend-1", {
      actor: "operator",
      expectedRuntimeId: "stale-runtime",
      expectedAcquiredAt: "2026-06-12T14:59:00.000Z",
      now: "2026-06-12T15:01:00.000Z"
    });
    expect(result).toMatchObject({ released: false, applied: false, reason: "lease_changed" });
    expect(store.data.agentSlots.find((slot) => slot.id === "implementer-backend-1").lease.runtimeId).toBe("fresh-runtime");
  });

  it("defaults bootstrapped agents to their active project and only searches all projects when requested", async () => {
    store = new WorkboardStore({ dataDir: tempDir, storageMode: "json", defaultProjectKey: "TEAM" });
    await store.init();
    const team = await store.createProject({ name: "Team Board", key: "TEAM" });
    const teamTask = await store.createTask({
      projectId: team.id,
      title: "TEAM MCP work",
      status: "ready",
      priority: "normal",
      role: "implementer",
      assignee: "mcp-agent",
      labels: ["mcp"]
    });
    const demoTask = await store.createTask({
      projectId: "project_demo",
      title: "DEMO MCP work should not leak",
      status: "ready",
      priority: "urgent",
      role: "implementer",
      assignee: "mcp-agent",
      labels: ["mcp"]
    });

    const acquired = await store.acquireAgentSlot({
      agentId: "mcp-agent",
      runtimeId: "runtime-project-scope",
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(acquired).toMatchObject({
      agentId: "mcp-agent",
      activeProjectId: team.id,
      activeProject: {
        id: team.id,
        key: "TEAM",
        name: "Team Board"
      }
    });
    expect(acquired.nextTask).toMatchObject({
      projectId: team.id
    });

    const scopedNext = store.getNextTaskForAgent("mcp-agent", {
      now: "2026-06-12T15:01:00.000Z"
    });
    expect(scopedNext.agent).toMatchObject({
      activeProjectId: team.id,
      activeProject: {
        key: "TEAM"
      }
    });
    expect(scopedNext.task).toMatchObject({ id: teamTask.id });
    expect(scopedNext.candidates.map((candidate) => candidate.id)).not.toContain(demoTask.id);

    const allProjectsNext = store.getNextTaskForAgent("mcp-agent", {
      allProjects: true,
      now: "2026-06-12T15:01:00.000Z"
    });
    expect(allProjectsNext.task).toMatchObject({ id: demoTask.id });
    expect(allProjectsNext.selection).toMatchObject({
      projectScope: "all"
    });
  });

  it("rejects bootstrapped cross-project claims unless an override reason is supplied", async () => {
    const team = await store.createProject({ name: "Team Board", key: "TEAM" });
    const demoTask = await store.createTask({
      projectId: "project_demo",
      title: "DEMO task outside active project",
      status: "ready",
      priority: "urgent",
      role: "implementer",
      labels: ["mcp"]
    });

    await store.acquireAgentSlot({
      agentId: "mcp-agent",
      activeProjectId: team.id,
      runtimeId: "runtime-claim-scope",
      now: "2026-06-12T15:00:00.000Z"
    });

    await expect(
      store.claimTask(demoTask.id, {
        assignee: "mcp-agent",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
    ).rejects.toMatchObject({
      status: 409,
      details: {
        activeProjectId: team.id,
        taskProjectId: "project_demo"
      }
    });

    const claimed = await store.claimTask(demoTask.id, {
      assignee: "mcp-agent",
      expectedStatus: "ready",
      expectedAssignee: "",
      projectOverrideReason: "Operator asked mcp-agent to rescue the demo task."
    });
    expect(claimed).toMatchObject({
      id: demoTask.id,
      status: "in_progress",
      assignee: "mcp-agent"
    });
    expect(claimed.activity[0].message).toContain("Operator asked mcp-agent to rescue the demo task.");
  });

  it("routes decomposition-needed containers only to planner decomposer slots", async () => {
    const project = await store.createProject({ name: "Planner Routing Project" });
    const container = await store.createTask({
      projectId: project.id,
      title: "Break down the OSS roadmap epic",
      status: "ready",
      priority: "urgent",
      role: "implementer",
      labels: ["mcp", "decomposition-needed", "epic"]
    });
    const ordinaryMcpTask = await store.createTask({
      projectId: project.id,
      title: "Ordinary MCP implementation",
      status: "ready",
      priority: "normal",
      role: "implementer",
      labels: ["mcp"]
    });

    const plannerSlot = await store.acquireAgentSlot({
      preferredType: "planner-decomposer",
      runtimeId: "runtime-planner",
      projectId: project.id,
      now: "2026-06-13T16:00:00.000Z"
    });

    expect(plannerSlot).toMatchObject({
      agentId: "planner-agent",
      role: "pm",
      specialties: expect.arrayContaining(["planner", "decomposition"])
    });

    const plannerNext = store.getNextTaskForAgent("planner-agent", {
      projectId: project.id,
      now: "2026-06-13T16:01:00.000Z"
    });
    expect(plannerNext.task).toMatchObject({ id: container.id });
    expect(plannerNext.selection).toMatchObject({
      claim: {
        taskId: container.id,
        assignee: "planner-agent",
        expectedStatus: "ready",
        expectedAssignee: ""
      }
    });

    const implementerNext = store.getNextTaskForAgent("mcp-agent", {
      projectId: project.id,
      now: "2026-06-13T16:01:00.000Z"
    });
    expect(implementerNext.task).toMatchObject({ id: ordinaryMcpTask.id });
    expect(implementerNext.candidates.map((candidate) => candidate.id)).not.toContain(container.id);
  });

  it("creates child tasks and comments a parent decomposition summary", async () => {
    const project = await store.createProject({ name: "Decomposition Output Project" });
    const parent = await store.createTask({
      projectId: project.id,
      title: "Decompose operator approval epic",
      status: "in_progress",
      priority: "high",
      role: "pm",
      assignee: "planner-agent",
      labels: ["decomposition-needed", "epic"]
    });

    const result = await store.decomposeTask(parent.id, {
      actor: "planner-agent",
      summary: "Split the approval epic into backend and frontend slices.",
      children: [
        {
          title: "Backend approval audit trail",
          role: "implementer",
          priority: "high",
          labels: ["backend", "approvals"],
          acceptanceCriteria: ["Persist approval decisions with actor and timestamp."],
          evidence: "Focused API test plus full npm test.",
          sequencing: "Do before the frontend slice."
        },
        {
          title: "Frontend approval review panel",
          role: "implementer",
          priority: "normal",
          labels: ["frontend", "approvals"],
          acceptanceCriteria: ["Show pending approvals grouped by requested action."],
          evidence: "Component or e2e coverage for grouping."
        }
      ]
    });

    expect(result.childTasks).toHaveLength(2);
    expect(result.childTasks[0]).toMatchObject({
      projectId: project.id,
      title: "Backend approval audit trail",
      role: "implementer",
      priority: "high",
      labels: expect.arrayContaining(["backend", "approvals"])
    });
    expect(result.childTasks[0].description).toContain("Acceptance criteria:");
    expect(result.childTasks[0].description).toContain("- Persist approval decisions with actor and timestamp.");
    expect(result.childTasks[0].description).toContain("Evidence expectations:");
    expect(result.childTasks[0].description).toContain("Sequencing notes:");

    const refreshedParent = store.getTask(parent.id);
    expect(refreshedParent.comments[0]).toMatchObject({
      author: "planner-agent"
    });
    expect(refreshedParent.comments[0].body).toContain("Split the approval epic into backend and frontend slices.");
    expect(refreshedParent.comments[0].body).toContain(result.childTasks[0].id);
    expect(refreshedParent.comments[0].body).toContain(result.childTasks[1].id);
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

  it("returns no next task while a single-task agent already owns in-progress work", async () => {
    const project = await store.createProject({ name: "Occupied Single Task Project" });
    const active = await store.createTask({
      projectId: project.id,
      title: "Current implementation",
      status: "in_progress",
      priority: "normal",
      role: "implementer",
      assignee: "mcp-agent",
      labels: ["mcp"]
    });
    await store.createTask({
      projectId: project.id,
      title: "Tempting follow-up",
      status: "ready",
      priority: "urgent",
      role: "implementer",
      assignee: "mcp-agent",
      labels: ["mcp"]
    });

    const next = store.getNextTaskForAgent("mcp-agent", {
      projectId: project.id,
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(next.task).toBeNull();
    expect(next.candidates).toEqual([]);
    expect(next.selection).toMatchObject({
      reason: "active_task_in_progress",
      activeTask: {
        id: active.id,
        title: "Current implementation"
      }
    });
  });

  it("treats drain-role-queue as one-active-at-a-time but leaves watch-mode eligible", async () => {
    const project = await store.createProject({ name: "Work Mode Active Claim Project" });
    const reviewerActive = await store.createTask({
      projectId: project.id,
      title: "Reviewer already active",
      status: "in_progress",
      priority: "normal",
      role: "reviewer",
      assignee: "reviewer-agent"
    });
    await store.createTask({
      projectId: project.id,
      title: "Reviewer role queue",
      status: "ready",
      priority: "urgent",
      role: "reviewer"
    });
    await store.createTask({
      projectId: project.id,
      title: "Observability already active",
      status: "in_progress",
      priority: "normal",
      role: "implementer",
      assignee: "implementer-observability-1"
    });
    const watchReady = await store.createTask({
      projectId: project.id,
      title: "Watch-mode follow-up",
      status: "ready",
      priority: "urgent",
      role: "implementer",
      assignee: "implementer-observability-1"
    });

    const reviewerNext = store.getNextTaskForAgent("reviewer-agent", {
      projectId: project.id,
      now: "2026-06-12T15:00:00.000Z"
    });
    const watchNext = store.getNextTaskForAgent("implementer-observability-1", {
      projectId: project.id,
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(reviewerNext.task).toBeNull();
    expect(reviewerNext.selection).toMatchObject({
      reason: "active_task_in_progress",
      activeTask: {
        id: reviewerActive.id
      }
    });
    expect(watchNext.task).toMatchObject({ id: watchReady.id });
    expect(watchNext.selection).toMatchObject({
      reason: "assigned_to_agent",
      claim: {
        taskId: watchReady.id,
        assignee: "implementer-observability-1"
      }
    });
  });

  it("requires generic role-type workers to acquire a concrete slot before next-task selection", async () => {
    const project = await store.createProject({ name: "Role Type Next Task Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Review through a concrete slot",
      status: "ready",
      priority: "high",
      role: "reviewer"
    });

    const genericNext = store.getNextTaskForAgent("reviewer", {
      projectId: project.id,
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(genericNext.task).toBeNull();
    expect(genericNext.candidates).toEqual([]);
    expect(genericNext.selection).toMatchObject({
      reason: "agent_slot_required",
      typeId: "reviewer",
      suggestedSlotIds: ["reviewer-agent", "reviewer-agent-2"]
    });

    const concreteNext = store.getNextTaskForAgent("reviewer-agent", {
      projectId: project.id,
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(concreteNext.task).toMatchObject({ id: task.id });
    expect(concreteNext.selection).toMatchObject({
      reason: "role_queue",
      claim: {
        taskId: task.id,
        assignee: "reviewer-agent",
        expectedStatus: "ready",
        expectedAssignee: ""
      }
    });
  });

  it("requires generic numbered non-slot workers to acquire a concrete slot before next-task selection", async () => {
    const project = await store.createProject({ name: "Numbered Worker Next Task Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Implement through a concrete slot",
      status: "ready",
      priority: "high",
      role: "implementer"
    });

    const genericNext = store.getNextTaskForAgent("implementer-1", {
      projectId: project.id,
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(genericNext.task).toBeNull();
    expect(genericNext.candidates).toEqual([]);
    expect(genericNext.selection).toMatchObject({
      reason: "agent_slot_required",
      agentId: "implementer-1",
      typeId: "implementer-general",
      suggestedSlotIds: ["implementer-agent"]
    });

    const concreteNext = store.getNextTaskForAgent("implementer-agent", {
      projectId: project.id,
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(concreteNext.task).toMatchObject({ id: task.id });
    expect(concreteNext.selection).toMatchObject({
      reason: "role_queue",
      claim: {
        taskId: task.id,
        assignee: "implementer-agent",
        expectedStatus: "ready",
        expectedAssignee: ""
      }
    });
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

    const firstStore = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
    const secondStore = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
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
    expect(next.selection).toMatchObject({ reason: "no_eligible_work" });
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

  it("updates agent slot controls for work mode and pause state", async () => {
    const slot = await store.updateAgentSlot("mcp-agent", {
      workMode: "watch-mode",
      paused: true,
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(slot).toMatchObject({
      id: "mcp-agent",
      workMode: "watch-mode",
      paused: true,
      active: false,
      available: false,
      updatedAt: "2026-06-12T15:00:00.000Z"
    });

    const registry = store.listAgentSlots({ now: "2026-06-12T15:01:00.000Z" });
    expect(registry.slots.find((candidate) => candidate.id === "mcp-agent")).toMatchObject({
      workMode: "watch-mode",
      paused: true,
      available: false
    });

    await expect(store.updateAgentSlot("mcp-agent", { workMode: "freestyle" })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("workMode")
    });
  });

  it("updates agent type capacity and uses the desired capacity during slot acquisition", async () => {
    const increased = await store.updateAgentType("mcp", {
      capacity: 3,
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(increased).toMatchObject({
      id: "mcp",
      capacity: 3,
      slotIds: ["mcp-agent", "mcp-agent-2", "mcp-agent-3"]
    });
    expect(store.listAgentSlots({ now: "2026-06-12T15:00:00.000Z" }).slots.map((slot) => slot.id)).toContain("mcp-agent-3");

    const reduced = await store.updateAgentType("mcp", {
      capacity: 1,
      now: "2026-06-12T15:01:00.000Z"
    });

    expect(reduced).toMatchObject({
      id: "mcp",
      capacity: 1,
      slotIds: ["mcp-agent", "mcp-agent-2", "mcp-agent-3"]
    });

    const first = await store.acquireAgentSlot({
      preferredType: "mcp",
      runtimeId: "runtime-mcp-1",
      now: "2026-06-12T15:02:00.000Z"
    });
    expect(first.agentId).toBe("mcp-agent");

    await expect(
      store.acquireAgentSlot({
        preferredType: "mcp",
        runtimeId: "runtime-mcp-2",
        now: "2026-06-12T15:02:00.000Z"
      })
    ).rejects.toMatchObject({
      status: 409,
      details: {
        typeId: "mcp",
        capacity: 1,
        active: 1
      }
    });

    const listed = store.listAgentSlots({ now: "2026-06-12T15:02:00.000Z" });
    expect(listed.types.find((type) => type.id === "mcp")).toMatchObject({
      capacity: 1,
      active: 1,
      available: 0,
      configured: 3
    });
    expect(listed.slots.find((slot) => slot.id === "mcp-agent-2")).toMatchObject({
      withinCapacity: false,
      available: false
    });

    await expect(store.updateAgentType("mcp", { capacity: -1 })).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("capacity")
    });
  });

  it("reports role-specific upstream signals with activity-scaled recheck hints", async () => {
    const project = await store.createProject({ name: "Standing Agent Signals", key: "SIGNALS" });
    for (const status of ["backlog", "ready", "in_progress", "review", "testing", "done"]) {
      await store.createTask({
        projectId: project.id,
        title: `${status} signal task`,
        status,
        role: "implementer",
        ...(status === "done"
          ? {
              completion: {
                completionType: "no-code",
                completedBy: "test",
                completedAt: "2026-06-12T14:00:00.000Z",
                notes: "Signal fixture"
              }
            }
          : {})
      });
    }

    const implementer = store.getNextTaskForAgent("implementer-backend-1", { projectId: project.id });
    const reviewer = store.getNextTaskForAgent("reviewer-agent", { projectId: project.id });
    const tester = store.getNextTaskForAgent("test-agent", { projectId: project.id });

    expect(implementer).toMatchObject({
      upstreamSignal: {
        role: "implementer",
        statuses: ["ready", "backlog"],
        counts: { ready: 1, backlog: 1 },
        total: 2,
        active: true,
        recheckAfterSeconds: 90
      },
      recheckAfterSeconds: 90
    });
    expect(reviewer.upstreamSignal).toMatchObject({
      role: "reviewer",
      statuses: ["in_progress", "ready"],
      counts: { in_progress: 1, ready: 1 },
      total: 2
    });
    expect(tester.upstreamSignal).toMatchObject({
      role: "tester",
      statuses: ["review", "in_progress"],
      counts: { review: 1, in_progress: 1 },
      total: 2
    });

    const quietProject = await store.createProject({ name: "Quiet Signals", key: "QUIET" });
    expect(store.getNextTaskForAgent("test-agent", { projectId: quietProject.id })).toMatchObject({
      upstreamSignal: { total: 0, active: false, recheckAfterSeconds: 180 },
      recheckAfterSeconds: 180
    });

    const busyProject = await store.createProject({ name: "Busy Signals", key: "BUSY" });
    for (let index = 0; index < 5; index += 1) {
      await store.createTask({
        projectId: busyProject.id,
        title: `Busy review ${index}`,
        status: "review",
        role: "implementer"
      });
    }
    expect(store.getNextTaskForAgent("test-agent", { projectId: busyProject.id })).toMatchObject({
      upstreamSignal: { total: 5, recheckAfterSeconds: 60 },
      recheckAfterSeconds: 60
    });
  });

  it("reports waiting presence while upstream work is still moving toward the role", async () => {
    const project = await store.createProject({ name: "Waiting Tester", key: "WAIT" });
    await store.createTask({
      projectId: project.id,
      title: "Implementation approaching test",
      status: "in_progress",
      role: "implementer"
    });

    const report = await store.reportNoEligibleWork("test-agent", {
      reason: "no_testing_work_yet",
      message: "Waiting for implementation to reach testing.",
      filters: { projectId: project.id, role: "tester" },
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(report).toMatchObject({
      upstreamSignal: {
        role: "tester",
        statuses: ["review", "in_progress"],
        counts: { review: 0, in_progress: 1 },
        total: 1,
        active: true,
        recheckAfterSeconds: 120
      },
      recheckAfterSeconds: 120,
      presence: {
        state: "waiting",
        status: "waiting",
        stale: false,
        offline: false,
        upstreamSignal: { total: 1 }
      },
      report: {
        reason: "no_testing_work_yet",
        recheckAfterSeconds: 120,
        upstreamSignal: { total: 1 }
      }
    });

    expect(store.listAgentSlots({ now: "2026-06-12T15:00:00.000Z" }).slots.find((slot) => slot.id === "test-agent")).toMatchObject({
      active: true,
      available: false,
      presenceFresh: true,
      presence: {
        state: "waiting",
        status: "waiting",
        upstreamSignal: { total: 1 }
      }
    });
  });

  it("records agent presence and no-eligible-work reports", async () => {
    const team = await store.createProject({ name: "Team Board", key: "TEAM" });
    const active = await store.updateAgentPresence("mcp-agent", {
      state: "active",
      activeProjectId: team.id,
      taskId: "task_123",
      workMode: "single-task",
      message: "Working the claimed helper task.",
      now: "2026-06-12T15:00:00.000Z"
    });

    expect(active).toMatchObject({
      agentId: "mcp-agent",
      state: "active",
      status: "online",
      activeProjectId: team.id,
      activeProject: {
        id: team.id,
        key: "TEAM"
      },
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
      message: "No eligible MCP tasks remain.",
      upstreamSignal: {
        total: 0,
        active: false,
        recheckAfterSeconds: 180
      }
    });
    expect(report.report).toMatchObject({
      reason: "no_ready_work",
      filters: { role: "implementer", labels: ["mcp"] },
      upstreamSignal: { total: 0 },
      recheckAfterSeconds: 180
    });

    const saved = JSON.parse(await readFile(path.join(tempDir, "workboard.json"), "utf8"));
    expect(saved.agentPresence["mcp-agent"].noEligibleWork).toMatchObject({
      reason: "no_ready_work"
    });
  });

  it("rejects presence reports from generic numbered non-slot workers", async () => {
    await expect(
      store.updateAgentPresence("implementer-1", {
        state: "active",
        message: "I should have acquired a slot first.",
        now: "2026-06-12T15:00:00.000Z"
      })
    ).rejects.toMatchObject({
      status: 409,
      details: {
        agentId: "implementer-1",
        typeId: "implementer-general",
        suggestedSlotIds: ["implementer-agent"]
      }
    });

    await expect(
      store.reportNoEligibleWork("implementer-1", {
        reason: "no_ready_work",
        now: "2026-06-12T15:00:00.000Z"
      })
    ).rejects.toMatchObject({
      status: 409,
      details: {
        agentId: "implementer-1",
        typeId: "implementer-general",
        suggestedSlotIds: ["implementer-agent"]
      }
    });

    expect(store.data.agentPresence["implementer-1"]).toBeUndefined();
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
    await store.acquireAgentSlot({
      agentId: "implementer-backend-3",
      runtimeId: "off-script-runtime",
      now: "2026-06-12T15:10:00.000Z"
    });
    await store.acquireAgentSlot({
      agentId: "implementer-backend-4",
      runtimeId: "unbound-runtime",
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
    const offScriptTask = await store.createTask({
      projectId: project.id,
      title: "Assigned agent reports another task",
      status: "in_progress",
      role: "implementer",
      assignee: "implementer-backend-3"
    });
    const unboundTask = await store.createTask({
      projectId: project.id,
      title: "Assigned agent reports no task",
      status: "in_progress",
      role: "implementer",
      assignee: "implementer-backend-4"
    });

    await store.updateAgentPresence("implementer-backend-2", {
      state: "active",
      currentTaskId: freshTask.id,
      now: "2026-06-12T15:10:30.000Z"
    });
    await store.updateAgentPresence("implementer-backend-3", {
      state: "active",
      taskId: freshTask.id,
      now: "2026-06-12T15:10:30.000Z"
    });
    await store.updateAgentPresence("implementer-backend-4", {
      state: "active",
      taskId: "",
      now: "2026-06-12T15:10:30.000Z"
    });

    const stale = store.listStaleInProgressTasks({
      projectId: project.id,
      now: "2026-06-12T15:20:01.000Z"
    });

    // Both stale tasks are created in the same tick, so lastProgressAt can tie and
    // the title tiebreak decides the order. Assert on identity rather than position.
    expect(stale.tasks.map((item) => item.task.id).sort()).toEqual(
      [missingSlotTask.id, expiredHeartbeatTask.id, offScriptTask.id, unboundTask.id].sort()
    );
    expect(stale.tasks.map((item) => item.task.id)).not.toContain(freshTask.id);

    const missingSlotEntry = stale.tasks.find((item) => item.task.id === missingSlotTask.id);
    const expiredHeartbeatEntry = stale.tasks.find((item) => item.task.id === expiredHeartbeatTask.id);
    const offScriptEntry = stale.tasks.find((item) => item.task.id === offScriptTask.id);
    const unboundEntry = stale.tasks.find((item) => item.task.id === unboundTask.id);

    expect(missingSlotEntry).toMatchObject({
      kind: "stalled",
      warningLabel: "STALLED",
      reason: "missing_slot",
      assignee: "implementer-backend-99",
      canAcknowledge: false,
      suggestedActions: ["comment", "requeue", "block"]
    });
    expect(expiredHeartbeatEntry).toMatchObject({
      kind: "stalled",
      warningLabel: "STALLED",
      reason: "expired_heartbeat",
      assignee: "implementer-backend-1",
      canAcknowledge: true,
      suggestedActions: ["comment", "requeue", "block", "acknowledge"]
    });
    expect(expiredHeartbeatEntry.lastProgressAt).toBe(expiredHeartbeatTask.updatedAt);
    expect(expiredHeartbeatEntry.freshness).toMatchObject({
      leaseFresh: false,
      presenceFreshActive: false,
      ownerProgressFresh: false,
      summary: "No fresh heartbeat or owner progress"
    });
    expect(offScriptEntry).toMatchObject({
      kind: "off_script",
      warningLabel: "OFF-SCRIPT",
      reason: "presence_task_mismatch",
      reasonLabel: "Different task reported",
      freshness: {
        presenceFreshActive: true,
        presenceTaskMatches: false,
        presenceCurrentTaskId: freshTask.id,
        summary: `Agent reports ${freshTask.id} instead`
      }
    });
    expect(unboundEntry).toMatchObject({
      kind: "off_script",
      warningLabel: "OFF-SCRIPT",
      reason: "presence_task_missing",
      reasonLabel: "No task reported",
      freshness: expect.objectContaining({
        presenceFreshActive: true,
        presenceTaskMatches: false,
        presenceCurrentTaskId: "",
        summary: "Active agent reports no current task"
      })
    });
  });

  it("uses only recent owner-authored task progress to suppress expired heartbeat stale work", async () => {
    const project = await store.createProject({ name: "Owner Progress Project" });
    await store.acquireAgentSlot({
      agentId: "implementer-backend-1",
      runtimeId: "owner-progress-runtime",
      now: "2026-06-12T15:00:00.000Z"
    });
    await store.acquireAgentSlot({
      agentId: "implementer-backend-2",
      runtimeId: "pm-progress-runtime",
      now: "2026-06-12T15:00:00.000Z"
    });
    await store.acquireAgentSlot({
      agentId: "implementer-backend-3",
      runtimeId: "old-progress-runtime",
      now: "2026-06-12T15:00:00.000Z"
    });

    const ownerProgressTask = await store.createTask({
      projectId: project.id,
      title: "Owner recently posted",
      status: "in_progress",
      role: "implementer",
      assignee: "implementer-backend-1"
    });
    const pmProgressTask = await store.createTask({
      projectId: project.id,
      title: "Only PM recently posted",
      status: "in_progress",
      role: "implementer",
      assignee: "implementer-backend-2"
    });
    const oldOwnerProgressTask = await store.createTask({
      projectId: project.id,
      title: "Owner posted too long ago",
      status: "in_progress",
      role: "implementer",
      assignee: "implementer-backend-3"
    });

    const ownerComment = await store.addComment(ownerProgressTask.id, {
      author: "implementer-backend-1",
      body: "Still working this implementation."
    });
    ownerComment.createdAt = "2026-06-12T15:12:00.000Z";
    const pmComment = await store.addComment(pmProgressTask.id, {
      author: "pm",
      body: "PM is checking on this."
    });
    pmComment.createdAt = "2026-06-12T15:14:00.000Z";
    const oldOwnerComment = await store.addComment(oldOwnerProgressTask.id, {
      author: "implementer-backend-3",
      body: "Older implementation update."
    });
    oldOwnerComment.createdAt = "2026-06-12T15:04:00.000Z";

    const stale = store.listStaleInProgressTasks({
      projectId: project.id,
      now: "2026-06-12T15:20:01.000Z"
    });

    expect(stale.tasks.map((item) => item.task.id)).toEqual([oldOwnerProgressTask.id, pmProgressTask.id]);
    expect(stale.tasks.find((item) => item.task.id === pmProgressTask.id)).toMatchObject({
      reason: "expired_heartbeat",
      freshness: {
        ownerProgressFresh: false,
        summary: "No fresh heartbeat or owner progress"
      }
    });
    expect(stale.tasks.find((item) => item.task.id === oldOwnerProgressTask.id)).toMatchObject({
      reason: "expired_heartbeat",
      freshness: {
        ownerProgressFresh: false,
        lastOwnerProgressAt: "2026-06-12T15:04:00.000Z",
        lastOwnerProgressSource: "task_comment"
      }
    });
  });

  it("uses recent related Agent Talks by the assignee as owner progress", async () => {
    const project = await store.createProject({ name: "Owner Talk Project" });
    await store.acquireAgentSlot({
      agentId: "implementer-backend-1",
      runtimeId: "owner-talk-runtime",
      now: "2026-06-12T15:00:00.000Z"
    });
    const task = await store.createTask({
      projectId: project.id,
      title: "Owner posted in talks",
      status: "in_progress",
      role: "implementer",
      assignee: "implementer-backend-1"
    });
    const talk = await store.addTalkMessage(project.id, {
      authorAgentId: "implementer-backend-1",
      kind: "update",
      relatedTaskId: task.id,
      body: "Still alive via Agent Talks."
    });
    talk.createdAt = "2026-06-12T15:18:00.000Z";

    const stale = store.listStaleInProgressTasks({
      projectId: project.id,
      now: "2026-06-12T15:20:01.000Z"
    });

    expect(stale.tasks.map((item) => item.task.id)).not.toContain(task.id);
  });

  it("keeps missing-slot work stale even when the assignee posts recent progress", async () => {
    const project = await store.createProject({ name: "Missing Slot Progress Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Missing slot with progress",
      status: "in_progress",
      role: "implementer",
      assignee: "implementer-backend-99"
    });
    const comment = await store.addComment(task.id, {
      author: "implementer-backend-99",
      body: "I exist, but my slot does not."
    });
    comment.createdAt = "2026-06-12T15:18:00.000Z";

    const stale = store.listStaleInProgressTasks({
      projectId: project.id,
      now: "2026-06-12T15:20:01.000Z"
    });

    expect(stale.tasks).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ id: task.id }),
        reason: "missing_slot",
        freshness: expect.objectContaining({
          ownerProgressFresh: true,
          summary: "Assignee has no configured slot"
        })
      })
    ]);
  });

  it("treats acknowledgement as same-task temporary presence freshness", async () => {
    const project = await store.createProject({ name: "Acknowledge Project" });
    await store.acquireAgentSlot({
      agentId: "implementer-backend-1",
      runtimeId: "ack-runtime",
      now: "2026-06-12T15:00:00.000Z"
    });
    const task = await store.createTask({
      projectId: project.id,
      title: "Acknowledged stale work",
      status: "in_progress",
      role: "implementer",
      assignee: "implementer-backend-1"
    });
    await store.updateAgentPresence("implementer-backend-1", {
      state: "active",
      currentTaskId: task.id,
      message: "Operator acknowledged active ownership.",
      now: "2026-06-12T15:18:00.000Z"
    });

    const stale = store.listStaleInProgressTasks({
      projectId: project.id,
      now: "2026-06-12T15:20:01.000Z"
    });

    expect(stale.tasks.map((item) => item.task.id)).not.toContain(task.id);

    const staleAfterAcknowledgeExpires = store.listStaleInProgressTasks({
      projectId: project.id,
      now: "2026-06-12T15:34:00.000Z"
    });

    expect(staleAfterAcknowledgeExpires.tasks).toEqual([
      expect.objectContaining({
        task: expect.objectContaining({ id: task.id }),
        reason: "expired_heartbeat",
        freshness: expect.objectContaining({
          presenceFreshActive: false
        })
      })
    ]);
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

  it("round-trips a project backup with comments, activity, and attachment metadata", async () => {
    const project = await store.createProject({ name: "Backup Store Project", key: "BSP" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Preserve task evidence",
      description: "Backup should keep task history.",
      status: "ready",
      role: "implementer",
      labels: ["backup"]
    });

    await store.updateTask(
      task.id,
      { status: "review", assignee: "reviewer-agent", expectedRevision: task.revision },
      "implementer-backend-2"
    );
    const comment = await store.addComment(task.id, { author: "reviewer-agent", body: "Review evidence survives." });
    const attachment = await store.addAttachment(
      task.id,
      {
        originalname: "restore-me.txt",
        mimetype: "text/plain",
        size: 12,
        buffer: Buffer.from("restore data")
      },
      "tester-agent"
    );

    const backup = store.exportProjectBackup(project.id);
    expect(backup).toMatchObject({
      packageType: "agent-workboard.project-backup",
      packageVersion: 1,
      project: {
        id: project.id,
        key: "BSP"
      },
      tasks: [
        expect.objectContaining({
          id: task.id,
          projectId: project.id,
          comments: [comment],
          attachments: [attachment]
        })
      ]
    });
    expect(backup.tasks[0].activity.map((event) => event.type)).toEqual(
      expect.arrayContaining(["created", "updated", "commented", "attachment.added"])
    );

    const importDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-import-store-"));
    const targetStore = new WorkboardStore({ dataDir: importDir, storageMode: "json" });
    await targetStore.init();
    try {
      const imported = await targetStore.importProjectBackup(backup, { actor: "restore-agent" });
      expect(imported).toMatchObject({
        created: true,
        projectId: project.id,
        taskCount: 1
      });

      const importedTask = targetStore.getTask(task.id);
      expect(importedTask).toMatchObject({
        id: task.id,
        projectId: project.id,
        title: "Preserve task evidence",
        revision: backup.tasks[0].revision,
        comments: [comment],
        attachments: [attachment]
      });
      expect(importedTask.activity.map((event) => event.type)).toEqual(
        backup.tasks[0].activity.map((event) => event.type)
      );

      const updatedEventMessage = "Updated restored project event.";
      const updated = await targetStore.importProjectBackup(
        {
          ...backup,
          project: { ...backup.project, name: "Updated Backup Store Project" },
          tasks: [{ ...backup.tasks[0], title: "Updated restored task" }],
          events: backup.events.map((event, index) => (index === 0 ? { ...event, message: updatedEventMessage } : event))
        },
        { actor: "restore-agent" }
      );
      expect(updated).toMatchObject({
        created: false,
        taskCount: 1
      });
      expect(targetStore.getProject(project.id).name).toBe("Updated Backup Store Project");
      expect(targetStore.getTask(task.id).title).toBe("Updated restored task");
      expect(targetStore.data.events.filter((event) => event.id === backup.events[0].id)).toHaveLength(1);
      expect(targetStore.data.events.find((event) => event.id === backup.events[0].id)).toMatchObject({
        projectId: project.id,
        message: updatedEventMessage
      });
    } finally {
      await rm(importDir, { recursive: true, force: true });
    }
  });

  it("rejects project backup event id collisions across projects", async () => {
    const existing = await store.createProject({ name: "Existing Event Project", key: "EEP" });
    const existingEvent = store.data.events.find((event) => event.projectId === existing.id && event.type === "project.created");
    const backup = {
      packageType: "agent-workboard.project-backup",
      packageVersion: 1,
      project: {
        id: "project_restore_events",
        key: "RESTORE-EVENTS",
        name: "Restore Events Project"
      },
      tasks: [],
      events: [
        {
          ...existingEvent,
          projectId: "project_restore_events",
          message: "Unsafe imported event"
        }
      ]
    };

    await expect(store.importProjectBackup(backup, { actor: "restore-agent" })).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({
        reason: "event_id_collision",
        eventId: existingEvent.id,
        existingProjectId: existing.id
      })
    });
    expect(store.data.events.find((event) => event.id === existingEvent.id)).toMatchObject({
      projectId: existing.id,
      message: existingEvent.message
    });
  });

  it("rejects unsafe project backup imports", async () => {
    const existing = await store.createProject({ name: "Existing Backup Project", key: "EXISTING" });
    const backup = {
      packageType: "agent-workboard.project-backup",
      packageVersion: 1,
      project: {
        id: "project_restore",
        key: existing.key,
        name: "Conflicting Backup Project"
      },
      tasks: [],
      events: []
    };

    await expect(store.importProjectBackup(backup, { actor: "restore-agent" })).rejects.toMatchObject({
      status: 409,
      details: expect.objectContaining({ reason: "project_key_collision" })
    });

    await expect(
      store.importProjectBackup(
        {
          ...backup,
          project: { ...backup.project, key: "SAFE" },
          tasks: [
            {
              id: "task_restore",
              projectId: "project_other",
              title: "Wrong project task"
            }
          ]
        },
        { actor: "restore-agent" }
      )
    ).rejects.toMatchObject({
      status: 400,
      details: expect.objectContaining({ reason: "task_project_mismatch" })
    });
  });
});
