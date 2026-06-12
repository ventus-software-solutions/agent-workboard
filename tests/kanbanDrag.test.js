import { describe, expect, it } from "vitest";
import { getTaskDropMove } from "../src/lib/kanbanDrag.js";

const tasks = [
  { id: "task-1", status: "ready", title: "Ready task" },
  { id: "task-2", status: "review", title: "Review task" }
];

describe("kanban drag helpers", () => {
  it("returns the task and destination status for a real move", () => {
    expect(getTaskDropMove(tasks, "task-1", "review")).toEqual({
      task: tasks[0],
      statusId: "review"
    });
  });

  it("ignores drops back into the task's current status", () => {
    expect(getTaskDropMove(tasks, "task-1", "ready")).toBeNull();
  });

  it("ignores unknown task ids and missing destinations", () => {
    expect(getTaskDropMove(tasks, "missing", "review")).toBeNull();
    expect(getTaskDropMove(tasks, "task-1", "")).toBeNull();
  });
});
