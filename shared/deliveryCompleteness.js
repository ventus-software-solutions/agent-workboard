function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function deliveryRequirements(deploymentSettings = {}) {
  const rules = text(deploymentSettings.processOverrides).toLowerCase();
  if (!rules) return { enabled: false, requireBranch: false, requirePush: false, requirePullRequest: false };

  return {
    enabled: true,
    requireBranch: /\bbranch(?:es)?\b/.test(rules),
    requirePush: /\bpush(?:ed|es|ing)?\b|\bremote\b/.test(rules),
    requirePullRequest: /\bpull request(?:s)?\b|\bpr(?:s)?\b/.test(rules)
  };
}

export function taskDeliveryShortfall(task, { deploymentSettings = {}, integrationStatus = {} } = {}) {
  const requirements = deliveryRequirements(deploymentSettings);
  if (!requirements.enabled || task?.status !== "review") return null;

  const branch = text(task.branch);
  const pullRequestUrl = text(task.pullRequestUrl);
  const branchStatus = (integrationStatus.deliveryBranches || []).find((candidate) => text(candidate.branch) === branch);
  const issues = [];

  if (requirements.requireBranch && !branch) {
    issues.push({ code: "missing_branch", message: "Delivery branch is missing." });
  } else if (requirements.requirePush && branchStatus?.state === "missing" && !pullRequestUrl) {
    issues.push({ code: "missing_branch_ref", message: `Branch ${branch} is not present locally or on origin.` });
  } else if (requirements.requirePush && branchStatus?.state === "unpushed") {
    const suffix = branchStatus.ahead > 0
      ? `${branchStatus.ahead} unpushed commit${branchStatus.ahead === 1 ? "" : "s"}`
      : "no remote branch";
    issues.push({ code: "unpushed_branch", message: `Branch ${branch} exists locally but is not fully pushed (${suffix}).` });
  }

  if (requirements.requirePullRequest && !pullRequestUrl) {
    issues.push({ code: "missing_pull_request", message: "Pull request URL is missing." });
  }

  if (issues.length === 0) return null;
  return {
    taskId: task.id,
    branch,
    issues,
    codes: issues.map((issue) => issue.code),
    detail: issues.map((issue) => issue.message).join(" ")
  };
}
