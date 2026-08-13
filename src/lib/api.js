const API_BASE = import.meta.env.VITE_API_BASE || "";

export class ApiError extends Error {
  constructor(message, { status = 0, details = null } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

export async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (!response.ok) {
    throw new ApiError(data?.error?.message || `Request failed with ${response.status}`, {
      status: response.status,
      details: data?.error?.details || null
    });
  }
  return data;
}

export const api = {
  meta: () => request("/api/meta"),
  deploymentSettings: () => request("/api/deployment-settings"),
  updateDeploymentSettings: (settings) =>
    request("/api/deployment-settings", { method: "PATCH", body: JSON.stringify(settings) }),
  agentDocs: () => request("/api/agent-docs"),
  integrationStatus: () => request("/api/integration-status"),
  agentSlots: () => request("/api/agent-slots"),
  updateAgentType: (typeId, patch) =>
    request(`/api/agent-types/${encodeURIComponent(typeId)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  updateAgentSlot: (agentId, patch) =>
    request(`/api/agent-slots/${encodeURIComponent(agentId)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  releaseAgentSlot: (agentId, patch) =>
    request(`/api/agent-slots/${encodeURIComponent(agentId)}/release`, { method: "POST", body: JSON.stringify(patch) }),
  bootstrap: (input) => request("/api/bootstrap", { method: "POST", body: JSON.stringify(input) }),
  updatePresence: (agentId, presence) =>
    request(`/api/agents/${encodeURIComponent(agentId)}/presence`, {
      method: "POST",
      body: JSON.stringify(presence)
    }),
  projects: () => request("/api/projects"),
  createProject: (project) => request("/api/projects", { method: "POST", body: JSON.stringify(project) }),
  capabilities: (filters = {}) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined && value !== ""));
    return request(`/api/capabilities${params.size ? `?${params}` : ""}`);
  },
  createCapability: (capability) => request("/api/capabilities", { method: "POST", body: JSON.stringify(capability) }),
  updateCapability: (capabilityId, patch) =>
    request(`/api/capabilities/${capabilityId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  boardState: (filters = {}) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    return request(`/api/board-state${params.size ? `?${params}` : ""}`);
  },
  tasks: (filters = {}) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    return request(`/api/tasks${params.size ? `?${params}` : ""}`);
  },
  projectActivity: (projectId, filters = {}) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    return request(`/api/projects/${projectId}/activity${params.size ? `?${params}` : ""}`);
  },
  talks: (projectId, filters = {}) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    return request(`/api/projects/${projectId}/talks${params.size ? `?${params}` : ""}`);
  },
  postTalk: (projectId, message) =>
    request(`/api/projects/${projectId}/talks`, { method: "POST", body: JSON.stringify(message) }),
  staleInProgressTasks: (filters = {}) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    return request(`/api/tasks/stale-in-progress${params.size ? `?${params}` : ""}`);
  },
  recoverStaleTask: (taskId, recovery) =>
    request(`/api/tasks/${taskId}/stale-recovery`, { method: "POST", body: JSON.stringify(recovery) }),
  operatorApprovals: (filters = {}) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    return request(`/api/operator-approvals${params.size ? `?${params}` : ""}`);
  },
  worktreeCleanup: (filters = {}) => {
    const params = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
    return request(`/api/worktree-cleanup${params.size ? `?${params}` : ""}`);
  },
  cleanupWorktree: (cleanup) =>
    request("/api/worktree-cleanup/cleanup", { method: "POST", body: JSON.stringify(cleanup) }),
  createTask: (task) => request("/api/tasks", { method: "POST", body: JSON.stringify(task) }),
  updateTask: (taskId, patch) => request(`/api/tasks/${taskId}`, { method: "PATCH", body: JSON.stringify(patch) }),
  claimTask: (taskId, claim) => request(`/api/tasks/${taskId}/claim`, { method: "POST", body: JSON.stringify(claim) }),
  claimTaskStage: (taskId, claim) =>
    request(`/api/tasks/${taskId}/stage-claim`, { method: "POST", body: JSON.stringify(claim) }),
  resolveTaskStage: (taskId, resolution) =>
    request(`/api/tasks/${taskId}/stage-resolution`, { method: "POST", body: JSON.stringify(resolution) }),
  requestOperatorApproval: (taskId, input) =>
    request(`/api/tasks/${taskId}/operator-approval`, { method: "POST", body: JSON.stringify(input) }),
  decideOperatorApproval: (taskId, input) =>
    request(`/api/tasks/${taskId}/operator-approval/decision`, { method: "POST", body: JSON.stringify(input) }),
  addComment: (taskId, comment) =>
    request(`/api/tasks/${taskId}/comments`, { method: "POST", body: JSON.stringify(comment) }),
  uploadAttachment: (taskId, file, author = "operator") => {
    const form = new FormData();
    form.append("file", file);
    form.append("author", author);
    return request(`/api/tasks/${taskId}/attachments`, { method: "POST", body: form });
  }
};
