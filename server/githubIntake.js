import { externalSourceKey, normalizeExternalSource } from "../shared/externalSource.js";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_ATTENTION_AGE_DAYS = 3;
const DEFAULT_MAX_PAGES = 20;
const SYNC_ACTOR = "github-intake";

export function readGitHubIntakeConfig(env = process.env) {
  const repository = normalizeRepository(env.WORKBOARD_GITHUB_REPOSITORY || "", { required: false });
  const token = text(env.WORKBOARD_GITHUB_TOKEN || env.GITHUB_TOKEN || "");
  return {
    enabled: Boolean(repository),
    repository,
    token,
    projectKey: text(env.WORKBOARD_GITHUB_PROJECT_KEY || env.WORKBOARD_DEFAULT_PROJECT_KEY || "").toUpperCase(),
    apiBaseUrl: normalizeApiBaseUrl(env.WORKBOARD_GITHUB_API_URL || DEFAULT_API_BASE_URL),
    syncIntervalMs: readNonNegativeInteger(
      env.WORKBOARD_GITHUB_SYNC_INTERVAL_MS,
      DEFAULT_SYNC_INTERVAL_MS,
      "WORKBOARD_GITHUB_SYNC_INTERVAL_MS"
    ),
    attentionAgeDays: readPositiveInteger(
      env.WORKBOARD_GITHUB_EXTERNAL_AGE_DAYS,
      DEFAULT_ATTENTION_AGE_DAYS,
      "WORKBOARD_GITHUB_EXTERNAL_AGE_DAYS"
    ),
    maxPages: readPositiveInteger(env.WORKBOARD_GITHUB_MAX_PAGES, DEFAULT_MAX_PAGES, "WORKBOARD_GITHUB_MAX_PAGES")
  };
}

export class GitHubRestClient {
  constructor({ repository, token = "", apiBaseUrl = DEFAULT_API_BASE_URL, maxPages = DEFAULT_MAX_PAGES, fetchImpl = globalThis.fetch } = {}) {
    this.repository = normalizeRepository(repository);
    this.token = text(token);
    this.apiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
    this.maxPages = readPositiveInteger(maxPages, DEFAULT_MAX_PAGES, "maxPages");
    if (typeof fetchImpl !== "function") throw new TypeError("GitHub intake requires a fetch implementation.");
    this.fetch = fetchImpl;
  }

  listPullRequests() {
    return this.paginate(`/repos/${encodedRepository(this.repository)}/pulls?state=all&per_page=100`);
  }

  async listIssues() {
    const issues = await this.paginate(`/repos/${encodedRepository(this.repository)}/issues?state=all&per_page=100`);
    return issues.filter((issue) => !issue?.pull_request);
  }

  async paginate(pathname) {
    const items = [];
    let nextUrl = new URL(`${this.apiBaseUrl}${pathname}`).toString();
    let page = 0;

    while (nextUrl) {
      page += 1;
      if (page > this.maxPages) {
        throw githubError(`GitHub intake exceeded the configured ${this.maxPages}-page limit.`, {
          repository: this.repository,
          maxPages: this.maxPages
        });
      }

      const response = await this.fetch(nextUrl, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "agent-workboard-github-intake",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
        }
      });
      if (!response?.ok) {
        const detail = await readErrorDetail(response);
        throw githubError(`GitHub request failed with ${response?.status || "an unknown status"}${detail ? `: ${detail}` : "."}`, {
          repository: this.repository,
          githubStatus: response?.status || 0
        });
      }

      const payload = await response.json();
      if (!Array.isArray(payload)) {
        throw githubError("GitHub list response was not an array.", { repository: this.repository });
      }
      items.push(...payload);
      nextUrl = nextPageUrl(response.headers?.get?.("link"), this.apiBaseUrl);
    }

    return items;
  }
}

export class GitHubIntakeService {
  constructor({ store, config = readGitHubIntakeConfig(), client = null, logger = console, clock = () => new Date() } = {}) {
    if (!store) throw new TypeError("GitHub intake requires a workboard store.");
    this.store = store;
    this.config = normalizeConfig(config);
    this.client = client || (this.config.enabled ? new GitHubRestClient(this.config) : null);
    this.logger = logger;
    this.clock = clock;
    this.timer = null;
    this.inFlight = null;
    this.lastAttemptAt = "";
    this.lastResult = null;
    this.lastError = null;
  }

  status() {
    return {
      enabled: this.config.enabled,
      repository: this.config.repository,
      projectKey: this.config.projectKey,
      tokenConfigured: Boolean(this.config.token),
      syncIntervalMs: this.config.syncIntervalMs,
      attentionAgeDays: this.config.attentionAgeDays,
      running: Boolean(this.timer),
      syncing: Boolean(this.inFlight),
      lastAttemptAt: this.lastAttemptAt,
      lastResult: this.lastResult,
      lastError: this.lastError
    };
  }

  start({ immediate = true } = {}) {
    if (!this.config.enabled || this.config.syncIntervalMs === 0 || this.timer) return this.status();
    if (immediate) void this.sync().catch((error) => this.logFailure(error));
    this.timer = setInterval(() => void this.sync().catch((error) => this.logFailure(error)), this.config.syncIntervalMs);
    this.timer.unref?.();
    return this.status();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.status();
  }

  sync() {
    if (!this.config.enabled || !this.client) {
      return Promise.reject(configurationError("GitHub intake is disabled. Set WORKBOARD_GITHUB_REPOSITORY=owner/repo to enable it."));
    }
    if (this.inFlight) return this.inFlight;

    this.lastAttemptAt = this.clock().toISOString();
    this.lastError = null;
    this.inFlight = this.performSync()
      .then((result) => {
        this.lastResult = result;
        return result;
      })
      .catch((error) => {
        this.lastError = { message: error.message, at: this.clock().toISOString() };
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  async performSync() {
    const project = resolveTargetProject(this.store, this.config.projectKey);
    const [pulls, issues] = await Promise.all([this.client.listPullRequests(), this.client.listIssues()]);
    const syncedAt = this.clock().toISOString();
    const items = [
      ...pulls.map((pull) => normalizePullRequest(pull, this.config, syncedAt)),
      ...issues.map((issue) => normalizeIssue(issue, this.config, syncedAt))
    ].sort((left, right) => left.externalSource.kind.localeCompare(right.externalSource.kind) || left.externalSource.number - right.externalSource.number);

    const tasks = this.store.listTasks({ projectId: project.id });
    const byExternalKey = new Map(
      tasks.filter((task) => task.externalSource).map((task) => [safeExternalSourceKey(task.externalSource), task]).filter(([key]) => key)
    );
    const result = {
      repository: this.config.repository,
      projectId: project.id,
      projectKey: project.key,
      syncedAt,
      fetched: { pullRequests: pulls.length, issues: issues.length },
      created: 0,
      updated: 0,
      completed: 0,
      skippedClosedUnlinked: 0,
      unchanged: 0
    };

    for (const item of items) {
      const key = externalSourceKey(item.externalSource);
      let task = byExternalKey.get(key) || findLegacyLinkedTask(tasks, item);

      if (!task) {
        if (item.externalSource.state !== "open") {
          result.skippedClosedUnlinked += 1;
          continue;
        }
        task = await this.store.createTask(buildTaskInput(project.id, item));
        byExternalKey.set(key, task);
        tasks.push(task);
        result.created += 1;
        continue;
      }

      const outcome = await reconcileTask(this.store, task, item);
      result[outcome] += 1;
    }

    return result;
  }

  logFailure(error) {
    this.logger?.warn?.(`GitHub intake sync failed: ${error.message}`);
  }
}

function buildTaskInput(projectId, item) {
  const kindLabel = item.externalSource.kind === "pull_request" ? "PR" : "issue";
  return {
    projectId,
    title: `GitHub ${kindLabel} #${item.externalSource.number}: ${item.title}`,
    description: [
      `Imported from GitHub ${item.externalSource.kind === "pull_request" ? "pull request" : "issue"} #${item.externalSource.number}.`,
      item.externalSource.author ? `Author: ${item.externalSource.author}` : "",
      `Source: ${item.externalSource.url}`
    ]
      .filter(Boolean)
      .join("\n"),
    status: "ready",
    priority: "normal",
    role: item.externalSource.kind === "pull_request" ? "reviewer" : "pm",
    workItemType: "chore",
    assignee: "",
    labels: item.labels,
    externalSource: item.externalSource,
    ...(item.externalSource.kind === "pull_request"
      ? { pullRequestUrl: item.externalSource.url, branch: item.externalSource.headBranch || "" }
      : {}),
    actor: SYNC_ACTOR
  };
}

async function reconcileTask(store, task, item) {
  const patch = { externalSource: item.externalSource, actor: SYNC_ACTOR };
  if (item.externalSource.kind === "pull_request") {
    patch.pullRequestUrl = item.externalSource.url;
    if (!task.branch && item.externalSource.headBranch) patch.branch = item.externalSource.headBranch;
  }

  let outcome = "updated";
  if (item.externalSource.state !== "open" && task.status !== "done") {
    const completion = completionFor(item.externalSource);
    if (completion) {
      patch.status = "done";
      patch.assignee = "";
      patch.completion = completion;
      outcome = "completed";
    }
  } else if (item.externalSource.state === "open" && task.status === "done" && task.completion?.completedBy === SYNC_ACTOR) {
    patch.status = "ready";
    patch.assignee = "";
  }

  if (requiresExpectedRevision(patch)) patch.expectedRevision = task.revision;
  const beforeRevision = task.revision;
  const updatedTask = await store.updateTask(task.id, patch, SYNC_ACTOR);
  return updatedTask.revision === beforeRevision ? "unchanged" : outcome;
}

function requiresExpectedRevision(patch) {
  return ["externalSource", "pullRequestUrl", "branch", "assignee"].some((field) => Object.prototype.hasOwnProperty.call(patch, field));
}

function completionFor(source) {
  const common = {
    completedBy: SYNC_ACTOR,
    completedAt: source.mergedAt || source.closedAt || source.updatedAt || new Date().toISOString()
  };
  if (source.state === "merged" && source.mergeCommitSha) {
    return {
      ...common,
      completionType: "merged",
      branch: source.headBranch,
      commitSha: source.mergeCommitSha,
      mergedTo: source.baseBranch || "main",
      notes: `Observed merged GitHub pull request #${source.number}: ${source.url}`
    };
  }
  if (source.state === "merged") return null;
  return {
    ...common,
    completionType: "no-code",
    notes: `Observed externally ${source.state} GitHub ${source.kind === "pull_request" ? "pull request" : "issue"} #${source.number}: ${source.url}`
  };
}

function normalizePullRequest(pull, config, fallbackTimestamp) {
  const openedAt = timestamp(pull?.created_at, fallbackTimestamp);
  const state = pull?.merged_at || pull?.merged === true ? "merged" : pull?.state === "closed" ? "closed" : "open";
  const externalSource = normalizeExternalSource({
    provider: "github",
    repository: config.repository,
    kind: "pull_request",
    number: pull?.number,
    url: pull?.html_url,
    state,
    author: pull?.user?.login,
    openedAt,
    updatedAt: timestamp(pull?.updated_at, fallbackTimestamp),
    closedAt: timestamp(pull?.closed_at),
    mergedAt: timestamp(pull?.merged_at),
    attentionAfterAt: attentionAfter(openedAt, config.attentionAgeDays),
    headBranch: pull?.head?.ref,
    baseBranch: pull?.base?.ref,
    mergeCommitSha: pull?.merge_commit_sha
  });
  return {
    title: text(pull?.title) || `Pull request ${externalSource.number}`,
    labels: externalLabels(pull, "pull-request"),
    externalSource
  };
}

function normalizeIssue(issue, config, fallbackTimestamp) {
  const openedAt = timestamp(issue?.created_at, fallbackTimestamp);
  const state = issue?.state === "closed" ? "closed" : "open";
  const externalSource = normalizeExternalSource({
    provider: "github",
    repository: config.repository,
    kind: "issue",
    number: issue?.number,
    url: issue?.html_url,
    state,
    author: issue?.user?.login,
    openedAt,
    updatedAt: timestamp(issue?.updated_at, fallbackTimestamp),
    closedAt: timestamp(issue?.closed_at),
    attentionAfterAt: attentionAfter(openedAt, config.attentionAgeDays)
  });
  return {
    title: text(issue?.title) || `Issue ${externalSource.number}`,
    labels: externalLabels(issue, "issue"),
    externalSource
  };
}

function externalLabels(item, kindLabel) {
  const githubLabels = (Array.isArray(item?.labels) ? item.labels : [])
    .map((label) => text(typeof label === "string" ? label : label?.name).toLowerCase())
    .filter(Boolean);
  const author = text(item?.user?.login).toLowerCase();
  const dependencies = author.startsWith("dependabot") || githubLabels.some((label) => ["dependencies", "dependabot"].includes(label));
  return [...new Set(["external", "github", kindLabel, ...(dependencies ? ["dependencies"] : [])])];
}

function findLegacyLinkedTask(tasks, item) {
  if (item.externalSource.kind !== "pull_request") return null;
  return tasks.find((task) => text(task.pullRequestUrl) === item.externalSource.url) || null;
}

function resolveTargetProject(store, projectKey) {
  const projects = store.listProjects();
  if (projectKey) {
    const project = projects.find((candidate) => text(candidate.key).toUpperCase() === projectKey);
    if (!project) throw configurationError(`GitHub intake project ${projectKey} was not found or is archived.`);
    return project;
  }
  const project = store.getAgentProjectContext(SYNC_ACTOR).activeProject;
  if (!project) throw configurationError("GitHub intake could not resolve an active default project.");
  return store.getProject(project.id);
}

function normalizeConfig(config) {
  const repository = normalizeRepository(config?.repository || "", { required: false });
  return {
    enabled: config?.enabled === undefined ? Boolean(repository) : Boolean(config.enabled && repository),
    repository,
    token: text(config?.token),
    projectKey: text(config?.projectKey).toUpperCase(),
    apiBaseUrl: normalizeApiBaseUrl(config?.apiBaseUrl || DEFAULT_API_BASE_URL),
    syncIntervalMs: readNonNegativeInteger(config?.syncIntervalMs, DEFAULT_SYNC_INTERVAL_MS, "syncIntervalMs"),
    attentionAgeDays: readPositiveInteger(config?.attentionAgeDays, DEFAULT_ATTENTION_AGE_DAYS, "attentionAgeDays"),
    maxPages: readPositiveInteger(config?.maxPages, DEFAULT_MAX_PAGES, "maxPages")
  };
}

function normalizeRepository(value, { required = true } = {}) {
  const repository = text(value).toLowerCase();
  if (!repository && !required) return "";
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw configurationError("GitHub repository must use owner/repo format.");
  }
  return repository;
}

function normalizeApiBaseUrl(value) {
  let url;
  try {
    url = new URL(text(value));
  } catch {
    throw configurationError("GitHub API URL must be a valid http(s) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw configurationError("GitHub API URL must be a valid http(s) URL.");
  return url.toString().replace(/\/$/, "");
}

function encodedRepository(repository) {
  return repository.split("/").map(encodeURIComponent).join("/");
}

function nextPageUrl(linkHeader, apiBaseUrl) {
  if (!linkHeader) return "";
  const next = String(linkHeader)
    .split(",")
    .map((part) => /^\s*<([^>]+)>;\s*rel="([^"]+)"\s*$/.exec(part))
    .find((match) => match?.[2] === "next")?.[1];
  if (!next) return "";

  const candidate = new URL(next);
  const allowed = new URL(apiBaseUrl);
  if (candidate.protocol !== allowed.protocol || candidate.host !== allowed.host) {
    throw githubError("GitHub pagination attempted to leave the configured API origin.");
  }
  return candidate.toString();
}

async function readErrorDetail(response) {
  try {
    const payload = await response.json();
    return text(payload?.message).slice(0, 240);
  } catch {
    return "";
  }
}

function timestamp(value, fallback = "") {
  const parsed = Date.parse(text(value));
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  return fallback;
}

function attentionAfter(openedAt, days) {
  return new Date(Date.parse(openedAt) + days * 86_400_000).toISOString();
}

function safeExternalSourceKey(value) {
  try {
    return externalSourceKey(value);
  } catch {
    return "";
  }
}

function readPositiveInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw configurationError(`${label} must be a positive integer.`);
  return parsed;
}

function readNonNegativeInteger(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw configurationError(`${label} must be a non-negative integer.`);
  return parsed;
}

function configurationError(message) {
  return Object.assign(new Error(message), { status: 503 });
}

function githubError(message, details = {}) {
  return Object.assign(new Error(message), { status: 502, details });
}

function text(value) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}
