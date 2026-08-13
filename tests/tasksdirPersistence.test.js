import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTaskFile, serializeTaskFile } from "../server/storage/frontmatterTaskFile.js";
import {
  applyViewToDoc,
  fileViewFromBoardTask,
  mapFileTask,
  threeWayMergeViews
} from "../server/storage/tasksdirPersistence.js";
import { createWorkboardPersistence } from "../server/storage/persistence.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "tasksdir");

function docFromFrontmatter(lines, body = "Body.\n") {
  return parseTaskFile(`---\n${lines.join("\n")}\n---\n${body}`);
}

describe("frontmatter round-trip", () => {
  it("serializes every fixture task.md byte-for-byte, including CRLF files", async () => {
    const folders = (await readdir(fixturesDir, { withFileTypes: true })).filter((d) => d.isDirectory());
    expect(folders.length).toBeGreaterThanOrEqual(4);
    for (const folder of folders) {
      const raw = await readFile(path.join(fixturesDir, folder.name, "task.md"), "utf8");
      expect(serializeTaskFile(parseTaskFile(raw)), folder.name).toBe(raw);
    }
  });

  it("touches only the changed key and preserves unknown keys and the body", async () => {
    const raw = await readFile(path.join(fixturesDir, "fbr_20260812143216_78750600c", "task.md"), "utf8");
    const doc = parseTaskFile(raw);
    const { view } = mapFileTask(doc, "fbr_20260812143216_78750600c");
    const nextView = { ...view, status: "in_progress", assignee: "implementer-backend-1", revision: 2 };
    applyViewToDoc(doc, view, nextView);
    const rewritten = serializeTaskFile(doc);

    expect(rewritten).toContain("status: in_progress");
    expect(rewritten).toContain("owner: implementer-backend-1");
    expect(rewritten).toContain("  revision: 2");
    // unknown keys survive verbatim
    expect(rewritten).toContain("fbr_ref: fbr_20260812143216_78750600c");
    expect(rewritten).toContain("source: fbr");
    expect(rewritten).toContain("module: '-'");
    expect(rewritten).toContain("created: 2026-08-12");
    // the body is byte-identical
    const body = raw.slice(raw.indexOf("\n---\n") + 5);
    expect(rewritten.endsWith(body)).toBe(true);
    // untouched keys keep their exact original lines
    expect(rewritten).toContain('title: "COLA closeout crashes when the report has no line items"');
    expect(rewritten).toContain("priority: unset");
  });

  it("keeps CRLF line endings when patching a CRLF file", async () => {
    const raw = await readFile(path.join(fixturesDir, "idea_realtime_sync", "task.md"), "utf8");
    const doc = parseTaskFile(raw);
    const { view } = mapFileTask(doc, "idea_realtime_sync");
    applyViewToDoc(doc, view, { ...view, priority: "high" });
    const rewritten = serializeTaskFile(doc);
    expect(rewritten).toContain("priority: high\r\n");
    expect(rewritten).not.toMatch(/[^\r]\npriority/);
    expect(rewritten.endsWith("- CRDT or last-write-wins?\r\n")).toBe(true);
  });
});

describe("testing verification targets", () => {
  it("round-trips the structured target through board frontmatter", () => {
    const doc = docFromFrontmatter([
      "id: verify-target",
      'title: "Verify deployed build"',
      "owner: unassigned",
      "status: review",
      "type: task",
      "priority: high",
      "labels:"
    ]);
    const { view } = mapFileTask(doc, "verify-target");
    const verificationTarget = {
      commitSha: "abc123",
      mergedTo: "main",
      artifactNote: "https://deploy.example.test"
    };

    applyViewToDoc(doc, view, { ...view, status: "testing", verificationTarget });
    const reparsed = mapFileTask(parseTaskFile(serializeTaskFile(doc)), "verify-target").view;

    expect(reparsed.status).toBe("testing");
    expect(reparsed.verificationTarget).toEqual(verificationTarget);
  });
});

describe("legacy status/type/priority mapping", () => {
  const base = ["id: t1", 'title: "T"', "owner: unassigned", "priority: unset", "labels:"];

  it.each([
    ["todo", "ready"],
    ["ready", "ready"],
    ["backlog", "backlog"],
    ["in_progress", "in_progress"],
    ["review", "review"],
    ["testing", "testing"],
    ["blocked", "blocked"],
    ["mystery_status", "backlog"]
  ])("maps file status %s to board status %s", (fileStatus, boardStatus) => {
    const { view } = mapFileTask(docFromFrontmatter([...base, `status: ${fileStatus}`, "type: bug"]), "t1");
    expect(view.status).toBe(boardStatus);
    expect(view.completion).toBeNull();
  });

  it("maps wont_do to done with a no-code completion", () => {
    const { view } = mapFileTask(docFromFrontmatter([...base, "status: wont_do", "type: chore"]), "t1");
    expect(view.status).toBe("done");
    expect(view.completion).toMatchObject({ completionType: "no-code" });
  });

  it("maps not_relevant to done with a superseded completion", () => {
    const { view } = mapFileTask(docFromFrontmatter([...base, "status: not_relevant", "type: bug"]), "t1");
    expect(view.status).toBe("done");
    expect(view.completion).toMatchObject({ completionType: "superseded" });
  });

  it("backfills a legacy-needs-audit completion for done files without a board record", () => {
    const { view } = mapFileTask(docFromFrontmatter([...base, "status: done", "type: bug"]), "t1");
    expect(view.completion).toMatchObject({ completionType: "legacy-needs-audit" });
  });

  it.each([
    ["bug", "bug", []],
    ["chore", "chore", []],
    ["task", "task", []],
    ["feature", "task", []],
    ["docs", "chore", ["docs"]],
    ["idea", "spike", ["idea"]],
    ["whatever", "task", []]
  ])("maps file type %s to board type %s", (fileType, boardType, extraLabels) => {
    const { view } = mapFileTask(docFromFrontmatter([...base, "status: ready", `type: ${fileType}`]), "t1");
    expect(view.workItemType).toBe(boardType);
    for (const label of extraLabels) expect(view.labels).toContain(label);
  });

  it("keeps legacy todo ideas out of the claimable ready pool", () => {
    const { view } = mapFileTask(docFromFrontmatter([...base, "status: todo", "type: idea"]), "t1");
    expect(view.status).toBe("backlog");
    expect(view.workItemType).toBe("spike");
  });

  it("respects a board-written ready on an idea so operator promotion sticks", () => {
    const { view } = mapFileTask(docFromFrontmatter([...base, "status: ready", "type: idea"]), "t1");
    expect(view.status).toBe("ready");
    expect(view.workItemType).toBe("spike");
  });

  it("parses mixed flow lists with quoted commas intact", () => {
    const { view } = mapFileTask(
      docFromFrontmatter(["id: t1", 'title: "T"', "status: ready", "type: bug", 'labels: [docs, "with, comma", plain]']),
      "t1"
    );
    expect(view.labels).toEqual(["docs", "with, comma", "plain"]);
  });

  it("maps owner and priority sentinels", () => {
    const { view } = mapFileTask(
      docFromFrontmatter(["id: t1", 'title: "T"', "owner: unassigned", "priority: unset", "labels:", "status: todo", "type: bug"]),
      "t1"
    );
    expect(view.assignee).toBe("");
    expect(view.priority).toBeNull();

    const { view: named } = mapFileTask(
      docFromFrontmatter(["id: t2", 'title: "T"', "owner: implementer-backend-1", "priority: urgent", "labels: [a, b]", "status: ready", "type: bug"]),
      "t2"
    );
    expect(named.assignee).toBe("implementer-backend-1");
    expect(named.priority).toBe("urgent");
    expect(named.labels).toEqual(["a", "b"]);
  });
});

describe("three-way merge", () => {
  function views() {
    const doc = docFromFrontmatter(["id: t1", 'title: "T"', "owner: unassigned", "status: ready", "type: bug", "priority: unset", "labels:"]);
    return mapFileTask(doc, "t1").view;
  }

  it("merges disjoint board and external changes", () => {
    const base = views();
    const ours = { ...base, priority: "high", revision: 2 };
    const theirs = { ...base, title: "Edited outside" };
    const { merged, conflicts } = threeWayMergeViews(base, ours, theirs);
    expect(conflicts).toEqual([]);
    expect(merged.priority).toBe("high");
    expect(merged.title).toBe("Edited outside");
    expect(merged.revision).toBe(2);
  });

  it("flags a same-key conflict", () => {
    const base = views();
    const ours = { ...base, title: "Board title", revision: 2 };
    const theirs = { ...base, title: "External title" };
    const { conflicts } = threeWayMergeViews(base, ours, theirs);
    expect(conflicts).toEqual(["title"]);
  });

  it("resolves concurrent revision bumps to the max instead of conflicting", () => {
    const base = views();
    const { merged, conflicts } = threeWayMergeViews(base, { ...base, revision: 3 }, { ...base, revision: 5 });
    expect(conflicts).toEqual([]);
    expect(merged.revision).toBe(5);
  });
});

describe("mode selection", () => {
  let savedTasksDir;

  beforeEach(() => {
    savedTasksDir = process.env.WORKBOARD_TASKS_DIR;
    delete process.env.WORKBOARD_TASKS_DIR;
  });

  afterEach(() => {
    if (savedTasksDir === undefined) delete process.env.WORKBOARD_TASKS_DIR;
    else process.env.WORKBOARD_TASKS_DIR = savedTasksDir;
  });

  it("fails fast when tasksdir mode is selected without WORKBOARD_TASKS_DIR", () => {
    expect(() => createWorkboardPersistence({ dataDir: "/tmp/x", storageMode: "tasksdir" })).toThrow(
      /WORKBOARD_TASKS_DIR/
    );
  });

  it("accepts tasksdir as a storage mode and keeps rejecting unknown modes", () => {
    const persistence = createWorkboardPersistence({
      dataDir: "/tmp/x",
      storageMode: "tasksdir",
      tasksDir: fixturesDir
    });
    expect(persistence.mode).toBe("tasksdir");
    expect(persistence.workItemsExternal).toBe(true);
    expect(() => createWorkboardPersistence({ dataDir: "/tmp/x", storageMode: "bogus" })).toThrow(
      /"sqlite", "json", or "tasksdir"/
    );
  });

  it("rejects an invalid ops storage mode", () => {
    expect(() =>
      createWorkboardPersistence({ dataDir: "/tmp/x", storageMode: "tasksdir", tasksDir: fixturesDir, opsStorageMode: "tasksdir" })
    ).toThrow(/WORKBOARD_OPS_STORAGE/);
  });

  it("round-trips a board view through fileViewFromBoardTask without drift", () => {
    const doc = docFromFrontmatter(["id: t1", 'title: "T"', "owner: unassigned", "status: todo", "type: bug", "priority: unset", "labels:"]);
    const { view } = mapFileTask(doc, "t1");
    const task = {
      id: "t1",
      title: view.title,
      status: view.status,
      assignee: view.assignee,
      workItemType: view.workItemType,
      priority: view.priority,
      labels: view.labels,
      description: view.description,
      role: view.role,
      revision: view.revision,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
      completion: view.completion,
      blocker: view.blocker,
      dependsOn: view.dependsOn,
      blockedBy: view.blockedBy,
      parentTaskId: view.parentTaskId
    };
    expect(fileViewFromBoardTask(task)).toEqual(view);
  });
});
