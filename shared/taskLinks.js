const HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,!?;:]+$/;

export function isSafeHttpUrl(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function tokenizeHttpLinks(value) {
  const text = String(value || "");
  const tokens = [];
  let cursor = 0;

  for (const match of text.matchAll(HTTP_URL_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) tokens.push({ type: "text", text: text.slice(cursor, start) });

    const { urlText, trailing } = splitTrailingUrlPunctuation(match[0]);
    if (isSafeHttpUrl(urlText)) {
      tokens.push({ type: "link", text: urlText, href: urlText });
      if (trailing) tokens.push({ type: "text", text: trailing });
    } else {
      tokens.push({ type: "text", text: match[0] });
    }
    cursor = start + match[0].length;
  }

  if (cursor < text.length) tokens.push({ type: "text", text: text.slice(cursor) });
  return tokens.length > 0 ? tokens : [{ type: "text", text }];
}

export function githubBranchUrl(pullRequestUrl, branch) {
  const branchName = String(branch || "").trim();
  if (!branchName || !isSafeHttpUrl(pullRequestUrl)) return "";

  const url = new URL(String(pullRequestUrl).trim());
  if (url.hostname.toLowerCase() !== "github.com") return "";
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 4 || segments[2] !== "pull") return "";

  const encodedBranch = branchName
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${url.origin}/${segments[0]}/${segments[1]}/tree/${encodedBranch}`;
}

function splitTrailingUrlPunctuation(value) {
  let urlText = value.replace(TRAILING_PUNCTUATION, "");
  let trailing = value.slice(urlText.length);
  while (urlText.endsWith(")") && count(urlText, "(") < count(urlText, ")")) {
    urlText = urlText.slice(0, -1);
    trailing = `)${trailing}`;
  }
  while (urlText.endsWith("]") && count(urlText, "[") < count(urlText, "]")) {
    urlText = urlText.slice(0, -1);
    trailing = `]${trailing}`;
  }
  return { urlText, trailing };
}

function count(value, character) {
  return [...value].filter((candidate) => candidate === character).length;
}
