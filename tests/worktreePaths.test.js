import { describe, it, expect } from "vitest";
import { worktreeRoot, worktreePrefix, worktreeDirName, worktreePath } from "../server/worktreePaths.js";

describe("worktreeRoot", () => {
  it("defaults to the repository sibling directory", () => {
    expect(worktreeRoot({})).toBe("..");
  });

  it("honors WORKBOARD_WORKTREE_ROOT", () => {
    expect(worktreeRoot({ WORKBOARD_WORKTREE_ROOT: "/srv/worktrees" })).toBe("/srv/worktrees");
  });

  it("trims whitespace and trailing separators from the configured root", () => {
    expect(worktreeRoot({ WORKBOARD_WORKTREE_ROOT: "  /srv/worktrees/  " })).toBe("/srv/worktrees");
    expect(worktreeRoot({ WORKBOARD_WORKTREE_ROOT: "C:\\worktrees\\" })).toBe("C:\\worktrees");
  });

  it("falls back to the default for blank configuration", () => {
    expect(worktreeRoot({ WORKBOARD_WORKTREE_ROOT: "   " })).toBe("..");
  });

  it("keeps a bare root separator intact", () => {
    expect(worktreeRoot({ WORKBOARD_WORKTREE_ROOT: "/" })).toBe("/");
  });
});

describe("worktreeDirName", () => {
  it("composes the conventional worktree directory name", () => {
    expect(worktreeDirName("implementer-01", "claim-api")).toBe("wt-agent-workboard-implementer-01-claim-api");
  });

  it("passes placeholders through untouched", () => {
    expect(worktreeDirName("<agent-id>", "<slug>")).toBe("wt-agent-workboard-<agent-id>-<slug>");
  });

  it("uses WORKBOARD_WORKTREE_PREFIX when configured", () => {
    expect(
      worktreeDirName("implementer-01", "claim-api", { WORKBOARD_WORKTREE_PREFIX: "vergleichshai-worktree" })
    ).toBe("vergleichshai-worktree-implementer-01-claim-api");
  });
});

describe("worktreePrefix", () => {
  it("preserves the existing default and ignores blank configuration", () => {
    expect(worktreePrefix({})).toBe("wt-agent-workboard");
    expect(worktreePrefix({ WORKBOARD_WORKTREE_PREFIX: "   " })).toBe("wt-agent-workboard");
  });

  it("trims the configured prefix", () => {
    expect(worktreePrefix({ WORKBOARD_WORKTREE_PREFIX: "  vergleichshai-worktree  " })).toBe(
      "vergleichshai-worktree"
    );
  });
});

describe("worktreePath", () => {
  it("joins the root and directory name with a forward slash on every platform", () => {
    expect(worktreePath("implementer-01", "claim-api", {})).toBe("../wt-agent-workboard-implementer-01-claim-api");
  });

  it("uses the configured root", () => {
    expect(worktreePath("<agent-id>", "<slug>", { WORKBOARD_WORKTREE_ROOT: "/srv/worktrees" })).toBe(
      "/srv/worktrees/wt-agent-workboard-<agent-id>-<slug>"
    );
  });

  it("uses the configured root and prefix together", () => {
    expect(
      worktreePath("<agent-id>", "<slug>", {
        WORKBOARD_WORKTREE_ROOT: "/srv/worktrees",
        WORKBOARD_WORKTREE_PREFIX: "vergleichshai-worktree"
      })
    ).toBe("/srv/worktrees/vergleichshai-worktree-<agent-id>-<slug>");
  });

  it("never emits a hardcoded Windows drive path by default", () => {
    expect(worktreePath("reviewer-01", "audit", {})).not.toMatch(/^[A-Za-z]:/);
  });
});
