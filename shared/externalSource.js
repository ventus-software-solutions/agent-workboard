const GITHUB_KINDS = new Set(["pull_request", "issue"]);
const GITHUB_STATES = new Set(["open", "closed", "merged"]);

export class ExternalSourceValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExternalSourceValidationError";
  }
}

export function normalizeExternalSource(value) {
  if (value === null || value === undefined || value === "") return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ExternalSourceValidationError("Task externalSource must be an object.");
  }

  const provider = text(value.provider).toLowerCase();
  if (provider !== "github") {
    throw new ExternalSourceValidationError("Task externalSource.provider must be github.");
  }

  const repository = normalizeRepository(value.repository);
  const kind = text(value.kind).toLowerCase();
  if (!GITHUB_KINDS.has(kind)) {
    throw new ExternalSourceValidationError("Task externalSource.kind must be pull_request or issue.");
  }

  const number = Number(value.number);
  if (!Number.isInteger(number) || number < 1) {
    throw new ExternalSourceValidationError("Task externalSource.number must be a positive integer.");
  }

  const url = normalizeHttpUrl(value.url, "Task externalSource.url");
  const state = text(value.state).toLowerCase();
  if (!GITHUB_STATES.has(state)) {
    throw new ExternalSourceValidationError("Task externalSource.state must be open, closed, or merged.");
  }

  const record = {
    provider,
    repository,
    kind,
    number,
    url,
    state,
    openedAt: normalizeTimestamp(value.openedAt, "Task externalSource.openedAt", { required: true })
  };

  copyText(record, value, "author");
  copyTimestamp(record, value, "updatedAt");
  copyTimestamp(record, value, "closedAt");
  copyTimestamp(record, value, "mergedAt");
  copyTimestamp(record, value, "attentionAfterAt");
  copyText(record, value, "headBranch");
  copyText(record, value, "baseBranch");
  copyText(record, value, "mergeCommitSha");

  return record;
}

export function externalSourceKey(value) {
  const source = normalizeExternalSource(value);
  return source ? `${source.provider}:${source.repository}:${source.kind}:${source.number}` : "";
}

export function agedExternalSource(task, currentTime = new Date()) {
  if (!task || task.status === "done" || !task.externalSource) return null;

  let source;
  try {
    source = normalizeExternalSource(task.externalSource);
  } catch {
    return null;
  }
  if (source.state !== "open" || !source.attentionAfterAt) return null;

  const nowMs = currentTime instanceof Date ? currentTime.getTime() : new Date(currentTime).getTime();
  const thresholdMs = Date.parse(source.attentionAfterAt);
  const openedMs = Date.parse(source.openedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(thresholdMs) || nowMs < thresholdMs) return null;

  return {
    source,
    ageDays: Math.max(0, Math.floor((nowMs - openedMs) / 86_400_000)),
    thresholdDays: Math.max(0, Math.round((thresholdMs - openedMs) / 86_400_000))
  };
}

function normalizeRepository(value) {
  const repository = text(value).toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new ExternalSourceValidationError("Task externalSource.repository must use owner/repo format.");
  }
  return repository;
}

function normalizeHttpUrl(value, label) {
  let url;
  try {
    url = new URL(text(value));
  } catch {
    throw new ExternalSourceValidationError(`${label} must be a valid http(s) URL.`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) {
    throw new ExternalSourceValidationError(`${label} must be a valid http(s) URL.`);
  }
  return url.toString();
}

function normalizeTimestamp(value, label, { required = false } = {}) {
  const raw = text(value);
  if (!raw && !required) return "";
  const timestamp = Date.parse(raw);
  if (!raw || !Number.isFinite(timestamp)) {
    throw new ExternalSourceValidationError(`${label} must be an ISO timestamp.`);
  }
  return new Date(timestamp).toISOString();
}

function copyTimestamp(record, source, field) {
  const value = normalizeTimestamp(source[field], `Task externalSource.${field}`);
  if (value) record[field] = value;
}

function copyText(record, source, field) {
  const value = text(source[field]);
  if (value) record[field] = value;
}

function text(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
