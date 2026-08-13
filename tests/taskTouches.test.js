import { describe, expect, it } from "vitest";
import {
  globPathsIntersect,
  normalizeTaskTouches,
  taskTouchesOverlap
} from "../shared/taskTouches.js";

describe("task touch hints", () => {
  it("normalizes separators, directories, comma text, and duplicates", () => {
    expect(normalizeTaskTouches("./src/App.jsx, server\\storage\\, src/App.jsx")).toEqual([
      "src/App.jsx",
      "server/storage/**"
    ]);
  });

  it("rejects traversal, unsupported characters, and excessive hints", () => {
    expect(() => normalizeTaskTouches(["../outside.js"])).toThrow("stay within the repository");
    expect(() => normalizeTaskTouches(["src/{App,main}.jsx"])).toThrow("unsupported characters");
    expect(() => normalizeTaskTouches(Array.from({ length: 25 }, (_, index) => `src/${index}.js`))).toThrow("at most 24");
  });

  it.each([
    ["src/App.jsx", "src/App.jsx", true],
    ["server/storage/**", "server/storage/workboardStore.js", true],
    ["server/**/workboard*.js", "server/storage/workboardStore.js", true],
    ["src/*.jsx", "src/App.jsx", true],
    ["src/A??.jsx", "src/App.jsx", true],
    ["src/a*.jsx", "src/b*.jsx", false],
    ["src/*.jsx", "src/lib/App.jsx", false],
    ["docs/**", "src/App.jsx", false],
    ["**", "src/App.jsx", true]
  ])("detects whether %s and %s can address the same path", (left, right, expected) => {
    expect(globPathsIntersect(left, right)).toBe(expected);
    expect(globPathsIntersect(right, left)).toBe(expected);
  });

  it("returns the matching hint pairs as evidence", () => {
    expect(taskTouchesOverlap(["src/**", "docs/**"], ["src/App.jsx", "tests/**"])).toEqual({
      overlaps: true,
      matches: [{ left: "src/**", right: "src/App.jsx" }]
    });
  });
});
