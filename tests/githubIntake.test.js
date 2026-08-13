import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.js";
import { GitHubIntakeService, GitHubRestClient, readGitHubIntakeConfig } from "../server/githubIntake.js";
import { WorkboardStore } from "../server/storage/workboardStore.js";

let tempDir;
let store;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-github-intake-"));
  store = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
  await store.init();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("GitHub intake configuration and REST client", () => {
  it("stays disabled unless the workboard repository is explicitly configured", () => {
    const disabled = readGitHubIntakeConfig({ GITHUB_REPOSITORY: "ambient/actions-repository", GITHUB_TOKEN: "secret" });
    expect(disabled).toMatchObject({ enabled: false, repository: "", token: "secret" });

    const enabled = readGitHubIntakeConfig({
      WORKBOARD_GITHUB_REPOSITORY: "Ventus-Software-Solutions/Agent-Workboard",
      WORKBOARD_GITHUB_TOKEN: "configured-secret",
      WORKBOARD_GITHUB_SYNC_INTERVAL_MS: "0",
      WORKBOARD_GITHUB_EXTERNAL_AGE_DAYS: "5"
    });
    expect(enabled).toMatchObject({
      enabled: true,
      repository: "ventus-software-solutions/agent-workboard",
      token: "configured-secret",
      syncIntervalMs: 0,
      attentionAgeDays: 5
    });
  });

  it("paginates on the configured API origin and authenticates without gh CLI assumptions", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ number: 1 }], {
          link: '<https://api.github.test/repos/acme/work/pulls?state=all&per_page=100&page=2>; rel="next"'
        })
      )
      .mockResolvedValueOnce(jsonResponse([{ number: 2 }]));
    const client = new GitHubRestClient({
      repository: "acme/work",
      token: "token-value",
      apiBaseUrl: "https://api.github.test",
      fetchImpl
    });

    await expect(client.listPullRequests()).resolves.toEqual([{ number: 1 }, { number: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
      Authorization: "Bearer token-value",
      Accept: "application/vnd.github+json"
    });
  });
});

describe("GitHub intake synchronization", () => {
  it("creates unlinked PR and issue chores exactly once and routes dependency PRs to review", async () => {
    const client = mutableClient({
      pulls: [pullRequest()],
      issues: [issue(), { ...issue({ number: 99 }), pull_request: { url: "https://api.github.test/pulls/99" } }]
    });
    const service = intakeService(client);

    const first = await service.sync();
    expect(first).toMatchObject({
      created: 2,
      updated: 0,
      unchanged: 0,
      fetched: { pullRequests: 1, issues: 1 }
    });

    const tasks = store.listTasks({ projectId: "project_demo" }).filter((task) => task.labels.includes("external"));
    expect(tasks).toHaveLength(2);
    expect(tasks.find((task) => task.externalSource.kind === "pull_request")).toMatchObject({
      status: "ready",
      role: "reviewer",
      workItemType: "chore",
      labels: expect.arrayContaining(["external", "github", "pull-request", "dependencies"]),
      externalSource: {
        provider: "github",
        repository: "acme/work",
        number: 12,
        state: "open",
        headBranch: "dependabot/npm_and_yarn/vite-6.4.3"
      }
    });
    expect(tasks.find((task) => task.externalSource.kind === "issue")).toMatchObject({
      status: "ready",
      role: "pm",
      workItemType: "chore",
      labels: expect.arrayContaining(["external", "github", "issue"])
    });

    const second = await service.sync();
    expect(second).toMatchObject({ created: 0, unchanged: 2 });
    expect(store.listTasks({ projectId: "project_demo" }).filter((task) => task.labels.includes("external"))).toHaveLength(2);
  });

  it("auto-completes linked items with external merge/closure evidence and skips closed unlinked history", async () => {
    const client = mutableClient({ pulls: [pullRequest()], issues: [issue()] });
    const service = intakeService(client);
    await service.sync();

    client.pulls = [
      pullRequest({
        state: "closed",
        closed_at: "2026-08-13T09:00:00Z",
        merged_at: "2026-08-13T09:00:00Z",
        merge_commit_sha: "a".repeat(40)
      }),
      pullRequest({ number: 44, state: "closed", closed_at: "2026-08-12T09:00:00Z" })
    ];
    client.issues = [issue({ state: "closed", closed_at: "2026-08-13T09:05:00Z" })];

    const result = await service.sync();
    expect(result).toMatchObject({ completed: 2, skippedClosedUnlinked: 1 });

    const prTask = store.listTasks({ projectId: "project_demo" }).find((task) => task.externalSource?.kind === "pull_request");
    expect(prTask).toMatchObject({
      status: "done",
      assignee: "",
      externalSource: { state: "merged", mergeCommitSha: "a".repeat(40) },
      completion: {
        completionType: "merged",
        completedBy: "github-intake",
        commitSha: "a".repeat(40),
        branch: "dependabot/npm_and_yarn/vite-6.4.3",
        mergedTo: "main"
      }
    });
    const issueTask = store.listTasks({ projectId: "project_demo" }).find((task) => task.externalSource?.kind === "issue");
    expect(issueTask).toMatchObject({
      status: "done",
      externalSource: { state: "closed" },
      completion: { completionType: "no-code", completedBy: "github-intake" }
    });
  });

  it("exposes status and on-demand sync without leaking the configured token", async () => {
    const service = intakeService(mutableClient({ pulls: [], issues: [] }));
    const app = createApp({ store, githubIntake: service });

    const status = await request(app).get("/api/github-intake").expect(200);
    expect(status.body.intake).toMatchObject({
      enabled: true,
      repository: "acme/work",
      tokenConfigured: true,
      running: false
    });
    expect(JSON.stringify(status.body)).not.toContain("test-token");

    const synced = await request(app).post("/api/github-intake/sync").expect(200);
    expect(synced.body.sync).toMatchObject({ created: 0, repository: "acme/work" });
  });

  it("requires a current task revision before changing external identity state", async () => {
    const created = await store.createTask({
      projectId: "project_demo",
      title: "Externally linked issue",
      externalSource: issueSource()
    });
    const initialRevision = created.revision;
    await expect(
      store.updateTask(created.id, { externalSource: { ...issueSource(), updatedAt: "2026-08-13T09:00:00.000Z" } }, "client")
    ).rejects.toMatchObject({ status: 400 });

    const updated = await store.updateTask(
      created.id,
      {
        externalSource: { ...issueSource(), updatedAt: "2026-08-13T09:00:00.000Z" },
        expectedRevision: initialRevision
      },
      "client"
    );
    expect(updated).toMatchObject({ revision: initialRevision + 1, externalSource: { updatedAt: "2026-08-13T09:00:00.000Z" } });

    await expect(
      store.updateTask(
        created.id,
        { externalSource: { ...issueSource(), updatedAt: "2026-08-13T10:00:00.000Z" }, expectedRevision: initialRevision },
        "stale-client"
      )
    ).rejects.toMatchObject({ status: 409 });
  });

  it("coalesces overlapping timer and on-demand sync requests into one REST pass", async () => {
    let release;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const client = {
      listPullRequests: vi.fn(() => pending.then(() => [])),
      listIssues: vi.fn(() => pending.then(() => []))
    };
    const service = intakeService(client);

    const first = service.sync();
    const second = service.sync();
    expect(second).toBe(first);
    expect(client.listPullRequests).toHaveBeenCalledTimes(1);
    expect(client.listIssues).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toMatchObject({ created: 0 });
  });

  it("keeps the task open when a merged PR response lacks a merge commit SHA", async () => {
    const client = mutableClient({ pulls: [pullRequest()], issues: [] });
    const service = intakeService(client);
    await service.sync();
    client.pulls = [pullRequest({ state: "closed", merged_at: "2026-08-13T09:00:00Z", merge_commit_sha: null })];

    const result = await service.sync();
    expect(result).toMatchObject({ completed: 0, updated: 1 });
    const task = store.listTasks({ projectId: "project_demo" }).find((candidate) => candidate.externalSource?.number === 12);
    expect(task).toMatchObject({ status: "ready", externalSource: { state: "merged" }, completion: null });
  });
});

function intakeService(client) {
  return new GitHubIntakeService({
    store,
    client,
    config: {
      enabled: true,
      repository: "acme/work",
      token: "test-token",
      projectKey: "DEMO",
      syncIntervalMs: 0,
      attentionAgeDays: 3
    },
    clock: () => new Date("2026-08-13T12:00:00.000Z")
  });
}

function mutableClient({ pulls, issues }) {
  return {
    pulls,
    issues,
    listPullRequests() {
      return Promise.resolve(this.pulls);
    },
    listIssues() {
      return Promise.resolve(this.issues.filter((item) => !item.pull_request));
    }
  };
}

function pullRequest(patch = {}) {
  const number = patch.number || 12;
  return {
    number,
    title: "Bump Vite docs toolchain",
    html_url: `https://github.test/acme/work/pull/${number}`,
    state: "open",
    user: { login: "dependabot[bot]" },
    labels: [{ name: "dependencies" }],
    created_at: "2026-08-09T08:00:00Z",
    updated_at: "2026-08-12T08:00:00Z",
    closed_at: null,
    merged_at: null,
    merge_commit_sha: null,
    head: { ref: "dependabot/npm_and_yarn/vite-6.4.3" },
    base: { ref: "main" },
    ...patch
  };
}

function issue(patch = {}) {
  const number = patch.number || 23;
  return {
    number,
    title: "Document hosted deployment",
    html_url: `https://github.test/acme/work/issues/${number}`,
    state: "open",
    user: { login: "contributor" },
    labels: [{ name: "documentation" }],
    created_at: "2026-08-10T08:00:00Z",
    updated_at: "2026-08-12T08:00:00Z",
    closed_at: null,
    ...patch
  };
}

function issueSource() {
  return {
    provider: "github",
    repository: "acme/work",
    kind: "issue",
    number: 23,
    url: "https://github.test/acme/work/issues/23",
    state: "open",
    openedAt: "2026-08-10T08:00:00.000Z"
  };
}

function jsonResponse(payload, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers }
  });
}
