import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../server/app.js";
import { WorkboardStore } from "../server/storage/workboardStore.js";

let tempDir;
let store;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-stage-claims-"));
  store = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
  await store.init();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("review and testing stage claims", () => {
  it("CAS-claims review without replacing the implementer and filters claimed work", async () => {
    const project = await store.createProject({ name: "Review Claim Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Review this implementation",
      status: "review",
      assignee: "implementer-agent"
    });

    const next = store.getNextTaskForAgent("reviewer-agent", { projectId: project.id });
    expect(next.selection).toMatchObject({
      reason: "review_queue",
      stageClaim: { taskId: task.id, agentId: "reviewer-agent", expectedStatus: "review", expectedClaimant: "" }
    });

    const results = await Promise.allSettled([
      store.claimTaskStage(task.id, { agentId: "reviewer-agent", expectedStatus: "review", expectedClaimant: "" }),
      store.claimTaskStage(task.id, { agentId: "reviewer-agent-2", expectedStatus: "review", expectedClaimant: "" })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection.reason).toMatchObject({ status: 409 });

    const claimed = store.getTask(task.id);
    expect(claimed).toMatchObject({ status: "review", assignee: "implementer-agent" });
    expect(["reviewer-agent", "reviewer-agent-2"]).toContain(claimed.reviewedBy);
    expect(claimed.activity[0].type).toBe("review.claimed");
    expect(store.listTalkMessages({ projectId: project.id, taskId: task.id })[0]).toMatchObject({
      kind: "update",
      relatedTaskId: task.id
    });

    const otherReviewer = claimed.reviewedBy === "reviewer-agent" ? "reviewer-agent-2" : "reviewer-agent";
    const filtered = store.getNextTaskForAgent(otherReviewer, { projectId: project.id });
    expect(filtered.task).toBeNull();
  });

  it("never routes or permits a stage claim to the implementation assignee", async () => {
    const project = await store.createProject({ name: "Independent Review Project" });
    const selfReview = await store.createTask({
      projectId: project.id,
      title: "Do not self-review this implementation",
      status: "review",
      assignee: "reviewer-agent"
    });
    const selfTesting = await store.createTask({
      projectId: project.id,
      title: "Do not self-test this implementation",
      status: "testing",
      assignee: "test-agent"
    });

    expect(store.getNextTaskForAgent("reviewer-agent", { projectId: project.id }).task).toBeNull();
    expect(store.getNextTaskForAgent("test-agent", { projectId: project.id }).task).toBeNull();

    await expect(
      store.claimTaskStage(selfReview.id, {
        agentId: "reviewer-agent",
        expectedStatus: "review",
        role: "reviewer"
      })
    ).rejects.toMatchObject({ status: 409, details: { reason: "stage_self_claim" } });
    await expect(
      store.claimTaskStage(selfTesting.id, {
        agentId: "test-agent",
        expectedStatus: "testing",
        role: "tester"
      })
    ).rejects.toMatchObject({ status: 409, details: { reason: "stage_self_claim" } });
  });

  it("records a typed changes-requested verdict and clears it only on new commit evidence", async () => {
    const project = await store.createProject({ name: "Review Verdict Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Needs a verdict",
      status: "review",
      assignee: "implementer-agent"
    });
    await store.claimTaskStage(task.id, { agentId: "reviewer-agent", expectedStatus: "review" });

    const resolved = await store.resolveTaskStage(task.id, {
      agentId: "reviewer-agent",
      expectedStatus: "review",
      decision: "request_changes",
      findingsCount: 2,
      commitSha: "abc1234"
    });
    expect(resolved).toMatchObject({
      status: "ready",
      assignee: "implementer-agent",
      reviewedBy: "",
      reviewVerdict: {
        decision: "request_changes",
        findingsCount: 2,
        reviewer: "reviewer-agent",
        commitSha: "abc1234"
      }
    });
    expect(resolved.activity.some((event) => event.message === "Updated status:review->ready.")).toBe(true);

    await store.updateTask(task.id, { status: "review" }, "implementer-agent");
    expect(store.getTask(task.id).reviewVerdict).toMatchObject({
      decision: "request_changes",
      commitSha: "abc1234"
    });
    await store.updateTask(task.id, { status: "ready" }, "implementer-agent");

    await store.addComment(task.id, { author: "implementer-agent", body: "Plan only; no new commit." });
    expect(store.getTask(task.id).reviewVerdict).not.toBeNull();
    await store.addComment(task.id, {
      author: "implementer-agent",
      body: "Fix pushed.",
      evidence: { commitSha: "def5678" }
    });
    expect(store.getTask(task.id).reviewVerdict).toBeNull();
    expect(store.getTask(task.id).activity.some((event) => event.type === "review.evidence_added")).toBe(true);
  });

  it("requires stage resolution before every exit from a claimed review or testing stage", async () => {
    const project = await store.createProject({ name: "Stage Exit Guard Project" });
    const reviewTask = await store.createTask({
      projectId: project.id,
      title: "Cannot bypass review verdict through blocked",
      status: "review",
      assignee: "implementer-agent"
    });
    await store.claimTaskStage(reviewTask.id, { agentId: "reviewer-agent", expectedStatus: "review" });

    await expect(
      store.updateTask(
        reviewTask.id,
        { status: "blocked", blocker: { type: "external_issue", summary: "Reviewer cannot continue" } },
        "reviewer-agent"
      )
    ).rejects.toMatchObject({ status: 409, details: { reason: "review_verdict_required", requestedStatus: "blocked" } });
    expect(store.getTask(reviewTask.id)).toMatchObject({ status: "review", reviewedBy: "reviewer-agent", reviewVerdict: null });

    const testingTask = await store.createTask({
      projectId: project.id,
      title: "Cannot bypass testing resolution",
      status: "testing",
      assignee: "implementer-agent"
    });
    await store.claimTaskStage(testingTask.id, { agentId: "test-agent", expectedStatus: "testing" });
    await expect(
      store.updateTask(testingTask.id, { status: "done", completion: { completionType: "merged", commitSha: "abc123" } }, "test-agent")
    ).rejects.toMatchObject({ status: 409, details: { reason: "testing_resolution_required", requestedStatus: "done" } });
    expect(store.getTask(testingTask.id)).toMatchObject({ status: "testing", testedBy: "test-agent" });
  });

  it("claims testing independently and prevents reviewers from impersonating the implementer transition", async () => {
    const project = await store.createProject({ name: "Testing Claim Project" });
    const reviewTask = await store.createTask({
      projectId: project.id,
      title: "Protected review transition",
      status: "review",
      assignee: "implementer-agent"
    });
    await expect(store.updateTask(reviewTask.id, { status: "in_progress" }, "reviewer-agent")).rejects.toMatchObject({ status: 409 });

    const testingTask = await store.createTask({
      projectId: project.id,
      title: "Verify running system",
      status: "testing",
      assignee: "implementer-agent"
    });
    const next = store.getNextTaskForAgent("test-agent", { projectId: project.id });
    expect(next.selection.stageClaim).toMatchObject({ taskId: testingTask.id, expectedStatus: "testing" });
    const claimed = await store.claimTaskStage(testingTask.id, { agentId: "test-agent", expectedStatus: "testing" });
    expect(claimed).toMatchObject({ status: "testing", assignee: "implementer-agent", testedBy: "test-agent" });
  });

  it("exposes stage claim and structured resolution through REST", async () => {
    const project = await store.createProject({ name: "Stage Claim API Project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Review through API",
      status: "review",
      assignee: "implementer-agent"
    });
    const app = createApp({ store });

    await request(app)
      .post(`/api/tasks/${task.id}/stage-claim`)
      .send({ agentId: "reviewer-agent", expectedStatus: "review", expectedClaimant: "" })
      .expect(200);
    const duplicate = await request(app)
      .post(`/api/tasks/${task.id}/stage-claim`)
      .send({ agentId: "reviewer-agent-2", expectedStatus: "review", expectedClaimant: "" })
      .expect(409);
    expect(duplicate.body.error.details.reason).toBe("stage_already_claimed");

    const resolved = await request(app)
      .post(`/api/tasks/${task.id}/stage-resolution`)
      .send({
        agentId: "reviewer-agent",
        expectedStatus: "review",
        decision: "approve",
        findingsCount: 0,
        commitSha: "feed123"
      })
      .expect(200);
    expect(resolved.body.task).toMatchObject({
      status: "review",
      assignee: "implementer-agent",
      reviewedBy: "",
      reviewVerdict: { decision: "approve", commitSha: "feed123" }
    });
  });
});
