import { describe, expect, it } from "vitest";
import { statusActionLabel, taskWorkflowCue } from "../src/lib/statusActions.js";

const statuses = [
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "in_progress", label: "In Progress" },
  { id: "review", label: "Review" },
  { id: "testing", label: "Testing" },
  { id: "blocked", label: "Blocked" },
  { id: "done", label: "Done" }
];

describe("status action labels", () => {
  it.each([
    ["backlog", "Move to Backlog"],
    ["ready", "Move to Ready"],
    ["in_progress", "Start"],
    ["review", "Send to Review"],
    ["testing", "Move to Testing"],
    ["blocked", "Block"],
    ["done", "Complete"]
  ])("labels %s as an action", (statusId, expected) => {
    const status = statuses.find((candidate) => candidate.id === statusId);

    expect(statusActionLabel(status)).toBe(expected);
  });

  it("falls back to a move action for custom statuses", () => {
    expect(statusActionLabel({ id: "triage", label: "Triage" })).toBe("Move to Triage");
  });

  it("marks reviewer and audit work when it is outside the review lane", () => {
    expect(taskWorkflowCue({ role: "reviewer", status: "ready", labels: [] })).toBe("Reviewer work");
    expect(taskWorkflowCue({ role: "implementer", status: "ready", labels: ["audit"] })).toBe("Audit work");
    expect(taskWorkflowCue({ role: "reviewer", status: "review", labels: [] })).toBe("");
  });
});
