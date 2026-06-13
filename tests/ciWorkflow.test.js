import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = path.resolve(import.meta.dirname, "..");
const workflowPath = path.join(rootDir, ".github", "workflows", "ci.yml");
const readmePath = path.join(rootDir, "README.md");

describe("GitHub Actions CI workflow", () => {
  it("runs install, tests, and build on pull requests and main without secrets", async () => {
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("name: CI");
    expect(workflow).toMatch(/pull_request:\s*(?:\r?\n|$)/);
    expect(workflow).toMatch(/push:\s*\r?\n\s+branches:\s*\r?\n\s+- main/);
    expect(workflow).toContain("actions/checkout@");
    expect(workflow).toContain("actions/setup-node@");
    expect(workflow).toContain("node-version: 20");
    expect(workflow).toContain("npm install");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("npm run build");
    expect(workflow).not.toMatch(/\$\{\{\s*secrets\./i);
  });

  it("documents the CI workflow for contributors", async () => {
    const readme = await readFile(readmePath, "utf8");

    expect(readme).toContain("GitHub Actions CI");
    expect(readme).toContain("npm test");
    expect(readme).toContain("npm run build");
    expect(readme).toContain("does not require repository secrets");
  });
});
