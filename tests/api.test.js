import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { WorkboardStore } from "../server/storage/workboardStore.js";
import { buildWorktreeCleanupReport } from "../server/worktreeCleanup.js";

let tempDir;
let store;
let app;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-api-"));
  store = new WorkboardStore({ dataDir: tempDir });
  await store.init();
  app = createApp({ store });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("Agent Workboard API", () => {
  it("surfaces integration source guidance in meta, bootstrap, and agent docs", async () => {
    const integrationStatus = {
      sourceOfTruth: "local-main",
      baseRef: "main",
      pushDebt: true,
      ahead: 2,
      behind: 0,
      clean: true,
      localHead: "localsha",
      originHead: "originsha",
      summary: "Local main is 2 commits ahead of origin/main; use local main for dogfood worktrees until push debt is cleared.",
      worktreeCommand: "git worktree add C:/git/wt-agent-workboard-<agent-id>-<slug> -b <agent-id>/<slug> main",
      recoveryActions: ["Run git push origin main when non-interactive credentials are available."]
    };
    app = createApp({ store, integrationStatusProvider: () => integrationStatus });

    const meta = await request(app).get("/api/meta").expect(200);
    expect(meta.body.integrationStatus).toMatchObject({
      sourceOfTruth: "local-main",
      baseRef: "main",
      pushDebt: true
    });

    const bootstrap = await request(app)
      .post("/api/bootstrap")
      .send({ preferredType: "implementer-backend", runtimeId: "integration-guidance-test" })
      .expect(200);
    expect(bootstrap.body.integrationStatus).toMatchObject({
      sourceOfTruth: "local-main",
      baseRef: "main"
    });

    const doc = await request(app).get("/api/agent-docs/implementer-backend-1").expect(200);
    expect(doc.body.agent.integrationStatus).toMatchObject({
      sourceOfTruth: "local-main",
      baseRef: "main"
    });
    expect(doc.body.agent.worktree.join("\n")).toContain(" main");

    const markdown = await request(app).get("/api/agent-docs/implementer-backend-1?format=md").expect(200);
    expect(markdown.text).toContain("Integration Source");
    expect(markdown.text).toContain("local-main");
    expect(markdown.text).toContain("Push debt");
  });

  it("serves role-aware agent bootstrap docs as JSON and Markdown", async () => {
    const overview = await request(app).get("/api/agent-docs").expect(200);
    expect(overview.body.suggestedAgents).toContain("implementer");
    expect(overview.body.suggestedAgents).toContain("reviewer");
    expect(overview.body.suggestedAgents).not.toContain("implementer-frontend-1");
    expect(overview.body.suggestedAgents).not.toContain("implementer-backend-1");
    expect(overview.body.usage.promptTemplate).toContain("/api/agent-docs/{agentType}");
    expect(overview.body.identityModel.suggestedAgentsAre).toContain("role types");
    expect(overview.body.identityModel.currentRule).toContain("/api/bootstrap");
    expect(overview.body.slotBootstrap.status).toBe("available-http");
    expect(overview.body.slotBootstrap.plannedMcpTool).toBe("acquire_agent_slot");
    expect(overview.body.slotBootstrap.httpEndpoint).toBe("/api/bootstrap");

    const pmDoc = await request(app).get("/api/agent-docs/pm-agent").expect(200);
    expect(pmDoc.body.agent).toMatchObject({
      agentId: "pm-agent",
      role: "pm"
    });
    expect(pmDoc.body.agent.workflow).toContain("Only then look for another task.");
    expect(pmDoc.body.agent.worktree.join("\n")).toContain("git worktree add");
    expect(pmDoc.body.agent.cautions.join("\n")).toContain("Do not edit the main checkout directly");

    for (const agentId of ["implementer", "tester", "reviewer", "pm"]) {
      const agentDoc = await request(app).get(`/api/agent-docs/${agentId}`).expect(200);
      expect(agentDoc.body.agent.autonomousGoAhead).toMatchObject({
        status: "claimed-task-implicit-go-ahead",
        ordinaryRule: expect.stringContaining("successful claim plus a visible plan is the go-ahead"),
        safetyRule: expect.stringContaining("destructive changes"),
        approvalQueueRule: expect.stringContaining("operator approval queue"),
        migrationGuidance: expect.stringContaining("already waiting only for ordinary go-ahead")
      });

      const agentMarkdown = await request(app).get(`/api/agent-docs/${agentId}?format=md`).expect(200);
      expect(agentMarkdown.text).toContain("## Autonomous Go-Ahead");
      expect(agentMarkdown.text).toContain("successful claim plus a visible plan is the go-ahead");
      expect(agentMarkdown.text).toContain("destructive changes");
      expect(agentMarkdown.text).toContain("operator approval queue");
      expect(agentMarkdown.text).toContain("already waiting only for ordinary go-ahead");
    }

    const mcpDoc = await request(app).get("/api/agent-docs/mcp-agent").expect(200);
    expect(mcpDoc.body.agent.role).toBe("implementer");
    expect(mcpDoc.body.agent.specialties).toContain("mcp");

    const reviewerDoc = await request(app).get("/api/agent-docs/reviewer-agent").expect(200);
    expect(reviewerDoc.body.agent.api.reviewQueue).toContain("status=review");
    expect(reviewerDoc.body.agent.taskSelection.join("\n")).toContain("review-column work takes priority");
    expect(reviewerDoc.body.agent.reviewerMerge.join("\n")).toContain("completionType=merged");
    expect(reviewerDoc.body.agent.reviewerMerge.join("\n")).toContain("commitSha");

    const markdown = await request(app).get("/api/agent-docs/test-agent?format=md").expect(200);
    expect(markdown.headers["content-type"]).toContain("text/markdown");
    expect(markdown.text).toContain("You are **test-agent**");
    expect(markdown.text).toContain("Identity And Slots");
    expect(markdown.text).toContain("HTTP slot bootstrap is available");
    expect(markdown.text).toContain("Claim exactly one task");
    expect(markdown.text).toContain("Branch And Worktree Discipline");
    expect(markdown.text).toContain("wt-agent-workboard-test-agent");

    const reviewerMarkdown = await request(app).get("/api/agent-docs/reviewer-agent?format=md").expect(200);
    expect(reviewerMarkdown.text).toContain("Reviewer Merge Responsibility");
    expect(reviewerMarkdown.text).toContain("Check the review queue");

    const genericReviewerMarkdown = await request(app).get("/api/agent-docs/reviewer?format=md").expect(200);
    expect(genericReviewerMarkdown.text).toContain("You are **reviewer**");
    expect(genericReviewerMarkdown.text).toContain("role type `reviewer`");
    expect(genericReviewerMarkdown.text).toContain("acquire a concrete slot");
    expect(genericReviewerMarkdown.text).toContain("reviewer-agent");
    expect(genericReviewerMarkdown.text).not.toContain("concrete assignee id such as reviewer");
  });

  it("creates a project and a task, then moves the task", async () => {
    const projectResponse = await request(app)
      .post("/api/projects")
      .send({ name: "API Project", key: "API" })
      .expect(201);

    const taskResponse = await request(app)
      .post("/api/tasks")
      .send({
        projectId: projectResponse.body.project.id,
        title: "Implement MCP smoke test",
        role: "implementer",
        priority: "urgent"
      })
      .expect(201);

    const movedResponse = await request(app)
      .patch(`/api/tasks/${taskResponse.body.task.id}`)
      .send({
        status: "in_progress",
        assignee: "codex-agent",
        actor: "pm-agent",
        expectedRevision: taskResponse.body.task.revision
      })
      .expect(200);

    expect(movedResponse.body.task).toMatchObject({
      status: "in_progress",
      assignee: "codex-agent"
    });
  });

  it("exports and imports a project backup package without losing task evidence", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Backup API Project", key: "BKP" }).expect(201)).body
      .project;
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({
          projectId: project.id,
          title: "Back up this task",
          description: "Needs comments, activity, and attachment metadata.",
          status: "ready",
          role: "implementer",
          labels: ["backup"]
        })
        .expect(201)
    ).body.task;

    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: "review", actor: "implementer-backend-2", expectedRevision: task.revision })
      .expect(200);
    await request(app)
      .post(`/api/tasks/${task.id}/comments`)
      .send({ author: "reviewer-agent", body: "Keep this review note." })
      .expect(201);
    await request(app)
      .post(`/api/tasks/${task.id}/attachments`)
      .field("author", "tester-agent")
      .attach("file", Buffer.from("backup evidence"), "backup.txt")
      .expect(201);

    const exported = await request(app).get(`/api/projects/${project.id}/export`).expect(200);

    expect(exported.headers["content-type"]).toContain("application/json");
    expect(exported.headers["content-disposition"]).toContain("attachment");
    expect(exported.body).toMatchObject({
      packageType: "agent-workboard.project-backup",
      packageVersion: 1,
      project: {
        id: project.id,
        key: "BKP",
        name: "Backup API Project"
      }
    });
    expect(exported.body.tasks).toHaveLength(1);
    expect(exported.body.tasks[0]).toMatchObject({
      id: task.id,
      projectId: project.id,
      title: "Back up this task",
      comments: [expect.objectContaining({ author: "reviewer-agent", body: "Keep this review note." })],
      attachments: [expect.objectContaining({ filename: "backup.txt", uploadedBy: "tester-agent" })]
    });
    expect(exported.body.tasks[0].activity.map((event) => event.type)).toEqual(
      expect.arrayContaining(["created", "updated", "commented", "attachment.added"])
    );

    const importDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-import-api-"));
    const importStore = new WorkboardStore({ dataDir: importDir });
    await importStore.init();
    const importApp = createApp({ store: importStore });
    try {
      const imported = await request(importApp).post("/api/projects/import").send(exported.body).expect(201);
      expect(imported.body.import).toMatchObject({
        created: true,
        projectId: project.id,
        taskCount: 1
      });

      const importedTask = (await request(importApp).get(`/api/tasks/${task.id}`).expect(200)).body.task;
      expect(importedTask).toMatchObject({
        id: task.id,
        projectId: project.id,
        title: "Back up this task",
        comments: [expect.objectContaining({ author: "reviewer-agent", body: "Keep this review note." })],
        attachments: [expect.objectContaining({ filename: "backup.txt", uploadedBy: "tester-agent" })]
      });
      expect(importedTask.activity.map((event) => event.type)).toEqual(
        expect.arrayContaining(["created", "updated", "commented", "attachment.added"])
      );

      const updatedEventMessage = "API restored project event was updated.";
      const renamedPackage = {
        ...exported.body,
        project: {
          ...exported.body.project,
          name: "Restored Backup API Project"
        },
        events: exported.body.events.map((event, index) => (index === 0 ? { ...event, message: updatedEventMessage } : event))
      };
      const updated = await request(importApp).post("/api/projects/import").send(renamedPackage).expect(200);
      expect(updated.body.import).toMatchObject({
        created: false,
        projectId: project.id,
        taskCount: 1
      });
      expect((await request(importApp).get("/api/projects").expect(200)).body.projects).toContainEqual(
        expect.objectContaining({ id: project.id, name: "Restored Backup API Project" })
      );
      expect(importStore.data.events.filter((event) => event.id === exported.body.events[0].id)).toHaveLength(1);
      expect(importStore.data.events.find((event) => event.id === exported.body.events[0].id)).toMatchObject({
        projectId: project.id,
        message: updatedEventMessage
      });
    } finally {
      await rm(importDir, { recursive: true, force: true });
    }
  });

  it("rejects project backup imports with cross-project event id collisions", async () => {
    const existing = (await request(app).post("/api/projects").send({ name: "Existing Event API", key: "EEAPI" }).expect(201)).body
      .project;
    const existingEvent = store.data.events.find((event) => event.projectId === existing.id && event.type === "project.created");
    const backup = {
      packageType: "agent-workboard.project-backup",
      packageVersion: 1,
      project: {
        id: "project_api_restore_events",
        key: "API-RESTORE-EVENTS",
        name: "API Restore Events Project"
      },
      tasks: [],
      events: [
        {
          ...existingEvent,
          projectId: "project_api_restore_events",
          message: "Unsafe API imported event"
        }
      ]
    };

    const rejected = await request(app).post("/api/projects/import").send(backup).expect(409);
    expect(rejected.body.error.details).toMatchObject({
      reason: "event_id_collision",
      eventId: existingEvent.id,
      existingProjectId: existing.id
    });
    expect(store.data.events.find((event) => event.id === existingEvent.id)).toMatchObject({
      projectId: existing.id,
      message: existingEvent.message
    });
  });

  it("rejects invalid task create and update payloads with readable 400 errors", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Task Validation API", key: "TVAPI" }).expect(201)).body
      .project;

    const invalidCreate = await request(app)
      .post("/api/tasks")
      .send({
        projectId: project.id,
        title: "Invalid API task",
        status: "nearly_ready"
      })
      .expect(400);
    expect(invalidCreate.body.error.message).toMatch(/status/i);

    await request(app)
      .post("/api/tasks")
      .send({
        projectId: project.id,
        title: "Invalid API labels",
        labels: "backend"
      })
      .expect(400)
      .expect((response) => {
        expect(response.body.error.message).toMatch(/labels/i);
      });

    await request(app)
      .post("/api/tasks")
      .send({
        projectId: project.id,
        title: "Too many API labels",
        labels: Array.from({ length: 13 }, (_item, index) => `label-${index}`)
      })
      .expect(400)
      .expect((response) => {
        expect(response.body.error.message).toMatch(/labels/i);
      });

    const task = (
      await request(app)
        .post("/api/tasks")
        .send({
          projectId: project.id,
          title: "Valid API task",
          status: "ready",
          priority: "normal",
          role: "implementer",
          labels: ["backend"]
        })
        .expect(201)
    ).body.task;

    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: "invalid", actor: "tester" })
      .expect(400)
      .expect((response) => {
        expect(response.body.error.message).toMatch(/status/i);
      });
    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ priority: "eventually", actor: "tester" })
      .expect(400)
      .expect((response) => {
        expect(response.body.error.message).toMatch(/priority/i);
      });
    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ role: "wizard", actor: "tester" })
      .expect(400)
      .expect((response) => {
        expect(response.body.error.message).toMatch(/role/i);
      });
    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ title: "", actor: "tester" })
      .expect(400)
      .expect((response) => {
        expect(response.body.error.message).toMatch(/title/i);
      });

    const unchanged = await request(app).get(`/api/tasks/${task.id}`).expect(200);
    expect(unchanged.body.task).toMatchObject({
      title: "Valid API task",
      status: "ready",
      priority: "normal",
      role: "implementer",
      labels: ["backend"]
    });
  });

  it("posts and lists project Agent Talks through the API", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Talks API Project" }).expect(201)).body.project;
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({ projectId: project.id, title: "Review via talks", status: "review" })
        .expect(201)
    ).body.task;

    const posted = await request(app)
      .post(`/api/projects/${project.id}/talks`)
      .send({
        authorAgentId: "implementer-01",
        kind: "review-request",
        body: "Please review this slice.",
        relatedTaskId: task.id,
        mentions: ["reviewer-agent"]
      })
      .expect(201);

    expect(posted.body.message).toMatchObject({
      projectId: project.id,
      authorAgentId: "implementer-01",
      kind: "review-request",
      body: "Please review this slice.",
      relatedTaskId: task.id,
      mentions: ["reviewer-agent"],
      relatedTask: {
        id: task.id,
        title: "Review via talks"
      }
    });

    const filtered = await request(app)
      .get(`/api/projects/${project.id}/talks?kind=review-request&agentId=implementer-01&taskId=${task.id}`)
      .expect(200);

    expect(filtered.body.messages).toHaveLength(1);
    expect(filtered.body.messages[0]).toMatchObject({
      id: posted.body.message.id,
      relatedTask: {
        id: task.id,
        status: "review"
      }
    });
  });

  it("validates Agent Talks API related tasks and exposes MCP tool names", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Talk Validation API" }).expect(201)).body.project;
    const otherProject = (await request(app).post("/api/projects").send({ name: "Other Talk Validation API" }).expect(201)).body
      .project;
    const otherTask = (
      await request(app).post("/api/tasks").send({ projectId: otherProject.id, title: "Wrong project task" }).expect(201)
    ).body.task;

    const invalid = await request(app)
      .post(`/api/projects/${project.id}/talks`)
      .send({
        authorAgentId: "implementer-01",
        kind: "question",
        body: "Wrong project?",
        relatedTaskId: otherTask.id
      })
      .expect(400);

    expect(invalid.body.error.message).toMatch(/same project/i);

    const tools = await request(app).get("/api/mcp/tools").expect(200);
    expect(tools.body.tools).toEqual(expect.arrayContaining(["post_talk_message", "list_talk_messages"]));
  });

  it("exposes a worktree cleanup dry-run report for operator coordination", async () => {
    const cleanupApp = createApp({
      store,
      worktreeCleanupProvider: ({ store: reportStore, mainRef }) =>
        buildWorktreeCleanupReport({
          tasks: reportStore.listTasks(),
          mainRef,
          generatedAt: "2026-06-01T12:00:00.000Z",
          worktrees: [
            {
              path: "C:/tmp/wt-agent-workboard-implementer-clean",
              branch: "implementer/clean",
              head: "abc1234",
              dirty: false,
              untrackedCount: 0,
              aheadMain: 0,
              behindMain: 0,
              mergedIntoMain: true
            }
          ]
        })
    });

    const project = (await request(cleanupApp).post("/api/projects").send({ name: "Cleanup API" }).expect(201)).body.project;
    const task = (
      await request(cleanupApp)
        .post("/api/tasks")
        .send({
          projectId: project.id,
          title: "Merged branch cleanup",
          status: "done",
          role: "reviewer",
          completion: {
            completionType: "merged",
            branch: "implementer/clean",
            commitSha: "abc1234",
            mergedTo: "main"
          }
        })
        .expect(201)
    ).body.task;

    const response = await request(cleanupApp).get("/api/worktree-cleanup?mainRef=main").expect(200);

    expect(response.body.report).toMatchObject({
      mainRef: "main",
      counts: {
        cleanupReady: 1
      },
      items: [
        {
          branch: "implementer/clean",
          status: "cleanup-ready",
          cleanupEligible: true,
          task: {
            id: task.id,
            status: "done"
          },
          completion: {
            branch: "implementer/clean",
            commitSha: "abc1234"
          },
          commands: {
            removeWorktree: "git worktree remove C:/tmp/wt-agent-workboard-implementer-clean",
            deleteBranch: "git branch -d implementer/clean"
          }
        }
      ]
    });
  });

  it("rejects incomplete worktree cleanup API requests before the action runs", async () => {
    const calls = [];
    const cleanupApp = createApp({
      store,
      worktreeCleanupAction: async (input) => {
        calls.push(input);
        return { cleaned: true };
      }
    });

    const response = await request(cleanupApp)
      .post("/api/worktree-cleanup/cleanup")
      .send({
        branch: "implementer/clean"
      })
      .expect(400);

    expect(response.body.error).toMatchObject({
      message: "Cleanup request must identify one current cleanup candidate."
    });
    expect(response.body.error.details.missing).toEqual(["taskId", "worktreePath", "expectedHead"]);
    expect(calls).toHaveLength(0);
  });

  it("runs guarded worktree cleanup through the API", async () => {
    const cleanupApp = createApp({
      store,
      worktreeCleanupAction: async ({ taskId, branch, worktreePath, expectedHead, actor }) => ({
        cleaned: true,
        taskId,
        branch,
        worktreePath,
        expectedHead,
        actor,
        actions: ["worktree.remove", "branch.delete"]
      })
    });

    const response = await request(cleanupApp)
      .post("/api/worktree-cleanup/cleanup")
      .send({
        taskId: "task_clean",
        branch: "implementer/clean",
        worktreePath: "C:/tmp/wt-clean",
        expectedHead: "abc1234",
        actor: "operator-ui"
      })
      .expect(200);

    expect(response.body.cleanup).toMatchObject({
      cleaned: true,
      taskId: "task_clean",
      branch: "implementer/clean",
      worktreePath: "C:/tmp/wt-clean",
      expectedHead: "abc1234",
      actions: ["worktree.remove", "branch.delete"]
    });
  });

  it("exposes capability CRUD, filtering, and task completion links", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Capability API", key: "CAPAPI" }).expect(201)).body
      .project;
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({
          projectId: project.id,
          title: "Publish capability endpoint",
          status: "review",
          role: "implementer",
          assignee: "implementer-01"
        })
        .expect(201)
    ).body.task;

    const seeded = await request(app).get("/api/capabilities?q=MCP").expect(200);
    expect(seeded.body.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "cap_mcp_workflow_tools",
          status: "live"
        })
      ])
    );

    const created = await request(app)
      .post("/api/capabilities")
      .send({
        id: "cap_api_registry_test",
        projectId: project.id,
        name: "Capability API registry",
        summary: "List, read, create, and update product capabilities.",
        status: "planned",
        ownerRole: "implementer",
        relatedTaskIds: [task.id],
        surfaces: ["API", "MCP"]
      })
      .expect(201);

    await request(app)
      .get(`/api/capabilities/${created.body.capability.id}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.capability).toMatchObject({
          id: "cap_api_registry_test",
          live: false,
          relatedTaskIds: [task.id]
        });
      });

    await request(app)
      .get(`/api/capabilities?projectId=${project.id}&status=planned&q=product`)
      .expect(200)
      .expect((response) => {
        expect(response.body.capabilities).toHaveLength(1);
      });

    await request(app)
      .patch(`/api/capabilities/${created.body.capability.id}`)
      .send({ status: "live", verificationEvidence: ["API test verified registry CRUD."] })
      .expect(200)
      .expect((response) => {
        expect(response.body.capability).toMatchObject({
          status: "live",
          live: true
        });
      });

    const completed = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({
        status: "done",
        actor: "reviewer-01",
        completion: {
          completionType: "merged",
          commitSha: "abc1234",
          capabilityIds: [created.body.capability.id]
        }
      })
      .expect(200);

    expect(completed.body.task.completion.capabilityIds).toEqual([created.body.capability.id]);
  });

  it("supports operator approval requests from in-progress tasks, queue listing, and approval decisions", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Approval API Project" }).expect(201)).body.project;
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({
          projectId: project.id,
          title: "Commit verified branch",
          status: "in_progress",
          assignee: "implementer-01"
        })
        .expect(201)
    ).body.task;
    await request(app)
      .post(`/api/tasks/${task.id}/comments`)
      .send({ author: "implementer-01", body: "Diff summary and tests are posted." })
      .expect(201);

    const blocked = await request(app)
      .post(`/api/tasks/${task.id}/operator-approval`)
      .send({
        requestedBy: "implementer-01",
        reason: "Need operator approval before commit.",
        requestedAction: "Approve commit `feat: approval queue`.",
        nextStatus: "review"
      })
      .expect(200);

    expect(blocked.body.task).toMatchObject({
      status: "blocked",
      blocker: {
        type: "operator_approval",
        status: "pending",
        nextStatus: "review"
      }
    });

    const queue = await request(app).get(`/api/operator-approvals?projectId=${project.id}`).expect(200);
    expect(queue.body.approvals).toHaveLength(1);
    expect(queue.body.approvals[0]).toMatchObject({
      task: {
        id: task.id
      },
      latestComment: {
        body: "Diff summary and tests are posted."
      }
    });

    const approved = await request(app)
      .post(`/api/tasks/${task.id}/operator-approval/decision`)
      .send({
        decision: "approved",
        decidedBy: "operator",
        note: "Approved for review.",
        nextStatus: "review"
      })
      .expect(200);

    expect(approved.body.task).toMatchObject({
      status: "review",
      blocker: null,
      approvalHistory: [
        expect.objectContaining({
          decision: "approved",
          decidedBy: "operator"
        }),
        expect.objectContaining({
          decision: "requested"
        })
      ]
    });
  });

  it("claims a task through a stale-safe first-class endpoint", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Claim API Project" })).body.project;
    const task = (
      await request(app).post("/api/tasks").send({
        projectId: project.id,
        title: "Claim through API",
        status: "ready",
        assignee: ""
      })
    ).body.task;

    const firstClaim = await request(app)
      .post(`/api/tasks/${task.id}/claim`)
      .send({
        assignee: "implementer-agent",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
      .expect(200);

    expect(firstClaim.body.task).toMatchObject({
      id: task.id,
      status: "in_progress",
      assignee: "implementer-agent"
    });
    expect(firstClaim.body.task.activity[0]).toMatchObject({
      actor: "implementer-agent",
      type: "claimed"
    });

    const staleClaim = await request(app)
      .post(`/api/tasks/${task.id}/claim`)
      .send({
        assignee: "mcp-agent",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
      .expect(409);

    expect(staleClaim.body.error.message).toMatch(/already claimed|expected/i);
  });

  it("rejects stale full task saves with 409 and keeps the first client change", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Revision API Project" })).body.project;
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({
          projectId: project.id,
          title: "API original title",
          status: "ready",
          role: "implementer"
        })
        .expect(201)
    ).body.task;

    const firstSave = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({
        title: "Client A API title",
        actor: "operator-a",
        expectedRevision: task.revision
      })
      .expect(200);

    const staleSave = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({
        title: "Client B API title",
        actor: "operator-b",
        expectedRevision: task.revision
      })
      .expect(409);

    expect(staleSave.body.error).toMatchObject({
      details: {
        taskId: task.id,
        expectedRevision: task.revision,
        currentRevision: firstSave.body.task.revision
      }
    });
    expect(staleSave.body.error.message).toMatch(/changed by another client/i);

    const current = (await request(app).get(`/api/tasks/${task.id}`).expect(200)).body.task;
    expect(current).toMatchObject({
      title: "Client A API title",
      revision: firstSave.body.task.revision
    });
    expect(current.activity[0]).toMatchObject({
      actor: "operator-b",
      type: "update.rejected"
    });
  });

  it("rejects stale full task saves after operator approval request and decision mutations", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Approval Revision API Project" })).body.project;
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({
          projectId: project.id,
          title: "Approval API revision guard",
          status: "in_progress",
          role: "implementer",
          assignee: "implementer-01"
        })
        .expect(201)
    ).body.task;

    const requested = await request(app)
      .post(`/api/tasks/${task.id}/operator-approval`)
      .send({
        requestedBy: "implementer-01",
        reason: "Need approval before review.",
        requestedAction: "Approve review handoff.",
        nextStatus: "review"
      })
      .expect(200);

    expect(requested.body.task.revision).toBe(task.revision + 1);
    const staleAfterRequest = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({
        title: "Stale API save after request",
        actor: "operator-stale",
        expectedRevision: task.revision
      })
      .expect(409);
    expect(staleAfterRequest.body.error.details).toMatchObject({
      taskId: task.id,
      expectedRevision: task.revision,
      currentRevision: requested.body.task.revision
    });

    const approved = await request(app)
      .post(`/api/tasks/${task.id}/operator-approval/decision`)
      .send({
        decision: "approved",
        decidedBy: "operator",
        note: "Approved after stale save was rejected.",
        nextStatus: "review"
      })
      .expect(200);

    expect(approved.body.task.revision).toBe(requested.body.task.revision + 1);
    const staleAfterDecision = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({
        title: "Stale API save after approval",
        actor: "operator-stale",
        expectedRevision: requested.body.task.revision
      })
      .expect(409);
    expect(staleAfterDecision.body.error.details).toMatchObject({
      taskId: task.id,
      expectedRevision: requested.body.task.revision,
      currentRevision: approved.body.task.revision
    });
  });

  it("rejects role-type task claims that bypass concrete agent slots", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Role Claim API Project" })).body.project;
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({
          projectId: project.id,
          title: "Review with a real reviewer slot",
          status: "ready",
          role: "reviewer",
          assignee: ""
        })
        .expect(201)
    ).body.task;

    const roleClaim = await request(app)
      .post(`/api/tasks/${task.id}/claim`)
      .send({
        assignee: "reviewer",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
      .expect(409);

    expect(roleClaim.body.error.message).toMatch(/concrete agent slot/i);
    expect(roleClaim.body.error.details).toMatchObject({
      agentId: "reviewer",
      typeId: "reviewer",
      suggestedSlotIds: ["reviewer-agent", "reviewer-agent-2"]
    });

    const slotClaim = await request(app)
      .post(`/api/tasks/${task.id}/claim`)
      .send({
        assignee: "reviewer-agent",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
      .expect(200);

    expect(slotClaim.body.task).toMatchObject({
      id: task.id,
      status: "in_progress",
      assignee: "reviewer-agent"
    });
  });

  it("reports board-state version changes for task lifecycle mutations", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Live State API Project" })).body.project;

    async function readState() {
      const response = await request(app).get("/api/board-state").query({ projectId: project.id }).expect(200);
      expect(response.body.state).toMatchObject({
        projectId: project.id,
        taskCount: expect.any(Number),
        version: expect.any(String)
      });
      return response.body.state;
    }

    async function expectVersionChange(previousVersion, action) {
      await action();
      const nextState = await readState();
      expect(nextState.version).not.toBe(previousVersion);
      expect(nextState.latestUpdatedAt).toEqual(expect.any(String));
      return nextState.version;
    }

    let version = (await readState()).version;
    let task;

    version = await expectVersionChange(version, async () => {
      task = (
        await request(app).post("/api/tasks").send({
          projectId: project.id,
          title: "Live board lifecycle task",
          status: "ready",
          role: "implementer"
        })
      ).body.task;
    });

    version = await expectVersionChange(version, () =>
      request(app)
        .post(`/api/tasks/${task.id}/claim`)
        .send({ assignee: "implementer-agent", expectedStatus: "ready", expectedAssignee: "" })
        .expect(200)
    );

    version = await expectVersionChange(version, () =>
      request(app).patch(`/api/tasks/${task.id}`).send({ status: "review", actor: "implementer-agent" }).expect(200)
    );

    version = await expectVersionChange(version, () =>
      request(app)
        .post(`/api/tasks/${task.id}/comments`)
        .send({ author: "reviewer-01", body: "Live update comment evidence." })
        .expect(201)
    );

    version = await expectVersionChange(version, () =>
      request(app)
        .post(`/api/tasks/${task.id}/attachments`)
        .field("author", "reviewer-01")
        .attach("file", Buffer.from("live update attachment\n"), "live-evidence.txt")
        .expect(201)
    );

    await expectVersionChange(version, () =>
      request(app)
        .patch(`/api/tasks/${task.id}`)
        .send({
          status: "done",
          actor: "reviewer-01",
          completion: {
            completionType: "no-code",
            notes: "Live board state noticed completion."
          }
        })
        .expect(200)
    );
  });

  it("rejects a second active REST claim and withholds next-task work for single-task agents", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Single Active API Project" })).body.project;
    const active = (
      await request(app)
        .post("/api/tasks")
        .send({
          projectId: project.id,
          title: "API active task",
          status: "in_progress",
          role: "implementer",
          assignee: "mcp-agent",
          labels: ["mcp"]
        })
        .expect(201)
    ).body.task;
    const ready = (
      await request(app)
        .post("/api/tasks")
        .send({
          projectId: project.id,
          title: "API second claim",
          status: "ready",
          role: "implementer",
          assignee: "mcp-agent",
          labels: ["mcp"]
        })
        .expect(201)
    ).body.task;

    const claim = await request(app)
      .post(`/api/tasks/${ready.id}/claim`)
      .send({
        assignee: "mcp-agent",
        expectedStatus: "ready",
        expectedAssignee: "mcp-agent"
      })
      .expect(409);

    expect(claim.body.error.message).toContain(active.id);
    expect(claim.body.error.message).toMatch(/finish, hand off, or requeue/i);

    const next = await request(app)
      .get("/api/agents/mcp-agent/next-task")
      .query({ projectId: project.id, now: "2026-06-12T15:00:00.000Z" })
      .expect(200);

    expect(next.body.task).toBeNull();
    expect(next.body.candidates).toEqual([]);
    expect(next.body.selection).toMatchObject({
      reason: "active_task_in_progress",
      activeTask: {
        id: active.id,
        title: "API active task"
      }
    });
  });

  it("lists configured agent slots", async () => {
    const response = await request(app).get("/api/agent-slots").expect(200);

    expect(response.body.types).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "implementer-backend",
          capacity: 4,
          active: 0,
          available: 4
        })
      ])
    );
    expect(response.body.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "implementer-backend-1",
          typeId: "implementer-backend",
          active: false,
          available: true
        })
      ])
    );
  });

  it("reports in-progress work assigned to non-slot identities as slot warnings", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Slot Warning API Project" })).body.project;
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({
          projectId: project.id,
          title: "Invisible reviewer work",
          status: "in_progress",
          role: "reviewer",
          assignee: "reviewer"
        })
        .expect(201)
    ).body.task;

    const response = await request(app).get("/api/agent-slots").query({ now: "2026-06-12T15:00:00.000Z" }).expect(200);
    const reviewerType = response.body.types.find((type) => type.id === "reviewer");

    expect(reviewerType).toMatchObject({
      active: 0,
      available: 2
    });
    expect(response.body.untrackedInProgressAssignees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          assignee: "reviewer",
          role: "reviewer",
          typeId: "reviewer",
          inProgressTaskCount: 1,
          taskIds: [task.id],
          suggestedSlotIds: ["reviewer-agent", "reviewer-agent-2"]
        })
      ])
    );
  });

  it("rejects slot-managed claim requests from non-configured slot assignees", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Non Slot Claim API Project" })).body.project;
    const task = (
      await request(app)
        .post("/api/tasks")
        .send({
          projectId: project.id,
          title: "Reviewer must claim through slot",
          status: "ready",
          role: "reviewer",
          assignee: ""
        })
        .expect(201)
    ).body.task;

    const response = await request(app)
      .post(`/api/tasks/${task.id}/claim`)
      .send({
        assignee: "reviewer-01",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
      .expect(409);

    expect(response.body.error).toMatchObject({
      details: {
        agentId: "reviewer-01",
        role: "reviewer",
        typeId: "reviewer",
        suggestedSlotIds: ["reviewer-agent", "reviewer-agent-2"]
      }
    });

    const fetched = await request(app).get(`/api/tasks/${task.id}`).expect(200);
    expect(fetched.body.task).toMatchObject({
      status: "ready",
      assignee: ""
    });
  });

  it("bootstraps an anonymous worker into a matching slot", async () => {
    const response = await request(app)
      .post("/api/bootstrap")
      .send({
        preferredType: "backend",
        runtimeId: "api-runtime-1",
        now: "2026-06-12T15:00:00.000Z"
      })
      .expect(200);

    expect(response.body).toMatchObject({
      acquired: true,
      renewed: false,
      agentId: "implementer-backend-1",
      typeId: "implementer-backend",
      role: "implementer",
      slotNumber: 1
    });

    const renewed = await request(app)
      .post("/api/bootstrap")
      .send({
        preferredType: "backend",
        runtimeId: "api-runtime-1",
        now: "2026-06-12T15:05:00.000Z"
      })
      .expect(200);

    expect(renewed.body).toMatchObject({
      renewed: true,
      agentId: "implementer-backend-1"
    });
  });

  it("returns active project context from bootstrap, agent docs, and slot registry", async () => {
    const dogfood = (await request(app).post("/api/projects").send({ name: "Dogfood", key: "DOGFOOD" }).expect(201)).body.project;

    const bootstrap = await request(app)
      .post("/api/bootstrap")
      .send({
        agentId: "mcp-agent",
        runtimeId: "api-project-runtime",
        now: "2026-06-12T15:00:00.000Z"
      })
      .expect(200);

    expect(bootstrap.body).toMatchObject({
      agentId: "mcp-agent",
      activeProjectId: dogfood.id,
      activeProject: {
        id: dogfood.id,
        key: "DOGFOOD",
        name: "Dogfood"
      },
      nextTask: {
        projectId: dogfood.id
      }
    });
    expect(bootstrap.body.nextTask.url).toContain(`/api/agents/mcp-agent/next-task`);
    expect(bootstrap.body.nextTask.url).toContain(`projectId=${encodeURIComponent(dogfood.id)}`);

    const doc = await request(app).get("/api/agent-docs/mcp-agent").expect(200);
    expect(doc.body.agent).toMatchObject({
      activeProjectId: dogfood.id,
      activeProject: {
        key: "DOGFOOD",
        name: "Dogfood"
      }
    });
    expect(doc.body.agent.api.listTasks).toContain(`projectId=${encodeURIComponent(dogfood.id)}`);
    expect(doc.body.agent.api.talks).toContain(encodeURIComponent(dogfood.id));

    const markdown = await request(app).get("/api/agent-docs/mcp-agent?format=md").expect(200);
    expect(markdown.text).toContain("Assigned Project");
    expect(markdown.text).toContain(`DOGFOOD (${dogfood.id})`);

    const slots = await request(app).get("/api/agent-slots").query({ now: "2026-06-12T15:01:00.000Z" }).expect(200);
    expect(slots.body.slots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mcp-agent",
          activeProjectId: dogfood.id,
          activeProject: expect.objectContaining({
            key: "DOGFOOD"
          })
        })
      ])
    );
  });

  it("documents planner decomposer agents and creates child tasks through the API", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Planner API Project" }).expect(201)).body.project;

    const doc = await request(app).get("/api/agent-docs/planner-agent").expect(200);
    expect(doc.body.agent).toMatchObject({
      role: "pm",
      specialties: expect.arrayContaining(["planner", "decomposition"])
    });
    expect(doc.body.agent.workflow.join("\n")).toContain("Do not implement code");
    expect(doc.body.agent.mcp.then).toContain("decompose_task");

    const parent = (
      await request(app)
        .post("/api/tasks")
        .send({
          projectId: project.id,
          title: "Plan the approvals epic",
          status: "in_progress",
          priority: "high",
          role: "pm",
          assignee: "planner-agent",
          labels: ["decomposition-needed", "epic"]
        })
        .expect(201)
    ).body.task;

    const decomposition = await request(app)
      .post(`/api/tasks/${parent.id}/decompose`)
      .send({
        actor: "planner-agent",
        summary: "Approval epic split into API and UI slices.",
        children: [
          {
            title: "Approval API persistence",
            role: "implementer",
            priority: "high",
            labels: ["backend", "approvals"],
            acceptanceCriteria: ["Store approval decisions durably."],
            evidence: "Focused API tests."
          },
          {
            title: "Approval UI review list",
            role: "implementer",
            priority: "normal",
            labels: ["frontend", "approvals"],
            acceptanceCriteria: ["Render pending approvals by action type."]
          }
        ]
      })
      .expect(201);

    expect(decomposition.body.childTasks).toHaveLength(2);
    expect(decomposition.body.childTasks[0]).toMatchObject({
      projectId: project.id,
      title: "Approval API persistence",
      labels: expect.arrayContaining(["backend", "approvals"])
    });
    expect(decomposition.body.comment.body).toContain(decomposition.body.childTasks[0].id);

    const refreshedParent = await request(app).get(`/api/tasks/${parent.id}`).expect(200);
    expect(refreshedParent.body.task.comments[0].body).toContain("Approval epic split into API and UI slices.");
    expect(refreshedParent.body.task.comments[0].body).toContain(decomposition.body.childTasks[1].id);
  });

  it("bootstraps an explicit agent id and refreshes the same runtime heartbeat", async () => {
    const first = await request(app)
      .post("/api/bootstrap")
      .send({
        agentId: "reviewer-agent",
        runtimeId: "api-review-runtime-1",
        now: "2026-06-12T15:00:00.000Z"
      })
      .expect(200);

    expect(first.body).toMatchObject({
      acquired: true,
      renewed: false,
      reclaimed: false,
      agentId: "reviewer-agent",
      typeId: "reviewer",
      role: "reviewer",
      workMode: "drain-role-queue"
    });
    expect(first.body.lease).toMatchObject({
      acquiredAt: "2026-06-12T15:00:00.000Z",
      heartbeatAt: "2026-06-12T15:00:00.000Z",
      expiresAt: "2026-06-12T15:15:00.000Z"
    });

    const renewed = await request(app)
      .post("/api/bootstrap")
      .send({
        agentId: "reviewer-agent",
        runtimeId: "api-review-runtime-1",
        now: "2026-06-12T15:05:00.000Z"
      })
      .expect(200);

    expect(renewed.body).toMatchObject({
      renewed: true,
      agentId: "reviewer-agent",
      typeId: "reviewer"
    });
    expect(renewed.body.lease).toMatchObject({
      acquiredAt: "2026-06-12T15:00:00.000Z",
      heartbeatAt: "2026-06-12T15:05:00.000Z",
      expiresAt: "2026-06-12T15:20:00.000Z"
    });

    const conflict = await request(app)
      .post("/api/bootstrap")
      .send({
        agentId: "reviewer-agent",
        runtimeId: "api-review-runtime-2",
        now: "2026-06-12T15:06:00.000Z"
      })
      .expect(409);

    expect(conflict.body.error.message).toContain("reviewer-agent is already active");
  });

  it("exposes continuous-work helper endpoints for next-task and presence", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Continuous API Project" })).body.project;
    const task = (
      await request(app).post("/api/tasks").send({
        projectId: project.id,
        title: "Continuous helper work",
        status: "ready",
        role: "implementer",
        assignee: "mcp-agent",
        labels: ["mcp"]
      })
    ).body.task;

    const next = await request(app)
      .get("/api/agents/mcp-agent/next-task")
      .query({ projectId: project.id, now: "2026-06-12T15:00:00.000Z" })
      .expect(200);

    expect(next.body.task).toMatchObject({ id: task.id });
    expect(next.body.selection).toMatchObject({
      reason: "assigned_to_agent",
      claim: {
        taskId: task.id,
        assignee: "mcp-agent",
        expectedStatus: "ready",
        expectedAssignee: "mcp-agent"
      }
    });

    const presence = await request(app)
      .post("/api/agents/mcp-agent/presence")
      .send({
        state: "active",
        currentTaskId: task.id,
        message: "Working from API helper.",
        now: "2026-06-12T15:01:00.000Z"
      })
      .expect(200);

    expect(presence.body.presence).toMatchObject({
      agentId: "mcp-agent",
      state: "active",
      status: "online",
      currentTaskId: task.id
    });

    const idle = await request(app)
      .post("/api/agents/mcp-agent/no-eligible-work")
      .send({
        reason: "no_ready_work",
        message: "No matching work.",
        filters: { projectId: project.id, labels: ["mcp"] },
        now: "2026-06-12T15:02:00.000Z"
      })
      .expect(200);

    expect(idle.body.report).toMatchObject({ reason: "no_ready_work" });
    expect(idle.body.presence).toMatchObject({ state: "idle", status: "idle" });

    const allPresence = await request(app).get("/api/agents/presence").expect(200);
    expect(allPresence.body.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: "mcp-agent",
          state: "idle"
        })
      ])
    );
  });

  it("requires generic numbered non-slot workers to use concrete slots for helper endpoints", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Numbered Helper API Project" })).body.project;
    await request(app)
      .post("/api/tasks")
      .send({
        projectId: project.id,
        title: "Concrete slot helper work",
        status: "ready",
        role: "implementer"
      })
      .expect(201);

    const next = await request(app)
      .get("/api/agents/implementer-1/next-task")
      .query({ projectId: project.id, now: "2026-06-12T15:00:00.000Z" })
      .expect(200);

    expect(next.body.task).toBeNull();
    expect(next.body.selection).toMatchObject({
      reason: "agent_slot_required",
      agentId: "implementer-1",
      typeId: "implementer-general",
      suggestedSlotIds: ["implementer-agent"]
    });

    const presence = await request(app)
      .post("/api/agents/implementer-1/presence")
      .send({
        state: "active",
        message: "I should have acquired a slot first.",
        now: "2026-06-12T15:01:00.000Z"
      })
      .expect(409);

    expect(presence.body.error).toMatchObject({
      details: {
        agentId: "implementer-1",
        typeId: "implementer-general",
        suggestedSlotIds: ["implementer-agent"]
      }
    });

    await request(app)
      .post("/api/agents/implementer-1/no-eligible-work")
      .send({
        reason: "no_ready_work",
        now: "2026-06-12T15:02:00.000Z"
      })
      .expect(409);

    const allPresence = await request(app).get("/api/agents/presence").expect(200);
    expect(allPresence.body.agents.some((agent) => agent.agentId === "implementer-1")).toBe(false);
  });

  it("lists stale in-progress tasks with slot and heartbeat evidence", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Stale Work API Project" })).body.project;
    await request(app)
      .post("/api/agent-slots/acquire")
      .send({
        agentId: "implementer-backend-1",
        runtimeId: "stale-api-runtime",
        now: "2026-06-12T15:00:00.000Z"
      })
      .expect(200);
    await request(app)
      .post("/api/agent-slots/acquire")
      .send({
        agentId: "implementer-backend-2",
        runtimeId: "fresh-api-runtime",
        now: "2026-06-12T15:10:00.000Z"
      })
      .expect(200);
    const staleTask = (
      await request(app)
        .post("/api/tasks")
        .send({
          projectId: project.id,
          title: "API stale worker task",
          status: "in_progress",
          role: "implementer",
          assignee: "implementer-backend-1"
        })
        .expect(201)
    ).body.task;
    await request(app)
      .post("/api/tasks")
      .send({
        projectId: project.id,
        title: "API missing slot task",
        status: "in_progress",
        role: "implementer",
        assignee: "implementer-backend-99"
      })
      .expect(201);
    const freshTask = (
      await request(app)
        .post("/api/tasks")
        .send({
          projectId: project.id,
          title: "API fresh worker task",
          status: "in_progress",
          role: "implementer",
          assignee: "implementer-backend-2"
        })
        .expect(201)
    ).body.task;

    await request(app)
      .post("/api/agents/implementer-backend-2/presence")
      .send({
        state: "active",
        currentTaskId: freshTask.id,
        now: "2026-06-12T15:10:30.000Z"
      })
      .expect(200);

    const response = await request(app)
      .get("/api/tasks/stale-in-progress")
      .query({ projectId: project.id, now: "2026-06-12T15:20:01.000Z" })
      .expect(200);

    expect(response.body.leaseMs).toBeGreaterThan(0);
    expect(response.body.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "expired_heartbeat",
          task: expect.objectContaining({ id: staleTask.id }),
          assignee: "implementer-backend-1",
          freshness: expect.objectContaining({
            leaseFresh: false,
            presenceFreshActive: false,
            ownerProgressFresh: false,
            summary: "No fresh heartbeat or owner progress"
          }),
          suggestedActions: expect.arrayContaining(["comment", "requeue", "block", "acknowledge"])
        }),
        expect.objectContaining({
          reason: "missing_slot",
          assignee: "implementer-backend-99",
          canAcknowledge: false
        })
      ])
    );
    expect(response.body.tasks.map((item) => item.task.id)).not.toContain(freshTask.id);
  });

  it("returns reviewer review-queue metadata without claim preconditions", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Reviewer Pass API Project" })).body.project;
    const reviewTask = (
      await request(app).post("/api/tasks").send({
        projectId: project.id,
        title: "Implementation awaiting review",
        status: "review",
        role: "implementer",
        assignee: "implementer-backend-1"
      })
    ).body.task;
    await request(app)
      .post("/api/tasks")
      .send({
        projectId: project.id,
        title: "Assigned reviewer wrapper",
        status: "ready",
        role: "reviewer",
        priority: "urgent",
        assignee: "reviewer-agent"
      })
      .expect(201);

    const next = await request(app)
      .get("/api/agents/reviewer-agent/next-task")
      .query({ projectId: project.id, now: "2026-06-12T15:00:00.000Z" })
      .expect(200);

    expect(next.body.task).toMatchObject({
      id: reviewTask.id,
      status: "review",
      assignee: "implementer-backend-1"
    });
    expect(next.body.selection).toMatchObject({
      reason: "review_queue",
      review: {
        taskId: reviewTask.id,
        originalAssignee: "implementer-backend-1",
        reviewer: "reviewer-agent"
      }
    });
    expect(next.body.selection.claim).toBeUndefined();
  });

  it("rejects bootstrap when active slots are full", async () => {
    for (const slotNumber of [1, 2, 3, 4]) {
      await request(app)
        .post("/api/bootstrap")
        .send({
          preferredType: "implementer-backend",
          runtimeId: `api-runtime-${slotNumber}`,
          now: "2026-06-12T15:00:00.000Z"
        })
        .expect(200);
    }

    const rejected = await request(app)
      .post("/api/bootstrap")
      .send({
        preferredType: "implementer-backend",
        runtimeId: "api-runtime-5",
        now: "2026-06-12T15:00:00.000Z"
      })
      .expect(409);

    expect(rejected.body.error.message).toContain("No available agent slot for implementer-backend");
    expect(rejected.body.error.details).toMatchObject({
      typeId: "implementer-backend",
      capacity: 4,
      active: 4
    });
  });

  it("requires completion evidence when marking a task done", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Completion API Project" })).body.project;
    const task = (
      await request(app).post("/api/tasks").send({
        projectId: project.id,
        title: "Complete with evidence",
        status: "review",
        role: "implementer",
        assignee: "implementer-01"
      })
    ).body.task;

    const missingEvidence = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({ status: "done", actor: "reviewer-01" })
      .expect(400);
    expect(missingEvidence.body.error.message).toMatch(/completion record/i);

    const completed = await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({
        status: "done",
        actor: "reviewer-01",
        completion: {
          completionType: "merged",
          branch: "implementer-01/evidence",
          commitSha: "def5678",
          tests: ["npm test"]
        }
      })
      .expect(200);

    expect(completed.body.task).toMatchObject({
      status: "done",
      completion: {
        completionType: "merged",
        completedBy: "reviewer-01",
        branch: "implementer-01/evidence",
        commitSha: "def5678",
        mergedTo: "main",
        tests: ["npm test"]
      }
    });
  });

  it("does not mutate a task when completion validation fails", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Atomic Completion API Project" })).body.project;
    const task = (
      await request(app).post("/api/tasks").send({
        projectId: project.id,
        title: "Original API title",
        status: "review",
        role: "implementer",
        assignee: "implementer-01"
      })
    ).body.task;

    await request(app)
      .patch(`/api/tasks/${task.id}`)
      .send({
        title: "Mutated through failed API completion",
        status: "done",
        actor: "reviewer-01",
        expectedRevision: task.revision,
        completion: {
          completionType: "merged"
        }
      })
      .expect(400);

    const fetched = await request(app).get(`/api/tasks/${task.id}`).expect(200);
    expect(fetched.body.task).toMatchObject({
      title: "Original API title",
      status: "review",
      completion: null
    });
  });

  it("requires completion evidence when creating an already-done task", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Create Done API Project" })).body.project;

    const missingEvidence = await request(app)
      .post("/api/tasks")
      .send({
        projectId: project.id,
        title: "Created already done",
        status: "done"
      })
      .expect(400);
    expect(missingEvidence.body.error.message).toMatch(/completion record/i);

    const completed = await request(app)
      .post("/api/tasks")
      .send({
        projectId: project.id,
        title: "Created done with evidence",
        status: "done",
        role: "pm",
        actor: "pm-agent",
        completion: {
          completionType: "no-code",
          notes: "Seeded as an already completed planning task."
        }
      })
      .expect(201);

    expect(completed.body.task).toMatchObject({
      status: "done",
      completion: {
        completionType: "no-code",
        completedBy: "pm-agent"
      }
    });
  });

  it("filters tasks and accepts file attachments", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Upload Project" })).body.project;
    const task = (
      await request(app).post("/api/tasks").send({
        projectId: project.id,
        title: "Check artifact",
        role: "tester"
      })
    ).body.task;

    await request(app)
      .post(`/api/tasks/${task.id}/attachments`)
      .field("author", "tester-agent")
      .attach("file", Buffer.from("artifact"), "result.txt")
      .expect(201);

    const filtered = await request(app)
      .get("/api/tasks")
      .query({ projectId: project.id, role: "tester", q: "artifact" })
      .expect(200);

    expect(filtered.body.tasks).toHaveLength(1);
    expect(filtered.body.tasks[0].attachments).toHaveLength(1);
  });

  it("sanitizes uploaded attachment filenames and downloads only from the owning task", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Attachment Safety Project" })).body.project;
    const firstTask = (
      await request(app).post("/api/tasks").send({
        projectId: project.id,
        title: "Attach unsafe file",
        role: "tester"
      })
    ).body.task;
    const secondTask = (
      await request(app).post("/api/tasks").send({
        projectId: project.id,
        title: "Unrelated attachment scope",
        role: "tester"
      })
    ).body.task;

    const uploaded = await request(app)
      .post(`/api/tasks/${firstTask.id}/attachments`)
      .field("author", "tester-agent")
      .attach("file", Buffer.from("download evidence"), "../bad spec?.txt")
      .expect(201);

    expect(uploaded.body.attachment).toMatchObject({
      filename: "bad_spec_.txt",
      size: "download evidence".length,
      uploadedBy: "tester-agent"
    });
    expect(uploaded.body.attachment.storedName).toMatch(new RegExp(`^${uploaded.body.attachment.id}-bad_spec_\\.txt$`));
    expect(uploaded.body.task.attachments[0]).toMatchObject({
      id: uploaded.body.attachment.id,
      filename: "bad_spec_.txt"
    });

    const downloaded = await request(app)
      .get(`/api/tasks/${firstTask.id}/attachments/${uploaded.body.attachment.id}/download`)
      .expect(200);

    expect(downloaded.headers["content-disposition"]).toContain('filename="bad_spec_.txt"');
    expect(downloaded.text).toBe("download evidence");

    await request(app)
      .get(`/api/tasks/${secondTask.id}/attachments/${uploaded.body.attachment.id}/download`)
      .expect(404);
  });

  it("returns 404 for missing attachments and rejects files over the upload limit", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Attachment Limits Project" })).body.project;
    const task = (
      await request(app).post("/api/tasks").send({
        projectId: project.id,
        title: "Check attachment limits",
        role: "tester"
      })
    ).body.task;

    await request(app).get(`/api/tasks/${task.id}/attachments/file_missing/download`).expect(404);

    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1, "a");
    const rejected = await request(app)
      .post(`/api/tasks/${task.id}/attachments`)
      .attach("file", oversized, "too-large.txt")
      .expect(413);

    expect(rejected.body.error.message).toMatch(/file too large/i);
    expect(store.getTask(task.id).attachments).toHaveLength(0);
  });
});
