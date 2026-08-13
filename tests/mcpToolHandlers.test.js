import { describe, expect, it } from "vitest";
import { buildUpdateTaskStatusPatch } from "../server/mcpToolHandlers.js";

describe("MCP tool handlers", () => {
  it("omits completion from ordinary status updates", () => {
    const patch = buildUpdateTaskStatusPatch({
      taskId: "task_123",
      status: "in_progress",
      completion: undefined
    });

    expect(patch).toEqual({ status: "in_progress" });
    expect(Object.prototype.hasOwnProperty.call(patch, "completion")).toBe(false);
  });

  it("includes completion evidence when supplied", () => {
    const completion = {
      completionType: "merged",
      commitSha: "abc1234"
    };

    expect(
      buildUpdateTaskStatusPatch({
        taskId: "task_123",
        status: "done",
        completion
      })
    ).toEqual({ status: "done", completion });
  });

  it("includes task delivery links when supplied", () => {
    expect(
      buildUpdateTaskStatusPatch({
        taskId: "task_123",
        status: "review",
        pullRequestUrl: "https://github.com/acme/workboard/pull/42",
        branch: "implementer/task-links"
      })
    ).toEqual({
      status: "review",
      pullRequestUrl: "https://github.com/acme/workboard/pull/42",
      branch: "implementer/task-links"
    });
  });
});
