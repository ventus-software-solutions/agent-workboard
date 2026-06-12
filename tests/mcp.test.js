import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MCP_TOOL_NAMES } from "../server/mcpToolHandlers.js";
import { registerWorkboardMcpTools } from "../server/mcp.js";
import { WorkboardStore } from "../server/storage/workboardStore.js";

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
      listCapabilities: vi.fn(() => [
        {
          id: "cap_mcp_workflow_tools",
          name: "MCP workflow tools",
          status: "live"
        }
      ]),
      getCapability: vi.fn(() => ({
        id: "cap_mcp_workflow_tools",
        name: "MCP workflow tools",
        status: "live"
      })),
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

    const listCapabilities = registrations.find((registration) => registration.name === "list_capabilities");
    expect(parseTextResult(await listCapabilities.handler({ q: "MCP", status: "live" }))).toMatchObject({
      capabilities: [
        {
          id: "cap_mcp_workflow_tools",
          status: "live"
        }
      ]
    });
    expect(fakeStore.listCapabilities).toHaveBeenCalledWith({
      q: "MCP",
      status: "live"
    });

    const getCapability = registrations.find((registration) => registration.name === "get_capability");
    expect(parseTextResult(await getCapability.handler({ capabilityId: "cap_mcp_workflow_tools" }))).toMatchObject({
      capability: {
        id: "cap_mcp_workflow_tools",
        status: "live"
      }
    });
    expect(fakeStore.getCapability).toHaveBeenCalledWith("cap_mcp_workflow_tools");
  });

  it("surfaces the store one-active-task guard through claim_task", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-mcp-"));
    const store = new WorkboardStore({ dataDir: tempDir });
    await store.init();
    try {
      const project = await store.createProject({ name: "MCP Single Active Claim Project" });
      const active = await store.createTask({
        projectId: project.id,
        title: "MCP active task",
        status: "in_progress",
        role: "implementer",
        assignee: "mcp-agent"
      });
      const next = await store.createTask({
        projectId: project.id,
        title: "MCP second task",
        status: "ready",
        role: "implementer",
        assignee: "mcp-agent"
      });
      const registrations = [];
      const fakeServer = {
        registerTool: (name, config, handler) => {
          registrations.push({ name, config, handler });
        }
      };
      registerWorkboardMcpTools(fakeServer, store);

      const claimTask = registrations.find((registration) => registration.name === "claim_task");
      await expect(
        claimTask.handler({
          taskId: next.id,
          assignee: "mcp-agent",
          expectedStatus: "ready",
          expectedAssignee: "mcp-agent"
        })
      ).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining(active.id)
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
