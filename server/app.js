import express from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildAgentDoc, listAgentDocs, renderAgentDocMarkdown } from "./agentDocs.js";
import { getIntegrationStatus } from "./integrationStatus.js";
import { clientDisconnectMiddleware, finishHttpError } from "./httpResilience.js";
import { MCP_TOOL_NAMES } from "./mcpToolHandlers.js";
import { cleanupWorktree, createWorktreeCleanupReport, validateWorktreeCleanupRequest } from "./worktreeCleanup.js";
import { inspectTasksDir } from "./tasksdirDoctor.js";
import { canonicalPath, pathIdentity } from "./storage/projectDataSource.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageMetadata = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));
const PROCESS_STARTED_AT = new Date().toISOString();

export function createApp({
  store,
  githubIntake = null,
  integrationStatusProvider = getIntegrationStatus,
  tasksdirDoctor = inspectTasksDir,
  worktreeCleanupProvider = createWorktreeCleanupReport,
  worktreeCleanupAction = cleanupWorktree,
  logger = console,
  staticDir = path.resolve(__dirname, "../dist"),
  startedAt = PROCESS_STARTED_AT,
  version = packageMetadata.version
} = {}) {
  const app = express();

  // This must precede body parsing, API routes, and express.static so every
  // response and underlying socket has an error listener before any write.
  app.use(clientDisconnectMiddleware({ logger }));
  app.use(express.json({ limit: "2mb" }));

  const projectPreflights = new Map();
  const integrationStatus = (projectId = "") => {
    const project = projectId ? store.getProject(projectId) : null;
    const cwd = project?.dataSource?.repoDir || undefined;
    return integrationStatusProvider(cwd ? { cwd } : undefined);
  };

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "agent-workboard" });
  });

  app.get("/api/github-intake", (_req, res) => {
    res.json({
      intake: githubIntake?.status?.() || {
        enabled: false,
        repository: "",
        tokenConfigured: false,
        running: false,
        syncing: false
      }
    });
  });

  app.post("/api/github-intake/sync", async (_req, res, next) => {
    try {
      if (!githubIntake?.sync) {
        throw Object.assign(new Error("GitHub intake is not configured for this server."), { status: 503 });
      }
      res.json({ sync: await githubIntake.sync(), intake: githubIntake.status() });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/meta", (req, res) => {
    res.json({
      roles: store.roles(),
      statuses: store.statuses(),
      completionTypes: store.completionTypes(),
      workItemTypes: store.workItemTypes(),
      capabilityStatuses: store.capabilityStatuses(),
      server: {
        startedAt,
        version,
        storageMode: store.persistence?.mode || "unknown"
      },
      integrationStatus: integrationStatus(req.query.projectId),
      blockerTypes: store.blockerTypes(),
      operatorApprovalDecisions: store.operatorApprovalDecisions()
    });
  });

  app.get("/api/deployment-settings", (_req, res, next) => {
    try {
      res.json({ settings: store.getDeploymentSettings() });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/deployment-settings", async (req, res, next) => {
    try {
      res.json({ settings: await store.updateDeploymentSettings(req.body) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/agent-docs", (_req, res) => {
    res.json(
      listAgentDocs({
        roles: store.roles(),
        statuses: store.statuses(),
        integrationStatus: integrationStatus(),
        deploymentSettings: store.getDeploymentSettings()
      })
    );
  });

  app.get("/api/agent-docs/:agentId", (req, res) => {
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const agentSlotRegistry = store.listAgentSlots();
    const projectContext = store.getAgentProjectContext(req.params.agentId);
    const doc = buildAgentDoc({
      agentId: req.params.agentId,
      roles: store.roles(),
      statuses: store.statuses(),
      agentSlots: agentSlotRegistry.slots,
      agentTypes: agentSlotRegistry.types,
      integrationStatus: integrationStatus(projectContext.activeProjectId),
      baseUrl,
      projectContext,
      deploymentSettings: store.getDeploymentSettings()
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

  app.patch("/api/agent-slots/:agentId", async (req, res, next) => {
    try {
      res.json({ slot: await store.updateAgentSlot(req.params.agentId, req.body) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/agent-slots/:agentId/release", async (req, res, next) => {
    try {
      res.json(await store.forceReleaseAgentSlot(req.params.agentId, req.body));
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/agent-types/:typeId", async (req, res, next) => {
    try {
      res.json({ type: await store.updateAgentType(req.params.typeId, req.body) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/integration-status", (req, res, next) => {
    try {
      res.json({ integrationStatus: integrationStatus(req.query.projectId) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/bootstrap", async (req, res, next) => {
    try {
      const acquisition = await store.acquireAgentSlot(req.body);
      res.json({ ...acquisition, integrationStatus: integrationStatus(acquisition.activeProjectId) });
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

  app.post("/api/projects/preflight", async (req, res, next) => {
    try {
      if (!store.projectDataSourcesSupported()) {
        throw Object.assign(
          new Error("Per-project tasks folders require WORKBOARD_STORAGE=sqlite or json; global tasksdir mode already owns one tree."),
          { status: 409, details: { reason: "project_data_sources_unavailable_in_global_tasksdir" } }
        );
      }
      const tasksDirInput = String(req.body.tasksDir || "").trim();
      if (!tasksDirInput) {
        throw Object.assign(new Error("tasksDir is required for project preflight."), { status: 400 });
      }
      const tasksDir = await canonicalPath(tasksDirInput);
      const report = await tasksdirDoctor(tasksDir);
      if (!report.go) {
        res.json({ report, confirmationToken: "" });
        return;
      }
      for (const [token, confirmation] of projectPreflights) {
        if (confirmation.expiresAt < Date.now()) projectPreflights.delete(token);
      }
      const confirmationToken = randomUUID();
      projectPreflights.set(confirmationToken, {
        tasksDir,
        tasksDirIdentity: pathIdentity(tasksDir),
        sourceFingerprint: report.sourceFingerprint,
        expiresAt: Date.now() + 10 * 60_000
      });
      res.json({ report, confirmationToken });
    } catch (error) {
      if (!error.status) {
        error.status = 400;
        error.details = { reason: "tasksdir_preflight_failed", code: error.code || "" };
      }
      next(error);
    }
  });

  app.post("/api/projects", async (req, res, next) => {
    try {
      if (req.body.dataSource?.tasksDir) {
        const tasksDir = await canonicalPath(String(req.body.dataSource.tasksDir).trim());
        const confirmation = projectPreflights.get(req.body.preflightToken);
        projectPreflights.delete(req.body.preflightToken);
        if (
          !confirmation ||
          confirmation.tasksDirIdentity !== pathIdentity(tasksDir) ||
          confirmation.expiresAt < Date.now()
        ) {
          throw Object.assign(new Error("Run a successful tasks-directory preflight and confirm its report first."), {
            status: 409,
            details: { reason: "tasksdir_preflight_required", tasksDir }
          });
        }
        const currentReport = await tasksdirDoctor(tasksDir);
        if (!currentReport.go || currentReport.sourceFingerprint !== confirmation.sourceFingerprint) {
          throw Object.assign(new Error("The tasks directory changed after preflight. Review a fresh report before creating the project."), {
            status: 409,
            details: {
              reason: "tasksdir_preflight_stale",
              tasksDir,
              expectedFingerprint: confirmation.sourceFingerprint,
              actualFingerprint: currentReport.sourceFingerprint,
              report: currentReport
            }
          });
        }
        req.body.dataSource.tasksDir = tasksDir;
      }
      const project = await store.createProject(req.body);
      res.status(201).json({ project });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/projects/:projectId/data-source/refresh", async (req, res, next) => {
    try {
      res.json({ project: await store.refreshProjectDataSource(req.params.projectId) });
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

  app.post("/api/tasks/:taskId/stale-recovery", async (req, res, next) => {
    try {
      res.json(await store.recoverStaleInProgressTask(req.params.taskId, req.body));
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
      res.status(201).json({ task: store.describeTask(task) });
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
      res.json({ task: store.describeTask(store.getTask(req.params.taskId)) });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/tasks/:taskId", async (req, res, next) => {
    try {
      const task = await store.updateTask(req.params.taskId, req.body, req.body.actor);
      res.json({ task: store.describeTask(task) });
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

  app.post("/api/tasks/:taskId/stage-claim", async (req, res, next) => {
    try {
      const task = await store.claimTaskStage(req.params.taskId, req.body);
      res.json({ task });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/tasks/:taskId/stage-resolution", async (req, res, next) => {
    try {
      const task = await store.resolveTaskStage(req.params.taskId, req.body);
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
      res.download(filePath, attachment.filename, (error) => {
        if (error) {
          next(error);
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/mcp/tools", (_req, res) => {
    res.json({
      tools: MCP_TOOL_NAMES
    });
  });

  if (existsSync(staticDir)) {
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.path.startsWith("/api")) {
        next();
        return;
      }
      res.sendFile(path.join(staticDir, "index.html"), (error) => {
        if (error) {
          next(error);
        }
      });
    });
  }

  app.use((error, req, res, next) => {
    if (finishHttpError(error, req, res, next, { logger })) {
      return;
    }
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
