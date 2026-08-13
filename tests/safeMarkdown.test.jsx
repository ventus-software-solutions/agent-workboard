import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SafeMarkdown, safeMarkdownHref } from "../src/components/SafeMarkdown.jsx";

describe("SafeMarkdown", () => {
  it("renders common task markdown without exposing raw markup", () => {
    const html = renderToStaticMarkup(
      <SafeMarkdown>{"## Gap\nUse **bold**, *care*, and `code`.\n\n- first\n- second"}</SafeMarkdown>
    );
    expect(html).toContain("<h4>Gap</h4>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>care</em>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<ul><li>first</li><li>second</li></ul>");
  });

  it("escapes HTML and refuses unsafe markdown links", () => {
    const html = renderToStaticMarkup(
      <SafeMarkdown>{'<img src=x onerror=alert(1)> [click](javascript:alert(1)) [safe](https://example.com/a)'}</SafeMarkdown>
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain('href="https://example.com/a"');
    expect(safeMarkdownHref("data:text/html,bad")).toBe("");
  });

  it("linkifies bare http URLs without consuming trailing punctuation", () => {
    const html = renderToStaticMarkup(
      <SafeMarkdown>{"Read https://example.com/spec?case=links. Then continue."}</SafeMarkdown>
    );
    expect(html).toContain('href="https://example.com/spec?case=links"');
    expect(html).toContain('>https://example.com/spec?case=links</a>. Then continue.');
  });
});
