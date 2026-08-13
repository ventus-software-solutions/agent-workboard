import { expect, test } from "@playwright/test";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import { createApp } from "../../server/app.js";
import { createE2eStore } from "./workboard-test-store.js";

const projectRoot = path.resolve(".");

let apiServer;
let apiBaseURL;
let baseURL;
let dataDir;
let uploadFixturePath;
let viteServer;

test.beforeAll(async () => {
  const fixture = await createE2eStore("agent-workboard-e2e-");
  dataDir = fixture.dataDir;
  const { store } = fixture;

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

  const metaResponse = await page.request.get(`${apiBaseURL}/api/meta`);
  expect(metaResponse.ok()).toBe(true);
  const { server } = await metaResponse.json();
  const systemStatus = page.getByTestId("system-status-pill");
  await expect(systemStatus).toBeVisible();
  await expect(systemStatus).toContainText("Recent restart");
  await expect(systemStatus).toContainText(server.storageMode);
  await expect(systemStatus).toContainText(`v${server.version}`);
  await expect(systemStatus).toHaveAttribute("title", new RegExp(`Started ${server.startedAt}`));

  const readyColumn = page.locator('.kanbanColumn[data-status-id="ready"]');
  await expect(readyColumn.locator(".taskCard", { hasText: "Shape the first release plan" })).toBeVisible();

  const workflowCard = readyColumn.locator(".taskCard", { hasText: "Implement the first useful workflow" });
  await expect(workflowCard).toBeVisible();
  await expect(workflowCard).toContainText("high");
  await expect(workflowCard).toContainText("Unassigned");
});

test("refreshes runtime identity once after a mounted-page polling outage", async ({ page }) => {
  let pollingUnavailable = false;
  let restarted = false;
  let metaRequests = 0;
  const restartedAt = new Date(Date.now() - 30_000).toISOString();

  await page.route("**/api/meta", async (route) => {
    metaRequests += 1;
    const response = await route.fetch();
    const payload = await response.json();
    if (restarted) payload.server.startedAt = restartedAt;
    await route.fulfill({ response, json: payload });
  });
  await page.route("**/api/board-state**", async (route) => {
    if (pollingUnavailable) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "Synthetic poll failure" } })
      });
      return;
    }
    await route.continue();
  });

  await page.goto(baseURL);
  const systemStatus = page.getByTestId("system-status-pill");
  await expect(systemStatus).toContainText("Recent restart");
  await page.waitForTimeout(3_000);
  expect(metaRequests).toBe(1);

  pollingUnavailable = true;
  await expect(systemStatus).toContainText("Reconnecting…");
  await expect(systemStatus.locator("time")).toContainText("Retry at");
  await expect(systemStatus).not.toContainText("Recent restart");
  await expect(systemStatus).toHaveAttribute("title", /Synthetic poll failure/);

  restarted = true;
  pollingUnavailable = false;
  await expect(systemStatus).toContainText("Recent restart", { timeout: 10_000 });
  await expect(systemStatus).toHaveAttribute("title", new RegExp(`Started ${restartedAt}`));
  await expect.poll(() => metaRequests).toBe(2);
  await page.waitForTimeout(3_000);
  expect(metaRequests).toBe(2);
});

test("shows stage ownership and structured changes-requested verdicts on tasks", async ({ page }) => {
  const projectName = uniqueName("E2E Review Claim Project");
  const projectResponse = await page.request.post(`${apiBaseURL}/api/projects`, { data: { name: projectName } });
  expect(projectResponse.ok()).toBe(true);
  const { project } = await projectResponse.json();
  const taskResponse = await page.request.post(`${apiBaseURL}/api/tasks`, {
    data: {
      projectId: project.id,
      title: "Review claim visibility",
      status: "review",
      assignee: "implementer-agent"
    }
  });
  const { task } = await taskResponse.json();
  expect(
    (
      await page.request.post(`${apiBaseURL}/api/tasks/${task.id}/stage-claim`, {
        data: { agentId: "reviewer-agent", expectedStatus: "review", expectedClaimant: "" }
      })
    ).ok()
  ).toBe(true);

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  const card = taskCard(page, "Review claim visibility");
  await expect(card).toContainText("Review: reviewer-agent");
  await card.click();
  await expect(page.locator(".drawer")).toContainText("Review claimed by reviewer-agent");
  await closeDrawerIfOpen(page);

  expect(
    (
      await page.request.post(`${apiBaseURL}/api/tasks/${task.id}/stage-resolution`, {
        data: {
          agentId: "reviewer-agent",
          expectedStatus: "review",
          decision: "request_changes",
          findingsCount: 2,
          commitSha: "abc1234"
        }
      })
    ).ok()
  ).toBe(true);
  await expect(card).toContainText("Changes requested (2)", { timeout: 10_000 });

  expect(
    (
      await page.request.post(`${apiBaseURL}/api/tasks/${task.id}/comments`, {
        data: { author: "implementer-agent", body: "New fix commit.", evidence: { commitSha: "def5678" } }
      })
    ).ok()
  ).toBe(true);
  await expect(card.getByText("Changes requested (2)")).toHaveCount(0, { timeout: 10_000 });
});

test("edits deployment process rules from Settings and updates generated agent docs", async ({ page }) => {
  const rules = "- Deliver through a branch and PR.\n- Coordinator merges foundation-class changes.";

  await page.goto(baseURL);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.locator(".kanbanColumn")).toHaveCount(0);

  const editor = page.getByLabel("Process overrides (Markdown)");
  await editor.fill(rules);
  await page.getByRole("button", { name: "Save deployment rules" }).click();
  await expect(page.getByText("Deployment process rules saved.")).toBeVisible();

  const generatedDoc = await page.request.get(`${apiBaseURL}/api/agent-docs/reviewer?format=md`);
  expect(generatedDoc.ok()).toBe(true);
  expect(await generatedDoc.text()).toContain(`## Deployment process rules (OVERRIDE defaults)\n${rules}`);

  await editor.fill("");
  await page.getByRole("button", { name: "Save deployment rules" }).click();
  await expect(page.getByText("Deployment process rules saved.")).toBeVisible();
  const clearedDoc = await page.request.get(`${apiBaseURL}/api/agent-docs/reviewer?format=md`);
  expect(await clearedDoc.text()).not.toContain("Deployment process rules (OVERRIDE defaults)");
});

test("provides keyboard-accessible operator help for every main surface", async ({ page }) => {
  await page.goto(baseURL);

  const projectsTrigger = page.getByRole("button", { name: "About Projects" });
  await projectsTrigger.focus();
  await projectsTrigger.press("Enter");
  const projectsDialog = page.getByRole("dialog", { name: "Projects" });
  await expect(projectsDialog).toBeVisible();
  await expect(projectsDialog.getByRole("link", { name: "Learn more" })).toHaveAttribute("href", "/operator-guide#projects");
  await expect(projectsDialog.getByRole("button", { name: "Close Projects help" })).toBeFocused();
  const desktopViewport = page.viewportSize();
  const desktopBox = await projectsDialog.boundingBox();
  expect(desktopViewport).not.toBeNull();
  expect(desktopBox).not.toBeNull();
  expect(desktopBox.x).toBeGreaterThanOrEqual(0);
  expect(desktopBox.y).toBeGreaterThanOrEqual(0);
  expect(desktopBox.x + desktopBox.width).toBeLessThanOrEqual(desktopViewport.width);
  expect(desktopBox.y + desktopBox.height).toBeLessThanOrEqual(desktopViewport.height);
  await page.keyboard.press("Escape");
  await expect(projectsDialog).toHaveCount(0);
  await expect(projectsTrigger).toBeFocused();

  await expectHelpLink(page, "Board and tasks", "/operator-guide#tasks");
  await expectHelpLink(page, "Operator attention", "/operator-guide#read-the-board-in-30-seconds");
  await expectHelpLink(page, "Integration status", "/operator-guide#integration-status");

  await page.getByRole("tab", { name: /Coordination/ }).click();
  await expectHelpLink(page, "Coordination", "/operator-guide#agent-talks");
  await expectHelpLink(page, "Worktree cleanup", "/operator-guide#worktree-cleanup");

  await page.getByRole("tab", { name: /Activity/ }).click();
  await expectHelpLink(page, "Activity", "/operator-guide#activity");

  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expectHelpLink(page, "Agents", "/operator-guide#agents");
  await page.getByRole("button", { name: "Capabilities", exact: true }).click();
  await expectHelpLink(page, "Capabilities", "/operator-guide#capabilities");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expectHelpLink(page, "Settings", "/operator-guide#settings");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open sidebar" }).click();
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await page.getByRole("button", { name: "About Board and tasks" }).click();
  const compactDialog = page.getByRole("dialog", { name: "Board and tasks" });
  const box = await compactDialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
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

test("linkifies safe task URLs while keeping markup and unsafe schemes inert", async ({ page }) => {
  const projectName = uniqueName("E2E Safe Task Links Project");
  const projectKey = uniqueKey("LNK");
  const taskTitle = uniqueName("Expose delivery links safely");
  const descriptionUrl = "https://example.com/spec?case=links";
  const commentUrl = "https://example.org/review/42";
  const talkUrl = "https://example.net/coordination";
  const pullRequestUrl = "https://github.com/acme/workboard/pull/42";
  const branch = "implementer/task-links";
  const unsafeText = '<img src=x onerror=alert(1)> javascript:alert(1) data:text/html,bad';

  const project = (
    await postJson(page, "/api/projects", {
      name: projectName,
      key: projectKey,
      description: "Project for safe link rendering coverage."
    })
  ).project;
  const task = (
    await postJson(page, "/api/tasks", {
      projectId: project.id,
      title: taskTitle,
      description: `Read ${descriptionUrl}. ${unsafeText}`,
      status: "ready",
      role: "implementer",
      priority: "normal",
      pullRequestUrl,
      branch
    })
  ).task;
  await postJson(page, `/api/tasks/${task.id}/comments`, {
    author: "reviewer-agent",
    body: `Review ${commentUrl}. ${unsafeText}`
  });
  await postJson(page, `/api/projects/${project.id}/talks`, {
    authorAgentId: "implementer-agent",
    kind: "update",
    relatedTaskId: task.id,
    body: `Coordination ${talkUrl}. ${unsafeText}`
  });

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  const card = taskCard(page, taskTitle);
  await expect(card).toBeVisible();
  const descriptionLink = card.getByRole("link", { name: descriptionUrl });
  await expect(descriptionLink).toHaveAttribute("href", descriptionUrl);
  await expect(descriptionLink).toHaveAttribute("target", "_blank");
  await expect(descriptionLink).toHaveAttribute("rel", /noopener/);
  await expect(card.getByRole("link", { name: "PR", exact: true })).toHaveAttribute("href", pullRequestUrl);
  await expect(card.getByRole("link", { name: branch, exact: true })).toHaveAttribute(
    "href",
    "https://github.com/acme/workboard/tree/implementer/task-links"
  );
  await expect(card.locator("img")).toHaveCount(0);
  await expect(card.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(card.locator('a[href^="data:"]')).toHaveCount(0);

  await card.locator("h4").click();
  const drawer = page.locator(".drawer");
  await expect(drawer.locator(".drawerHeader").getByRole("link", { name: "Pull request" })).toHaveAttribute(
    "href",
    pullRequestUrl
  );
  await expect(drawer.getByLabel("Pull request URL")).toHaveValue(pullRequestUrl);
  await expect(drawer.getByLabel("Branch", { exact: true })).toHaveValue(branch);

  const comment = drawer.locator(".comment", { hasText: commentUrl });
  const commentLink = comment.getByRole("link", { name: commentUrl });
  await expect(commentLink).toHaveAttribute("target", "_blank");
  await expect(comment.locator("img")).toHaveCount(0);
  await expect(comment.locator('a[href^="javascript:"]')).toHaveCount(0);

  const updatedPullRequestUrl = "https://github.com/acme/workboard/pull/43";
  const updatedBranch = "implementer/task-links-v2";
  await drawer.getByLabel("Pull request URL").fill(updatedPullRequestUrl);
  await drawer.getByLabel("Branch", { exact: true }).fill(updatedBranch);
  await drawer.getByRole("button", { name: "Save", exact: true }).click();
  await expect(drawer.locator(".drawerHeader").getByRole("link", { name: "Pull request" })).toHaveAttribute(
    "href",
    updatedPullRequestUrl
  );
  await expect(drawer.locator(".drawerHeader").getByRole("link", { name: updatedBranch, exact: true })).toHaveAttribute(
    "href",
    "https://github.com/acme/workboard/tree/implementer/task-links-v2"
  );

  await closeDrawerIfOpen(page);
  await page.getByRole("tab", { name: /Coordination/ }).click();
  const talk = page.locator(".talkMessage", { hasText: talkUrl });
  const talkLink = talk.getByRole("link", { name: talkUrl });
  await expect(talkLink).toHaveAttribute("target", "_blank");
  await expect(talkLink).toHaveAttribute("rel", /noopener/);
  await expect(talk.locator("img")).toHaveCount(0);
  await expect(talk.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(talk.locator('a[href^="data:"]')).toHaveCount(0);
});

test("creates a folder-backed project only after a visible successful preflight confirmation", async ({ page }) => {
  test.skip(process.env.WORKBOARD_STORAGE === "tasksdir", "Global tasksdir mode is the single-tree compatibility fallback.");
  const projectName = uniqueName("E2E Folder Source Project");
  const projectKey = uniqueKey("SRC");
  const tasksDir = path.join(dataDir, `source-${projectKey.toLowerCase()}`);
  await cp(path.join(projectRoot, "tests", "fixtures", "tasksdir"), tasksDir, { recursive: true });

  await page.goto(baseURL);
  await page.getByRole("button", { name: "Project", exact: true }).click();
  const dialog = page.locator(".dialog");
  await dialog.getByLabel("Name").fill(projectName);
  await dialog.getByLabel("Key").fill(projectKey);
  await dialog.getByLabel(/Tasks folder path/).fill(tasksDir);
  await dialog.getByLabel(/Repository path/).fill(projectRoot);

  const createButton = dialog.getByRole("button", { name: "Create project" });
  await expect(createButton).toBeDisabled();
  await dialog.getByRole("button", { name: "Check tasks folder" }).click();
  const report = dialog.locator(".projectPreflight");
  await expect(report).toContainText("Preflight passed");
  await expect(report).toContainText("4 parsed, 0 failed across 4 task files");
  await expect(createButton).toBeDisabled();

  await dialog.getByLabel(/I reviewed this report/).check();
  await expect(createButton).toBeEnabled();
  await createButton.click();

  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  await expect(taskCard(page, "Rewrite the onboarding guide for the new tariff flow")).toBeVisible();
  await expect(page.locator(".integrationStatus")).toBeVisible();

  await page.getByRole("button", { name: /Demo Agent Project/ }).click();
  await expect(taskCard(page, "Implement the first useful workflow")).toBeVisible();
});

test("keeps project health counters stable while task filters change", async ({ page }) => {
  const projectName = uniqueName("E2E Stable Health Project");
  const projectKey = uniqueKey("HLT");
  const searchTitle = uniqueName("Find the visible implementation target");

  const project = (
    await postJson(page, "/api/projects", {
      name: projectName,
      key: projectKey,
      description: "Project health must describe the whole project, not the filtered task list."
    })
  ).project;

  const taskPayloads = [
    {
      title: searchTitle,
      status: "ready",
      role: "implementer",
      workItemType: "task",
      assignee: "filter-alice"
    },
    {
      title: uniqueName("Hidden blocked reviewer bug"),
      status: "blocked",
      role: "reviewer",
      workItemType: "bug",
      assignee: "filter-bob"
    },
    {
      title: uniqueName("Hidden review tester chore"),
      status: "review",
      role: "tester",
      workItemType: "chore",
      assignee: "filter-carol"
    },
    {
      title: uniqueName("Hidden operator approval spike"),
      status: "in_progress",
      role: "pm",
      workItemType: "spike",
      assignee: "filter-dana"
    }
  ];

  const createdTasks = [];
  for (const task of taskPayloads) {
    createdTasks.push(
      (
        await postJson(page, "/api/tasks", {
          projectId: project.id,
          priority: "normal",
          ...task
        })
      ).task
    );
  }

  await postJson(page, `/api/tasks/${createdTasks[3].id}/operator-approval`, {
    requestedBy: "filter-dana",
    reason: "Keep the approval hidden behind unrelated task filters.",
    requestedAction: "Approve the filtered health regression.",
    nextStatus: "review"
  });

  const tasksTab = page.getByRole("tab", { name: /^Tasks/ });
  const expectWholeProjectHealth = async () => {
    await expect(page.locator(".topStats .stat", { hasText: "Open" }).locator("strong")).toHaveText("4");
    await expect(page.locator(".topStats .stat", { hasText: "Blocked" }).locator("strong")).toHaveText("2");
    await expect(page.locator(".topStats .stat", { hasText: "Review" }).locator("strong")).toHaveText("1");
    await expect(page.locator(".topStats .stat", { hasText: "Approvals" }).locator("strong")).toHaveText("1");
  };
  const expectSingleFilteredTask = async () => {
    await expect(tasksTab).toContainText("1 of 4");
    await expectWholeProjectHealth();
  };

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  await expect(tasksTab).toContainText("4");
  await expectWholeProjectHealth();

  await page.getByPlaceholder("Search tasks").fill(searchTitle);
  await expectSingleFilteredTask();

  await page.getByPlaceholder("Search tasks").fill("");
  await page.getByPlaceholder("Agent").fill("filter-alice");
  await expectSingleFilteredTask();

  await page.getByPlaceholder("Agent").fill("");
  await page.getByRole("button", { name: "Reviewer Agent", exact: true }).click();
  await expectSingleFilteredTask();

  await page.getByRole("button", { name: "Reviewer Agent", exact: true }).click();
  await page.getByLabel("Work item type filter").selectOption("bug");
  await expectSingleFilteredTask();
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

test("shows, filters, creates, and edits work item types in the task UI", async ({ page }) => {
  const projectName = uniqueName("E2E Work Type Project");
  const projectKey = uniqueKey("TYP");
  const epicTitle = uniqueName("Plan typed roadmap epic");
  const taskTitle = uniqueName("Implement typed task");

  await page.goto(baseURL);
  await page.getByRole("button", { name: "Project", exact: true }).click();
  await page.locator(".dialog").getByLabel("Name").fill(projectName);
  await page.locator(".dialog").getByLabel("Key").fill(projectKey);
  await page.getByRole("button", { name: "Create project" }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await createTask(page, {
    title: epicTitle,
    role: "implementer",
    priority: "high",
    assignee: "",
    labels: "frontend, roadmap",
    description: "Container work should be visible but not claimable by implementers.",
    workItemType: "epic"
  });
  await createTask(page, {
    title: taskTitle,
    role: "implementer",
    priority: "normal",
    assignee: "",
    labels: "frontend",
    description: "Default task type should remain claimable."
  });

  await expect(taskCard(page, epicTitle)).toContainText("Epic");
  await expect(taskCard(page, taskTitle)).toContainText("Task");

  await page.getByLabel("Work item type filter").selectOption("epic");
  await expect(taskCard(page, epicTitle)).toBeVisible();
  await expect(taskCard(page, taskTitle)).toHaveCount(0);

  await page.getByLabel("Work item type filter").selectOption("");
  await taskCard(page, taskTitle).click();
  const drawer = page.locator(".drawer");
  await drawer.getByLabel("Work item type").selectOption("bug");
  await drawer.getByRole("button", { name: "Save" }).click();
  await expect(drawer.locator(".saveErrorPanel")).toHaveCount(0);
  await expect(taskCard(page, taskTitle)).toContainText("Bug");
});

test("edits parent-child and dependency relationships in the task drawer", async ({ page }) => {
  const projectName = uniqueName("E2E Relationships Project");
  const projectKey = uniqueKey("REL");
  const parentTitle = uniqueName("Parent relationship story");
  const prerequisiteTitle = uniqueName("Prerequisite relationship task");
  const childTitle = uniqueName("Child relationship task");

  const projectResponse = await page.request.post(`${apiBaseURL}/api/projects`, {
    data: { name: projectName, key: projectKey }
  });
  expect(projectResponse.ok()).toBe(true);
  const { project } = await projectResponse.json();

  async function createApiTask(title) {
    const response = await page.request.post(`${apiBaseURL}/api/tasks`, {
      data: {
        projectId: project.id,
        title,
        status: "ready",
        role: "implementer",
        priority: "normal",
        labels: ["backend"]
      }
    });
    expect(response.ok()).toBe(true);
    return (await response.json()).task;
  }

  const parent = await createApiTask(parentTitle);
  const prerequisite = await createApiTask(prerequisiteTitle);
  const child = await createApiTask(childTitle);

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await taskCard(page, parentTitle).click();
  let drawer = page.locator(".drawer");
  await drawer.getByLabel("Child tasks").selectOption(child.id);
  await drawer.getByRole("button", { name: "Save" }).click();
  await expect(drawer.locator(".saveErrorPanel")).toHaveCount(0);

  await expect
    .poll(async () => {
      const response = await page.request.get(`${apiBaseURL}/api/tasks/${child.id}`);
      expect(response.ok()).toBe(true);
      return (await response.json()).task.parentTaskId;
    })
    .toBe(parent.id);

  await closeDrawerIfOpen(page);
  await taskCard(page, childTitle).click();
  drawer = page.locator(".drawer");
  await drawer.getByLabel("Depends on").selectOption(prerequisite.id);
  await drawer.getByRole("button", { name: "Save" }).click();
  await expect(drawer.locator(".saveErrorPanel")).toHaveCount(0);

  await expect
    .poll(async () => {
      const response = await page.request.get(`${apiBaseURL}/api/tasks/${child.id}`);
      expect(response.ok()).toBe(true);
      const updated = (await response.json()).task;
      return {
        dependsOn: updated.dependsOn,
        state: updated.dependencyStatus.state
      };
    })
    .toEqual({
      dependsOn: [prerequisite.id],
      state: "waiting"
    });
  await expect(taskCard(page, childTitle)).toContainText("Waiting");

  const prerequisiteResponse = await page.request.patch(`${apiBaseURL}/api/tasks/${prerequisite.id}`, {
    data: { status: "review", actor: "operator-ui" }
  });
  expect(prerequisiteResponse.ok()).toBe(true);

  await expect
    .poll(async () => {
      const response = await page.request.get(`${apiBaseURL}/api/tasks/${child.id}`);
      expect(response.ok()).toBe(true);
      return (await response.json()).task.dependencyStatus.state;
    })
    .toBe("clear");
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
  const activityTab = page.getByRole("tab", { name: /Activity/ });
  await expect(tasksTab).toHaveAttribute("aria-selected", "true");
  await expect(coordinationTab).toContainText(/Coordination/);
  await expect(activityTab).toContainText(/Activity/);
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
  await expect(page.locator(".talksControlDeck")).toBeVisible();
  await expect(page.getByLabel("Talk kind filter")).toBeVisible();
  await expect(page.getByLabel("Talk message")).toBeVisible();
  await expect(page.getByTestId("coordination-attention")).toContainText(blockedTitle);
  await expect(page.getByTestId("coordination-attention")).toContainText(reviewTitle);
  await expect(page.getByTestId("stale-work-card").filter({ hasText: staleTitle })).toBeVisible();
  await expect(drawer.getByLabel("Title")).toHaveValue(draftTitle);

  const coordinationLinks = [
    ["Talks", "#coordination-talks"],
    ["Claim Warnings", "#coordination-stale-work"],
    ["Cleanup", "#coordination-cleanup"],
    ["Blocked", "#coordination-blocked"],
    ["Review", "#coordination-review"]
  ];
  for (const [label, target] of coordinationLinks) {
    await expect(page.getByRole("link", { name: new RegExp(`^${label}:`) })).toHaveAttribute("href", target);
  }
  await page.getByRole("link", { name: /^Claim Warnings:/ }).click();
  await expect(page).toHaveURL(/#coordination-stale-work$/);
  await expect(page.locator("#coordination-stale-work")).toBeInViewport();

  const talkListBox = await page.locator(".talkList").boundingBox();
  const talkComposerBox = await page.locator(".talkComposerPanel").boundingBox();
  expect(talkListBox?.height ?? 0).toBeGreaterThan(320);
  expect(talkListBox?.height ?? 0).toBeGreaterThan((talkComposerBox?.height ?? 0) * 1.5);

  await page.getByLabel("Talk kind filter").selectOption("update");
  await page.getByLabel("Talk agent filter").fill("implementer-2");
  await expect(page.locator(".talksPanel")).toContainText("Coordination belongs away from the roomy board.");
  await page.getByLabel("Talk agent filter").fill("missing-agent");
  await expect(page.locator(".talkEmpty")).toBeVisible();
  await page.getByRole("button", { name: /Clear/ }).click();
  await expect(page.locator(".talksPanel")).toContainText("Coordination belongs away from the roomy board.");

  await page.getByLabel("Talk author").fill("operator-ui");
  await page.getByLabel("Talk kind", { exact: true }).selectOption("question");
  await page.getByLabel("Related talk task").selectOption({ label: readyTitle });
  await page.getByLabel("Talk mentions").fill("implementer-2");
  await page.getByLabel("Talk message").fill("Can the feed stay readable after posting?");
  await page.getByRole("button", { name: /Post/ }).click();
  await expect(page.locator(".talksPanel")).toContainText("Can the feed stay readable after posting?");
  await expect(page.locator(".talksPanel")).toContainText("@implementer-2");

  await tasksTab.click();
  await expect(tasksTab).toHaveAttribute("aria-selected", "true");
  await expect(taskCard(page, readyTitle)).toBeVisible();
  await expect(drawer.getByLabel("Title")).toHaveValue(draftTitle);

  await closeDrawerIfOpen(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tasksTab).toBeVisible();
  await expect(coordinationTab).toBeVisible();
  await expect(activityTab).toBeVisible();
  const tabOverflow = await page.locator(".workspaceTabs").evaluate((tabs) => tabs.scrollWidth > tabs.clientWidth + 1);
  expect(tabOverflow).toBe(false);

  await coordinationTab.click();
  await expect(page.locator(".talksControlDeck")).toBeVisible();
  const talksOverflow = await page.locator(".talksPanel").evaluate((panel) => panel.scrollWidth > panel.clientWidth + 1);
  expect(talksOverflow).toBe(false);
});

test("paginates Agent Talks newest first and loads the remaining boundary", async ({ page }) => {
  const projectName = uniqueName("E2E Paginated Talks Project");
  const projectKey = uniqueKey("PGT");
  const projectResponse = await page.request.post(`${apiBaseURL}/api/projects`, {
    data: { name: projectName, key: projectKey }
  });
  expect(projectResponse.ok()).toBe(true);
  const { project } = await projectResponse.json();

  for (let index = 0; index < 26; index += 1) {
    const talkResponse = await page.request.post(`${apiBaseURL}/api/projects/${project.id}/talks`, {
      data: {
        authorAgentId: "pagination-agent",
        kind: "update",
        body: `Pagination message ${String(index).padStart(2, "0")}`
      }
    });
    expect(talkResponse.ok()).toBe(true);
  }

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await page.getByRole("tab", { name: /Coordination/ }).click();

  await expect(page.locator(".talkMessage")).toHaveCount(25);
  await expect(page.locator(".talksHeaderMeta")).toContainText("25 of 26 shown");
  await expect(page.locator(".talksPanel")).toContainText("Pagination message 25");
  await expect(page.locator(".talksPanel")).not.toContainText("Pagination message 00");

  await page.getByRole("button", { name: "Load 1 more" }).click();
  await expect(page.locator(".talkMessage")).toHaveCount(26);
  await expect(page.locator(".talksHeaderMeta")).toContainText("26 of 26 shown");
  await expect(page.locator(".talksPanel")).toContainText("Pagination message 00");

  await page.getByLabel("Talk kind filter").selectOption("update");
  await expect(page.locator(".talkMessage")).toHaveCount(25);
  await expect(page.locator(".talksHeaderMeta")).toContainText("25 of 26 shown");
  await expect(page.getByRole("button", { name: "Load 1 more" })).toBeVisible();
});

test("shows project activity audit events without opening every task", async ({ page }) => {
  const projectName = uniqueName("E2E Activity Audit Project");
  const projectKey = uniqueKey("AUD");
  const taskTitle = uniqueName("Trace project activity feed");

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
      assignee: "",
      role: "implementer",
      priority: "high",
      actor: "pm-agent"
    }
  });
  expect(taskResponse.ok()).toBe(true);
  const { task } = await taskResponse.json();

  const claimResponse = await page.request.post(`${apiBaseURL}/api/tasks/${task.id}/claim`, {
    data: {
      assignee: "implementer-backend-1",
      expectedStatus: "ready",
      expectedAssignee: "",
      actor: "implementer-backend-1"
    }
  });
  expect(claimResponse.ok()).toBe(true);

  const staleResponse = await page.request.patch(`${apiBaseURL}/api/tasks/${task.id}`, {
    data: {
      title: "Outdated browser activity title",
      expectedRevision: task.revision,
      actor: "operator-stale"
    }
  });
  expect(staleResponse.status()).toBe(409);

  const commentResponse = await page.request.post(`${apiBaseURL}/api/tasks/${task.id}/comments`, {
    data: { author: "reviewer-agent", body: "Browser audit comment evidence." }
  });
  expect(commentResponse.ok()).toBe(true);

  const approvalResponse = await page.request.post(`${apiBaseURL}/api/tasks/${task.id}/operator-approval`, {
    data: {
      requestedBy: "implementer-backend-1",
      reason: "Need approval before browser audit release.",
      requestedAction: "Approve browser audit release",
      nextStatus: "in_progress"
    }
  });
  expect(approvalResponse.ok()).toBe(true);

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  const activityTab = page.getByRole("tab", { name: /Activity/ });
  await activityTab.click();
  await expect(activityTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".activityWorkspace")).toBeVisible();
  await expect(page.locator(".activityWorkspace")).toContainText(taskTitle);
  await expect(page.locator(".activityWorkspace")).toContainText("Created project");
  await expect(page.locator(".activityWorkspace")).toContainText("Task created");
  await expect(page.locator(".activityWorkspace")).toContainText("Claimed task");
  await expect(page.locator(".activityWorkspace")).toContainText("Rejected stale full task update");
  await expect(page.locator(".activityWorkspace")).toContainText("Added a comment");
  await expect(page.locator(".activityWorkspace")).toContainText("Requested operator approval");

  await page.getByLabel("Activity type filter").selectOption("update.rejected");
  await expect(page.locator(".activityWorkspace")).toContainText("Rejected stale full task update");
  await expect(page.locator(".activityWorkspace")).not.toContainText("Task created");

  await page.getByLabel("Activity type filter").selectOption("");
  await page.getByLabel("Search activity").fill("browser audit comment");
  await expect(page.locator(".activityWorkspace")).toContainText("Added a comment");
  await expect(page.locator(".activityWorkspace")).not.toContainText("Claimed task");

  await page.locator(".activityEvent", { hasText: "Added a comment" }).getByRole("button", { name: new RegExp(taskTitle) }).click();
  await expect(page.getByRole("tab", { name: /Tasks/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".drawer")).toContainText(taskTitle);
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

  const stalledCard = taskCard(page, staleTitle);
  await expect(stalledCard.getByRole("button", { name: `STALLED: return ${staleTitle} to Ready` })).toBeVisible();
  await expect(page.locator(".roleChip.warning", { hasText: "Implementer Agent" })).toContainText("1");

  const inboxCard = page.locator(".operatorAttentionItem.attentionKind-stalled").filter({ hasText: staleTitle });
  await expect(inboxCard).toBeVisible();
  await expect(inboxCard).toContainText("What happened:");
  await expect(inboxCard).toContainText("Why it matters:");
  await expect(inboxCard).toContainText("Do this:");
  await expect(inboxCard).toContainText("has no recoverable owner");
  await expect(inboxCard).toContainText("then spawn an implementer");
  await expect(inboxCard).not.toContainText("missing_slot");
  await expect(inboxCard.locator(".operatorPromptPreview")).toContainText("agent-docs/implementer");

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

test("flags a fresh agent bound to different work as off-script and returns the claim to Ready", async ({ page }) => {
  const projectName = uniqueName("E2E Off Script Project");
  const projectKey = uniqueKey("OFF");
  const claimedTitle = uniqueName("Claimed UI reliability work");
  const reportedTitle = uniqueName("Reported unrelated work");

  const projectResponse = await page.request.post(`${apiBaseURL}/api/projects`, {
    data: { name: projectName, key: projectKey }
  });
  expect(projectResponse.ok()).toBe(true);
  const { project } = await projectResponse.json();
  const claimedResponse = await page.request.post(`${apiBaseURL}/api/tasks`, {
    data: {
      projectId: project.id,
      title: claimedTitle,
      role: "implementer",
      priority: "high",
      status: "in_progress",
      assignee: "implementer-frontend-1"
    }
  });
  const reportedResponse = await page.request.post(`${apiBaseURL}/api/tasks`, {
    data: {
      projectId: project.id,
      title: reportedTitle,
      role: "implementer",
      status: "ready"
    }
  });
  const claimedTask = (await claimedResponse.json()).task;
  const reportedTask = (await reportedResponse.json()).task;
  const presenceResponse = await page.request.post(`${apiBaseURL}/api/agents/implementer-frontend-1/presence`, {
    data: {
      state: "active",
      taskId: reportedTask.id,
      activeProjectId: project.id,
      message: "Reporting the other task from browser coverage."
    }
  });
  expect(presenceResponse.ok()).toBe(true);
  expect((await presenceResponse.json()).presence).toMatchObject({ currentTaskId: reportedTask.id });

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  const inboxCard = page.locator(".operatorAttentionItem.attentionKind-off_script").filter({ hasText: claimedTitle });
  await expect(inboxCard).toContainText("live task binding disagree");
  await expect(inboxCard).toContainText(reportedTask.id);

  const claimedCard = taskCard(page, claimedTitle);
  const recovery = claimedCard.getByRole("button", { name: `OFF-SCRIPT: return ${claimedTitle} to Ready` });
  await expect(recovery).toBeVisible();
  await expect(page.locator(".roleChip.warning", { hasText: "Implementer Agent" })).toContainText("1");
  await recovery.click();

  await expect(page.locator('.kanbanColumn[data-status-id="ready"]')).toContainText(claimedTitle);
  await expect(recovery).toHaveCount(0);
  const updatedTask = (await (await page.request.get(`${apiBaseURL}/api/tasks/${claimedTask.id}`)).json()).task;
  expect(updatedTask).toMatchObject({ status: "ready", assignee: "" });
  expect(updatedTask.comments[0].body).toContain("Recovered off-script in-progress work");
  expect(updatedTask.activity[0]).toMatchObject({ type: "stale_recovery.requeue", actor: "operator-ui" });
  expect(
    (
      await page.request.post(`${apiBaseURL}/api/agents/implementer-frontend-1/presence`, {
        data: { state: "idle", taskId: "", message: "Browser coverage complete." }
      })
    ).ok()
  ).toBe(true);
});

test("refreshes an open board after external task changes without discarding drawer drafts", async ({ page }) => {
  const externalTitle = uniqueName("Externally created live task");
  const draftTitle = "Local unsaved live draft";

  await page.goto(baseURL);
  await expect(page.getByRole("heading", { name: "Demo Agent Project" })).toBeVisible();
  await expect(page.locator(".refreshStatus")).toContainText(/Live|Updated|Recent restart/, { timeout: 10_000 });

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
      expectedRevision: created.revision,
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
  await expect(page.locator(".topStats")).toContainText("Active");
  await expect(page.locator(".topStats")).toContainText("Available");
  await expect(page.locator(".topStats")).not.toContainText("Configured slots");
  await expect(page.locator(".agentsRegistry").getByRole("heading", { name: "Implementer Agent" })).toBeVisible();
  await expect(page.locator(".agentsRegistry").getByRole("heading", { name: "Reviewer Agent" })).toBeVisible();
  await expect(page.locator(".agentsRegistry").getByRole("heading", { name: "Test Agent" })).toBeVisible();
  const implementerRole = page.locator(".roleSummary", { hasText: "Implementer Agent" });
  await expect(implementerRole).toContainText(/\d+ active \/ \d+ seats \(\d+ available\)/);
  await implementerRole.getByRole("button", { name: "Fill a seat" }).click();
  await expect(implementerRole.locator(".fillPrompt")).toContainText(
    "You are implementer. Read"
  );
  await expect(implementerRole.getByRole("button", { name: "Copy prompt" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Implementer Frontend" })).toHaveCount(0);
  await page.getByText("Advanced: agent types and capacity", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Implementer Frontend" })).toBeVisible();

  await expect(page.getByTestId("bootstrap-card-implementer")).not.toBeVisible();
  await page.getByText("Advanced: onboarding guide", { exact: true }).click();
  await expect(page.getByTestId("bootstrap-card-implementer")).toBeVisible();

  const frontendType = page.locator(".agentTypeCard", { hasText: "Implementer Frontend" });
  await expect(frontendType).toContainText("desired");
  await expect(frontendType).toContainText("occupied");
  await expect(frontendType).toContainText("available");
  await expect(frontendType).toContainText("needs cleanup");
  await expect(frontendType).toContainText("implementer-frontend-1");
  await frontendType.getByRole("button", { name: "Increase implementer-frontend capacity" }).click();
  await expect(frontendType.getByLabel("implementer-frontend desired slots")).toHaveValue("4");
  let slotsResponse = await page.request.get(`${apiBaseURL}/api/agent-slots`);
  expect(slotsResponse.ok()).toBe(true);
  let slots = await slotsResponse.json();
  expect(slots.types.find((type) => type.id === "implementer-frontend")).toMatchObject({
    capacity: 4,
    configured: 4
  });
  expect(slots.slots.find((slot) => slot.id === "implementer-frontend-4")).toBeTruthy();

  const backendCard = page.getByTestId("agent-card").filter({ hasText: "implementer-backend-1" });
  await expect(backendCard).toBeVisible();
  await expect(backendCard).toContainText("Stalled");
  await expect(backendCard).toContainText(currentTaskTitle);
  await expect(backendCard).toContainText("No presence message");
  await expect(backendCard).toContainText("No heartbeat");
  await expect(backendCard.getByLabel("implementer-backend-1 work mode")).toBeHidden();
  await backendCard.getByText("Details and controls", { exact: true }).click();
  await expect(backendCard).toContainText("backend");
  const backendMode = backendCard.getByLabel("implementer-backend-1 work mode");
  await expect(backendMode).toHaveValue("single-task");
  await backendMode.selectOption("watch-mode");
  await expect(backendMode).toHaveValue("watch-mode");
  slotsResponse = await page.request.get(`${apiBaseURL}/api/agent-slots`);
  expect(slotsResponse.ok()).toBe(true);
  slots = await slotsResponse.json();
  expect(slots.slots.find((slot) => slot.id === "implementer-backend-1")).toMatchObject({
    workMode: "watch-mode",
    paused: false
  });

  await backendCard.getByRole("button", { name: "Pause implementer-backend-1" }).click();
  await expect(backendCard).toContainText("Paused");
  await expect(backendCard.getByRole("button", { name: "Resume implementer-backend-1" })).toBeVisible();
  slotsResponse = await page.request.get(`${apiBaseURL}/api/agent-slots`);
  expect(slotsResponse.ok()).toBe(true);
  slots = await slotsResponse.json();
  expect(slots.slots.find((slot) => slot.id === "implementer-backend-1")).toMatchObject({
    workMode: "watch-mode",
    paused: true
  });

  await backendCard.getByRole("button", { name: "Resume implementer-backend-1" }).click();
  await expect(backendCard).toContainText("Stalled");
  await backendMode.selectOption("single-task");
  await expect(backendMode).toHaveValue("single-task");

  const adHocCard = page.getByTestId("agent-card").filter({ hasText: "implementer-adhoc-ui" });
  await expect(adHocCard).toBeVisible();
  await expect(adHocCard).toContainText("Task Assignee");
  await expect(adHocCard).toContainText("historical assignee");
  await expect(adHocCard).toContainText("Blocked");
  await expect(adHocCard).toContainText(blockedTaskTitle);

  await backendCard.getByRole("button", { name: currentTaskTitle, exact: true }).click();
  await expect(page.locator(".drawer")).toContainText(currentTaskTitle);
  await closeDrawerIfOpen(page);

  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await backendCard.getByText("Details and controls", { exact: true }).click();
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

test("reports Fill a seat clipboard fallbacks truthfully", async ({ page }) => {
  await page.addInitScript(() => {
    window.__clipboardMode = "reject";
    window.__copyFallbackResult = true;
    window.__fallbackCopies = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      get() {
        if (window.__clipboardMode === "missing") return undefined;
        return {
          writeText: async () => {
            throw new Error("Clipboard permission denied");
          }
        };
      }
    });
    Document.prototype.execCommand = function execCommand(command) {
      if (command !== "copy" || !window.__copyFallbackResult) return false;
      const textareas = document.querySelectorAll("textarea");
      window.__fallbackCopies.push(textareas[textareas.length - 1]?.value || "");
      return true;
    };
  });

  await page.goto(baseURL);
  await page.getByRole("button", { name: "Agents", exact: true }).click();

  const implementerRole = page.locator(".roleSummary", { hasText: "Implementer Agent" });
  await implementerRole.getByRole("button", { name: "Fill a seat" }).click();
  await implementerRole.getByRole("button", { name: "Copy prompt" }).click();
  await expect(implementerRole.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__fallbackCopies.at(-1)))
    .toContain("You are implementer. Read");

  await page.evaluate(() => {
    window.__clipboardMode = "missing";
  });
  const reviewerRole = page.locator(".roleSummary", { hasText: "Reviewer Agent" });
  await reviewerRole.getByRole("button", { name: "Fill a seat" }).click();
  await reviewerRole.getByRole("button", { name: "Copy prompt" }).click();
  await expect(reviewerRole.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__fallbackCopies.at(-1)))
    .toContain("You are reviewer. Read");

  await page.evaluate(() => {
    window.__copyFallbackResult = false;
  });
  const testerRole = page.locator(".roleSummary", { hasText: "Test Agent" });
  await testerRole.getByRole("button", { name: "Fill a seat" }).click();
  await testerRole.getByRole("button", { name: "Copy prompt" }).click();
  await expect(testerRole.getByRole("button", { name: "Copy failed" })).toBeVisible();
  await expect(testerRole.getByRole("button", { name: "Copied" })).toHaveCount(0);
});

test("Busy reveals a task-only current worker outside collapsed history", async ({ page }) => {
  const projectName = uniqueName("E2E Task-only Busy Agent Project");
  const projectKey = uniqueKey("TBA");
  const taskTitle = uniqueName("Keep task-only worker reachable");

  const project = (
    await postJson(page, "/api/projects", {
      name: projectName,
      key: projectKey
    })
  ).project;
  await postJson(page, "/api/tasks", {
    projectId: project.id,
    title: taskTitle,
    role: "implementer",
    status: "in_progress",
    assignee: "ghost-busy-agent",
    priority: "high"
  });

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await page.getByRole("button", { name: "Agents", exact: true }).click();

  const implementerRole = page.locator(".roleSummary", { hasText: "Implementer Agent" });
  const ghostCard = page.getByTestId("agent-card").filter({ hasText: "ghost-busy-agent" });
  await expect(implementerRole.locator(".roleSeatsDisclosure")).not.toHaveAttribute("open", "");
  await expect(ghostCard).toBeVisible();
  await expect(ghostCard).toContainText("Stalled");
  await expect(ghostCard).toContainText(taskTitle);

  await page.getByRole("button", { name: /Busy.*show workers/i }).click();
  await expect(ghostCard).toBeInViewport();
});

test("lets the operator resolve a pending approval from the board", async ({ page }) => {
  const projectName = uniqueName("E2E Approval Project");
  const projectKey = uniqueKey("APR");
  const taskTitle = uniqueName("Approve implementation handoff");

  const project = (
    await postJson(page, "/api/projects", {
      name: projectName,
      key: projectKey,
      description: "Project with a seeded operator approval."
    })
  ).project;
  const task = (
    await postJson(page, "/api/tasks", {
      projectId: project.id,
      title: taskTitle,
      description: "Seeded through API so the browser test can focus on approval UI.",
      status: "in_progress",
      role: "implementer",
      priority: "high",
      assignee: "implementer-e2e",
      labels: ["approval", "e2e"]
    })
  ).task;
  await postJson(page, `/api/tasks/${task.id}/comments`, {
    author: "implementer-e2e",
    body: "Diff summary and browser evidence are ready."
  });
  await postJson(page, `/api/tasks/${task.id}/operator-approval`, {
    requestedBy: "implementer-e2e",
    reason: "Ready to hand this work to review.",
    requestedAction: "Approve review handoff.",
    nextStatus: "review"
  });

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await expect(page.locator(".approvalQueueItem", { hasText: taskTitle })).toBeVisible();
  await expect(page.locator(".topStats")).toContainText("Approvals");

  await page.locator(".approvalQueueItem", { hasText: taskTitle }).click();
  const panel = page.locator(".approvalPanel");
  await expect(panel).toContainText("Approve review handoff.");
  await expect(panel).toContainText("Diff summary and browser evidence are ready.");

  await panel.getByLabel("Decision note").fill("Approved in browser e2e.");
  await panel.getByRole("button", { name: "Approve" }).click();

  await expect(page.locator(".approvalQueueItem", { hasText: taskTitle })).toHaveCount(0);
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".kanbanColumn", { hasText: "Review" }).locator(".taskCard", { hasText: taskTitle })).toBeVisible();
});

test("flags capability status drift and opens its completed linked task", async ({ page }) => {
  const projectName = uniqueName("E2E Capability Drift Project");
  const projectKey = uniqueKey("CDR");
  const taskTitle = uniqueName("Ship capability behavior");
  const capabilityName = uniqueName("Capability awaiting status update");

  const projectResponse = await page.request.post(`${apiBaseURL}/api/projects`, {
    data: { name: projectName, key: projectKey }
  });
  expect(projectResponse.ok()).toBe(true);
  const { project } = await projectResponse.json();

  const taskResponse = await page.request.post(`${apiBaseURL}/api/tasks`, {
    data: {
      projectId: project.id,
      title: taskTitle,
      status: "review",
      role: "implementer",
      assignee: "implementer-agent"
    }
  });
  expect(taskResponse.ok()).toBe(true);
  const { task } = await taskResponse.json();

  const capabilityResponse = await page.request.post(`${apiBaseURL}/api/capabilities`, {
    data: {
      id: `cap_e2e_drift_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
      projectId: project.id,
      name: capabilityName,
      status: "planned",
      ownerRole: "implementer",
      relatedTaskIds: [task.id]
    }
  });
  expect(capabilityResponse.ok()).toBe(true);
  const { capability } = await capabilityResponse.json();

  const completionResponse = await page.request.patch(`${apiBaseURL}/api/tasks/${task.id}`, {
    data: {
      status: "done",
      actor: "reviewer-agent",
      completion: {
        completionType: "merged",
        commitSha: "e2e1234",
        capabilityIds: [capability.id]
      }
    }
  });
  expect(completionResponse.ok()).toBe(true);

  await page.goto(baseURL);
  await page.getByRole("button", { name: new RegExp(projectName) }).click();
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  await page.getByRole("button", { name: "Capabilities", exact: true }).click();

  const card = page.locator(".capabilityCard", { hasText: capabilityName });
  await expect(card).toBeVisible();
  await expect(card.getByLabel("Capability status drift")).toContainText("Status may be stale");
  await expect(card.getByLabel("Capability status drift")).toContainText("still planned");
  await expect(card.locator(".capabilityTaskStatus")).toHaveText("done");
  await expect(card.locator(".capabilityTaskIdentity small")).toHaveText(task.id);

  const linkedTaskButton = card.getByRole("button", { name: `Open linked task ${taskTitle}` });
  await linkedTaskButton.focus();
  await linkedTaskButton.press("Enter");
  await expect(page.locator(".drawer")).toContainText(taskTitle);
});

async function createTask(page, { title, role, priority, assignee, labels, description, workItemType = "" }) {
  await closeDrawerIfOpen(page);
  await page.getByRole("button", { name: "Task", exact: true }).click();
  const dialog = page.locator(".dialog");
  await dialog.getByLabel("Title").fill(title);
  if (workItemType) {
    await dialog.getByLabel("Work item type").selectOption(workItemType);
  }
  await dialog.getByLabel("Role").selectOption(role);
  await dialog.getByLabel("Priority").selectOption(priority);
  await dialog.getByLabel("Assignee").fill(assignee);
  await dialog.getByLabel("Labels").fill(labels);
  await dialog.getByLabel("Description").fill(description);
  await page.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toHaveCount(0);
  await closeDrawerIfOpen(page);
}

async function expectHelpLink(page, label, href) {
  const trigger = page.getByRole("button", { name: `About ${label}` });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: label });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Learn more" })).toHaveAttribute("href", href);
  await dialog.getByRole("button", { name: `Close ${label} help` }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

async function postJson(page, pathname, body) {
  const response = await page.request.post(`${baseURL}${pathname}`, {
    data: body
  });
  expect(response.ok()).toBe(true);
  return response.json();
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
