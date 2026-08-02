import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { buildIntegrationStatus } from "../server/integrationStatus.js";
import { WorkboardStore } from "../server/storage/workboardStore.js";

let cleanupPaths = [];

afterEach(async () => {
  const paths = cleanupPaths;
  cleanupPaths = [];
  await Promise.all(paths.map((target) => rm(target, { recursive: true, force: true })));
});

function fakeGit(outputs) {
  return (args) => {
    const key = args.join(" ");
    if (key in outputs) {
      const output = outputs[key];
      if (output instanceof Error) throw output;
      return output;
    }
    throw new Error(`Unexpected git command: ${key}`);
  };
}

describe("integration status guidance", () => {
  it("uses local main as the dogfood base when it is clean and ahead of origin", () => {
    const status = buildIntegrationStatus({
      runGit: fakeGit({
        "branch --show-current": "main",
        "rev-parse main": "localsha",
        "rev-parse origin/main": "originsha",
        "rev-list --left-right --count origin/main...main": "0\t2",
        "status --short": ""
      })
    });

    expect(status).toMatchObject({
      sourceOfTruth: "local-main",
      baseRef: "main",
      pushDebt: true,
      ahead: 2,
      behind: 0,
      clean: true
    });
    expect(status.summary).toMatch(/local main is 2 commits ahead/i);
    expect(status.recoveryActions.join("\n")).toMatch(/git push origin main/i);
  });

  it("uses origin main when local and origin match", () => {
    const status = buildIntegrationStatus({
      runGit: fakeGit({
        "branch --show-current": "main",
        "rev-parse main": "samesha",
        "rev-parse origin/main": "samesha",
        "rev-list --left-right --count origin/main...main": "0\t0",
        "status --short": ""
      })
    });

    expect(status).toMatchObject({
      sourceOfTruth: "origin-main",
      baseRef: "origin/main",
      pushDebt: false,
      ahead: 0,
      behind: 0
    });
    expect(status.worktreeCommand).toContain("origin/main");
    expect(status.worktreeCommand).toContain("../wt-agent-workboard-<agent-id>-<slug>");
    expect(status.worktreeCommand).not.toMatch(/\b[A-Za-z]:\//);
  });

  it("pauses branch guidance when local and origin have diverged", () => {
    const status = buildIntegrationStatus({
      runGit: fakeGit({
        "branch --show-current": "main",
        "rev-parse main": "localsha",
        "rev-parse origin/main": "originsha",
        "rev-list --left-right --count origin/main...main": "3\t2",
        "status --short": ""
      })
    });

    expect(status).toMatchObject({
      sourceOfTruth: "reconcile-first",
      baseRef: null,
      pushDebt: true,
      ahead: 2,
      behind: 3
    });
    expect(status.summary).toMatch(/diverged/i);
    expect(status.worktreeCommand).toMatch(/reconcile/i);
  });

  it("treats CRLF-only Docker mount status noise as clean for local-main-ahead guidance", () => {
    const status = buildIntegrationStatus({
      runGit: fakeGit({
        "branch --show-current": "main",
        "rev-parse main": "localsha",
        "rev-parse origin/main": "originsha",
        "rev-list --left-right --count origin/main...main": "0\t2",
        "status --short": " M docs/architecture.md",
        "-c core.autocrlf=true status --short": ""
      })
    });

    expect(status).toMatchObject({
      sourceOfTruth: "local-main",
      baseRef: "main",
      pushDebt: true,
      ahead: 2,
      behind: 0,
      clean: true
    });
  });

  it("uses WORKBOARD_REPO_DIR so deployed app endpoints can read host Git state", async () => {
    const repoDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-repo-"));
    const remoteDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-origin-"));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-data-"));
    cleanupPaths.push(repoDir, remoteDir, dataDir);

    git(["init", "--bare"], remoteDir);
    git(["init", "-b", "main"], repoDir);
    git(["config", "user.email", "agent-workboard@example.test"], repoDir);
    git(["config", "user.name", "Agent Workboard"], repoDir);
    await writeFile(path.join(repoDir, "README.md"), "# integration status\n");
    git(["add", "README.md"], repoDir);
    git(["commit", "-m", "initial"], repoDir);
    git(["remote", "add", "origin", remoteDir], repoDir);
    git(["push", "-u", "origin", "main"], repoDir);
    const commit = git(["rev-parse", "main"], repoDir).slice(0, 12);

    const previousRepoDir = process.env.WORKBOARD_REPO_DIR;
    process.env.WORKBOARD_REPO_DIR = repoDir;
    try {
      const store = new WorkboardStore({ dataDir });
      await store.init();
      const app = createApp({ store });

      const response = await request(app).get("/api/integration-status").expect(200);

      expect(response.body.integrationStatus).toMatchObject({
        sourceOfTruth: "origin-main",
        baseRef: "origin/main",
        localHead: commit,
        originHead: commit,
        pushDebt: false
      });
    } finally {
      if (previousRepoDir === undefined) {
        delete process.env.WORKBOARD_REPO_DIR;
      } else {
        process.env.WORKBOARD_REPO_DIR = previousRepoDir;
      }
    }
  });

  it("keeps the Docker deployment contract aligned with integration-status Git access", async () => {
    const dockerfile = await readFile(path.resolve("Dockerfile"), "utf8");
    const compose = await readFile(path.resolve("docker-compose.yml"), "utf8");

    expect(dockerfile).toContain("apk add --no-cache git");
    expect(dockerfile).toContain("WORKBOARD_REPO_DIR=/workspace");
    expect(dockerfile).toContain("safe.directory /workspace");
    expect(compose).toContain("WORKBOARD_REPO_DIR: /workspace");
    expect(compose).toContain("./:/workspace:ro");
  });
});

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}
