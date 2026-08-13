export const AGENT_BOOTSTRAP_PROMPT_TEMPLATE =
  "You are {agentType}. Read {origin}/api/agent-docs/{agentType}?format=md and do what it tells you.";

export function formatAgentBootstrapPrompt({ agentType, origin }) {
  const normalizedAgentType = String(agentType ?? "");
  const normalizedOrigin = String(origin ?? "").replace(/\/+$/, "");
  return AGENT_BOOTSTRAP_PROMPT_TEMPLATE.replaceAll("{agentType}", normalizedAgentType).replace(
    "{origin}", normalizedOrigin
  );
}
