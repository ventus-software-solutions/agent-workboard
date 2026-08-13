const VIEWS = new Set(["board", "agents", "capabilities", "settings"]);
const WORKSPACE_TABS = new Set(["tasks", "coordination", "activity"]);

export function parseWorkboardRoute(value = globalThis.location) {
  const url = toUrl(value);
  const segments = url.pathname.split("/").filter(Boolean);
  const view = VIEWS.has(segments[0]) ? segments[0] : "board";
  const workspaceTab = view === "board" && WORKSPACE_TABS.has(segments[1]) ? segments[1] : "tasks";

  return {
    view,
    workspaceTab,
    projectId: url.searchParams.get("project") || "",
    taskId: url.searchParams.get("task") || "",
    filters: {
      q: url.searchParams.get("q") || "",
      role: url.searchParams.get("role") || "",
      assignee: url.searchParams.get("agent") || "",
      workItemType: url.searchParams.get("type") || ""
    }
  };
}

export function formatWorkboardRoute({ view = "board", workspaceTab = "tasks", projectId = "", taskId = "", filters = {} }) {
  const safeView = VIEWS.has(view) ? view : "board";
  const safeTab = WORKSPACE_TABS.has(workspaceTab) ? workspaceTab : "tasks";
  const pathname = safeView === "board" ? `/board/${safeTab}` : `/${safeView}`;
  const params = new URLSearchParams();

  append(params, "project", projectId);
  append(params, "task", taskId);
  append(params, "agent", filters.assignee);
  append(params, "q", filters.q);
  append(params, "role", filters.role);
  append(params, "type", filters.workItemType);

  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

function append(params, key, value) {
  const text = String(value || "").trim();
  if (text) params.set(key, text);
}

function toUrl(value) {
  if (value && typeof value === "object" && "pathname" in value) {
    return new URL(`${value.pathname || "/"}${value.search || ""}`, "http://workboard.local");
  }
  return new URL(String(value || "/"), "http://workboard.local");
}
