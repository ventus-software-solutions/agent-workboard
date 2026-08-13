import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkboardStore } from "../server/storage/workboardStore.js";

let tempDir;

async function openStore(options = {}) {
  const store = new WorkboardStore({ dataDir: tempDir, storageMode: "json", ...options });
  await store.init();
  return store;
}

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-default-project-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("default active project", () => {
  it("falls back to the seeded demo project when no default key is configured", async () => {
    const store = await openStore();
    await store.createProject({ name: "Zebra", key: "ZEBRA" });

    const context = store.getAgentProjectContext("implementer-1");

    expect(context.activeProjectId).toBe("project_demo");
    expect(context.projectContextSource).toBe("default");
    expect(context.projectContextDefaulted).toBe(true);
  });

  it("prefers the configured default project key", async () => {
    const store = await openStore({ defaultProjectKey: "TEAM" });
    const team = await store.createProject({ name: "Team Board", key: "TEAM" });

    const context = store.getAgentProjectContext("implementer-1");

    expect(context.activeProjectId).toBe(team.id);
    expect(context.projectContextSource).toBe("configured-default");
    expect(context.projectContextDefaulted).toBe(true);
  });

  it("normalizes the configured key the same way project keys are normalized", async () => {
    const store = await openStore({ defaultProjectKey: " team board " });
    const team = await store.createProject({ name: "Team Board" });

    expect(team.key).toBe("TEAM-BOARD");
    expect(store.getAgentProjectContext("implementer-1").activeProjectId).toBe(team.id);
  });

  it("falls back to the ordinary default when the configured key matches no project", async () => {
    const store = await openStore({ defaultProjectKey: "MISSING" });
    await store.createProject({ name: "Zebra", key: "ZEBRA" });

    const context = store.getAgentProjectContext("implementer-1");

    expect(context.activeProjectId).toBe("project_demo");
    expect(context.projectContextSource).toBe("default");
  });

  it("ignores an archived project that matches the configured key", async () => {
    const store = await openStore({ defaultProjectKey: "TEAM" });
    const team = await store.createProject({ name: "Team Board", key: "TEAM" });
    store.data.projects.find((project) => project.id === team.id).archived = true;

    const context = store.getAgentProjectContext("implementer-1");

    expect(context.activeProjectId).toBe("project_demo");
    expect(context.projectContextSource).toBe("default");
  });

  it("reads the default key from WORKBOARD_DEFAULT_PROJECT_KEY when not passed explicitly", async () => {
    const previous = process.env.WORKBOARD_DEFAULT_PROJECT_KEY;
    process.env.WORKBOARD_DEFAULT_PROJECT_KEY = "TEAM";
    try {
      const store = await openStore();
      const team = await store.createProject({ name: "Team Board", key: "TEAM" });

      const context = store.getAgentProjectContext("implementer-1");

      expect(context.activeProjectId).toBe(team.id);
      expect(context.projectContextSource).toBe("configured-default");
    } finally {
      if (previous === undefined) delete process.env.WORKBOARD_DEFAULT_PROJECT_KEY;
      else process.env.WORKBOARD_DEFAULT_PROJECT_KEY = previous;
    }
  });
});
