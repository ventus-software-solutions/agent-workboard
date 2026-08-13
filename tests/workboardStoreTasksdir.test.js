import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkboardStore } from "../server/storage/workboardStore.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tasksdir");
const FBR_BUG = "fbr_20260812143216_78750600c";
const FBR_WONT_DO = "fbr_20260810090000_11aa22bb3";

let tempDir;
let dataDir;
let tasksDir;

async function openStore() {
  const store = new WorkboardStore({ dataDir, storageMode: "tasksdir", tasksDir });
  await store.init();
  return store;
}

async function snapshotFiles() {
  const snapshot = new Map();
  for (const dirent of await readdir(tasksDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    snapshot.set(dirent.name, await readFile(path.join(tasksDir, dirent.name, "task.md"), "utf8"));
  }
  return snapshot;
}

function taskFilePath(folder) {
  return path.join(tasksDir, folder, "task.md");
}

async function writeTaskFolder(folder, id, { status = "todo", type = "bug", title = id } = {}) {
  await mkdir(path.join(tasksDir, folder), { recursive: true });
  await writeFile(
    taskFilePath(folder),
    `---\nid: ${id}\ntitle: "${title}"\nowner: unassigned\nstatus: ${status}\ntype: ${type}\npriority: unset\nlabels:\ncreated: 2026-08-13\n---\nBody of ${id}.\n`
  );
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-tasksdir-"));
  dataDir = path.join(tempDir, "data");
  tasksDir = path.join(tempDir, "tasks");
  await cp(fixturesDir, tasksDir, { recursive: true });
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("WorkboardStore tasksdir mode", () => {
  it("keeps external GitHub identity in the ops sidecar across restarts", async () => {
    const store = await openStore();
    const externalSource = {
      provider: "github",
      repository: "acme/work",
      kind: "issue",
      number: 23,
      url: "https://github.test/acme/work/issues/23",
      state: "open",
      openedAt: "2026-08-10T08:00:00.000Z",
      attentionAfterAt: "2026-08-13T08:00:00.000Z"
    };
    const created = await store.createTask({
      projectId: "project_demo",
      title: "GitHub issue #23",
      role: "pm",
      status: "ready",
      workItemType: "chore",
      labels: ["external"],
      externalSource
    });

    const restarted = await openStore();
    expect(restarted.getTask(created.id).externalSource).toEqual(externalSource);
  });

  it("boots against a tasks dir, maps files to board tasks, and seeds no demo work items", async () => {
    const store = await openStore();
    const tasks = store.listTasks({});

    expect(tasks.map((task) => task.id).sort()).toEqual(
      [FBR_BUG, FBR_WONT_DO, "idea_realtime_sync", "task_docs_cleanup"].sort()
    );
    expect(tasks.every((task) => task.projectId === "project_demo")).toBe(true);

    const bug = store.getTask(FBR_BUG);
    expect(bug).toMatchObject({ status: "ready", workItemType: "bug", assignee: "", priority: null });
    expect(bug.description).toContain("Felix reported");

    expect(store.getTask(FBR_WONT_DO)).toMatchObject({
      status: "done",
      workItemType: "chore",
      completion: expect.objectContaining({ completionType: "no-code" })
    });
    expect(store.getTask("task_docs_cleanup")).toMatchObject({
      status: "done",
      workItemType: "chore",
      labels: expect.arrayContaining(["docs", "onboarding", "tariffs"]),
      completion: expect.objectContaining({ completionType: "legacy-needs-audit" })
    });
    expect(store.getTask("idea_realtime_sync")).toMatchObject({
      status: "backlog",
      workItemType: "spike",
      labels: expect.arrayContaining(["idea"])
    });
  });

  it("boots twice without rewriting any task file (no bulk rewrite, no status rewrite on read)", async () => {
    const before = await snapshotFiles();
    await openStore();
    await openStore();
    const after = await snapshotFiles();
    expect(after).toEqual(before);
  });

  it("rewrites only the mutated task's file and preserves unknown keys and the body byte-for-byte", async () => {
    const store = await openStore();
    const before = await snapshotFiles();

    const task = store.getTask(FBR_BUG);
    await store.updateTask(
      FBR_BUG,
      { priority: "high", touches: ["server/storage/**"], expectedRevision: task.revision },
      "operator"
    );

    const after = await snapshotFiles();
    for (const [folder, content] of before) {
      if (folder === FBR_BUG) continue;
      expect(after.get(folder), folder).toBe(content);
    }

    const rewritten = after.get(FBR_BUG);
    const original = before.get(FBR_BUG);
    expect(rewritten).not.toBe(original);
    expect(rewritten).toContain("priority: high");
    expect(rewritten).toContain('touches: ["server/storage/**"]');
    // unknown keys keep their exact lines
    for (const line of ["source: fbr", `fbr_ref: ${FBR_BUG}`, "module: '-'", "created: 2026-08-12"]) {
      expect(rewritten).toContain(line);
    }
    // legacy status is not rewritten by an unrelated mutation
    expect(rewritten).toContain("status: todo");
    // the markdown body is byte-identical
    const body = original.slice(original.indexOf("\n---\n") + 5);
    expect(rewritten.endsWith(body)).toBe(true);
    // board-only fields live in the namespaced board block
    expect(rewritten).toContain("board:\n");
    expect(rewritten).toMatch(/ {2}revision: \d+/);

    const reloaded = await openStore();
    expect(reloaded.getTask(FBR_BUG).touches).toEqual(["server/storage/**"]);
  });

  it("claims through the file: winner writes owner/status, loser gets a 409", async () => {
    const store = await openStore();

    const results = await Promise.allSettled([
      store.claimTask(FBR_BUG, { assignee: "implementer-backend-1", expectedStatus: "ready" }),
      store.claimTask(FBR_BUG, { assignee: "implementer-backend-2", expectedStatus: "ready" })
    ]);

    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.status).toBe(409);

    const content = await readFile(taskFilePath(FBR_BUG), "utf8");
    expect(content).toContain("status: in_progress");
    expect(content).toMatch(/owner: implementer-backend-[12]/);
  });

  it("a second store instance sees a claim made through the files and refuses to re-claim", async () => {
    const storeA = await openStore();
    const storeB = await openStore();

    await storeA.claimTask(FBR_BUG, { assignee: "implementer-backend-1", expectedStatus: "ready" });

    await expect(
      storeB.claimTask(FBR_BUG, { assignee: "implementer-backend-2", expectedStatus: "ready" })
    ).rejects.toMatchObject({ status: 409 });
  });

  it("reconciles a disjoint external edit instead of clobbering it", async () => {
    const store = await openStore();

    const original = await readFile(taskFilePath(FBR_BUG), "utf8");
    await writeFile(
      taskFilePath(FBR_BUG),
      original.replace(
        'title: "COLA closeout crashes when the report has no line items"',
        'title: "COLA closeout crashes on empty reports"'
      )
    );

    const task = store.getTask(FBR_BUG);
    await store.updateTask(FBR_BUG, { priority: "urgent", expectedRevision: task.revision }, "operator");

    const content = await readFile(taskFilePath(FBR_BUG), "utf8");
    expect(content).toContain('title: "COLA closeout crashes on empty reports"');
    expect(content).toContain("priority: urgent");

    const reconciled = store.getTask(FBR_BUG);
    expect(reconciled.title).toBe("COLA closeout crashes on empty reports");
    expect(reconciled.priority).toBe("urgent");
    expect(reconciled.activity.some((event) => event.type === "external.reconciled")).toBe(true);
  });

  it("rejects a cached ready task entering testing externally without a verification target", async () => {
    const store = await openStore();
    const original = await readFile(taskFilePath(FBR_BUG), "utf8");
    await writeFile(taskFilePath(FBR_BUG), original.replace("status: todo", "status: testing"));

    const task = store.getTask(FBR_BUG);
    await expect(
      store.updateTask(FBR_BUG, { priority: "high", expectedRevision: task.revision }, "operator")
    ).rejects.toMatchObject({ status: 409, reason: "verification_target_required", taskId: FBR_BUG });

    const rejected = store.getTask(FBR_BUG);
    expect(rejected.status).toBe("ready");
    expect(rejected.priority).toBeNull();
    expect(rejected.verificationTarget).toBeNull();
    expect(rejected.activity.some((event) => event.type === "update.rejected")).toBe(true);
    expect(await readFile(taskFilePath(FBR_BUG), "utf8")).toContain("status: testing");
  });

  it("rejects a new external testing task without a verification target after the gate is established", async () => {
    await openStore();
    await writeTaskFolder("external_testing", "external_testing", { status: "testing" });

    await expect(openStore()).rejects.toMatchObject({
      status: 409,
      reason: "verification_target_required",
      taskId: "external_testing"
    });
  });

  it("migrates a testing task that predates the tasksdir verification-target gate", async () => {
    await writeTaskFolder("legacy_testing", "legacy_testing", { status: "testing" });

    const store = await openStore();
    expect(store.getTask("legacy_testing")).toMatchObject({
      status: "testing",
      verificationTarget: {
        commitSha: "",
        mergedTo: "",
        artifactNote: expect.stringMatching(/before verification targets were required/i)
      }
    });
    expect(await readFile(taskFilePath("legacy_testing"), "utf8")).toContain("verificationTarget:");

    const reloaded = await openStore();
    expect(reloaded.getTask("legacy_testing").verificationTarget.artifactNote).toMatch(
      /before verification targets were required/i
    );
  });

  it("rejects a stale write when the same key changed externally, records it, and keeps the store usable", async () => {
    const store = await openStore();

    const original = await readFile(taskFilePath(FBR_BUG), "utf8");
    await writeFile(taskFilePath(FBR_BUG), original.replace("priority: unset", "priority: low"));

    const task = store.getTask(FBR_BUG);
    await expect(
      store.updateTask(FBR_BUG, { priority: "urgent", expectedRevision: task.revision }, "operator")
    ).rejects.toMatchObject({ status: 409, reason: "stale_task_file" });

    // the external value wins on disk and in memory
    const content = await readFile(taskFilePath(FBR_BUG), "utf8");
    expect(content).toContain("priority: low");
    const reverted = store.getTask(FBR_BUG);
    expect(reverted.priority).toBe("low");
    expect(reverted.activity.some((event) => event.type === "update.rejected")).toBe(true);
    // the failed mutation's own audit events are rolled back, not left beside the rejection
    expect(reverted.activity.filter((event) => event.type === "updated")).toHaveLength(0);

    // the rejection survives a restart via the ops sidecar
    const reloaded = await openStore();
    expect(reloaded.getTask(FBR_BUG).activity.some((event) => event.type === "update.rejected")).toBe(true);

    // and the store still saves afterwards (the write queue is not poisoned)
    const fresh = store.getTask(FBR_BUG);
    await store.updateTask(FBR_BUG, { labels: ["triaged"], expectedRevision: fresh.revision }, "operator");
    expect((await readFile(taskFilePath(FBR_BUG), "utf8")).includes("labels: [triaged]")).toBe(true);
  });

  it("creates a board task as a new task folder in the consumer file shape", async () => {
    const store = await openStore();
    const task = await store.createTask({
      projectId: "project_demo",
      title: "Wire the tariff export to the new endpoint",
      description: "Use the /v2/export endpoint.\n\nSee the API notes.",
      status: "ready",
      priority: "high",
      role: "implementer",
      labels: ["export"]
    });

    const content = await readFile(taskFilePath(task.id), "utf8");
    expect(content).toContain(`id: ${task.id}`);
    expect(content).toContain('title: "Wire the tariff export to the new endpoint"');
    expect(content).toContain("owner: unassigned");
    expect(content).toContain("status: ready");
    expect(content).toContain("type: task");
    expect(content).toContain("priority: high");
    expect(content).toContain("labels: [export]");
    expect(content).toMatch(/board:\n {2}revision: 1/);
    expect(content).toContain("Use the /v2/export endpoint.");

    const reloaded = await openStore();
    expect(reloaded.getTask(task.id)).toMatchObject({
      title: "Wire the tariff export to the new endpoint",
      status: "ready",
      priority: "high",
      labels: ["export"]
    });
  });

  it("keeps comments in the ops sidecar and bumps only the board block in the file", async () => {
    const store = await openStore();
    const before = await readFile(taskFilePath(FBR_BUG), "utf8");

    await store.addComment(FBR_BUG, { author: "implementer-backend-1", body: "Plan: guard the reduce." });

    const after = await readFile(taskFilePath(FBR_BUG), "utf8");
    expect(after).not.toContain("Plan: guard the reduce.");
    expect(after).toMatch(/board:\n {2}revision: 2/);
    // everything else in the file is untouched
    const stripBoard = (text) => text.replace(/board:\n( {2}.+\n)+/, "");
    expect(stripBoard(after)).toBe(stripBoard(before));

    const reloaded = await openStore();
    const comments = reloaded.getTask(FBR_BUG).comments;
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ author: "implementer-backend-1", body: "Plan: guard the reduce." });
  });

  it("fails fast when WORKBOARD_TASKS_DIR is missing or does not exist", async () => {
    expect(() => new WorkboardStore({ dataDir, storageMode: "tasksdir", tasksDir: "" })).toThrow(
      /WORKBOARD_TASKS_DIR/
    );

    const missing = new WorkboardStore({
      dataDir,
      storageMode: "tasksdir",
      tasksDir: path.join(tempDir, "no-such-tasks")
    });
    await expect(missing.init()).rejects.toThrow(/does not exist/);
  });

  it("keeps global tasksdir mode as a single-tree fallback instead of accepting project bindings", async () => {
    const store = await openStore();
    await expect(
      store.createProject({ name: "Second tree", dataSource: { tasksDir: path.join(tempDir, "other-tasks") } })
    ).rejects.toMatchObject({
      status: 409,
      details: { reason: "project_data_sources_unavailable_in_global_tasksdir" }
    });
  });

  it("binds a duplicated frontmatter id to the canonical folder (folder name == id)", async () => {
    // A copied folder with a stale id: must never hijack the canonical task,
    // regardless of readdir order (dupe_a sorts before the canonical folder,
    // zz_copy after it).
    await writeTaskFolder("plain_bug", "plain_bug");
    await writeTaskFolder("dupe_a", "plain_bug", { title: "stale copy A" });
    await writeTaskFolder("zz_copy", "plain_bug", { title: "stale copy Z" });

    const store = await openStore();
    const matches = store.listTasks({}).filter((task) => task.id === "plain_bug");
    expect(matches).toHaveLength(1);
    expect(matches[0].title).toBe("plain_bug");

    const before = await snapshotFiles();
    const task = store.getTask("plain_bug");
    await store.updateTask("plain_bug", { priority: "high", expectedRevision: task.revision }, "operator");

    const after = await snapshotFiles();
    expect(after.get("plain_bug")).toContain("priority: high");
    expect(after.get("dupe_a")).toBe(before.get("dupe_a"));
    expect(after.get("zz_copy")).toBe(before.get("zz_copy"));
  });

  it("keeps an operator-promoted idea ready across restarts", async () => {
    const store = await openStore();
    expect(store.getTask("idea_realtime_sync").status).toBe("backlog");

    await store.updateTask("idea_realtime_sync", { status: "ready" }, "operator");
    expect((await readFile(taskFilePath("idea_realtime_sync"), "utf8"))).toContain("status: ready");

    const reloaded = await openStore();
    expect(reloaded.getTask("idea_realtime_sync")).toMatchObject({ status: "ready", workItemType: "spike" });
  });

  it("refuses to boot over an ops store that still holds snapshot work items, unless overridden", async () => {
    const jsonStore = new WorkboardStore({ dataDir, storageMode: "json" });
    await jsonStore.init(); // seeds demo work items into the snapshot

    await expect(openStore()).rejects.toThrow(/already contains 2 stored work item/);

    process.env.WORKBOARD_TASKSDIR_IGNORE_SNAPSHOT_TASKS = "1";
    try {
      const store = await openStore();
      expect(store.listTasks({}).map((task) => task.id)).not.toContain("task_demo_impl");
    } finally {
      delete process.env.WORKBOARD_TASKSDIR_IGNORE_SNAPSHOT_TASKS;
    }
  });

  it("assigns new external task folders to the configured default project key", async () => {
    const bootstrap = await openStore();
    const team = await bootstrap.createProject({ name: "Team Build", key: "TEAM-BUILD" });

    // a git pull brings a task folder the board has no sidecar for
    await writeTaskFolder("ext_new_task", "ext_new_task");

    const store = new WorkboardStore({ dataDir, storageMode: "tasksdir", tasksDir, defaultProjectKey: "team build" });
    await store.init();
    expect(store.getTask("ext_new_task").projectId).toBe(team.id);
    // tasks already bound via their sidecar keep their project
    expect(store.getTask(FBR_BUG).projectId).toBe("project_demo");
  });

  it("does not log a reconcile event for a content-neutral mtime touch", async () => {
    const store = await openStore();
    const filePath = taskFilePath(FBR_BUG);
    await writeFile(filePath, await readFile(filePath, "utf8")); // same bytes
    const future = new Date(Date.now() + 5000);
    await utimes(filePath, future, future);

    const task = store.getTask(FBR_BUG);
    await store.updateTask(FBR_BUG, { priority: "high", expectedRevision: task.revision }, "operator");

    const updated = store.getTask(FBR_BUG);
    expect(updated.priority).toBe("high");
    expect(updated.activity.some((event) => event.type === "external.reconciled")).toBe(false);
    expect(await readFile(filePath, "utf8")).toContain("priority: high");
  });

  it("sweeps stale tmp litter from a task folder on the next write", async () => {
    const store = await openStore();
    const litterPath = `${taskFilePath(FBR_BUG)}.deadbeef.tmp`;
    await writeFile(litterPath, "crash leftover");

    const task = store.getTask(FBR_BUG);
    await store.updateTask(FBR_BUG, { priority: "urgent", expectedRevision: task.revision }, "operator");

    expect(existsSync(litterPath)).toBe(false);
    expect(await readFile(taskFilePath(FBR_BUG), "utf8")).toContain("priority: urgent");
  });

  it("does not touch task files when only ops state changes", async () => {
    const store = await openStore();
    const before = await snapshotFiles();
    const stats = new Map();
    for (const folder of before.keys()) {
      stats.set(folder, (await stat(taskFilePath(folder))).mtimeMs);
    }

    await store.acquireAgentSlot({ agentId: "implementer-backend-1" });
    await store.addTalkMessage("project_demo", {
      author: "implementer-backend-1",
      kind: "update",
      body: "Ops-only write."
    });

    const after = await snapshotFiles();
    expect(after).toEqual(before);
    for (const folder of before.keys()) {
      expect((await stat(taskFilePath(folder))).mtimeMs, folder).toBe(stats.get(folder));
    }
  });

  it("persists stage ownership and review verdicts in tasksdir sidecars", async () => {
    const store = await openStore();
    await store.updateTask(FBR_BUG, { status: "review" }, "implementer-agent");
    await store.claimTaskStage(FBR_BUG, { agentId: "reviewer-agent", expectedStatus: "review" });

    let reloaded = await openStore();
    expect(reloaded.getTask(FBR_BUG)).toMatchObject({
      status: "review",
      reviewedBy: "reviewer-agent"
    });

    await reloaded.resolveTaskStage(FBR_BUG, {
      agentId: "reviewer-agent",
      expectedStatus: "review",
      decision: "request_changes",
      findingsCount: 1,
      commitSha: "abc1234"
    });
    reloaded = await openStore();
    expect(reloaded.getTask(FBR_BUG)).toMatchObject({
      status: "ready",
      reviewedBy: "",
      reviewVerdict: { decision: "request_changes", findingsCount: 1, commitSha: "abc1234" }
    });
  });

  it("persists task delivery links in tasksdir sidecars across store reopen", async () => {
    let store = await openStore();
    const task = store.getTask(FBR_BUG);
    await store.updateTask(
      FBR_BUG,
      {
        pullRequestUrl: "https://github.com/acme/workboard/pull/42",
        branch: "implementer/task-links",
        expectedRevision: task.revision
      },
      "implementer-agent"
    );

    store = await openStore();
    expect(store.getTask(FBR_BUG)).toMatchObject({
      pullRequestUrl: "https://github.com/acme/workboard/pull/42",
      branch: "implementer/task-links"
    });
  });
});
