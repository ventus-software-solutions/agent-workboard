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
      listAgentSlots: vi.fn(() => ({
        types: [
          {
            id: "mcp",
            role: "implementer",
            specialties: ["mcp", "agent-tools"],
            defaultWorkMode: "single-task",
            slotIds: ["mcp-agent"]
          }
        ],
        slots: [
          {
            id: "mcp-agent",
            typeId: "mcp",
            role: "implementer",
            specialties: ["mcp", "agent-tools"],
            workMode: "single-task",
            slotNumber: 1
          }
        ]
      })),
      listProjects: vi.fn(() => []),
      listTasks: vi.fn(() => []),
      createTask: vi.fn(),
      decomposeTask: vi.fn((taskId, input) => ({
        parentTask: { id: taskId },
        childTasks: input.children.map((child, index) => ({
          id: `task_child_${index + 1}`,
          ...child
        })),
        comment: {
          id: "comment_decomposition",
          body: "Created child tasks task_child_1 and task_child_2."
        }
      })),
      claimTask: vi.fn((taskId, input) => ({ id: taskId, ...input })),
      forceReleaseAgentSlot: vi.fn((agentId, input) => ({
        released: true,
        agentId,
        returnedTasks: [{ taskId: "task_x", title: "x" }]
      })),
      acquireAgentSlot: vi.fn((input) => ({
        acquired: true,
        agentId: input.agentId || "mcp-agent",
        typeId: "mcp",
        role: "implementer",
        specialties: ["mcp", "agent-tools"],
        slotNumber: 1,
        workMode: "single-task",
        activeProjectId: input.activeProjectId,
        activeProject: input.activeProjectId
          ? {
              id: input.activeProjectId,
              key: "TEAM",
              name: "Team Board"
            }
          : null,
        lease: {
          expiresAt: "2026-06-12T15:05:00.000Z"
        }
      })),
      updateTask: vi.fn(),
      addComment: vi.fn(),
      getAgentProjectContext: vi.fn(() => ({
        activeProjectId: "project_team",
        activeProject: {
          id: "project_team",
          key: "TEAM",
          name: "Team Board"
        }
      })),
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
      requestOperatorApproval: vi.fn(() => ({
        id: "task_approval",
        status: "blocked",
        blocker: { type: "operator_approval", status: "pending" }
      })),
      listOperatorApprovals: vi.fn(() => [
        {
          task: { id: "task_approval" },
          blocker: { status: "pending" }
        }
      ]),
      decideOperatorApproval: vi.fn(() => ({
        id: "task_approval",
        status: "review",
        blocker: null
      })),
      getNextTaskForAgent: vi.fn(() => ({
        task: { id: "task_123" },
        selection: { reason: "assigned_to_agent" }
      })),
      updateAgentPresence: vi.fn((agentId, input) => ({
        agentId,
        ...input,
        state: input.state || "active"
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

    expect(parseTextResult(await getNext.handler({ agentId: "mcp-agent", allProjects: true }))).toMatchObject({
      task: { id: "task_123" },
      selection: { reason: "assigned_to_agent" }
    });
    expect(fakeStore.getNextTaskForAgent).toHaveBeenCalledWith("mcp-agent", {
      agentId: "mcp-agent",
      allProjects: true
    });

    const acquireSlot = registrations.find((registration) => registration.name === "acquire_agent_slot");
    const acquiredSlot = parseTextResult(
      await acquireSlot.handler({
        agentId: "mcp-agent",
        activeProjectId: "project_team",
        runtimeId: "runtime-mcp"
      })
    );
    expect(acquiredSlot).toMatchObject({
      agentId: "mcp-agent",
      activeProjectId: "project_team",
      instructions: {
        activeProjectId: "project_team",
        activeProject: {
          key: "TEAM"
        },
        integrationStatus: {
          sourceOfTruth: expect.any(String)
        }
      }
    });
    expect(fakeStore.acquireAgentSlot).toHaveBeenCalledWith({
      agentId: "mcp-agent",
      activeProjectId: "project_team",
      runtimeId: "runtime-mcp"
    });

    const claimTask = registrations.find((registration) => registration.name === "claim_task");
    const roleClaimError = Object.assign(new Error("Agent id reviewer is a role type; acquire a concrete agent slot first."), {
      status: 409,
      details: {
        agentId: "reviewer",
        typeId: "reviewer",
        suggestedSlotIds: ["reviewer-agent", "reviewer-agent-2"]
      }
    });
    fakeStore.claimTask.mockRejectedValueOnce(roleClaimError);
    await expect(claimTask.handler({ taskId: "task_123", assignee: "reviewer" })).rejects.toMatchObject({
      status: 409,
      details: {
        typeId: "reviewer"
      }
    });
    expect(fakeStore.claimTask).toHaveBeenCalledWith("task_123", {
      taskId: "task_123",
      assignee: "reviewer"
    });

    expect(
      parseTextResult(
        await claimTask.handler({
          taskId: "task_123",
          assignee: "mcp-agent",
          projectOverrideReason: "Operator asked this agent to take a DEMO task."
        })
      )
    ).toMatchObject({
      task: {
        id: "task_123",
        assignee: "mcp-agent",
        projectOverrideReason: "Operator asked this agent to take a DEMO task."
      }
    });

    const bootstrap = parseTextResult(
      await acquireSlot.handler({
        preferredType: "mcp",
        runtimeId: "runtime-123",
        specialties: ["mcp"]
      })
    );
    expect(bootstrap).toMatchObject({
      acquired: true,
      agentId: "mcp-agent",
      role: "implementer",
      slotNumber: 1,
      workMode: "single-task",
      instructions: {
        agentId: "mcp-agent",
        role: "implementer"
      },
      nextTask: {
        task: { id: "task_123" },
        selection: { reason: "assigned_to_agent" }
      },
      heartbeat: {
        presenceTool: "update_presence",
        renewTool: "acquire_agent_slot",
        leaseExpiresAt: "2026-06-12T15:05:00.000Z"
      }
    });
    expect(fakeStore.acquireAgentSlot).toHaveBeenCalledWith({
      preferredType: "mcp",
      runtimeId: "runtime-123",
      specialties: ["mcp"]
    });
    expect(fakeStore.getNextTaskForAgent).toHaveBeenCalledWith("mcp-agent", {
      agentId: "mcp-agent",
      role: "implementer",
      specialties: ["mcp", "agent-tools"],
      workMode: "single-task"
    });

    const updatePresence = registrations.find((registration) => registration.name === "update_presence");
    expect(
      parseTextResult(
        await updatePresence.handler({
          agentId: "mcp-agent",
          state: "active",
          activeProjectId: "project_team"
        })
      )
    ).toMatchObject({
      presence: {
        agentId: "mcp-agent",
        state: "active",
        activeProjectId: "project_team"
      }
    });

    const releaseSlot = registrations.find((registration) => registration.name === "release_agent_slot");
    expect(parseTextResult(await releaseSlot.handler({ agentId: "mcp-agent" }))).toMatchObject({
      released: true,
      agentId: "mcp-agent"
    });
    expect(fakeStore.forceReleaseAgentSlot).toHaveBeenCalledWith("mcp-agent", {
      actor: undefined,
      now: undefined
    });

    const idle = registrations.find((registration) => registration.name === "report_no_eligible_work");
    expect(parseTextResult(await idle.handler({ agentId: "mcp-agent", reason: "no_ready_work" }))).toMatchObject({
      report: {
        reason: "no_ready_work"
      }
    });

    const decomposeTask = registrations.find((registration) => registration.name === "decompose_task");
    expect(
      parseTextResult(
        await decomposeTask.handler({
          taskId: "task_parent",
          actor: "planner-agent",
          summary: "Split parent into backend and frontend work.",
          children: [
            {
              title: "Backend planning child",
              role: "implementer",
              priority: "high",
              labels: ["backend"],
              acceptanceCriteria: ["Persist child work."]
            },
            {
              title: "Frontend planning child",
              role: "implementer",
              priority: "normal",
              labels: ["frontend"]
            }
          ]
        })
      )
    ).toMatchObject({
      childTasks: [
        { id: "task_child_1", title: "Backend planning child" },
        { id: "task_child_2", title: "Frontend planning child" }
      ],
      comment: {
        id: "comment_decomposition"
      }
    });
    expect(fakeStore.decomposeTask).toHaveBeenCalledWith("task_parent", {
      taskId: "task_parent",
      actor: "planner-agent",
      summary: "Split parent into backend and frontend work.",
      children: [
        {
          title: "Backend planning child",
          role: "implementer",
          priority: "high",
          labels: ["backend"],
          acceptanceCriteria: ["Persist child work."]
        },
        {
          title: "Frontend planning child",
          role: "implementer",
          priority: "normal",
          labels: ["frontend"]
        }
      ]
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

    const requestApproval = registrations.find((registration) => registration.name === "request_operator_approval");
    expect(
      parseTextResult(
        await requestApproval.handler({
          taskId: "task_approval",
          requestedBy: "mcp-agent",
          reason: "Need approval before commit.",
          requestedAction: "Approve commit.",
          nextStatus: "review"
        })
      )
    ).toMatchObject({
      task: {
        status: "blocked",
        blocker: { status: "pending" }
      }
    });
    expect(fakeStore.requestOperatorApproval).toHaveBeenCalledWith("task_approval", {
      taskId: "task_approval",
      requestedBy: "mcp-agent",
      reason: "Need approval before commit.",
      requestedAction: "Approve commit.",
      nextStatus: "review"
    });

    const listApprovals = registrations.find((registration) => registration.name === "list_operator_approvals");
    expect(parseTextResult(await listApprovals.handler({ projectId: "project_123" }))).toMatchObject({
      approvals: [
        {
          task: { id: "task_approval" },
          blocker: { status: "pending" }
        }
      ]
    });
    expect(fakeStore.listOperatorApprovals).toHaveBeenCalledWith({ projectId: "project_123" });

    const decideApproval = registrations.find((registration) => registration.name === "decide_operator_approval");
    expect(
      parseTextResult(
        await decideApproval.handler({
          taskId: "task_approval",
          decision: "approved",
          decidedBy: "operator",
          note: "Approved.",
          nextStatus: "review"
        })
      )
    ).toMatchObject({
      task: {
        status: "review",
        blocker: null
      }
    });
  });

  it("surfaces the store one-active-task guard through claim_task", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-mcp-"));
    const store = new WorkboardStore({ dataDir: tempDir, storageMode: "json" });
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
