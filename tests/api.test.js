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
    expect(overview.body.suggestedAgents).toContain("pm-agent");
    expect(overview.body.usage.promptTemplate).toContain("/api/agent-docs/{agentId}");

    const pmDoc = await request(app).get("/api/agent-docs/pm-agent").expect(200);
    expect(pmDoc.body.agent).toMatchObject({
      agentId: "pm-agent",
      role: "pm"
    });
    expect(pmDoc.body.agent.workflow).toContain("Only then look for another task.");

    const mcpDoc = await request(app).get("/api/agent-docs/mcp-agent").expect(200);
    expect(mcpDoc.body.agent.role).toBe("implementer");
    expect(mcpDoc.body.agent.specialties).toContain("mcp");

    const markdown = await request(app).get("/api/agent-docs/test-agent?format=md").expect(200);
    expect(markdown.headers["content-type"]).toContain("text/markdown");
    expect(markdown.text).toContain("You are **test-agent**");
    expect(markdown.text).toContain("Claim exactly one task");
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
