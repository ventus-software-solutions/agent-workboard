import { describe, expect, it } from "vitest";
import { describeTaskSaveError } from "../src/lib/taskSaveErrors.js";

describe("task save error descriptions", () => {
  it("describes stale/conflict failures as recoverable draft-preserving errors", () => {
    expect(
      describeTaskSaveError({
        status: 409,
        message: "Task was changed before this save."
      })
    ).toMatchObject({
      tone: "conflict",
      title: "Task changed before this save",
      detail: "Task was changed before this save.",
      canRetry: true,
      canReload: true
    });
  });

  it("describes validation failures without suggesting the draft was discarded", () => {
    expect(
      describeTaskSaveError({
        status: 400,
        message: "A completion record is required before moving a task to done."
      })
    ).toMatchObject({
      tone: "validation",
      title: "Task save needs changes",
      canRetry: true,
      canReload: false
    });
  });

  it("describes unexpected failures with retry and reload recovery", () => {
    expect(describeTaskSaveError(new Error("Network unavailable"))).toMatchObject({
      tone: "error",
      title: "Task save failed",
      detail: "Network unavailable",
      canRetry: true,
      canReload: true
    });
  });
});
