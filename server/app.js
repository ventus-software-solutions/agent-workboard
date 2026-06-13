import express from "express";
import multer from "multer";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildAgentDoc, listAgentDocs, renderAgentDocMarkdown } from "./agentDocs.js";
import { getIntegrationStatus } from "./integrationStatus.js";
import { MCP_TOOL_NAMES } from "./mcpToolHandlers.js";
import { cleanupWorktree, createWorktreeCleanupReport, validateWorktreeCleanupRequest } from "./worktreeCleanup.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({
  store,
  integrationStatusProvider = getIntegrationStatus,
  worktreeCleanupProvider = createWorktreeCleanupReport,
  worktreeCleanupAction = cleanupWorktree
} = {}) {
  const app = express();

  app.use(express.json({ limit: "2mb" }));

  const integrationStatus = () => integrationStatusProvider();

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "agent-workboard" });
  });

  app.get("/api/meta", (_req, res) => {
    res.json({
      roles: store.roles(),
      statuses: store.statuses(),
      completionTypes: store.completionTypes(),
      workItemTypes: store.workItemTypes(),
      capabilityStatuses: store.capabilityStatuses(),
      integrationStatus: integrationStatus(),
      blockerTypes: store.blockerTypes(),
      operatorApprovalDecisions: store.operatorApprovalDecisions()
    });
  });

  app.get("/api/agent-docs", (_req, res) => {
    res.json(listAgentDocs({ roles: store.roles(), statuses: store.statuses(), integrationStatus: integrationStatus() }));
  });

  app.get("/api/agent-docs/:agentId", (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const agentSlotRegistry = store.listAgentSlots();
    const doc = buildAgentDoc({
      agentId: req.params.agentId,
      roles: store.roles(),
      statuses: store.statuses(),
      agentSlots: agentSlotRegistry.slots,
      agentTypes: agentSlotRegistry.types,
      integrationStatus: integrationStatus(),
      baseUrl,
      projectContext: store.getAgentProjectContext(req.params.agentId)
    });

    if (req.query.format === "md" || req.query.format === "markdown" || req.accepts(["json", "text"]) === "text") {
      res.type("text/markdown").send(renderAgentDocMarkdown(doc));
      return;
    }

    res.json({ agent: doc });
  });

  app.get("/api/agent-slots", (req, res, next) => {
    try {
      res.json(store.listAgentSlots(req.query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/integration-status", (_req, res, next) => {
    try {
      res.json({ integrationStatus: integrationStatus() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/bootstrap", async (req, res, next) => {
    try {
      res.json({ ...(await store.acquireAgentSlot(req.body)), integrationStatus: integrationStatus() });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent-slots/acquire", async (req, res, next) => {
    try {
      res.json(await store.acquireAgentSlot(req.body));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agents/presence", (req, res, next) => {
    try {
      res.json({ agents: store.listAgentPresence(req.query) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agents/:agentId/presence", async (req, res, next) => {
    try {
      res.json({ presence: await store.updateAgentPresence(req.params.agentId, req.body) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agents/:agentId/next-task", (req, res, next) => {
    try {
      res.json(store.getNextTaskForAgent(req.params.agentId, req.query));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agents/:agentId/no-eligible-work", async (req, res, next) => {
    try {
      res.json(await store.reportNoEligibleWork(req.params.agentId, req.body));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects", (req, res, next) => {
    try {
      res.json({ projects: store.listProjects({ includeArchived: req.query.includeArchived === "true" }) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects", async (req, res, next) => {
    try {
      const project = await store.createProject(req.body);
      res.status(201).json({ project });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:projectId/export", (req, res, next) => {
    try {
      const backup = store.exportProjectBackup(req.params.projectId);
      const filename = `${backup.project.key || backup.project.id}-workboard-backup.json`.toLowerCase();
      res.attachment(filename);
      res.json(backup);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/import", async (req, res, next) => {
    try {
      const result = await store.importProjectBackup(req.body, { actor: req.body.actor });
      res.status(result.created ? 201 : 200).json({ import: result, project: store.getProject(result.projectId) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:projectId/activity", (req, res, next) => {
    try {
      res.json({ activity: store.listProjectActivity({ ...req.query, projectId: req.params.projectId }) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects/:projectId/talks", (req, res, next) => {
    try {
      const messages = store
        .listTalkMessages({ ...req.query, projectId: req.params.projectId })
        .map((message) => decorateTalkMessage(store, message));
      res.json({ messages });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/:projectId/talks", async (req, res, next) => {
    try {
      const message = await store.addTalkMessage(req.params.projectId, req.body);
      res.status(201).json({ message: decorateTalkMessage(store, message) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/capabilities", (req, res, next) => {
    try {
      res.json({ capabilities: store.listCapabilities(req.query) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/capabilities", async (req, res, next) => {
    try {
      const capability = await store.createCapability(req.body);
      res.status(201).json({ capability });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/capabilities/:capabilityId", (req, res, next) => {
    try {
      res.json({ capability: store.getCapability(req.params.capabilityId) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/capabilities/:capabilityId", async (req, res, next) => {
    try {
      res.json({ capability: await store.updateCapability(req.params.capabilityId, req.body) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/board-state", (req, res, next) => {
    try {
      res.json({ state: store.getBoardState(req.query) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tasks", (req, res, next) => {
    try {
      res.json({ tasks: store.listTasks(req.query) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tasks/stale-in-progress", (req, res, next) => {
    try {
      res.json(store.listStaleInProgressTasks(req.query));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/worktree-cleanup", async (req, res, next) => {
    try {
      const mainRef = typeof req.query.mainRef === "string" && req.query.mainRef.trim() ? req.query.mainRef.trim() : "main";
      const report = await worktreeCleanupProvider({ store, mainRef });
      res.json({ report });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/worktree-cleanup/cleanup", async (req, res, next) => {
    try {
      const cleanupRequest = validateWorktreeCleanupRequest(req.body);
      const cleanup = await worktreeCleanupAction({ store, ...cleanupRequest });
      res.json({ cleanup });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tasks", async (req, res, next) => {
    try {
      const task = await store.createTask(req.body);
      res.status(201).json({ task });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/operator-approvals", (req, res, next) => {
    try {
      res.json({ approvals: store.listOperatorApprovals(req.query) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tasks/:taskId", (req, res, next) => {
    try {
      res.json({ task: store.getTask(req.params.taskId) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/tasks/:taskId", async (req, res, next) => {
    try {
      const task = await store.updateTask(req.params.taskId, req.body, req.body.actor);
      res.json({ task });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tasks/:taskId/claim", async (req, res, next) => {
    try {
      const task = await store.claimTask(req.params.taskId, req.body);
      res.json({ task });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tasks/:taskId/operator-approval", async (req, res, next) => {
    try {
      const task = await store.requestOperatorApproval(req.params.taskId, req.body);
      res.json({ task });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tasks/:taskId/operator-approval/decision", async (req, res, next) => {
    try {
      const task = await store.decideOperatorApproval(req.params.taskId, req.body);
      res.json({ task });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tasks/:taskId/decompose", async (req, res, next) => {
    try {
      const result = await store.decomposeTask(req.params.taskId, req.body);
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tasks/:taskId/comments", async (req, res, next) => {
    try {
      const comment = await store.addComment(req.params.taskId, req.body);
      res.status(201).json({ comment, task: store.getTask(req.params.taskId) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tasks/:taskId/attachments", upload.single("file"), async (req, res, next) => {
    try {
      const attachment = await store.addAttachment(req.params.taskId, req.file, req.body.author);
      res.status(201).json({ attachment, task: store.getTask(req.params.taskId) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tasks/:taskId/attachments/:attachmentId/download", async (req, res, next) => {
    try {
      const { attachment, filePath } = await store.getAttachment(req.params.taskId, req.params.attachmentId);
      res.download(filePath, attachment.filename);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/mcp/tools", (_req, res) => {
    res.json({
      tools: MCP_TOOL_NAMES
    });
  });

  const distDir = path.resolve(__dirname, "../dist");
  if (existsSync(distDir)) {
    app.use(express.static(distDir));
    app.use((req, res, next) => {
      if (req.path.startsWith("/api")) {
        next();
        return;
      }
      res.sendFile(path.join(distDir, "index.html"));
    });
  }

  app.use((error, _req, res, _next) => {
    const status = error.status || (error.code === "LIMIT_FILE_SIZE" ? 413 : 500);
    res.status(status).json({
      error: {
        message: status === 500 ? "Internal server error." : error.message,
        ...(error.details ? { details: error.details } : {})
      }
    });
  });

  return app;
}

function decorateTalkMessage(store, message) {
  const relatedTask = message.relatedTaskId ? store.getTask(message.relatedTaskId) : null;
  return {
    ...message,
    relatedTask: relatedTask
      ? {
          id: relatedTask.id,
          title: relatedTask.title,
          status: relatedTask.status,
          assignee: relatedTask.assignee
        }
      : null
  };
}
