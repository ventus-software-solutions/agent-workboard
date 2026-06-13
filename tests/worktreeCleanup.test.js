import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWorktreeCleanupReport,
  cleanupWorktree,
  parseWorktreePorcelain,
  readWorktreeCleanupConfig
} from "../server/worktreeCleanup.js";
import { WorkboardStore } from "../server/storage/workboardStore.js";

let cleanupPaths = [];

afterEach(async () => {
  const paths = cleanupPaths;
  cleanupPaths = [];
  await Promise.all(paths.map((target) => rm(target, { recursive: true, force: true })));
});

const baseTask = {
  projectId: "project_dogfood",
  priority: "normal",
  role: "implementer",
  assignee: "",
  labels: [],
  comments: [],
  activity: [],
  completion: null
};

function task(overrides) {
  return {
    ...baseTask,
    id: overrides.id,
    title: overrides.title || overrides.id,
    description: overrides.description || "",
    status: overrides.status || "done",
    updatedAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides
  };
}

describe("worktree cleanup report", () => {
  it("classifies clean merged done-task worktrees as cleanup-ready and quarantines unsafe cases", () => {
    const tasks = [
      task({
        id: "task_clean",
        title: "Clean merged task",
        completion: {
          completionType: "merged",
          branch: "implementer/clean",
          commitSha: "abc1234",
          mergedTo: "main"
        }
      }),
      task({
        id: "task_dirty",
        title: "Dirty done task",
        completion: {
          completionType: "merged",
          branch: "implementer/dirty",
          commitSha: "def5678",
          mergedTo: "main"
        }
      }),
      task({
        id: "task_unmerged",
        title: "Unmerged done task",
        completion: {
          completionType: "merged",
          branch: "implementer/unmerged",
          commitSha: "fedcba9",
          mergedTo: "main"
        }
      }),
      task({
        id: "task_active",
        title: "Active review task",
        status: "review",
        comments: [
          {
            id: "comment_branch",
            author: "implementer",
            body: "Branch: implementer/active",
            createdAt: "2026-06-01T00:00:00.000Z"
          }
        ]
      })
    ];

    const report = buildWorktreeCleanupReport({
      tasks,
      mainRef: "main",
      generatedAt: "2026-06-01T12:00:00.000Z",
      worktrees: [
        {
          path: "C:/tmp/wt-clean",
          branch: "implementer/clean",
          head: "abc1234",
          dirty: false,
          untrackedCount: 0,
          aheadMain: 0,
          behindMain: 0,
          mergedIntoMain: true
        },
        {
          path: "C:/tmp/wt-dirty",
          branch: "implementer/dirty",
          head: "def5678",
          dirty: true,
          untrackedCount: 2,
          aheadMain: 0,
          behindMain: 0,
          mergedIntoMain: true
        },
        {
          path: "C:/tmp/wt-unmerged",
          branch: "implementer/unmerged",
          head: "fedcba9",
          dirty: false,
          untrackedCount: 0,
          aheadMain: 3,
          behindMain: 1,
          mergedIntoMain: false
        },
        {
          path: "C:/tmp/wt-active",
          branch: "implementer/active",
          head: "1111111",
          dirty: false,
          untrackedCount: 0,
          aheadMain: 1,
          behindMain: 0,
          mergedIntoMain: false
        }
      ]
    });

    expect(report.counts).toMatchObject({
      total: 4,
      cleanupReady: 1,
      quarantined: 2,
      active: 1
    });

    expect(report.items.find((item) => item.branch === "implementer/clean")).toMatchObject({
      status: "cleanup-ready",
      cleanupEligible: true,
      task: { id: "task_clean", status: "done" },
      completion: { commitSha: "abc1234" },
      commands: {
        removeWorktree: "git worktree remove C:/tmp/wt-clean",
        deleteBranch: "git branch -d implementer/clean"
      }
    });

    expect(report.items.find((item) => item.branch === "implementer/dirty")).toMatchObject({
      status: "quarantined-dirty",
      cleanupEligible: false,
      dirty: true,
      untrackedCount: 2
    });

    expect(report.items.find((item) => item.branch === "implementer/unmerged")).toMatchObject({
      status: "quarantined-unmerged",
      cleanupEligible: false,
      aheadMain: 3,
      behindMain: 1
    });

    expect(report.items.find((item) => item.branch === "implementer/active")).toMatchObject({
      status: "active-keep",
      cleanupEligible: false,
      task: { id: "task_active", status: "review" }
    });
  });

  it("parses git worktree porcelain output", () => {
    expect(
      parseWorktreePorcelain(`worktree C:/git/agent-workboard
HEAD 1234567
branch refs/heads/main

worktree C:/tmp/wt-feature
HEAD abcdef0
branch refs/heads/implementer/feature

worktree C:/tmp/wt-detached
HEAD 9999999
detached
prunable gitdir file points to non-existent location
`)
    ).toEqual([
      {
        path: "C:/git/agent-workboard",
        head: "1234567",
        branchRef: "refs/heads/main",
        branch: "main",
        bare: false,
        detached: false,
        prunable: false,
        prunableReason: ""
      },
      {
        path: "C:/tmp/wt-feature",
        head: "abcdef0",
        branchRef: "refs/heads/implementer/feature",
        branch: "implementer/feature",
        bare: false,
        detached: false,
        prunable: false,
        prunableReason: ""
      },
      {
        path: "C:/tmp/wt-detached",
        head: "9999999",
        branchRef: "",
        branch: "",
        bare: false,
        detached: true,
        prunable: true,
        prunableReason: "gitdir file points to non-existent location"
      }
    ]);
  });

  it("uses WORKBOARD_REPO_DIR for deployed cleanup scans", () => {
    expect(readWorktreeCleanupConfig({ WORKBOARD_REPO_DIR: "/workspace", WORKBOARD_CLEANUP_MUTATIONS: "false" }, "/app")).toMatchObject({
      repoRoot: "/workspace",
      mainRef: "main",
      mutationsEnabled: false
    });
  });

  it("keeps the Docker deployment contract aligned with host worktree access", async () => {
    const dockerfile = await readFile(path.resolve("Dockerfile"), "utf8");
    const compose = await readFile(path.resolve("docker-compose.yml"), "utf8");

    expect(dockerfile).toContain("apk add --no-cache git");
    expect(dockerfile).toContain("WORKBOARD_REPO_DIR=/workspace");
    expect(dockerfile).toContain("WORKBOARD_CLEANUP_MUTATIONS=false");
    expect(dockerfile).toContain("safe.directory /workspace");
    expect(compose).toContain("WORKBOARD_REPO_DIR: /workspace");
    expect(compose).toContain('WORKBOARD_CLEANUP_MUTATIONS: "false"');
    expect(compose).toContain("./:/workspace:ro");
  });

  it("quarantines inaccessible done-task worktrees instead of presenting them as cleanup-ready", () => {
    const report = buildWorktreeCleanupReport({
      tasks: [
        task({
          id: "task_clean",
          completion: {
            completionType: "merged",
            branch: "implementer/clean",
            commitSha: "abc1234",
            mergedTo: "main"
          }
        })
      ],
      mainRef: "main",
      generatedAt: "2026-06-01T12:00:00.000Z",
      worktrees: [
        {
          path: "C:/tmp/wt-clean",
          branch: "implementer/clean",
          head: "abc1234",
          inaccessible: true,
          statusError: "fatal: cannot change to C:/tmp/wt-clean",
          dirty: false,
          untrackedCount: 0,
          aheadMain: 0,
          behindMain: 0,
          mergedIntoMain: true
        }
      ]
    });

    expect(report.counts).toMatchObject({
      cleanupReady: 0,
      quarantined: 1
    });
    expect(report.items[0]).toMatchObject({
      status: "quarantined-inaccessible",
      cleanupEligible: false,
      inaccessible: true,
      reason: "fatal: cannot change to C:/tmp/wt-clean"
    });
    expect(report.items[0].commands).toEqual({});
  });

  it("requires a precise cleanup candidate identity before running destructive commands", async () => {
    const calls = [];

    await expect(
      cleanupWorktree({
        store: { listTasks: () => [] },
        branch: "implementer/clean",
        git: async (args) => {
          calls.push(args);
          return { ok: true, stdout: "", stderr: "", exitCode: 0 };
        }
      })
    ).rejects.toMatchObject({
      status: 400,
      details: {
        missing: ["taskId", "worktreePath", "expectedHead"]
      }
    });

    expect(calls).toHaveLength(0);
  });

  it("refuses cleanup mutations in report-only deployments before running git commands", async () => {
    const originalCleanupMutations = process.env.WORKBOARD_CLEANUP_MUTATIONS;
    const calls = [];
    process.env.WORKBOARD_CLEANUP_MUTATIONS = "false";

    try {
      await expect(
        cleanupWorktree({
          store: { listTasks: () => [] },
          taskId: "task_clean",
          branch: "implementer/clean",
          worktreePath: "C:/tmp/wt-clean",
          expectedHead: "abc1234",
          git: async (args) => {
            calls.push(args);
            return { ok: true, stdout: "", stderr: "", exitCode: 0 };
          }
        })
      ).rejects.toMatchObject({
        status: 409,
        details: {
          mode: "report-only",
          env: "WORKBOARD_CLEANUP_MUTATIONS"
        }
      });
    } finally {
      if (originalCleanupMutations === undefined) {
        delete process.env.WORKBOARD_CLEANUP_MUTATIONS;
      } else {
        process.env.WORKBOARD_CLEANUP_MUTATIONS = originalCleanupMutations;
      }
    }

    expect(calls).toHaveLength(0);
  });

  it("removes cleanup-ready worktrees and records task evidence", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-cleanup-"));
    cleanupPaths.push(dataDir);
    const store = new WorkboardStore({ dataDir });
    await store.init();
    const project = await store.createProject({ name: "Cleanup action project" });
    const task = await store.createTask({
      projectId: project.id,
      title: "Merged cleanup branch",
      status: "done",
      completion: {
        completionType: "merged",
        branch: "implementer/clean",
        commitSha: "abc1234",
        mergedTo: "main"
      }
    });
    const calls = [];
    const git = async (args) => {
      calls.push(args);
      const key = args.join(" ");
      if (key === "-C C:/repo worktree list --porcelain") {
        return {
          ok: true,
          stdout: "worktree C:/tmp/wt-clean\nHEAD abc1234\nbranch refs/heads/implementer/clean",
          stderr: "",
          exitCode: 0
        };
      }
      if (key === "-C C:/tmp/wt-clean status --porcelain --untracked-files=normal") {
        return { ok: true, stdout: "", stderr: "", exitCode: 0 };
      }
      if (key === "-C C:/repo rev-list --left-right --count main...implementer/clean") {
        return { ok: true, stdout: "0\t0", stderr: "", exitCode: 0 };
      }
      if (key === "-C C:/repo merge-base --is-ancestor abc1234 main") {
        return { ok: true, stdout: "", stderr: "", exitCode: 0 };
      }
      if (key === "-C C:/repo worktree remove C:/tmp/wt-clean") {
        return { ok: true, stdout: "", stderr: "", exitCode: 0 };
      }
      if (key === "-C C:/repo branch -d implementer/clean") {
        return { ok: true, stdout: "Deleted branch", stderr: "", exitCode: 0 };
      }
      throw new Error(`Unexpected git command: ${key}`);
    };

    const result = await cleanupWorktree({
      store,
      repoRoot: "C:/repo",
      mainRef: "main",
      taskId: task.id,
      branch: "implementer/clean",
      worktreePath: "C:/tmp/wt-clean",
      expectedHead: "abc1234",
      actor: "operator-ui",
      git
    });

    expect(result).toMatchObject({
      cleaned: true,
      taskId: task.id,
      branch: "implementer/clean",
      worktreePath: "C:/tmp/wt-clean"
    });
    expect(calls.map((args) => args.join(" "))).toEqual(
      expect.arrayContaining([
        "-C C:/repo worktree remove C:/tmp/wt-clean",
        "-C C:/repo branch -d implementer/clean"
      ])
    );
    expect(store.getTask(task.id).comments[0]).toMatchObject({
      author: "operator-ui"
    });
    expect(store.getTask(task.id).comments[0].body).toContain("Removed cleanup-ready worktree");
  });

  it("rejects stale cleanup requests when the reported head no longer matches", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-cleanup-stale-"));
    cleanupPaths.push(dataDir);
    const store = new WorkboardStore({ dataDir });
    await store.init();
    const project = await store.createProject({ name: "Cleanup stale action project" });
    const staleTask = await store.createTask({
      projectId: project.id,
      title: "Merged cleanup branch",
      status: "done",
      completion: {
        completionType: "merged",
        branch: "implementer/clean",
        commitSha: "abc1234",
        mergedTo: "main"
      }
    });
    const calls = [];
    const git = async (args) => {
      calls.push(args);
      const key = args.join(" ");
      if (key === "-C C:/repo worktree list --porcelain") {
        return {
          ok: true,
          stdout: "worktree C:/tmp/wt-clean\nHEAD abc1234\nbranch refs/heads/implementer/clean",
          stderr: "",
          exitCode: 0
        };
      }
      if (key === "-C C:/tmp/wt-clean status --porcelain --untracked-files=normal") {
        return { ok: true, stdout: "", stderr: "", exitCode: 0 };
      }
      if (key === "-C C:/repo rev-list --left-right --count main...implementer/clean") {
        return { ok: true, stdout: "0\t0", stderr: "", exitCode: 0 };
      }
      if (key === "-C C:/repo merge-base --is-ancestor abc1234 main") {
        return { ok: true, stdout: "", stderr: "", exitCode: 0 };
      }
      throw new Error(`Unexpected git command: ${key}`);
    };

    await expect(
      cleanupWorktree({
        store,
        repoRoot: "C:/repo",
        mainRef: "main",
        taskId: staleTask.id,
        branch: "implementer/clean",
        worktreePath: "C:/tmp/wt-clean",
        expectedHead: "stale000",
        actor: "operator-ui",
        git
      })
    ).rejects.toMatchObject({
      status: 409
    });
    expect(calls.map((args) => args.join(" "))).not.toEqual(
      expect.arrayContaining([
        "-C C:/repo worktree remove C:/tmp/wt-clean",
        "-C C:/repo branch -d implementer/clean"
      ])
    );
  });
});
