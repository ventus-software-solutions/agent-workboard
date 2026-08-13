import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkboardStore } from "../../server/storage/workboardStore.js";

export async function createE2eStore(prefix) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), prefix));
  const storageMode = process.env.WORKBOARD_STORAGE || "json";
  const tasksDir = storageMode === "tasksdir" ? path.join(dataDir, "tasks") : undefined;

  if (tasksDir) {
    await mkdir(tasksDir, { recursive: true });
  }

  const store = new WorkboardStore({ dataDir, storageMode, tasksDir });
  await store.init();

  if (storageMode === "tasksdir") {
    await seedDemoTasks(store);
  }

  return { dataDir, store };
}

async function seedDemoTasks(store) {
  await store.createTask({
    projectId: "project_demo",
    title: "Shape the first release plan",
    description: "Turn the product goal into a small release plan with clear acceptance criteria.",
    status: "ready",
    priority: "high",
    role: "pm",
    assignee: "pm-agent",
    labels: ["planning"],
    actor: "system"
  });
  await store.createTask({
    projectId: "project_demo",
    title: "Implement the first useful workflow",
    description:
      "First-release slice: make the demo board useful for one complete task lifecycle. A ready task can be claimed through the first-class claim path, commented with plan/evidence, moved through review, and done requires a structured completion record.",
    status: "ready",
    priority: "high",
    role: "implementer",
    labels: ["mvp", "workflow", "demo"],
    actor: "system"
  });
}
