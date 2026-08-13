import { describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "../src/lib/clipboard.js";

function fallbackDocument(copyResult = true) {
  const textarea = {
    value: "",
    style: {},
    setAttribute: vi.fn(),
    select: vi.fn()
  };
  const body = {
    appendChild: vi.fn(),
    removeChild: vi.fn()
  };
  return {
    textarea,
    documentObject: {
      body,
      createElement: vi.fn(() => textarea),
      execCommand: vi.fn(() => copyResult)
    }
  };
}

describe("copyTextToClipboard", () => {
  it("uses the Clipboard API when the write succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const { documentObject } = fallbackDocument();

    await expect(copyTextToClipboard("prompt", { navigatorObject: { clipboard: { writeText } }, documentObject })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("prompt");
    expect(documentObject.createElement).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["rejected", { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } }]
  ])("falls back to a selected textarea when Clipboard API is %s", async (_label, navigatorObject) => {
    const { textarea, documentObject } = fallbackDocument(true);

    await expect(copyTextToClipboard("prompt", { navigatorObject, documentObject })).resolves.toBe(true);
    expect(textarea.value).toBe("prompt");
    expect(textarea.select).toHaveBeenCalledOnce();
    expect(documentObject.execCommand).toHaveBeenCalledWith("copy");
    expect(documentObject.body.removeChild).toHaveBeenCalledWith(textarea);
  });

  it("reports failure when neither copy path succeeds", async () => {
    const { documentObject } = fallbackDocument(false);

    await expect(copyTextToClipboard("prompt", { navigatorObject: {}, documentObject })).resolves.toBe(false);
  });
});
