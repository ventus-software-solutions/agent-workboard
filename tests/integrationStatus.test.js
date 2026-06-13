import { describe, expect, it } from "vitest";
import { buildIntegrationStatus } from "../server/integrationStatus.js";

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
});
