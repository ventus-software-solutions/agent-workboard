import { describe, expect, it, vi } from "vitest";
import { MCP_TOOL_NAMES } from "../server/mcpToolHandlers.js";
import { registerWorkboardMcpTools } from "../server/mcp.js";

function parseTextResult(result) {
  return JSON.parse(result.content[0].text);
}

describe("Agent Workboard MCP tools", () => {
  it("registers continuous-work helper tools and delegates to the store", async () => {
    const registrations = [];
    const fakeServer = {
      registerTool: (name, config, handler) => {
        registrations.push({ name, config, handler });
      }
    };
    const fakeStore = {
      roles: () => [],
      statuses: () => [],
      listProjects: vi.fn(() => []),
      listTasks: vi.fn(() => []),
      createTask: vi.fn(),
      claimTask: vi.fn(),
      acquireAgentSlot: vi.fn(),
      updateTask: vi.fn(),
      addComment: vi.fn(),
      getNextTaskForAgent: vi.fn(() => ({
        task: { id: "task_123" },
        selection: { reason: "assigned_to_agent" }
      })),
      updateAgentPresence: vi.fn(() => ({
        agentId: "mcp-agent",
        state: "active"
      })),
      reportNoEligibleWork: vi.fn(() => ({
        presence: { agentId: "mcp-agent", state: "idle" },
        report: { reason: "no_ready_work" }
      }))
    };

    registerWorkboardMcpTools(fakeServer, fakeStore);

    expect(registrations.map((registration) => registration.name)).toEqual(MCP_TOOL_NAMES);

    const getNext = registrations.find((registration) => registration.name === "get_next_task");
    expect(parseTextResult(await getNext.handler({ agentId: "mcp-agent", projectId: "project_123" }))).toMatchObject({
      task: { id: "task_123" },
      selection: { reason: "assigned_to_agent" }
    });
    expect(fakeStore.getNextTaskForAgent).toHaveBeenCalledWith("mcp-agent", {
      agentId: "mcp-agent",
      projectId: "project_123"
    });

    const updatePresence = registrations.find((registration) => registration.name === "update_presence");
    expect(parseTextResult(await updatePresence.handler({ agentId: "mcp-agent", state: "active" }))).toMatchObject({
      presence: {
        agentId: "mcp-agent",
        state: "active"
      }
    });

    const idle = registrations.find((registration) => registration.name === "report_no_eligible_work");
    expect(parseTextResult(await idle.handler({ agentId: "mcp-agent", reason: "no_ready_work" }))).toMatchObject({
      report: {
        reason: "no_ready_work"
      }
    });
  });
});
