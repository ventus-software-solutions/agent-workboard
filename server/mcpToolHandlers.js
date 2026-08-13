export const MCP_TOOL_NAMES = [
  "get_agent_instructions",
  "list_projects",
  "list_tasks",
  "list_capabilities",
  "get_capability",
  "create_task",
  "decompose_task",
  "claim_task",
  "claim_task_stage",
  "resolve_task_stage",
  "acquire_agent_slot",
  "get_next_task",
  "update_presence",
  "release_agent_slot",
  "report_no_eligible_work",
  "update_task_status",
  "update_task_touches",
  "request_operator_approval",
  "list_operator_approvals",
  "decide_operator_approval",
  "add_comment",
  "post_talk_message",
  "list_talk_messages"
];

export function buildUpdateTaskStatusPatch(input) {
  const patch = { status: input.status };
  for (const field of ["pullRequestUrl", "branch"]) {
    if (input[field] !== undefined) patch[field] = input[field];
  }
  if (input.completion !== undefined) {
    patch.completion = input.completion;
  }
  if (input.verificationTarget !== undefined) {
    patch.verificationTarget = input.verificationTarget;
  }
  return patch;
}
