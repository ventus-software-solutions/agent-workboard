const actionLabels = {
  backlog: "Move to Backlog",
  ready: "Move to Ready",
  in_progress: "Start",
  review: "Send to Review",
  testing: "Move to Testing",
  blocked: "Block",
  done: "Complete"
};

export function statusActionLabel(status) {
  if (!status) return "Move task";
  return actionLabels[status.id] || `Move to ${status.label || status.id}`;
}

export function statusControlLabel(currentStatusId, status) {
  if (!status) return "Unknown status";
  if (status.id === currentStatusId) return `Current: ${status.label}`;
  return statusActionLabel(status);
}

export function taskWorkflowCue(task) {
  if (!task || task.status === "review") return "";
  const labels = new Set((task.labels || []).map((label) => String(label).toLowerCase()));
  if (labels.has("audit")) return "Audit work";
  if (task.role === "reviewer" || labels.has("review") || labels.has("reviewer")) return "Reviewer work";
  return "";
}
