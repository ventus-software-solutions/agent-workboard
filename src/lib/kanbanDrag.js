export function getTaskDropMove(tasks, taskId, statusId) {
  if (!taskId || !statusId) return null;

  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task || task.status === statusId) return null;

  return { task, statusId };
}
