const DEFAULT_WORKTREE_ROOT = "..";
const DEFAULT_WORKTREE_PREFIX = "wt-agent-workboard";

export function worktreeRoot(env = process.env) {
  const configured = String(env?.WORKBOARD_WORKTREE_ROOT || "").trim();
  if (!configured) return DEFAULT_WORKTREE_ROOT;
  const trimmed = configured.replace(/[\\/]+$/, "");
  return trimmed || configured.slice(0, 1);
}

export function worktreePrefix(env = process.env) {
  return String(env?.WORKBOARD_WORKTREE_PREFIX || "").trim() || DEFAULT_WORKTREE_PREFIX;
}

export function worktreeDirName(agentId = "<agent-id>", slug = "<slug>", env = process.env) {
  return `${worktreePrefix(env)}-${agentId}-${slug}`;
}

export function worktreePath(agentId = "<agent-id>", slug = "<slug>", env = process.env) {
  const root = worktreeRoot(env);
  const separator = root.endsWith("/") || root.endsWith("\\") ? "" : "/";
  return `${root}${separator}${worktreeDirName(agentId, slug, env)}`;
}
