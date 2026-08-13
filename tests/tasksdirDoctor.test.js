import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectTasksDir,
  renderTasksdirDoctorReport,
  runTasksdirDoctorCli
} from "../server/tasksdirDoctor.js";

const temporaryDirectories = [];

async function tempTasksDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "tasksdir-doctor-"));
  temporaryDirectories.push(dir);
  return dir;
}

async function writeTask(root, folder, frontmatter, body = "Task body.\n") {
  const dir = path.join(root, folder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "task.md"), `---\n${frontmatter.join("\n")}\n---\n${body}`);
}

async function snapshotTree(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  const snapshot = {};
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = path.join(current, entry.name);
    const relative = path.relative(root, fullPath).split(path.sep).join("/");
    if (entry.isDirectory()) {
      snapshot[`${relative}/`] = "directory";
      Object.assign(snapshot, await snapshotTree(root, fullPath));
    } else {
      snapshot[relative] = (await readFile(fullPath)).toString("base64");
    }
  }
  return snapshot;
}

function captureStream() {
  let content = "";
  return {
    write(chunk) {
      content += String(chunk);
    },
    read() {
      return content;
    }
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("tasksdir doctor", () => {
  it("produces an actionable no-go report without changing an imperfect source tree", async () => {
    const root = await tempTasksDir();
    await writeTask(root, "alpha", [
      "id: alpha",
      'title: "Alpha: supports exotic, legal content"',
      "status: todo",
      "type: feature",
      "priority: high",
      "labels: [docs, \"with, comma\"]",
      "fbr_ref: source-123",
      "custom-block:",
      "  nested: yes",
      "board:",
      "  revision: 7",
      "  privateHint: keep-me"
    ], "Body with --- inside it.\n");
    await writeTask(root, "idea-one", [
      "id: idea-one",
      "title: Idea",
      "status: todo",
      "type: idea",
      "priority: unset"
    ]);
    await writeTask(root, "closed", [
      "id: closed",
      "title: Closed",
      "status: wont_do",
      "type: chore",
      "priority: normal"
    ]);
    await writeTask(root, "dup-a", [
      "id: shared",
      "title: Duplicate A",
      "status: ready",
      "type: task",
      "priority: low"
    ]);
    await writeTask(root, "dup-b", [
      "id: shared",
      "title: Duplicate B",
      "status: backlog",
      "type: bug",
      "priority: urgent"
    ]);
    await writeTask(root, "unknown", [
      "id: unknown",
      "title: Unknown mappings",
      "status: surprising",
      "type: contraption",
      "priority: immediate"
    ]);
    const brokenDir = path.join(root, "broken");
    await mkdir(brokenDir);
    await writeFile(path.join(brokenDir, "task.md"), "---\nid: broken\nstatus: todo\n");
    const malformedDir = path.join(root, "malformed");
    await mkdir(malformedDir);
    await writeFile(path.join(malformedDir, "task.md"), "---\nid: malformed\nthis is not a key\n---\nBody\n");
    await writeTask(root, path.join("nested", "deep"), [
      "id: deep",
      "title: Nested task",
      "status: ready",
      "type: task",
      "priority: normal"
    ]);

    const before = await snapshotTree(root);
    const report = await inspectTasksDir(root);
    const after = await snapshotTree(root);

    expect(after).toEqual(before);
    expect(report.go).toBe(false);
    expect(report.summary).toMatchObject({ foldersScanned: 9, taskFiles: 9, parsed: 7, failed: 2 });
    expect(report.parse.failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "broken/task.md", reason: expect.stringContaining("closing") }),
        expect.objectContaining({ file: "malformed/task.md", line: 3, reason: expect.stringContaining("key") })
      ])
    );
    expect(report.mappingPreview.status.histogram).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "todo", target: "ready", count: 1 }),
        expect.objectContaining({ source: "todo", target: "backlog", count: 1 }),
        expect.objectContaining({ source: "wont_do", target: "done/no-code", count: 1 })
      ])
    );
    expect(report.mappingPreview.status.unknown).toEqual([
      expect.objectContaining({ value: "surprising", target: "backlog" })
    ]);
    expect(report.mappingPreview.type.unknown[0]).toMatchObject({ value: "contraption", target: "task" });
    expect(report.mappingPreview.priority.unknown[0]).toMatchObject({ value: "immediate", target: "none" });
    expect(report.unknownFrontmatterKeys).toMatchObject({ preserved: true });
    expect(report.unknownFrontmatterKeys.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "fbr_ref", count: 1 }),
        expect.objectContaining({ key: "custom-block", count: 1 }),
        expect.objectContaining({ key: "board.privateHint", count: 1 })
      ])
    );
    expect(report.idChecks.duplicates).toEqual([{ id: "shared", files: ["dup-a/task.md", "dup-b/task.md"] }]);
    expect(report.idChecks.mismatches).toHaveLength(2);
    expect(report.idChecks.layoutIssues).toEqual([
      expect.objectContaining({ file: "nested/deep/task.md", reason: expect.stringContaining("<folder>/task.md") })
    ]);
    expect(report.blockers.join(" ")).toContain("unknown mapping");

    const human = renderTasksdirDoctorReport(report);
    expect(human).toContain("TASKSDIR PREFLIGHT: NO-GO");
    expect(human).toContain("broken/task.md");
    expect(human).toContain("surprising -> backlog: 1 [UNKNOWN]");
    expect(human).toContain("fix the blockers above");

    const stdout = captureStream();
    const stderr = captureStream();
    expect(await runTasksdirDoctorCli([root, "--json"], { stdout, stderr })).toBe(1);
    expect(JSON.parse(stdout.read())).toMatchObject({ schemaVersion: 1, go: false });
    expect(stderr.read()).toBe("");
  });

  it("returns go for supported mappings while inventorying unknown keys", async () => {
    const root = await tempTasksDir();
    await writeTask(root, "one", [
      "id: one",
      "title: One",
      "status: ready",
      "type: bug",
      "priority: high",
      "external_ref: issue-1"
    ]);
    await writeTask(root, "two", [
      "id: two",
      "title: Two",
      "status: not_relevant",
      "type: docs",
      "priority: unset"
    ]);

    const report = await inspectTasksDir(root);
    expect(report.go).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.summary).toMatchObject({ taskFiles: 2, parsed: 2, failed: 0 });
    expect(report.unknownFrontmatterKeys.items).toEqual([
      expect.objectContaining({ key: "external_ref", count: 1 })
    ]);
    expect(renderTasksdirDoctorReport(report)).toContain("Result: safe to enable tasksdir storage.");
  });

  it("parses a generated 550-folder tree and reports its measured size and duration", async () => {
    const root = await tempTasksDir();
    await Promise.all(
      Array.from({ length: 550 }, async (_, index) => {
        const id = `task-${String(index).padStart(3, "0")}`;
        await writeTask(root, id, [
          `id: ${id}`,
          `title: Task ${index}`,
          "status: todo",
          "type: task",
          "priority: normal"
        ]);
      })
    );

    const report = await inspectTasksDir(root);
    expect(report.go).toBe(true);
    expect(report.summary).toMatchObject({ foldersScanned: 550, taskFiles: 550, parsed: 550, failed: 0 });
    expect(report.summary.totalBytes).toBeGreaterThan(0);
    expect(report.summary.parseTimeMs).toBeGreaterThanOrEqual(0);
    expect(report.mappingPreview.status.histogram).toEqual([
      expect.objectContaining({ source: "todo", target: "ready", count: 550 })
    ]);
  });

  it("uses exit code 2 and stderr for invocation or directory errors", async () => {
    const stdout = captureStream();
    const stderr = captureStream();
    expect(await runTasksdirDoctorCli([], { stdout, stderr })).toBe(2);
    expect(stderr.read()).toContain("Usage:");

    const missingStderr = captureStream();
    expect(
      await runTasksdirDoctorCli([path.join(os.tmpdir(), "does-not-exist-tasksdir-doctor")], {
        stdout: captureStream(),
        stderr: missingStderr
      })
    ).toBe(2);
    expect(missingStderr.read()).toContain("tasksdir doctor failed:");
  });
});
