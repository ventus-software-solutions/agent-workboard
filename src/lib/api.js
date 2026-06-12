const API_BASE = import.meta.env.VITE_API_BASE || "";

export async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data?.error?.message || `Request failed with ${response.status}`);
  }
  return data;
}

export const api = {
  meta: () => request("/api/meta"),
  agentSlots: () => request("/api/agent-slots"),
  bootstrap: (input) => request("/api/bootstrap", { method: "POST", body: JSON.stringify(input) }),
  projects: () => request("/api/projects"),
  createProject: (project) => request("/api/projects", { method: "POST", body: JSON.stringify(project) }),
  tasks: (filters = {}) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    return request(`/api/tasks${params.size ? `?${params}` : ""}`);
  },
  createTask: (task) => request("/api/tasks", { method: "POST", body: JSON.stringify(task) }),
  updateTask: (taskId, patch) => request(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  claimTask: (taskId, claim) => request(`/api/tasks/${taskId}/claim`, { method: "POST", body: JSON.stringify(claim) }),
  addComment: (taskId, comment) =>
    request(`/api/tasks/${taskId}/comments`, { method: "POST", body: JSON.stringify(comment) }),
  uploadAttachment: (taskId, file, author = "operator") => {
    const form = new FormData();
    form.append("file", file);
    form.append("author", author);
    return request(`/api/tasks/${taskId}/attachments`, { method: "POST", body: form });
  }
};
