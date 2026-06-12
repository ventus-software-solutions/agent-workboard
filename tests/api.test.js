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
    expect(overview.body.identityModel.currentRule).toContain("concrete assignee id");
    expect(overview.body.slotBootstrap.status).toBe("planned");
    expect(overview.body.slotBootstrap.plannedMcpTool).toBe("acquire_agent_slot");
    expect(overview.body.slotBootstrap.currentFallback).toContain("implementer-a");

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
    expect(markdown.text).toContain("Automatic slot assignment is not implemented yet");
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
