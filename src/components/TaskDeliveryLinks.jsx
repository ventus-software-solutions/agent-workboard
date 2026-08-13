import { GitBranch, GitPullRequest } from "lucide-react";
import { githubBranchUrl, isSafeHttpUrl } from "../../shared/taskLinks.js";

export function TaskDeliveryLinks({ task, compact = false }) {
  const pullRequestUrl = isSafeHttpUrl(task.pullRequestUrl) ? task.pullRequestUrl.trim() : "";
  const branch = String(task.branch || "").trim();
  const branchUrl = githubBranchUrl(pullRequestUrl, branch);
  if (!pullRequestUrl && !branch) return null;

  return (
    <div className={`taskDeliveryLinks ${compact ? "compact" : ""}`}>
      {pullRequestUrl && (
        <a
          href={pullRequestUrl}
          target="_blank"
          rel="noopener noreferrer"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <GitPullRequest size={14} />
          <span>{compact ? "PR" : "Pull request"}</span>
        </a>
      )}
      {branch &&
        (branchUrl ? (
          <a
            href={branchUrl}
            target="_blank"
            rel="noopener noreferrer"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <GitBranch size={14} />
            <span>{branch}</span>
          </a>
        ) : (
          <span title="Branch">
            <GitBranch size={14} />
            <code>{branch}</code>
          </span>
        ))}
    </div>
  );
}
