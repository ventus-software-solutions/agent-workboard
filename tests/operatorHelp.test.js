import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  OPERATOR_HELP_TOPICS,
  REQUIRED_OPERATOR_HELP_TOPICS,
  getOperatorHelpTopic,
  operatorGuideHref
} from "../src/lib/operatorHelp.js";

const GUIDE_PATH = new URL("../docs/operator-guide.md", import.meta.url);
const APP_PATH = new URL("../src/App.jsx", import.meta.url);

describe("operator help topics", () => {
  it("keeps complete three-sentence copy and a guide anchor for every required surface", () => {
    expect(REQUIRED_OPERATOR_HELP_TOPICS).toEqual([
      "projects",
      "tasks",
      "coordination",
      "activity",
      "agents",
      "capabilities",
      "settings",
      "attention",
      "cleanup",
      "integration"
    ]);

    for (const topicId of REQUIRED_OPERATOR_HELP_TOPICS) {
      const topic = getOperatorHelpTopic(topicId);
      expect(topic.label).toBeTruthy();
      expect(topic.concept).toMatch(/\.$/);
      expect(topic.board).toMatch(/\.$/);
      expect(topic.operator).toMatch(/\.$/);
      expect(topic.anchor).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it("builds guide links beneath root and configured base paths", () => {
    expect(operatorGuideHref("tasks")).toBe("/operator-guide#tasks");
    expect(operatorGuideHref("settings", "/agent-workboard/")).toBe("/agent-workboard/operator-guide#settings");
    expect(operatorGuideHref("activity", "nested/base")).toBe("/nested/base/operator-guide#activity");
    expect(() => operatorGuideHref("missing")).toThrow("Unknown operator help topic: missing");
  });

  it("links every topic to an anchor published by the operator guide", async () => {
    const guide = await readFile(GUIDE_PATH, "utf8");

    for (const topic of Object.values(OPERATOR_HELP_TOPICS)) {
      const matchingHeading = guide
        .split("\n")
        .filter((line) => /^#{2,3} /.test(line))
        .some((line) =>
          line
            .replace(/^#{2,3} /, "")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-") === topic.anchor
        );
      expect(matchingHeading, `missing operator guide anchor #${topic.anchor}`).toBe(true);
    }
  });

  it("renders every mapped topic from the main application", async () => {
    const app = await readFile(APP_PATH, "utf8");

    for (const topicId of REQUIRED_OPERATOR_HELP_TOPICS) {
      if (["tasks", "coordination", "activity", "agents", "capabilities", "settings"].includes(topicId)) continue;
      expect(app).toContain(`<HelpPopover topic="${topicId}"`);
    }
    expect(app).toContain("<HelpPopover topic={activeTab}");
    expect(app).toContain("<HelpPopover topic={viewHelpTopic}");
  });
});
