import { Fragment } from "react";
import { tokenizeHttpLinks } from "../../shared/taskLinks.js";

const INLINE_PATTERN = /(\[[^\]]+\]\([^\s)]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;

export function SafeMarkdown({ children, compact = false, className = "" }) {
  const source = String(children || "").replace(/\r\n?/g, "\n").trim();
  const blocks = markdownBlocks(source || "No description yet.");
  return (
    <div className={["safeMarkdown", compact ? "compact" : "", className].filter(Boolean).join(" ")}>
      {blocks.map((block, index) => renderBlock(block, index))}
    </div>
  );
}

export function safeMarkdownHref(value) {
  try {
    const url = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function markdownBlocks(source) {
  const blocks = [];
  let paragraph = [];
  let list = null;

  function flushParagraph() {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
    paragraph = [];
  }

  function flushList() {
    if (!list) return;
    blocks.push(list);
    list = null;
  }

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }

    const listItem = /^(?:[-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line);
    if (listItem) {
      flushParagraph();
      const ordered = /^\d/.test(line);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { type: "list", ordered, items: [] };
      }
      list.items.push(listItem[1]);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function renderBlock(block, key) {
  if (block.type === "heading") {
    const Heading = `h${block.level + 2}`;
    return <Heading key={key}>{inlineMarkdown(block.text)}</Heading>;
  }
  if (block.type === "list") {
    const List = block.ordered ? "ol" : "ul";
    return (
      <List key={key}>
        {block.items.map((item, index) => <li key={index}>{inlineMarkdown(item)}</li>)}
      </List>
    );
  }
  return <p key={key}>{inlineMarkdown(block.text)}</p>;
}

function inlineMarkdown(source) {
  return String(source).split(INLINE_PATTERN).filter(Boolean).map((token, index) => {
    const link = /^\[([^\]]+)\]\(([^\s)]+)\)$/.exec(token);
    if (link) {
      const href = safeMarkdownHref(link[2]);
      return href
        ? <a key={index} href={href} target="_blank" rel="noreferrer noopener">{link[1]}</a>
        : <Fragment key={index}>{link[1]}</Fragment>;
    }
    if (token.startsWith("**") && token.endsWith("**")) return <strong key={index}>{token.slice(2, -2)}</strong>;
    if (token.startsWith("`") && token.endsWith("`")) return <code key={index}>{token.slice(1, -1)}</code>;
    if (token.startsWith("*") && token.endsWith("*")) return <em key={index}>{token.slice(1, -1)}</em>;
    return tokenizeHttpLinks(token).map((plainToken, plainIndex) =>
      plainToken.type === "link" ? (
        <a
          key={`${index}-${plainIndex}`}
          href={plainToken.href}
          target="_blank"
          rel="noreferrer noopener"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {plainToken.text}
        </a>
      ) : (
        <Fragment key={`${index}-${plainIndex}`}>{plainToken.text}</Fragment>
      )
    );
  });
}
