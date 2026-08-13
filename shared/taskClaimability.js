export const DECOMPOSITION_LABELS = new Set([
  "decomposition-needed",
  "needs-decomposition",
  "ready-for-decomposition",
  "epic",
  "story"
]);

export function taskRelationshipsAllowClaim(task = {}) {
  const dependencyState = task.dependencyStatus?.state || "clear";
  const relationshipsSatisfied = dependencyState === "clear" || task.status === "review";
  const pendingOperatorApproval = task.blocker?.type === "operator_approval" && task.blocker.status === "pending";
  return relationshipsSatisfied && !pendingOperatorApproval;
}
