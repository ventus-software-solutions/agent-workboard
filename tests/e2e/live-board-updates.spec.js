import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import { createApp } from "../../server/app.js";
import { WorkboardStore } from "../../server/storage/workboardStore.js";

const projectRoot = path.resolve(".");
const pollTimeout = 15_000;

let apiServer;
let baseURL;
let dataDir;
let viteServer;

test.beforeAll(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-live-e2e-"));
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
});

test.afterAll(async () => {
  await viteServer?.close();
  await closeServer(apiServer);
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("propagates claim, status, comment, and completion updates across browser contexts", async ({ browser }) => {
  const title = uniqueName("Live cross-context workflow");
  const comment = uniqueName("Cross-context comment evidence");
  const producer = await browser.newContext();
  const watcher = await browser.newContext();
  const producerPage = await producer.newPage();
  const watcherPage = await watcher.newPage();

  try {
    const task = await createApiTask(producerPage, {
      title,
      status: "ready",
      role: "tester",
      description: "Created before both browser contexts load the board."
    });

    await Promise.all([producerPage.goto(baseURL), watcherPage.goto(baseURL)]);
    await expectDemoBoard(watcherPage);
    await expectDemoBoard(producerPage);
    await expectLiveRefresh(watcherPage);
    await expect(statusTask(watcherPage, "Ready", title)).toBeVisible();

    await expectOk(
      producerPage.request.post(`${baseURL}/api/tasks/${task.id}/claim`, {
        data: { assignee: "test-agent", expectedStatus: "ready", expectedAssignee: "" }
      })
    );
    const inProgressCard = statusTask(watcherPage, "In Progress", title);
    await expect(inProgressCard).toBeVisible({ timeout: pollTimeout });
    await expect(inProgressCard.locator(".taskMeta")).toContainText("test-agent");

    await expectOk(
      producerPage.request.patch(`${baseURL}/api/tasks/${task.id}`, {
        data: { status: "review", actor: "producer-context" }
      })
    );
    await expect(statusTask(watcherPage, "Review", title)).toBeVisible({ timeout: pollTimeout });

    await statusTask(watcherPage, "Review", title).click();
    const drawer = watcherPage.locator(".drawer");
    await expect(drawer).toBeVisible();

    await expectOk(
      producerPage.request.post(`${baseURL}/api/tasks/${task.id}/comments`, {
        data: { author: "producer-context", body: comment }
      })
    );
    await expect(drawer.locator(".comment", { hasText: comment })).toBeVisible({ timeout: pollTimeout });

    await expectOk(
      producerPage.request.patch(`${baseURL}/api/tasks/${task.id}`, {
        data: {
          status: "done",
          actor: "producer-context",
          completion: {
            completionType: "no-code",
            notes: "Completed by the producer context for live-update propagation coverage."
          }
        }
      })
    );
    await expect(statusTask(watcherPage, "Done", title)).toBeVisible({ timeout: pollTimeout });
    await expect(statusTask(watcherPage, "Done", title).locator(".completionPill")).toContainText("no-code");
  } finally {
    await watcher.close();
    await producer.close();
  }
});

test("preserves an unsaved drawer edit when another browser context updates the task", async ({ browser }) => {
  const title = uniqueName("Live dirty drawer workflow");
  const localDraftTitle = uniqueName("Unsaved watcher draft");
  const producer = await browser.newContext();
  const watcher = await browser.newContext();
  const producerPage = await producer.newPage();
  const watcherPage = await watcher.newPage();

  try {
    const task = await createApiTask(producerPage, {
      title,
      status: "ready",
      role: "implementer",
      description: "The watcher will edit this locally while another context updates it."
    });

    await Promise.all([producerPage.goto(baseURL), watcherPage.goto(baseURL)]);
    await expectDemoBoard(watcherPage);
    await expectLiveRefresh(watcherPage);
    await expect(statusTask(watcherPage, "Ready", title)).toBeVisible();

    await statusTask(watcherPage, "Ready", title).click();
    const drawer = watcherPage.locator(".drawer");
    await drawer.getByLabel("Title").fill(localDraftTitle);

    await expectOk(
      producerPage.request.patch(`${baseURL}/api/tasks/${task.id}`, {
        data: {
          actor: "producer-context",
          description: "Updated from a separate browser context while the watcher draft is dirty."
        }
      })
    );

    await expect(drawer.locator(".liveUpdateNotice")).toContainText("changed elsewhere", { timeout: pollTimeout });
    await expect(drawer.getByLabel("Title")).toHaveValue(localDraftTitle);
  } finally {
    await watcher.close();
    await producer.close();
  }
});

test("shows a disconnected polling status when board-state refresh fails", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let failBoardState = false;

  await page.route("**/api/board-state**", async (route) => {
    if (!failBoardState) {
      await route.continue();
      return;
    }

    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "Synthetic board-state outage" } })
    });
  });

  try {
    await page.goto(baseURL);
    await expectDemoBoard(page);
    await expectLiveRefresh(page);

    failBoardState = true;

    const refreshStatus = page.locator(".refreshStatus");
    await expect(refreshStatus).toContainText("Disconnected", { timeout: pollTimeout });
    await expect(refreshStatus).toHaveAttribute("title", "Synthetic board-state outage");
  } finally {
    await context.close();
  }
});

async function createApiTask(page, task) {
  const response = await page.request.post(`${baseURL}/api/tasks`, {
    data: {
      projectId: "project_demo",
      priority: "normal",
      ...task
    }
  });
  await expectOk(response);
  return (await response.json()).task;
}

async function expectOk(responsePromise) {
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  return response;
}

async function expectDemoBoard(page) {
  await expect(page.getByRole("heading", { name: "Demo Agent Project" })).toBeVisible();
}

async function expectLiveRefresh(page) {
  await expect(page.locator(".refreshStatus")).toContainText(/Live|Updated/, { timeout: 10_000 });
}

function statusTask(page, statusLabel, title) {
  return page.locator(".kanbanColumn", { hasText: statusLabel }).locator(".taskCard", { hasText: title });
}

function uniqueName(prefix) {
  return `${prefix} ${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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
