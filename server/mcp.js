import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildAgentDoc, renderAgentDocMarkdown } from "./agentDocs.js";
import { WorkboardStore } from "./storage/workboardStore.js";

const dataDir = process.env.WORKBOARD_DATA_DIR || path.resolve(".workboard-data");
const store = new WorkboardStore({ dataDir });
await store.init();

const server = new McpServer({
  name: "agent-workboard",
  version: "0.1.0"
});

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
      baseUrl: "http://localhost:8088"
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
    description: "List tasks, optionally filtered by project, status, role, assignee, or query.",
    inputSchema: {
      projectId: z.string().optional(),
      status: z.string().optional(),
      role: z.string().optional(),
      assignee: z.string().optional(),
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
  "update_task_status",
  {
    title: "Update task status",
    description: "Move a task to another status column.",
    inputSchema: {
      taskId: z.string(),
      status: z.string(),
      actor: z.string().optional()
    }
  },
  async (input) => asText({ task: await store.updateTask(input.taskId, { status: input.status }, input.actor) })
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

await server.connect(new StdioServerTransport());
