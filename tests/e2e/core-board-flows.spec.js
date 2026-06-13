import { expect, test } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import { createApp } from "../../server/app.js";
import { WorkboardStore } from "../../server/storage/workboardStore.js";

const projectRoot = path.resolve(".");

let apiServer;
let apiBaseURL;
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
  apiBaseURL = apiBase;

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

test("shows the seeded DEMO lifecycle tasks in the ready lane", async ({ page }) => {
  await page.goto(baseURL);
  await expect(page.getByRole("heading", { name: "Demo Agent Project" })).toBeVisible();

  const readyColumn = page.locator('.kanbanColumn[data-status-id="ready"]');
  await expect(readyColumn.locator(".taskCard", { hasText: "Shape the first release plan" })).toBeVisible();

  const workflowCard = readyColumn.locator(".taskCard", { hasText: "Implement the first useful workflow" });
  await expect(workflowCard).toBeVisible();
  await expect(workflowCard).toContainText("high");
  await expect(workflowCard).toContainText("Unassigned");
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

  await taskCard(page, testerTaskTitle).getByRole("button", { name: "Move to Ready" }).click();
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

test("keeps wrapped task-card content inside the card at responsive widths", async ({ page }) => {
  const projectName = uniqueName("E2E Card Layout Project");
  const projectKey = uniqueKey("LAY");
  const longTitle =
    "Backend/frontend implementer: add task dependency and blocker links with a very long wrapped title for clipping coverage";
  const longAssignee = "implementer-backend-very-long-assignee-name-that-wraps-cleanly";

  await page.goto(baseURL);
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.locator(".dialog").getByLabel("Name").fill(projectName);
  await page.locator(".dialog").getByLabel("Key").fill(projectKey);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await createTask(page, {
    title: longTitle,
    role: "implementer",
    priority: "high",
    assignee: longAssignee,
    labels: "responsive,cards",
    description: "Short description keeps the regression focused on wrapped title and metadata rows."
  });

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 860, height: 720 },
    { width: 390, height: 844 }
  ]) {
    await page.setViewportSize(viewport);
    await expect(taskCard(page, longTitle)).toBeVisible();
    await expectCardContentInsideCard(page, longTitle);
  }
});

test("labels task status controls as actions", async ({ page }) => {
  const projectName = uniqueName("E2E Action Label Project");
  const projectKey = uniqueKey("ACT");
  const backlogTitle = uniqueName("Clarify backlog card action");
  const reviewerTitle = uniqueName("Review audit-ready copy");

  const projectResponse = await page.request.post(`${apiBaseURL}/api/projects`, {
    data: { name: projectName, key: projectKey }
  });
  expect(projectResponse.ok()).toBe(true);
  const { project } = await projectResponse.json();

  for (const payload of [
    {
      projectId: project.id,
      title: backlogTitle,
      status: "backlog",
      role: "implementer",
      priority: "normal",
      description: "Card action should say Move to Ready."
    },
    {
      projectId: project.id,
      title: reviewerTitle,
      status: "ready",
      role: "reviewer",
      priority: "high",
      labels: ["audit"],
      description: "Reviewer work in Ready should be visually distinct."
    }
  ]) {
    const taskResponse = await page.request.post(`${apiBaseURL}/api/tasks`, { data: payload });
    expect(taskResponse.ok()).toBe(true);
  }

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await expect(taskCard(page, backlogTitle).getByRole("button", { name: "Move to Ready" })).toBeVisible();
  const reviewerCard = taskCard(page, reviewerTitle);
  await expect(reviewerCard).toContainText("Current: Ready");
  await expect(reviewerCard).toContainText("Reviewer work");
  await expect(reviewerCard.getByRole("button", { name: "Start" })).toBeVisible();

  await reviewerCard.click();
  const drawer = page.locator(".drawer");
  await expect(drawer.getByRole("button", { name: "Current: Ready" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Send to Review" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Move to Testing" })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Block" })).toBeVisible();
  await expect(drawer.locator(".statusRow").getByRole("button", { name: "Complete", exact: true })).toBeVisible();
});

test("saves comma-separated drawer labels as task label arrays", async ({ page }) => {
  const projectName = uniqueName("E2E Drawer Labels Project");
  const projectKey = uniqueKey("LBL");
  const taskTitle = uniqueName("Normalize drawer labels");

  const projectResponse = await page.request.post(`${apiBaseURL}/api/projects`, {
    data: { name: projectName, key: projectKey }
  });
  expect(projectResponse.ok()).toBe(true);
  const { project } = await projectResponse.json();

  const taskResponse = await page.request.post(`${apiBaseURL}/api/tasks`, {
    data: {
      projectId: project.id,
      title: taskTitle,
      status: "ready",
      role: "implementer",
      priority: "normal",
      labels: ["initial"]
    }
  });
  expect(taskResponse.ok()).toBe(true);
  const { task } = await taskResponse.json();

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await taskCard(page, taskTitle).click();
  const drawer = page.locator(".drawer");
  await drawer.getByLabel("Labels").fill("alpha, beta, , gamma");
  await drawer.getByRole("button", { name: "Save" }).click();
  await expect(drawer.locator(".saveErrorPanel")).toHaveCount(0);

  await expect
    .poll(async () => {
      const updatedResponse = await page.request.get(`${apiBaseURL}/api/tasks/${task.id}`);
      expect(updatedResponse.ok()).toBe(true);
      const updated = await updatedResponse.json();
      return updated.task.labels;
    })
    .toEqual(["alpha", "beta", "gamma"]);
});

test("collapses the desktop sidebar without resetting board context", async ({ page }) => {
  const projectName = uniqueName("E2E Sidebar Project");
  const projectKey = uniqueKey("NAV");
  const testerTaskTitle = uniqueName("Verify sidebar context");
  const implementerTaskTitle = uniqueName("Implement hidden sidebar item");
  const draftTitle = "Unsaved sidebar drawer draft";

  const projectResponse = await page.request.post(`${apiBaseURL}/api/projects`, {
    data: { name: projectName, key: projectKey }
  });
  expect(projectResponse.ok()).toBe(true);
  const { project } = await projectResponse.json();

  for (const task of [
    {
      projectId: project.id,
      title: testerTaskTitle,
      status: "ready",
      role: "tester",
      priority: "high",
      assignee: "test-agent"
    },
    {
      projectId: project.id,
      title: implementerTaskTitle,
      status: "ready",
      role: "implementer",
      priority: "normal",
      assignee: "implementer-agent"
    }
  ]) {
    const taskResponse = await page.request.post(`${apiBaseURL}/api/tasks`, { data: task });
    expect(taskResponse.ok()).toBe(true);
  }

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("button", { name: "Test Agent" }).click();
  await page.getByPlaceholder("Search tasks").fill("sidebar context");
  await expect(taskCard(page, testerTaskTitle)).toBeVisible();
  await expect(taskCard(page, implementerTaskTitle)).toHaveCount(0);

  await taskCard(page, testerTaskTitle).click();
  const drawer = page.locator(".drawer");
  await drawer.getByLabel("Title").fill(draftTitle);

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.locator(".projectRail")).toBeHidden();
  await expect(page.getByRole("button", { name: "Open sidebar" })).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  await expect(page.getByPlaceholder("Search tasks")).toHaveValue("sidebar context");
  await expect(page.getByRole("button", { name: "tester" })).toBeVisible();
  await expect(drawer.getByLabel("Title")).toHaveValue(draftTitle);

  await page.reload();
  await expect(page.getByRole("button", { name: "Open sidebar" })).toBeVisible();
  await expect(page.locator(".projectRail")).toBeHidden();

  await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(page.locator(".projectRail")).toBeVisible();
});

test("uses an off-canvas sidebar on mobile with keyboard and outside-click close", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL);
  await expect(page.getByRole("heading", { name: "Demo Agent Project" })).toBeVisible();

  await expect(page.locator(".projectRail")).toBeHidden();

  await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(page.locator(".projectRail")).toBeVisible();
  await expect(page.getByRole("button", { name: "Close sidebar" }).first()).toHaveAttribute("aria-expanded", "true");

  await page.keyboard.press("Escape");
  await expect(page.locator(".projectRail")).toBeHidden();

  await page.getByRole("button", { name: "Open sidebar" }).click();
  await expect(page.locator(".projectRail")).toBeVisible();
  await page.locator(".sidebarScrim").click({ position: { x: 370, y: 40 } });
  await expect(page.locator(".projectRail")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Demo Agent Project" })).toBeVisible();
});

test("splits tasks and coordination while preserving board state", async ({ page }) => {
  const projectName = uniqueName("E2E Workspace Tabs Project");
  const projectKey = uniqueKey("TAB");
  const readyTitle = uniqueName("Build roomy tasks workspace");
  const blockedTitle = uniqueName("Resolve blocked coordination");
  const reviewTitle = uniqueName("Review workspace tab shell");
  const staleTitle = uniqueName("Recover missing slot owner");
  const draftTitle = "Unsaved workspace tab draft";

  const projectResponse = await page.request.post(`${apiBaseURL}/api/projects`, {
    data: { name: projectName, key: projectKey }
  });
  expect(projectResponse.ok()).toBe(true);
  const { project } = await projectResponse.json();

  for (const task of [
    { title: readyTitle, status: "ready", assignee: "implementer-2", priority: "high" },
    { title: blockedTitle, status: "blocked", assignee: "implementer-2", priority: "high" },
    { title: reviewTitle, status: "review", assignee: "reviewer-agent", priority: "normal" },
    { title: staleTitle, status: "in_progress", assignee: "missing-slot-agent", priority: "high" }
  ]) {
    const taskResponse = await page.request.post(`${apiBaseURL}/api/tasks`, {
      data: {
        projectId: project.id,
        role: "implementer",
        description: "Created for workspace tab coverage.",
        ...task
      }
    });
    expect(taskResponse.ok()).toBe(true);
    if (task.title === readyTitle) {
      const { task: readyTask } = await taskResponse.json();
      const talkResponse = await page.request.post(`${apiBaseURL}/api/projects/${project.id}/talks`, {
        data: {
          authorAgentId: "implementer-2",
          kind: "update",
          relatedTaskId: readyTask.id,
          body: "Coordination belongs away from the roomy board."
        }
      });
      expect(talkResponse.ok()).toBe(true);
    }
  }

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  const tasksTab = page.getByRole("tab", { name: /Tasks/ });
  const coordinationTab = page.getByRole("tab", { name: /Coordination/ });
  await expect(tasksTab).toHaveAttribute("aria-selected", "true");
  await expect(coordinationTab).toContainText(/Coordination/);
  await expect(page.locator(".kanbanBoard")).toBeVisible();
  await expect(page.locator(".talksPanel")).toHaveCount(0);

  const boardBox = await page.locator(".kanbanBoard").boundingBox();
  expect(boardBox?.height ?? 0).toBeGreaterThan(480);

  await taskCard(page, readyTitle).click();
  const drawer = page.locator(".drawer");
  await drawer.getByLabel("Title").fill(draftTitle);

  await coordinationTab.click();
  await expect(coordinationTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".kanbanBoard")).toHaveCount(0);
  await expect(page.locator(".talksPanel")).toBeVisible();
  await expect(page.locator(".talksPanel")).toContainText("Coordination belongs away from the roomy board.");
  await expect(page.getByTestId("coordination-attention")).toContainText(blockedTitle);
  await expect(page.getByTestId("coordination-attention")).toContainText(reviewTitle);
  await expect(page.getByTestId("stale-work-card").filter({ hasText: staleTitle })).toBeVisible();
  await expect(drawer.getByLabel("Title")).toHaveValue(draftTitle);

  await tasksTab.click();
  await expect(tasksTab).toHaveAttribute("aria-selected", "true");
  await expect(taskCard(page, readyTitle)).toBeVisible();
  await expect(drawer.getByLabel("Title")).toHaveValue(draftTitle);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tasksTab).toBeVisible();
  await expect(coordinationTab).toBeVisible();
  const tabOverflow = await page.locator(".workspaceTabs").evaluate((tabs) => tabs.scrollWidth > tabs.clientWidth + 1);
  expect(tabOverflow).toBe(false);
});

test("surfaces stale in-progress work and requeues it from the board", async ({ page }) => {
  const projectName = uniqueName("E2E Stale Work Project");
  const projectKey = uniqueKey("STL");
  const staleTitle = uniqueName("Recover stale implementation");

  const projectResponse = await page.request.post(`${apiBaseURL}/api/projects`, {
    data: { name: projectName, key: projectKey }
  });
  expect(projectResponse.ok()).toBe(true);
  const { project } = await projectResponse.json();
  const taskResponse = await page.request.post(`${apiBaseURL}/api/tasks`, {
    data: {
      projectId: project.id,
      title: staleTitle,
      role: "implementer",
      priority: "high",
      status: "in_progress",
      assignee: "implementer-backend-99",
      description: "This task should be surfaced as stale because the assignee is not a configured slot."
    }
  });
  expect(taskResponse.ok()).toBe(true);
  const { task } = await taskResponse.json();

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  await page.getByRole("tab", { name: /Coordination/ }).click();

  const staleCard = page.getByTestId("stale-work-card").filter({ hasText: staleTitle });
  await expect(staleCard).toBeVisible();
  await expect(staleCard).toContainText("implementer-backend-99");
  await expect(staleCard).toContainText("Missing slot");
  await expect(staleCard).toContainText("Assignee has no configured slot");

  await staleCard.getByPlaceholder("Recovery note").fill("Requeueing stale work from browser coverage.");
  await staleCard.getByRole("button", { name: "Requeue" }).click();

  await expect(staleCard).toHaveCount(0);
  await page.getByRole("tab", { name: /Tasks/ }).click();
  await expect(page.locator(".kanbanColumn", { hasText: "Ready" }).locator(".taskCard", { hasText: staleTitle })).toBeVisible();

  const updatedTaskResponse = await page.request.get(`${apiBaseURL}/api/tasks/${task.id}`);
  expect(updatedTaskResponse.ok()).toBe(true);
  const updatedTask = (await updatedTaskResponse.json()).task;
  expect(updatedTask).toMatchObject({ status: "ready", assignee: "" });
  expect(updatedTask.comments[0]).toMatchObject({
    author: "operator-ui",
    body: "Requeueing stale work from browser coverage."
  });
});

test("refreshes an open board after external task changes without discarding drawer drafts", async ({ page }) => {
  const externalTitle = uniqueName("Externally created live task");
  const draftTitle = "Local unsaved live draft";

  await page.goto(baseURL);
  await expect(page.getByRole("heading", { name: "Demo Agent Project" })).toBeVisible();
  await expect(page.locator(".refreshStatus")).toContainText(/Live|Updated/, { timeout: 10_000 });

  const createResponse = await page.request.post(`${baseURL}/api/tasks`, {
    data: {
      projectId: "project_demo",
      title: externalTitle,
      status: "ready",
      role: "implementer",
      description: "Created by a second client while the board stayed open."
    }
  });
  expect(createResponse.ok()).toBe(true);
  const created = (await createResponse.json()).task;

  await expect(taskCard(page, externalTitle)).toBeVisible({ timeout: 10_000 });
  await taskCard(page, externalTitle).click();

  const drawer = page.locator(".drawer");
  await drawer.getByLabel("Title").fill(draftTitle);

  const patchResponse = await page.request.patch(`${baseURL}/api/tasks/${created.id}`, {
    data: {
      actor: "external-client",
      description: "Changed by a second client while the drawer draft is dirty."
    }
  });
  expect(patchResponse.ok()).toBe(true);

  await expect(drawer.locator(".liveUpdateNotice")).toContainText("changed elsewhere", { timeout: 10_000 });
  await expect(drawer.getByLabel("Title")).toHaveValue(draftTitle);
});

test("shows the Agents view and filters board tasks by agent", async ({ page }) => {
  const projectName = uniqueName("E2E Agents Project");
  const projectKey = uniqueKey("AGT");
  const currentTaskTitle = uniqueName("Build agents registry UI");
  const blockedTaskTitle = uniqueName("Unblock ad hoc agent");
  const testerTaskTitle = uniqueName("Verify agent registry");

  const projectResponse = await page.request.post(`${apiBaseURL}/api/projects`, {
    data: { name: projectName, key: projectKey }
  });
  expect(projectResponse.ok()).toBe(true);
  const { project } = await projectResponse.json();

  for (const task of [
    {
      title: currentTaskTitle,
      role: "implementer",
      status: "in_progress",
      assignee: "implementer-backend-1",
      priority: "high",
      labels: ["backend", "agents"]
    },
    {
      title: blockedTaskTitle,
      role: "implementer",
      status: "blocked",
      assignee: "implementer-adhoc-ui",
      priority: "high",
      labels: ["frontend", "ui"]
    },
    {
      title: testerTaskTitle,
      role: "tester",
      status: "ready",
      assignee: "test-agent",
      priority: "normal",
      labels: ["tests"]
    }
  ]) {
    const taskResponse = await page.request.post(`${apiBaseURL}/api/tasks`, {
      data: {
        projectId: project.id,
        ...task
      }
    });
    expect(taskResponse.ok()).toBe(true);
  }

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Implementer Agent" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Reviewer Agent" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Test Agent" })).toBeVisible();

  const backendCard = page.getByTestId("agent-card").filter({ hasText: "implementer-backend-1" });
  await expect(backendCard).toBeVisible();
  await expect(backendCard).toContainText("Busy");
  await expect(backendCard).toContainText(currentTaskTitle);
  await expect(backendCard).toContainText("backend");

  const adHocCard = page.getByTestId("agent-card").filter({ hasText: "implementer-adhoc-ui" });
  await expect(adHocCard).toBeVisible();
  await expect(adHocCard).toContainText("Task Assignee");
  await expect(adHocCard).toContainText("Blocked");
  await expect(adHocCard).toContainText(blockedTaskTitle);

  await backendCard.getByRole("button", { name: currentTaskTitle, exact: true }).click();
  await expect(page.locator(".drawer")).toContainText(currentTaskTitle);
  await closeDrawerIfOpen(page);

  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await backendCard.getByRole("button", { name: "Assigned tasks" }).click();
  await expect(taskCard(page, currentTaskTitle)).toBeVisible();
  await expect(taskCard(page, blockedTaskTitle)).toHaveCount(0);
  await expect(taskCard(page, testerTaskTitle)).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(backendCard).toBeVisible();
  const hasHorizontalOverflow = await page.locator(".agentsRegistry").evaluate((registry) => registry.scrollWidth > registry.clientWidth + 1);
  expect(hasHorizontalOverflow).toBe(false);
});

async function createTask(page, { title, role, priority, assignee, labels, description }) {
  await closeDrawerIfOpen(page);
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

async function expectCardContentInsideCard(page, title) {
  const result = await page.locator(".taskCard", { hasText: title }).evaluate((card) => {
    const cardRect = card.getBoundingClientRect();
    const checked = [card.querySelector("h4"), card.querySelector(".taskMeta"), card.querySelector(".taskActions")].filter(Boolean);
    const overflow = checked
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          className: element.className || element.tagName,
          top: rect.top < cardRect.top - 0.5,
          bottom: rect.bottom > cardRect.bottom + 0.5,
          left: rect.left < cardRect.left - 0.5,
          right: rect.right > cardRect.right + 0.5
        };
      })
      .filter((item) => item.top || item.bottom || item.left || item.right);

    return {
      cardHeight: cardRect.height,
      overflow,
      scrollOverflow: card.scrollHeight > card.clientHeight + 1
    };
  });

  expect(result.overflow).toEqual([]);
  expect(result.scrollOverflow).toBe(false);
  expect(result.cardHeight).toBeGreaterThan(150);
}

async function closeDrawerIfOpen(page) {
  const drawer = page.locator(".drawer");
  const closeButton = drawer.getByRole("button", { name: "Close" });
  const visible = await closeButton.isVisible({ timeout: 5000 }).catch(() => false);
  if (!visible) {
    return;
  }
  await closeButton.click();
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
