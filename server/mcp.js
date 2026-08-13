import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildAgentDoc, renderAgentDocMarkdown } from "./agentDocs.js";
import { getIntegrationStatus } from "./integrationStatus.js";
import { MCP_TOOL_NAMES, buildUpdateTaskStatusPatch } from "./mcpToolHandlers.js";
import { WorkboardStore } from "./storage/workboardStore.js";

function asText(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

export function registerWorkboardMcpTools(server, store, { baseUrl = "http://localhost:8088" } = {}) {
  server.registerTool(
    "get_agent_instructions",
    {
      title: "Get agent instructions",
      description: "Return role-aware bootstrap instructions for an agent id.",
      inputSchema: {
        agentId: z.string(),
        format: z.enum(["json", "markdown"]).optional()
      }
    },
    async (input) => {
      const agentSlotRegistry = store.listAgentSlots();
      const doc = buildAgentDoc({
        agentId: input.agentId,
        roles: store.roles(),
        statuses: store.statuses(),
        agentSlots: agentSlotRegistry.slots,
        agentTypes: agentSlotRegistry.types,
        integrationStatus: getIntegrationStatus(),
        baseUrl,
        projectContext: store.getAgentProjectContext(input.agentId)
      });
      return asText(input.format === "json" ? doc : renderAgentDocMarkdown(doc));
    }
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List active workboard projects.",
      inputSchema: {}
    },
    async () => asText({ projects: store.listProjects() })
  );

  server.registerTool(
    "list_tasks",
    {
      title: "List tasks",
      description: "List tasks, optionally filtered by project, status, role, assignee, labels, or query.",
      inputSchema: {
        projectId: z.string().optional(),
        status: z.string().optional(),
        role: z.string().optional(),
        assignee: z.string().optional(),
        labels: z.string().optional(),
        q: z.string().optional()
      }
    },
    async (input) => asText({ tasks: store.listTasks(input) })
  );

  server.registerTool(
    "list_capabilities",
    {
      title: "List capabilities",
      description: "Search the product capability registry by project, status, owner, related task, live state, or text query.",
      inputSchema: {
        projectId: z.string().optional(),
        status: z.string().optional(),
        ownerRole: z.string().optional(),
        ownerAgent: z.string().optional(),
        relatedTaskId: z.string().optional(),
        taskId: z.string().optional(),
        live: z.boolean().optional(),
        q: z.string().optional()
      }
    },
    async (input) => asText({ capabilities: store.listCapabilities(input) })
  );

  server.registerTool(
    "get_capability",
    {
      title: "Get capability",
      description: "Read one product capability with status, ownership, task links, blockers, and verification evidence.",
      inputSchema: {
        capabilityId: z.string()
      }
    },
    async (input) => asText({ capability: store.getCapability(input.capabilityId) })
  );

  server.registerTool(
    "create_task",
    {
      title: "Create task",
      description: "Create a task for a project.",
      inputSchema: {
        projectId: z.string(),
        title: z.string(),
        description: z.string().optional(),
        role: z.string().optional(),
        priority: z.string().optional(),
        labels: z.array(z.string()).optional(),
        assignee: z.string().optional(),
        actor: z.string().optional()
      }
    },
    async (input) => asText({ task: await store.createTask(input) })
  );

  server.registerTool(
    "decompose_task",
    {
      title: "Decompose task",
      description: "Create child tasks from a decomposition-needed parent and comment the child task ids on the parent.",
      inputSchema: {
        taskId: z.string(),
        actor: z.string().optional(),
        summary: z.string().optional(),
        children: z
          .array(
            z.object({
              title: z.string(),
              description: z.string().optional(),
              status: z.string().optional(),
              role: z.string().optional(),
              priority: z.string().optional(),
              labels: z.array(z.string()).optional(),
              assignee: z.string().optional(),
              acceptanceCriteria: z.array(z.string()).optional(),
              evidence: z.string().optional(),
              sequencing: z.string().optional(),
              dependencies: z.array(z.string()).optional()
            })
          )
          .min(1)
      }
    },
    async (input) => asText(await store.decomposeTask(input.taskId, input))
  );

  server.registerTool(
    "claim_task",
    {
      title: "Claim task",
      description: "Stale-safely assign a task to an agent and move it into progress.",
      inputSchema: {
        taskId: z.string(),
        assignee: z.string(),
        actor: z.string().optional(),
        projectId: z.string().optional(),
        activeProjectId: z.string().optional(),
        projectOverrideReason: z.string().optional(),
        expectedStatus: z.string().optional(),
        expectedAssignee: z.string().optional()
      }
    },
    async (input) =>
      asText({
        task: await store.claimTask(input.taskId, input)
      })
  );

  server.registerTool(
    "acquire_agent_slot",
    {
      title: "Acquire agent slot",
      description: "Acquire or renew a concrete agent slot for a generic worker.",
      inputSchema: {
        preferredType: z.string().optional(),
        agentType: z.string().optional(),
        type: z.string().optional(),
        role: z.string().optional(),
        specialties: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
        projectId: z.string().optional(),
        q: z.string().optional(),
        agentId: z.string().optional(),
        activeProjectId: z.string().optional(),
        runtimeId: z.string().optional(),
        workMode: z.string().optional(),
        now: z.string().optional()
      }
    },
    async (input) => {
      const acquisition = await store.acquireAgentSlot(input);
      const agentSlotRegistry = store.listAgentSlots();
      const projectContext =
        acquisition.activeProjectId || acquisition.activeProject
          ? {
              activeProjectId: acquisition.activeProjectId || "",
              activeProject: acquisition.activeProject || null,
              projectContextSource: acquisition.projectContextSource || "",
              projectContextExplicit: Boolean(acquisition.projectContextExplicit),
              projectContextDefaulted: Boolean(acquisition.projectContextDefaulted)
            }
          : store.getAgentProjectContext(acquisition.agentId);
      const instructions = buildAgentDoc({
        agentId: acquisition.agentId,
        roles: store.roles(),
        statuses: store.statuses(),
        agentSlots: agentSlotRegistry.slots,
        agentTypes: agentSlotRegistry.types,
        integrationStatus: getIntegrationStatus(),
        projectContext,
        baseUrl
      });
      const nextTaskFilters = {
        agentId: acquisition.agentId,
        role: acquisition.role,
        specialties: acquisition.specialties,
        workMode: acquisition.workMode
      };
      if (input.projectId) nextTaskFilters.projectId = input.projectId;
      if (input.labels) nextTaskFilters.labels = input.labels;
      if (input.q) nextTaskFilters.q = input.q;

      return asText({
        ...acquisition,
        instructions,
        nextTask: store.getNextTaskForAgent(acquisition.agentId, nextTaskFilters),
        heartbeat: {
          presenceTool: "update_presence",
          renewTool: "acquire_agent_slot",
          releaseTool: "release_agent_slot",
          identityToken: acquisition.identityToken || "",
          leaseExpiresAt: acquisition.lease?.expiresAt || null,
          releaseBehavior:
            "On graceful shutdown keep the identityToken and re-pass it to acquire_agent_slot as identityToken on restart to reclaim this slot. To free the slot immediately (operator override) use release_agent_slot; otherwise stop renewing and the lease expires on its own."
        }
      });
    }
  );

  server.registerTool(
    "get_next_task",
    {
      title: "Get next task",
      description: "Return the next eligible task for an agent plus claim or review metadata. Does not claim automatically.",
      inputSchema: {
        agentId: z.string(),
        projectId: z.string().optional(),
        activeProjectId: z.string().optional(),
        allProjects: z.boolean().optional(),
        projectScope: z.enum(["active", "all", "all-projects"]).optional(),
        role: z.string().optional(),
        labels: z.array(z.string()).optional(),
        specialties: z.array(z.string()).optional(),
        q: z.string().optional(),
        workMode: z.string().optional(),
        now: z.string().optional()
      }
    },
    async (input) => asText(store.getNextTaskForAgent(input.agentId, input))
  );

  server.registerTool(
    "update_presence",
    {
      title: "Update presence",
      description: "Heartbeat or update an agent's visible work state.",
      inputSchema: {
        agentId: z.string(),
        state: z.enum(["active", "waiting", "idle", "paused"]).optional(),
        currentTaskId: z.string().optional(),
        currentTask: z.string().optional(),
        projectId: z.string().optional(),
        activeProjectId: z.string().optional(),
        workMode: z.string().optional(),
        message: z.string().optional(),
        upstreamSignal: z.any().optional(),
        now: z.string().optional()
      }
    },
    async (input) =>
      asText({
        presence: await store.updateAgentPresence(input.agentId, input)
      })
  );

  server.registerTool(
    "release_agent_slot",
    {
      title: "Force-release agent slot",
      description:
        "Operator override that frees an agent slot immediately, ignoring its lease. In-progress tasks claimed by the slot are returned to ready with the assignee cleared. Use only for truly gone or misbehaving agents.",
      inputSchema: {
        agentId: z.string(),
        actor: z.string().optional(),
        now: z.string().optional()
      }
    },
    async (input) =>
      asText(
        await store.forceReleaseAgentSlot(input.agentId, {
          actor: input.actor,
          now: input.now
        })
      )
  );

  server.registerTool(
    "report_no_eligible_work",
    {
      title: "Report no eligible work",
      description: "Record that an agent looked for work and found no eligible task.",
      inputSchema: {
        agentId: z.string(),
        reason: z.string().optional(),
        message: z.string().optional(),
        filters: z.any().optional(),
        now: z.string().optional()
      }
    },
    async (input) => asText(await store.reportNoEligibleWork(input.agentId, input))
  );

  server.registerTool(
    "update_task_status",
    {
      title: "Update task status",
      description: "Move a task to another status column.",
      inputSchema: {
        taskId: z.string(),
        status: z.string(),
        completion: z
          .object({
            completionType: z.string(),
            completedBy: z.string().optional(),
            completedAt: z.string().optional(),
            branch: z.string().optional(),
            commitSha: z.string().optional(),
            mergedTo: z.string().optional(),
            tests: z.array(z.string()).optional(),
            reviewTaskId: z.string().optional(),
            supersededByTaskId: z.string().optional(),
            capabilityIds: z.array(z.string()).optional(),
            notes: z.string().optional()
          })
          .optional(),
        actor: z.string().optional()
      }
    },
    async (input) => asText({ task: await store.updateTask(input.taskId, buildUpdateTaskStatusPatch(input), input.actor) })
  );

  server.registerTool(
    "request_operator_approval",
    {
      title: "Request operator approval",
      description: "Block a task on a visible operator approval request.",
      inputSchema: {
        taskId: z.string(),
        requestedBy: z.string().optional(),
        reason: z.string(),
        requestedAction: z.string(),
        nextStatus: z.string().optional()
      }
    },
    async (input) => asText({ task: await store.requestOperatorApproval(input.taskId, input) })
  );

  server.registerTool(
    "list_operator_approvals",
    {
      title: "List operator approvals",
      description: "List tasks currently waiting for operator approval.",
      inputSchema: {
        projectId: z.string().optional(),
        taskId: z.string().optional(),
        status: z.string().optional()
      }
    },
    async (input) => asText({ approvals: store.listOperatorApprovals(input) })
  );

  server.registerTool(
    "decide_operator_approval",
    {
      title: "Decide operator approval",
      description: "Approve, reject, or request changes on a pending operator approval.",
      inputSchema: {
        taskId: z.string(),
        decision: z.enum(["approved", "rejected", "changes_requested"]),
        decidedBy: z.string().optional(),
        note: z.string().optional(),
        nextStatus: z.string().optional()
      }
    },
    async (input) => asText({ task: await store.decideOperatorApproval(input.taskId, input) })
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add comment",
      description: "Add a progress note or review note to a task.",
      inputSchema: {
        taskId: z.string(),
        author: z.string(),
        body: z.string()
      }
    },
    async (input) => asText({ comment: await store.addComment(input.taskId, input) })
  );

  server.registerTool(
    "post_talk_message",
    {
      title: "Post Agent Talks message",
      description: "Post a project-scoped coordination message outside task evidence comments.",
      inputSchema: {
        projectId: z.string(),
        authorAgentId: z.string(),
        kind: z.enum(["update", "blocker", "review-request", "handoff", "question", "decision", "system"]).optional(),
        body: z.string(),
        relatedTaskId: z.string().optional(),
        mentions: z.array(z.string()).optional()
      }
    },
    async (input) => asText({ message: await store.addTalkMessage(input.projectId, input) })
  );

  server.registerTool(
    "list_talk_messages",
    {
      title: "List Agent Talks messages",
      description: "List project-scoped coordination messages, optionally filtered by kind, agent, task, or text.",
      inputSchema: {
        projectId: z.string(),
        kind: z.string().optional(),
        agentId: z.string().optional(),
        taskId: z.string().optional(),
        q: z.string().optional()
      }
    },
    async (input) => asText({ messages: store.listTalkMessages(input) })
  );

  return MCP_TOOL_NAMES;
}

export function createWorkboardMcpServer({ store, baseUrl = "http://localhost:8088" } = {}) {
  const server = new McpServer({
    name: "agent-workboard",
    version: "0.1.0"
  });

  registerWorkboardMcpTools(server, store, { baseUrl });
  return server;
}

async function main() {
  const dataDir = process.env.WORKBOARD_DATA_DIR || path.resolve(".workboard-data");
  const storageMode = process.env.WORKBOARD_STORAGE || "sqlite";
  const store = new WorkboardStore({ dataDir, storageMode });
  await store.init();
  const server = createWorkboardMcpServer({ store });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
