const MAX_TOUCH_HINTS = 24;
const MAX_TOUCH_HINT_LENGTH = 240;

export function normalizeTaskTouches(value, { defaultValue = [] } = {}) {
  if (value === undefined || value === null || value === "") return [...defaultValue];
  const items = Array.isArray(value) ? value : String(value).split(",");
  if (items.length > MAX_TOUCH_HINTS) throw new Error(`touches supports at most ${MAX_TOUCH_HINTS} path hints.`);

  const normalized = [];
  for (const item of items) {
    const hint = normalizeTouchHint(item);
    if (!hint || normalized.includes(hint)) continue;
    normalized.push(hint);
  }
  return normalized;
}

export function normalizeTouchHint(value) {
  let hint = String(value || "").trim().replaceAll("\\", "/");
  hint = hint.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/{2,}/g, "/").replace(/\/$/, "/**");
  if (!hint) return "";
  if (hint.length > MAX_TOUCH_HINT_LENGTH) throw new Error(`touches path hints must be at most ${MAX_TOUCH_HINT_LENGTH} characters.`);
  if (hint.includes("\0") || hint.split("/").some((segment) => segment === "..")) {
    throw new Error("touches path hints must stay within the repository.");
  }
  if (/[^A-Za-z0-9._/@*?+\-\[\]() ]/.test(hint)) {
    throw new Error("touches path hints contain unsupported characters.");
  }
  return hint;
}

export function taskTouchesOverlap(leftTouches, rightTouches) {
  const left = normalizeTaskTouches(leftTouches);
  const right = normalizeTaskTouches(rightTouches);
  const matches = [];

  for (const leftHint of left) {
    for (const rightHint of right) {
      if (globPathsIntersect(leftHint, rightHint)) matches.push({ left: leftHint, right: rightHint });
    }
  }

  return {
    overlaps: matches.length > 0,
    matches
  };
}

export function globPathsIntersect(leftPattern, rightPattern) {
  const left = normalizeTouchHint(leftPattern).split("/");
  const right = normalizeTouchHint(rightPattern).split("/");
  const visited = new Set();

  function visit(leftIndex, rightIndex) {
    const key = `${leftIndex}:${rightIndex}`;
    if (visited.has(key)) return false;
    visited.add(key);

    if (leftIndex === left.length && rightIndex === right.length) return true;
    const leftSegment = left[leftIndex];
    const rightSegment = right[rightIndex];

    if (leftSegment === "**") {
      if (visit(leftIndex + 1, rightIndex)) return true;
      if (rightIndex < right.length && visit(leftIndex, rightIndex + 1)) return true;
    }
    if (rightSegment === "**") {
      if (visit(leftIndex, rightIndex + 1)) return true;
      if (leftIndex < left.length && visit(leftIndex + 1, rightIndex)) return true;
    }
    if (
      leftIndex < left.length &&
      rightIndex < right.length &&
      leftSegment !== "**" &&
      rightSegment !== "**" &&
      globSegmentsIntersect(leftSegment, rightSegment)
    ) {
      return visit(leftIndex + 1, rightIndex + 1);
    }
    return false;
  }

  return visit(0, 0);
}

function globSegmentsIntersect(left, right) {
  const queue = [[0, 0]];
  const visited = new Set();

  while (queue.length) {
    const [leftIndex, rightIndex] = queue.shift();
    const key = `${leftIndex}:${rightIndex}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (leftIndex === left.length && rightIndex === right.length) return true;

    const leftToken = left[leftIndex];
    const rightToken = right[rightIndex];
    if (leftToken === "*") queue.push([leftIndex + 1, rightIndex]);
    if (rightToken === "*") queue.push([leftIndex, rightIndex + 1]);

    const leftTransition = segmentTransition(left, leftIndex);
    const rightTransition = segmentTransition(right, rightIndex);
    if (leftTransition && rightTransition && charactersIntersect(leftTransition.character, rightTransition.character)) {
      queue.push([leftTransition.next, rightTransition.next]);
    }
  }
  return false;
}

function segmentTransition(pattern, index) {
  if (index >= pattern.length) return null;
  const token = pattern[index];
  if (token === "*") return { character: null, next: index };
  if (token === "?") return { character: null, next: index + 1 };
  return { character: token, next: index + 1 };
}

function charactersIntersect(left, right) {
  return left === null || right === null || left === right;
}
