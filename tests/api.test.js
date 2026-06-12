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

  it("exposes capability CRUD, filtering, and task completion links", async () => {
    const project = (await request(app).post("/api/projects").send({ name: "Capability API", key: "CAPAPI" })).body.project;
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
        .send({ assignee: "implementer-01", expectedStatus: "ready", expectedAssignee: "" })
        .expect(200)
    );

    version = await expectVersionChange(version, () =>
      request(app).patch(`/api/tasks/${task.id}`).send({ status: "review", actor: "implementer-01" }).expect(200)
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
