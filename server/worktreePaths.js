const DEFAULT_WORKTREE_ROOT = "..";
const WORKTREE_PREFIX = "wt-agent-workboard";

export function worktreeRoot(env = process.env) {
  const configured = String(env?.WORKBOARD_WORKTREE_ROOT || "").trim();
  if (!configured) return DEFAULT_WORKTREE_ROOT;
  const trimmed = configured.replace(/[\\/]+$/, "");
  return trimmed || configured.slice(0, 1);
}

export function worktreeDirName(agentId = "<agent-id>", slug = "<slug>") {
  return `${WORKTREE_PREFIX}-${agentId}-${slug}`;
}

export function worktreePath(agentId = "<agent-id>", slug = "<slug>", env = process.env) {
  const root = worktreeRoot(env);
  const separator = root.endsWith("/") || root.endsWith("\\") ? "" : "/";
  return `${root}${separator}${worktreeDirName(agentId, slug)}`;
}
