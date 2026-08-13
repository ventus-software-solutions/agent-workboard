// Frontmatter task.md parser/serializer for the tasksdir storage mode.
// Zero-dependency by design: the supported subset is `key: value` lines, one
// optional nested `board:` block, and indented `- item` block lists. Round-trip
// fidelity is the contract — untouched lines (unknown keys, comments, spacing,
// newline style) and the markdown body are preserved byte-for-byte.

const DELIMITER = "---";
const PAIR_RE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):(.*)$/;
const CHILD_PAIR_RE = /^(\s+)([A-Za-z0-9_][A-Za-z0-9_.-]*):(.*)$/;
const LIST_ITEM_RE = /^\s+-\s+(.*)$/;
const BARE_SCALAR_RE = /^[A-Za-z0-9_][A-Za-z0-9_.:/@-]*$/;

export function validateTaskFileStructure(raw) {
  const lines = String(raw ?? "").split(/\r?\n/);
  if (lines[0]?.trim() !== DELIMITER) {
    return [{ line: 1, reason: "missing opening frontmatter delimiter (---)" }];
  }

  const closeIndex = lines.findIndex((line, index) => index > 0 && line.trim() === DELIMITER);
  if (closeIndex === -1) {
    return [{ line: Math.max(1, lines.length), reason: "missing closing frontmatter delimiter (---)" }];
  }

  const failures = [];
  let hasParent = false;
  for (let index = 1; index < closeIndex; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      hasParent = false;
      continue;
    }
    if (trimmed.startsWith("#")) {
      if (!/^\s/.test(line)) hasParent = false;
      continue;
    }
    if (!/^\s/.test(line) && PAIR_RE.test(line)) {
      hasParent = true;
      continue;
    }
    if (/^\s/.test(line) && hasParent && (CHILD_PAIR_RE.test(line) || LIST_ITEM_RE.test(line))) {
      continue;
    }
    failures.push({
      line: index + 1,
      reason: !/^\s/.test(line)
        ? "expected a frontmatter key followed by a colon"
        : hasParent
          ? "expected an indented child key followed by a colon, list item (- value), or comment"
          : "orphaned indented frontmatter content"
    });
    hasParent = false;
  }
  return failures;
}

export function detectNewline(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

function splitLinesKeepEnds(text) {
  if (!text) return [];
  return text.split(/(?<=\n)/);
}

function stripLineEnd(line) {
  return line.replace(/\r?\n$/, "");
}

export function parseScalar(rawValue) {
  const trimmed = String(rawValue ?? "").trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.replace(/^"|"$/g, "");
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (trimmed.startsWith("[")) {
    return parseFlowList(trimmed);
  }
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function parseFlowList(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to the quote-aware flow parser for unquoted items
  }
  const inner = text.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!inner) return [];
  return splitFlowItems(inner)
    .map((item) => parseScalar(item))
    .filter((item) => item !== null)
    .map(String);
}

// Splits flow-list items on commas outside quotes, so mixed lists like
// [docs, "with, comma"] keep quoted items intact.
function splitFlowItems(inner) {
  const items = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const char of inner) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (quote) {
      current += char;
      if (quote === '"' && char === "\\") escaped = true;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ",") {
      items.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) items.push(current);
  return items;
}

export function renderScalar(value) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) || typeof value === "object") return JSON.stringify(value);
  const text = String(value);
  return BARE_SCALAR_RE.test(text) ? text : JSON.stringify(text);
}

export function renderList(value) {
  const items = Array.isArray(value) ? value.filter((item) => item !== null && item !== undefined && item !== "") : [];
  if (items.length === 0) return "";
  return `[${items.map((item) => renderScalar(String(item))).join(", ")}]`;
}

// Parses raw file text into { entries, body, newline }.
// Each entry keeps its original lines (with terminators) so serialization of an
// untouched document reproduces the input exactly.
export function parseTaskFile(raw) {
  const text = String(raw ?? "");
  const newline = detectNewline(text);
  const doc = { entries: [], body: text, newline, hadFrontmatter: false };

  const lines = splitLinesKeepEnds(text);
  if (lines.length === 0 || stripLineEnd(lines[0]).trim() !== DELIMITER) {
    return doc;
  }

  let closeIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (stripLineEnd(lines[i]).trim() === DELIMITER) {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex === -1) {
    return doc;
  }

  doc.hadFrontmatter = true;
  doc.openLine = lines[0];
  doc.closeLine = lines[closeIndex];
  doc.body = lines.slice(closeIndex + 1).join("");

  let current = null;
  for (let i = 1; i < closeIndex; i += 1) {
    const line = lines[i];
    const bare = stripLineEnd(line);
    const pair = PAIR_RE.exec(bare);
    if (pair) {
      current = {
        key: pair[1],
        value: parseScalar(pair[2]),
        lines: [line],
        children: [],
        listItems: []
      };
      doc.entries.push(current);
      continue;
    }
    const childPair = current ? CHILD_PAIR_RE.exec(bare) : null;
    const listItem = current ? LIST_ITEM_RE.exec(bare) : null;
    if (childPair && !LIST_ITEM_RE.test(bare)) {
      current.children.push({ key: childPair[2], value: parseScalar(childPair[3]), line });
      current.lines.push(line);
      continue;
    }
    if (listItem) {
      current.listItems.push(String(parseScalar(listItem[1]) ?? ""));
      current.lines.push(line);
      continue;
    }
    if (current && bare.trim() !== "" && /^\s/.test(bare)) {
      // indented continuation we do not model; keep it attached for round-trip
      current.lines.push(line);
      continue;
    }
    current = null;
    doc.entries.push({ key: null, value: null, lines: [line], children: [], listItems: [] });
  }

  return doc;
}

export function serializeTaskFile(doc) {
  if (!doc.hadFrontmatter && doc.entries.length === 0) {
    return doc.body;
  }
  const nl = doc.newline;
  const open = doc.openLine ?? `${DELIMITER}${nl}`;
  const close = doc.closeLine ?? `${DELIMITER}${nl}`;
  const middle = doc.entries.map((entry) => entry.lines.join("")).join("");
  return `${open}${middle}${close}${doc.body}`;
}

export function getEntry(doc, key) {
  return doc.entries.find((entry) => entry.key === key) || null;
}

export function getValue(doc, key) {
  const entry = getEntry(doc, key);
  if (!entry) return undefined;
  if (entry.value === null && entry.listItems.length > 0) return [...entry.listItems];
  return entry.value;
}

export function getBoardValue(doc, key) {
  const board = getEntry(doc, "board");
  if (!board) return undefined;
  const child = board.children.find((candidate) => candidate.key === key);
  return child ? child.value : undefined;
}

export function setValue(doc, key, renderedValue) {
  ensureFrontmatter(doc);
  const nl = doc.newline;
  const line = renderedValue === "" ? `${key}:${nl}` : `${key}: ${renderedValue}${nl}`;
  const entry = getEntry(doc, key);
  if (entry) {
    entry.lines = [line];
    entry.value = parseScalar(renderedValue);
    entry.listItems = [];
    entry.children = [];
    return;
  }
  const created = { key, value: parseScalar(renderedValue), lines: [line], children: [], listItems: [] };
  const boardIndex = doc.entries.findIndex((candidate) => candidate.key === "board");
  if (boardIndex === -1) {
    doc.entries.push(created);
  } else {
    doc.entries.splice(boardIndex, 0, created);
  }
}

export function setBoardValue(doc, key, renderedValue) {
  ensureFrontmatter(doc);
  const nl = doc.newline;
  let board = getEntry(doc, "board");
  if (!board) {
    board = { key: "board", value: null, lines: [`board:${nl}`], children: [], listItems: [] };
    doc.entries.push(board);
  }
  if (renderedValue === "") {
    board.children = board.children.filter((child) => child.key !== key);
  } else {
    const line = `  ${key}: ${renderedValue}${nl}`;
    const child = board.children.find((candidate) => candidate.key === key);
    if (child) {
      child.value = parseScalar(renderedValue);
      child.line = line;
    } else {
      board.children.push({ key, value: parseScalar(renderedValue), line });
    }
  }
  board.lines = [`board:${nl}`, ...board.children.map((child) => child.line)];
}

function ensureFrontmatter(doc) {
  if (doc.hadFrontmatter) return;
  doc.hadFrontmatter = true;
  doc.openLine = `${DELIMITER}${doc.newline}`;
  doc.closeLine = `${DELIMITER}${doc.newline}`;
}
