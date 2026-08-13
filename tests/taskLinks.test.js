import { describe, expect, it } from "vitest";
import { githubBranchUrl, isSafeHttpUrl, tokenizeHttpLinks } from "../shared/taskLinks.js";

describe("task link helpers", () => {
  it("tokenizes safe HTTP links while preserving surrounding text and punctuation", () => {
    const value = "Spec: https://example.com/a?x=1, then (https://example.org/docs).\nDone.";
    const tokens = tokenizeHttpLinks(value);

    expect(tokens.filter((token) => token.type === "link")).toEqual([
      { type: "link", text: "https://example.com/a?x=1", href: "https://example.com/a?x=1" },
      { type: "link", text: "https://example.org/docs", href: "https://example.org/docs" }
    ]);
    expect(tokens.map((token) => token.text).join("")).toBe(value);
  });

  it("leaves non-HTTP schemes and markup as inert text", () => {
    const value = '<img src=x onerror=alert(1)> javascript:alert(1) data:text/html,bad https://safe.example/<script>';
    const tokens = tokenizeHttpLinks(value);

    expect(tokens.filter((token) => token.type === "link")).toEqual([
      { type: "link", text: "https://safe.example/", href: "https://safe.example/" }
    ]);
    expect(tokens.map((token) => token.text).join("")).toBe(value);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html,bad")).toBe(false);
  });

  it("derives a GitHub branch URL from a pull request without trusting other hosts", () => {
    expect(githubBranchUrl("https://github.com/acme/workboard/pull/42", "feat/task links")).toBe(
      "https://github.com/acme/workboard/tree/feat/task%20links"
    );
    expect(githubBranchUrl("https://example.com/acme/workboard/pull/42", "feat/task-links")).toBe("");
    expect(githubBranchUrl("javascript:alert(1)", "feat/task-links")).toBe("");
  });
});
