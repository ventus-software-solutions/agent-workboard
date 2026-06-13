import { describe, expect, it } from "vitest";
import { buildWorktreeCleanupReport, parseWorktreePorcelain } from "../server/worktreeCleanup.js";

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
});
