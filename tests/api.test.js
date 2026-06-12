import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { WorkboardStore } from "../server/storage/workboardStore.js";

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
      .send({ status: "in_progress", assignee: "codex-agent", actor: "pm-agent" })
      .expect(200);

    expect(movedResponse.body.task).toMatchObject({
      status: "in_progress",
      assignee: "codex-agent"
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
        assignee: "implementer-01",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
      .expect(200);

    expect(firstClaim.body.task).toMatchObject({
      id: task.id,
      status: "in_progress",
      assignee: "implementer-01"
    });
    expect(firstClaim.body.task.activity[0]).toMatchObject({
      actor: "implementer-01",
      type: "claimed"
    });

    const staleClaim = await request(app)
      .post(`/api/tasks/${task.id}/claim`)
      .send({
        assignee: "implementer-02",
        expectedStatus: "ready",
        expectedAssignee: ""
      })
      .expect(409);

    expect(staleClaim.body.error.message).toMatch(/already claimed|expected/i);
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
});
