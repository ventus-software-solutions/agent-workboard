import { formatAgentBootstrapPrompt } from "../../shared/agentBootstrap.js";
import { DECOMPOSITION_LABELS, taskRelationshipsAllowClaim } from "../../shared/taskClaimability.js";

// UI-specific role/card selection; prompt text lives in the shared server/client formatter.

// Agent roles that an operator can hand a bootstrap prompt to. `operator` is
// excluded because it is a human/operator identity, not a spawnable agent role.
export const AGENT_BOOTSTRAP_ROLE_IDS = ["pm", "implementer", "reviewer", "tester", "researcher"];

export function bootstrapPromptFor(role, origin) {
  return formatAgentBootstrapPrompt({ agentType: role, origin });
}

export function buildBootstrapCards(roles = [], origin = "") {
  const roleById = new Map(roles.map((role) => [role.id, role]));
  return AGENT_BOOTSTRAP_ROLE_IDS.map((id) => {
    const role = roleById.get(id);
    if (!role) return null;
    return {
      role: id,
      label: role.label || id,
      summary: role.summary || "",
      prompt: bootstrapPromptFor(id, origin)
    };
  }).filter(Boolean);
}

export function countClaimableReadyTasks(tasks = [], workItemTypes = []) {
  const claimableWorkItemTypes = new Set(
    workItemTypes.filter((workItemType) => workItemType.claimable).map((workItemType) => workItemType.id)
  );

  return tasks.filter((task) => {
    if (task.status !== "ready" || !claimableWorkItemTypes.has(task.workItemType || "task")) return false;
    if ((task.labels || []).some((label) => DECOMPOSITION_LABELS.has(label))) return false;
    return taskRelationshipsAllowClaim(task);
  }).length;
}

// Idle-state nudge: show only when there is claimable ready work but no agent is
// actively working a slot.
export function showIdleSpawnNudge({ readyTaskCount = 0, activeSlotCount = 0 } = {}) {
  return readyTaskCount > 0 && activeSlotCount === 0;
}
