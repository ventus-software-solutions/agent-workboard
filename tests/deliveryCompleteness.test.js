import { describe, expect, it } from "vitest";
import { deliveryRequirements, taskDeliveryShortfall } from "../shared/deliveryCompleteness.js";

const settings = {
  processOverrides: "Deliver implementation through a pushed branch and pull request before review."
};

function task(patch = {}) {
  return { id: "task_delivery", status: "review", branch: "implementer/feature", pullRequestUrl: "", ...patch };
}

describe("delivery completeness", () => {
  it("derives the configured delivery shape from deployment process rules", () => {
    expect(deliveryRequirements(settings)).toEqual({
      enabled: true,
      requireBranch: true,
      requirePush: true,
      requirePullRequest: true
    });
    expect(deliveryRequirements({})).toMatchObject({ enabled: false });
  });

  it("reports exact shortfalls and ignores work outside review", () => {
    expect(taskDeliveryShortfall(task({ status: "in_progress" }), { deploymentSettings: settings })).toBeNull();
    expect(taskDeliveryShortfall(task({ branch: "" }), { deploymentSettings: settings })).toMatchObject({
      codes: ["missing_branch", "missing_pull_request"],
      detail: "Delivery branch is missing. Pull request URL is missing."
    });
    expect(taskDeliveryShortfall(task(), {
      deploymentSettings: settings,
      integrationStatus: {
        deliveryBranches: [{ branch: "implementer/feature", state: "unpushed", ahead: 2 }]
      }
    })).toMatchObject({
      codes: ["unpushed_branch", "missing_pull_request"],
      detail: expect.stringContaining("2 unpushed commits")
    });
  });

  it("accepts a pushed branch and pull request as complete", () => {
    expect(taskDeliveryShortfall(task({ pullRequestUrl: "https://github.test/acme/work/pull/1" }), {
      deploymentSettings: settings,
      integrationStatus: {
        deliveryBranches: [{ branch: "implementer/feature", state: "pushed", ahead: 0 }]
      }
    })).toBeNull();
    expect(taskDeliveryShortfall(task({ pullRequestUrl: "https://github.test/acme/work/pull/1" }), {
      deploymentSettings: settings,
      integrationStatus: {
        deliveryBranches: [{ branch: "implementer/feature", state: "missing", ahead: 0 }]
      }
    })).toBeNull();
  });
});
