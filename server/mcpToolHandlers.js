export const MCP_TOOL_NAMES = [
  "get_agent_instructions",
  "list_projects",
  "list_tasks",
  "create_task",
  "claim_task",
  "acquire_agent_slot",
  "get_next_task",
  "update_presence",
  "report_no_eligible_work",
  "update_task_status",
  "add_comment"
];

export function buildUpdateTaskStatusPatch(input) {
  const patch = { status: input.status };
  if (input.completion !== undefined) {
    patch.completion = input.completion;
  }
  return patch;
}
