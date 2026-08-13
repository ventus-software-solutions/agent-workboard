import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_STATUSES,
  COMPLETION_TYPES,
  PRIORITIES,
  ROLES,
  STATUSES,
  TALK_KINDS,
  WORK_ITEM_TYPES
} from "../server/storage/workboardStore.js";

const GUIDE_PATH = new URL("../docs/operator-guide.md", import.meta.url);
const DOCS_CONFIG_PATH = new URL("../docs/.vitepress/config.js", import.meta.url);
const DOCS_INDEX_PATH = new URL("../docs/index.md", import.meta.url);

function markedSection(markdown, key) {
  const start = `<!-- guide-constants:${key}:start -->`;
  const end = `<!-- guide-constants:${key}:end -->`;
  const startIndex = markdown.indexOf(start);
  const endIndex = markdown.indexOf(end);

  expect(startIndex, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing ${end}`).toBeGreaterThan(startIndex);
  return markdown.slice(startIndex + start.length, endIndex);
}

function expectDocumented(markdown, key, values) {
  const section = markedSection(markdown, key);
  for (const value of values) {
    expect(section, `${value} is missing from ${key}`).toContain(`\`${value}\``);
  }
}

describe("operator guide", () => {
  it("cross-checks workflow constants against their operator-facing sections", async () => {
    const guide = await readFile(GUIDE_PATH, "utf8");

    expectDocumented(guide, "statuses", STATUSES.map((status) => status.id));
    expectDocumented(guide, "work-item-types", WORK_ITEM_TYPES.map((workItemType) => workItemType.id));
    expectDocumented(guide, "priorities", PRIORITIES);
    expectDocumented(guide, "roles", ROLES.map((role) => role.id));
    expectDocumented(guide, "completion-types", COMPLETION_TYPES);
    expectDocumented(guide, "talk-kinds", TALK_KINDS);
    expectDocumented(guide, "capability-statuses", CAPABILITY_STATUSES);
  });

  it("covers every requested surface and how-to recipe", async () => {
    const guide = await readFile(GUIDE_PATH, "utf8");
    const headings = [
      "## Projects",
      "## Board Workspaces",
      "## Tasks",
      "## Agents",
      "## Capabilities",
      "## Agent Talks",
      "## Operator Approvals",
      "## Worktree Cleanup",
      "## Integration Status",
      "## Activity",
      "### Put agents to work on a fresh project",
      "### Approve or deny a decision",
      "### Follow a task from backlog to done",
      "### Recover a stalled agent",
      "### Read the board in 30 seconds"
    ];

    for (const heading of headings) {
      expect(guide).toContain(heading);
    }
  });

  it("is linked from the published docs navigation and home page", async () => {
    const [config, index] = await Promise.all([
      readFile(DOCS_CONFIG_PATH, "utf8"),
      readFile(DOCS_INDEX_PATH, "utf8")
    ]);

    expect(config).toContain('"operator-guide.md"');
    expect(config).toContain('link: "/operator-guide"');
    expect(index).toContain("[Operator guide](./operator-guide.md)");
  });
});
