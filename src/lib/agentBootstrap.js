// @platform-candidate: agent-bootstrap-prompt — single source of the one-line
// bootstrap prompt for the operator onboarding UI. The prompt shape mirrors the
// template served by GET /api/agent-docs/{agentType}?format=md (server/agentDocs.js).
// Keep the midpoint template string here so the frontend never hardcodes it twice.

// Agent roles that an operator can hand a bootstrap prompt to. `operator` is
// excluded because it is a human/operator identity, not a spawnable agent role.
export const AGENT_BOOTSTRAP_ROLE_IDS = ["pm", "implementer", "reviewer", "tester", "researcher"];

export function bootstrapPromptFor(role, origin) {
  return `You are ${role}. Read ${origin}/api/agent-docs/${role}?format=md and do what it tells you.`;
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

// Idle-state nudge: show only when there is claimable ready work but no agent is
// actively working a slot.
export function showIdleSpawnNudge({ readyTaskCount = 0, activeSlotCount = 0 } = {}) {
  return readyTaskCount > 0 && activeSlotCount === 0;
}
