import { execFileSync } from "node:child_process";

const DEFAULT_LOCAL_REF = "main";
const DEFAULT_REMOTE_REF = "origin/main";

export function getIntegrationStatus({ cwd = process.cwd(), localRef = DEFAULT_LOCAL_REF, remoteRef = DEFAULT_REMOTE_REF } = {}) {
  return buildIntegrationStatus({
    localRef,
    remoteRef,
    runGit: (args) =>
      execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      })
  });
}

export function buildIntegrationStatus({
  runGit,
  localRef = DEFAULT_LOCAL_REF,
  remoteRef = DEFAULT_REMOTE_REF
} = {}) {
  const git = typeof runGit === "function" ? runGit : () => "";
  const currentBranch = readGit(git, ["branch", "--show-current"]) || "";
  const localHead = readGit(git, ["rev-parse", localRef]);
  const originHead = readGit(git, ["rev-parse", remoteRef]);
  const counts = readGit(git, ["rev-list", "--left-right", "--count", `${remoteRef}...${localRef}`]);
  const { behind, ahead } = parseAheadBehind(counts);
  const statusShort = readGit(git, ["status", "--short"]) || "";
  const clean = statusShort.trim().length === 0;
  const shortLocalHead = shortSha(localHead);
  const shortOriginHead = shortSha(originHead);
  const pushDebt = ahead > 0 || (!originHead && Boolean(localHead));
  const state = decideIntegrationState({ ahead, behind, clean, localHead, originHead, localRef, remoteRef });

  return {
    sourceOfTruth: state.sourceOfTruth,
    baseRef: state.baseRef,
    localRef,
    remoteRef,
    currentBranch,
    localHead: shortLocalHead,
    originHead: shortOriginHead,
    ahead,
    behind,
    clean,
    pushDebt,
    summary: state.summary,
    worktreeCommand: state.baseRef
      ? `git worktree add C:/git/wt-agent-workboard-<agent-id>-<slug> -b <agent-id>/<slug> ${state.baseRef}`
      : "Pause before creating a worktree: reconcile local main and origin/main first.",
    recoveryActions: recoveryActions({ pushDebt, sourceOfTruth: state.sourceOfTruth, localRef, remoteRef })
  };
}

function readGit(runGit, args) {
  try {
    return String(runGit(args) || "").trim();
  } catch {
    return "";
  }
}

function parseAheadBehind(value) {
  const [behindRaw, aheadRaw] = String(value || "")
    .trim()
    .split(/\s+/);
  const behind = Number.parseInt(behindRaw, 10);
  const ahead = Number.parseInt(aheadRaw, 10);
  return {
    behind: Number.isFinite(behind) ? behind : 0,
    ahead: Number.isFinite(ahead) ? ahead : 0
  };
}

function decideIntegrationState({ ahead, behind, clean, localHead, originHead, localRef, remoteRef }) {
  if (!localHead) {
    return {
      sourceOfTruth: "unknown",
      baseRef: null,
      summary: "Unable to read local main; inspect Git state before creating task worktrees."
    };
  }

  if (!originHead) {
    return clean
      ? {
          sourceOfTruth: "local-main",
          baseRef: localRef,
          summary: `Origin ref ${remoteRef} is unavailable; use local ${localRef} as the dogfood base until remote state is restored.`
        }
      : {
          sourceOfTruth: "reconcile-first",
          baseRef: null,
          summary: `Origin ref ${remoteRef} is unavailable and local ${localRef} has uncommitted changes; clean or commit before branching.`
        };
  }

  if (ahead > 0 && behind > 0) {
    return {
      sourceOfTruth: "reconcile-first",
      baseRef: null,
      summary: `Local ${localRef} and ${remoteRef} have diverged (${ahead} ahead, ${behind} behind); reconcile before creating new dogfood worktrees.`
    };
  }

  if (ahead > 0) {
    return clean
      ? {
          sourceOfTruth: "local-main",
          baseRef: localRef,
          summary: `Local ${localRef} is ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${remoteRef}; use local ${localRef} for dogfood worktrees until push debt is cleared.`
        }
      : {
          sourceOfTruth: "reconcile-first",
          baseRef: null,
          summary: `Local ${localRef} is ahead of ${remoteRef} but has uncommitted changes; clean the integration checkout before branching.`
        };
  }

  if (behind > 0) {
    return {
      sourceOfTruth: "origin-main",
      baseRef: remoteRef,
      summary: `${remoteRef} is ${behind} commit${behind === 1 ? "" : "s"} ahead of local ${localRef}; fetch or update local ${localRef}, and base new worktrees on ${remoteRef}.`
    };
  }

  return {
    sourceOfTruth: "origin-main",
    baseRef: remoteRef,
    summary: `Local ${localRef} and ${remoteRef} match; ${remoteRef} is safe for new worktrees.`
  };
}

function recoveryActions({ pushDebt, sourceOfTruth, localRef, remoteRef }) {
  if (sourceOfTruth === "reconcile-first") {
    return [
      `Run \`git fetch origin ${localRef}\` and reconcile ${localRef} with ${remoteRef} before creating more worktrees.`,
      "If reconciliation is blocked, comment the push/rebase blocker on the release task and leave new implementation work unclaimed.",
      `If remote push remains unavailable, export a handoff with \`git format-patch ${remoteRef}..${localRef}\` or attach branch/commit evidence.`
    ];
  }

  if (pushDebt) {
    return [
      `Run \`git push origin ${localRef}\` when non-interactive credentials are available.`,
      "If push is unavailable, record push debt in the release/reviewer evidence and keep using local main as the dogfood base.",
      `For handoff, export patches with \`git format-patch ${remoteRef}..${localRef}\` or cite the local branch/commit range.`
    ];
  }

  return [
    `No push debt detected between ${localRef} and ${remoteRef}.`,
    `Base new worktrees on ${remoteRef} unless a later integration-status check says otherwise.`
  ];
}

function shortSha(value) {
  return value ? value.slice(0, 12) : "";
}
