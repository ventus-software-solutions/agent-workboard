import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ACTIVE_STATUSES = new Set(["in_progress", "review", "testing", "blocked"]);
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "..");

export async function createWorktreeCleanupReport({
  store,
  repoRoot = DEFAULT_REPO_ROOT,
  mainRef = "main",
  git = runGit
} = {}) {
  const snapshot = await collectWorktreeSnapshot({ repoRoot, mainRef, git });
  return buildWorktreeCleanupReport({
    tasks: store.listTasks(),
    worktrees: snapshot.worktrees,
    mainRef,
    generatedAt: new Date().toISOString()
  });
}

export function buildWorktreeCleanupReport({
  tasks = [],
  worktrees = [],
  mainRef = "main",
  generatedAt = new Date().toISOString()
} = {}) {
  const items = worktrees
    .filter((worktree) => {
      const branch = normalizeText(worktree.branch);
      return branch && !PROTECTED_BRANCHES.has(branch);
    })
    .map((worktree) => classifyWorktree(worktree, tasks, mainRef))
    .sort(compareCleanupItems);

  return {
    generatedAt,
    mainRef,
    counts: {
      total: items.length,
      cleanupReady: items.filter((item) => item.status === "cleanup-ready").length,
      quarantined: items.filter((item) => item.status.startsWith("quarantined")).length,
      active: items.filter((item) => item.status === "active-keep").length,
      unknown: items.filter((item) => item.status === "unknown-task").length
    },
    items
  };
}

export function parseWorktreePorcelain(output = "") {
  const worktrees = [];
  let current = null;

  for (const rawLine of output.replace(/\r/g, "").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) {
      pushWorktree(worktrees, current);
      current = null;
      continue;
    }

    const [key, ...parts] = line.split(" ");
    const value = parts.join(" ");
    if (key === "worktree") {
      pushWorktree(worktrees, current);
      current = emptyWorktree(value);
      continue;
    }

    if (!current) {
      current = emptyWorktree("");
    }

    if (key === "HEAD") {
      current.head = value;
    } else if (key === "branch") {
      current.branchRef = value;
      current.branch = value.replace(/^refs\/heads\//, "");
    } else if (key === "bare") {
      current.bare = true;
    } else if (key === "detached") {
      current.detached = true;
    } else if (key === "prunable") {
      current.prunable = true;
      current.prunableReason = value;
    }
  }

  pushWorktree(worktrees, current);
  return worktrees;
}

async function collectWorktreeSnapshot({ repoRoot, mainRef, git }) {
  const listing = await git(["-C", repoRoot, "worktree", "list", "--porcelain"]);
  const worktrees = parseWorktreePorcelain(listing.stdout);
  const hydrated = await Promise.all(worktrees.map((worktree) => hydrateWorktree(worktree, { repoRoot, mainRef, git })));
  return { worktrees: hydrated };
}

async function hydrateWorktree(worktree, { repoRoot, mainRef, git }) {
  if (!worktree.path || !worktree.branch) {
    return {
      ...worktree,
      dirty: false,
      untrackedCount: 0,
      statusEntries: [],
      aheadMain: 0,
      behindMain: 0,
      mergedIntoMain: false
    };
  }

  const [statusResult, aheadBehindResult, mergedResult] = await Promise.all([
    git(["-C", worktree.path, "status", "--porcelain", "--untracked-files=normal"], { allowFailure: true }),
    git(["-C", repoRoot, "rev-list", "--left-right", "--count", `${mainRef}...${worktree.branch}`], {
      allowFailure: true
    }),
    git(["-C", repoRoot, "merge-base", "--is-ancestor", worktree.head || worktree.branch, mainRef], {
      allowFailure: true
    })
  ]);

  const statusEntries = statusResult.ok ? statusResult.stdout.split(/\r?\n/).filter(Boolean) : [];
  const aheadBehind = parseAheadBehind(aheadBehindResult.ok ? aheadBehindResult.stdout : "");

  return {
    ...worktree,
    dirty: !statusResult.ok || statusEntries.length > 0,
    untrackedCount: statusEntries.filter((entry) => entry.startsWith("??")).length,
    statusEntries,
    statusError: statusResult.ok ? "" : statusResult.stderr || "Unable to inspect worktree status.",
    aheadMain: aheadBehind.aheadMain,
    behindMain: aheadBehind.behindMain,
    mergedIntoMain: mergedResult.ok
  };
}

async function runGit(args, { allowFailure = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024
    });
    return { ok: true, stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: 0 };
  } catch (error) {
    const result = {
      ok: false,
      stdout: String(error.stdout || "").trimEnd(),
      stderr: String(error.stderr || error.message || "").trimEnd(),
      exitCode: typeof error.code === "number" ? error.code : 1
    };
    if (allowFailure) {
      return result;
    }
    throw error;
  }
}

function classifyWorktree(worktreeInput, tasks, mainRef) {
  const worktree = normalizeWorktree(worktreeInput);
  const task = findRelatedTask(worktree, tasks);
  const base = {
    worktreePath: worktree.path,
    branch: worktree.branch,
    head: worktree.head,
    dirty: worktree.dirty,
    untrackedCount: worktree.untrackedCount,
    aheadMain: worktree.aheadMain,
    behindMain: worktree.behindMain,
    mergedIntoMain: worktree.mergedIntoMain,
    mainRef,
    task: task ? summarizeTask(task) : null,
    completion: task?.completion ? summarizeCompletion(task.completion) : null,
    commands: {},
    cleanupEligible: false
  };

  if (!task) {
    return {
      ...base,
      status: "unknown-task",
      reason: "No task completion record, comment, or activity mentions this branch or worktree.",
      recommendedAction: "Inspect the branch owner before taking cleanup action."
    };
  }

  if (ACTIVE_STATUSES.has(task.status)) {
    return {
      ...base,
      status: "active-keep",
      reason: `Task is still ${task.status}.`,
      recommendedAction: "Keep this worktree out of cleanup until the task leaves active coordination."
    };
  }

  if (task.status !== "done") {
    return {
      ...base,
      status: "quarantined-not-done",
      reason: `Task is ${task.status}, not done.`,
      recommendedAction: "Quarantine and ask the assignee or reviewer to resolve the task state first."
    };
  }

  if (worktree.dirty) {
    return {
      ...base,
      status: "quarantined-dirty",
      reason: worktree.statusError || "Worktree has modified or untracked files.",
      recommendedAction: "Quarantine for manual inspection; do not remove a dirty done-task worktree."
    };
  }

  if (!worktree.mergedIntoMain) {
    return {
      ...base,
      status: "quarantined-unmerged",
      reason: `Branch head is not merged into ${mainRef}.`,
      recommendedAction: "Quarantine until the branch is merged, rebased, or explicitly abandoned with evidence."
    };
  }

  return {
    ...base,
    status: "cleanup-ready",
    cleanupEligible: true,
    reason: `Done task is clean and merged into ${mainRef}.`,
    recommendedAction: "Remove the worktree, delete the merged branch, and comment cleanup evidence on the task.",
    commands: {
      removeWorktree: `git worktree remove ${shellQuote(worktree.path)}`,
      deleteBranch: `git branch -d ${shellQuote(worktree.branch)}`
    }
  };
}

function normalizeWorktree(worktree) {
  const statusEntries = Array.isArray(worktree.statusEntries) ? worktree.statusEntries : [];
  const untrackedCount = toNumber(worktree.untrackedCount, statusEntries.filter((entry) => entry.startsWith("??")).length);
  return {
    path: normalizeText(worktree.path),
    branch: normalizeText(worktree.branch),
    head: normalizeText(worktree.head),
    dirty: Boolean(worktree.dirty || statusEntries.length > 0 || untrackedCount > 0),
    untrackedCount,
    statusEntries,
    statusError: normalizeText(worktree.statusError),
    aheadMain: toNumber(worktree.aheadMain, 0),
    behindMain: toNumber(worktree.behindMain, 0),
    mergedIntoMain: Boolean(worktree.mergedIntoMain)
  };
}

function findRelatedTask(worktree, tasks) {
  const branch = normalizeText(worktree.branch).toLowerCase();
  const worktreePath = normalizeText(worktree.path).toLowerCase();
  const head = normalizeText(worktree.head).toLowerCase();
  let best = null;

  for (const task of tasks) {
    let score = 0;
    const completionBranch = normalizeText(task.completion?.branch).toLowerCase();
    const completionCommit = normalizeText(task.completion?.commitSha).toLowerCase();
    const searchText = taskSearchText(task);

    if (branch && completionBranch === branch) score = Math.max(score, 100);
    if (head && completionCommit === head) score = Math.max(score, 90);
    if (branch && searchText.includes(branch)) score = Math.max(score, 70);
    if (worktreePath && searchText.includes(worktreePath)) score = Math.max(score, 60);

    if (score > 0 && (!best || score > best.score || (score === best.score && task.status === "done"))) {
      best = { task, score };
    }
  }

  return best?.task || null;
}

function taskSearchText(task) {
  const pieces = [
    task.title,
    task.description,
    task.assignee,
    task.completion?.branch,
    task.completion?.commitSha,
    task.completion?.notes,
    ...(task.comments || []).map((comment) => comment.body),
    ...(task.activity || []).map((event) => event.message)
  ];
  return pieces.map((piece) => normalizeText(piece).toLowerCase()).join("\n");
}

function summarizeTask(task) {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    assignee: task.assignee || "",
    role: task.role || ""
  };
}

function summarizeCompletion(completion) {
  return {
    completionType: completion.completionType,
    branch: completion.branch || "",
    commitSha: completion.commitSha || "",
    mergedTo: completion.mergedTo || "",
    completedAt: completion.completedAt || "",
    completedBy: completion.completedBy || ""
  };
}

function parseAheadBehind(output) {
  const [behindMain, aheadMain] = normalizeText(output)
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10));
  return {
    aheadMain: Number.isFinite(aheadMain) ? aheadMain : 0,
    behindMain: Number.isFinite(behindMain) ? behindMain : 0
  };
}

function compareCleanupItems(left, right) {
  const rank = {
    "cleanup-ready": 0,
    "quarantined-dirty": 1,
    "quarantined-unmerged": 2,
    "quarantined-not-done": 3,
    "active-keep": 4,
    "unknown-task": 5
  };
  return (rank[left.status] ?? 99) - (rank[right.status] ?? 99) || left.branch.localeCompare(right.branch);
}

function emptyWorktree(worktreePath) {
  return {
    path: worktreePath,
    head: "",
    branchRef: "",
    branch: "",
    bare: false,
    detached: false,
    prunable: false,
    prunableReason: ""
  };
}

function pushWorktree(worktrees, worktree) {
  if (worktree?.path) {
    worktrees.push(worktree);
  }
}

function shellQuote(value) {
  const text = String(value || "");
  if (/^[A-Za-z0-9_./:@\\-]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '\\"')}"`;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toNumber(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
