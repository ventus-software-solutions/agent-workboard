import { describe, expect, it } from "vitest";
import { formatWorkboardRoute, parseWorkboardRoute } from "../src/lib/workboardRoute.js";

describe("workboard routes", () => {
  it("round-trips board state with task, agent, and filters", () => {
    const state = {
      view: "board",
      workspaceTab: "activity",
      projectId: "project dogfood",
      taskId: "task/42",
      filters: {
        q: "lease race",
        role: "implementer",
        assignee: "implementer-frontend-1",
        workItemType: "bug"
      }
    };

    expect(parseWorkboardRoute(formatWorkboardRoute(state))).toEqual(state);
  });

  it("uses compact routes for top-level views", () => {
    expect(formatWorkboardRoute({ view: "agents", projectId: "project_demo" })).toBe(
      "/agents?project=project_demo"
    );
    expect(parseWorkboardRoute("/capabilities")).toMatchObject({ view: "capabilities", workspaceTab: "tasks" });
  });

  it("normalizes unknown paths and tabs without throwing", () => {
    expect(parseWorkboardRoute("/unknown/not-a-tab?task=missing")).toEqual({
      view: "board",
      workspaceTab: "tasks",
      projectId: "",
      taskId: "missing",
      filters: { q: "", role: "", assignee: "", workItemType: "" }
    });
  });
});
