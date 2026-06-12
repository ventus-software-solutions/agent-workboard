import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildAgentDoc, renderAgentDocMarkdown } from "./agentDocs.js";
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
      const doc = buildAgentDoc({
        agentId: input.agentId,
        roles: store.roles(),
        statuses: store.statuses(),
        baseUrl
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
    "claim_task",
    {
      title: "Claim task",
      description: "Stale-safely assign a task to an agent and move it into progress.",
      inputSchema: {
        taskId: z.string(),
        assignee: z.string(),
        actor: z.string().optional(),
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
        agentId: z.string().optional(),
        runtimeId: z.string().optional(),
        workMode: z.string().optional(),
        now: z.string().optional()
      }
    },
    async (input) => asText(await store.acquireAgentSlot(input))
  );

  server.registerTool(
    "get_next_task",
    {
      title: "Get next task",
      description: "Return the next eligible task for an agent plus claim or review metadata. Does not claim automatically.",
      inputSchema: {
        agentId: z.string(),
        projectId: z.string().optional(),
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
        state: z.enum(["active", "idle", "paused"]).optional(),
        currentTaskId: z.string().optional(),
        currentTask: z.string().optional(),
        workMode: z.string().optional(),
        message: z.string().optional(),
        now: z.string().optional()
      }
    },
    async (input) =>
      asText({
        presence: await store.updateAgentPresence(input.agentId, input)
      })
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
            notes: z.string().optional()
          })
          .optional(),
        actor: z.string().optional()
      }
    },
    async (input) => asText({ task: await store.updateTask(input.taskId, buildUpdateTaskStatusPatch(input), input.actor) })
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
  const store = new WorkboardStore({ dataDir });
  await store.init();
  const server = createWorkboardMcpServer({ store });
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
