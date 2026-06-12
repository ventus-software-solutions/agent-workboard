import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import { createApp } from "../../server/app.js";
import { WorkboardStore } from "../../server/storage/workboardStore.js";

const projectRoot = path.resolve(".");

let apiServer;
let baseURL;
let dataDir;
let uploadFixturePath;
let viteServer;

test.beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-e2e-"));
  const store = new WorkboardStore({ dataDir });
  await store.init();

  const apiApp = createApp({ store });
  apiServer = await listen(apiApp);
  const apiBase = `http://127.0.0.1:${apiServer.address().port}`;

  viteServer = await createViteServer({
    root: projectRoot,
    logLevel: "error",
    server: {
      host: "127.0.0.1",
      port: 0,
      strictPort: false,
      proxy: {
        "/api": apiBase
      }
    }
  });
  await viteServer.listen();

  baseURL = `http://127.0.0.1:${viteServer.config.server.port}`;
  uploadFixturePath = path.join(dataDir, "fixtures", "e2e-note.txt");
  await mkdir(path.dirname(uploadFixturePath), { recursive: true });
  await writeFile(uploadFixturePath, "browser attachment evidence\n");
});

test.afterAll(async () => {
  await viteServer?.close();
  await closeServer(apiServer);
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("covers core board flows in the browser", async ({ page }) => {
  const projectName = uniqueName("E2E Core Flow Project");
  const projectKey = uniqueKey("E2E");
  const testerTaskTitle = uniqueName("Verify upload workflow");
  const implementerTaskTitle = uniqueName("Implement hidden helper");
  const comment = "Browser e2e comment evidence";

  await page.goto(baseURL);
  await expect(page.getByRole("heading", { name: "Agent Workboard" })).toBeVisible();

  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.locator(".dialog").getByLabel("Name").fill(projectName);
  await page.locator(".dialog").getByLabel("Key").fill(projectKey);
  await page.locator(".dialog").getByLabel("Description").fill("Created by the Playwright core-flow coverage.");
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await createTask(page, {
    title: testerTaskTitle,
    role: "tester",
    priority: "high",
    assignee: "test-agent",
    labels: "tests, e2e",
    description: "Exercise the task details, comment, and file controls."
  });
  await expect(taskCard(page, testerTaskTitle)).toBeVisible();

  await createTask(page, {
    title: implementerTaskTitle,
    role: "implementer",
    priority: "normal",
    assignee: "implementer-agent",
    labels: "implementation",
    description: "This task should disappear behind the tester role filter."
  });
  await expect(taskCard(page, implementerTaskTitle)).toBeVisible();

  await page.getByRole("button", { name: "Test Agent" }).click();
  await expect(taskCard(page, testerTaskTitle)).toBeVisible();
  await expect(taskCard(page, implementerTaskTitle)).toHaveCount(0);

  await taskCard(page, testerTaskTitle).getByRole("button", { name: "Ready" }).click();
  await expect(page.locator(".kanbanColumn", { hasText: "Ready" }).locator(".taskCard", { hasText: testerTaskTitle })).toBeVisible();

  await taskCard(page, testerTaskTitle).click();
  await page.locator(".commentComposer textarea").fill(comment);
  await page.locator(".commentComposer button").click();
  await expect(page.locator(".comment", { hasText: comment })).toBeVisible();

  await page.locator(".uploadButton input[type='file']").setInputFiles(uploadFixturePath);
  const attachmentLink = page.getByRole("link", { name: "e2e-note.txt" });
  await expect(attachmentLink).toBeVisible();

  const [download] = await Promise.all([page.waitForEvent("download"), attachmentLink.click()]);
  expect(download.suggestedFilename()).toBe("e2e-note.txt");
  const downloadedPath = await download.path();
  await expect.poll(async () => readFile(downloadedPath, "utf8")).toBe("browser attachment evidence\n");
});

async function createTask(page, { title, role, priority, assignee, labels, description }) {
  await page.getByRole("button", { name: "Task", exact: true }).click();
  const dialog = page.locator(".dialog");
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByLabel("Role").selectOption(role);
  await dialog.getByLabel("Priority").selectOption(priority);
  await dialog.getByLabel("Assignee").fill(assignee);
  await dialog.getByLabel("Labels").fill(labels);
  await dialog.getByLabel("Description").fill(description);
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toHaveCount(0);
  await closeDrawerIfOpen(page);
}

function taskCard(page, title) {
  return page.locator(".taskCard", { hasText: title });
}

function uniqueName(prefix) {
  return `${prefix} ${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function uniqueKey(prefix) {
  return `${prefix}${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
}

async function closeDrawerIfOpen(page) {
  const drawer = page.locator(".drawer");
  if ((await drawer.count()) === 0) {
    return;
  }
  await drawer.getByRole("button", { name: "Close" }).click();
  await expect(drawer).toHaveCount(0);
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1");
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
