export function describeTaskSaveError(error) {
  const status = Number(error?.status || 0);
  const detail = error?.message || "The task update could not be saved.";

  if (status === 409) {
    return {
      tone: "conflict",
      title: "Task changed before this save",
      message: "Your draft is still here. Reload the latest board state or retry the save when you are ready.",
      detail,
      canRetry: true,
      canReload: true
    };
  }

  if (status === 400) {
    return {
      tone: "validation",
      title: "Task save needs changes",
      message: "The board rejected this update. Fix the issue and retry; your draft was not discarded.",
      detail,
      canRetry: true,
      canReload: false
    };
  }

  return {
    tone: "error",
    title: "Task save failed",
    message: "The board could not save this update. Your draft is still here.",
    detail,
    canRetry: true,
    canReload: true
  };
}
