import express from "express";
import multer from "multer";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ store }) {
  const app = express();

  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "agent-workboard" });
  });

  app.get("/api/meta", (_req, res) => {
    res.json({
      roles: store.roles(),
      statuses: store.statuses()
    });
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

  app.get("/api/tasks", (req, res, next) => {
    try {
      res.json({ tasks: store.listTasks(req.query) });
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
      tools: [
        "list_projects",
        "list_tasks",
        "create_task",
        "claim_task",
        "update_task_status",
        "add_comment"
      ]
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
        message: status === 500 ? "Internal server error." : error.message
      }
    });
  });

  return app;
}
