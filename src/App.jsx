import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Archive,
  Bot,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock3,
  Copy,
  Database,
  FileUp,
  Filter,
  FolderKanban,
  GitMerge,
  Link2,
  Menu,
  MessageSquarePlus,
  Minus,
  Paperclip,
  PauseCircle,
  PlayCircle,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  TestTube2,
  UserRoundCheck,
  WifiOff,
  X
} from "lucide-react";
import { api } from "./lib/api.js";
import { buildAgentBootstrapPrompt, buildAgentRegistry } from "./lib/agentRegistry.js";
import { countClaimableReadyTasks } from "./lib/agentBootstrap.js";
import { copyTextToClipboard } from "./lib/clipboard.js";
import { buildOperatorAttention, usesDedicatedSpawnRemedy } from "./lib/operatorAttention.js";
import { describeTaskSaveError } from "./lib/taskSaveErrors.js";
import { getTaskDropMove } from "./lib/kanbanDrag.js";
import { createPollingScheduler } from "./lib/polling.js";
import { statusActionLabel, statusControlLabel, taskWorkflowCue } from "./lib/statusActions.js";
import { describeSystemStatus } from "./lib/systemStatus.js";
import { formatWorkboardRoute, parseWorkboardRoute } from "./lib/workboardRoute.js";
import { AgentOnboarding } from "./components/AgentOnboarding.jsx";
import { HelpPopover } from "./components/HelpPopover.jsx";
import { LinkifiedText } from "./components/LinkifiedText.jsx";
import { SafeMarkdown } from "./components/SafeMarkdown.jsx";
import { TaskDeliveryLinks } from "./components/TaskDeliveryLinks.jsx";

const DRAG_START_THRESHOLD = 8;

const roleIcons = {
  pm: ClipboardList,
  implementer: Bot,
  reviewer: ShieldCheck,
  tester: TestTube2,
  researcher: Search,
  operator: UserRoundCheck
};

const priorityClass = {
  low: "priorityLow",
  normal: "priorityNormal",
  high: "priorityHigh",
  urgent: "priorityUrgent"
};

const talkKinds = ["update", "blocker", "review-request", "handoff", "question", "decision", "system"];
const TALK_PAGE_SIZE = 25;
const workModeOptions = [
  { id: "single-task", label: "Single task" },
  { id: "drain-role-queue", label: "Drain queue" },
  { id: "watch-mode", label: "Watch mode" }
];
const activityTypes = [
  { id: "project.created", label: "Project" },
  { id: "created", label: "Created" },
  { id: "claimed", label: "Claimed" },
  { id: "updated", label: "Updated" },
  { id: "completed", label: "Completed" },
  { id: "update.rejected", label: "Validation" },
  { id: "commented", label: "Comment" },
  { id: "attachment.added", label: "Attachment" },
  { id: "approval.requested", label: "Blocked" },
  { id: "approval.decided", label: "Approval" }
];
const LIVE_POLL_INTERVAL_MS = 2500;
const LIVE_POLL_MAX_BACKOFF_MS = 30_000;
const SIDEBAR_PREFERENCE_KEY = "agentWorkboard.sidebarCollapsed";
const SIDEBAR_NARROW_QUERY = "(max-width: 920px)";

function emptyWorktreeCleanup(error = "") {
  return {
    generatedAt: "",
    mainRef: "main",
    counts: {
      total: 0,
      cleanupReady: 0,
      quarantined: 0,
      active: 0,
      unknown: 0
    },
    items: [],
    error,
    loaded: false,
    loading: false
  };
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatHeartbeatAge(value, currentTime = Date.now()) {
  if (!value) return "No heartbeat";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "No heartbeat";
  const elapsedMinutes = Math.max(0, Math.floor((currentTime - timestamp) / 60_000));
  if (elapsedMinutes < 1) return "Heartbeat just now";
  if (elapsedMinutes < 60) return `Heartbeat ${elapsedMinutes}m ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `Heartbeat ${elapsedHours}h ago`;
  return `Heartbeat ${Math.floor(elapsedHours / 24)}d ago`;
}

function hasTaskFilters(filters) {
  return Boolean(filters.q || filters.role || filters.assignee || filters.workItemType);
}

async function fetchTaskLists(projectId, filters) {
  const filteredResultPromise = api.tasks({ projectId, ...filters });
  if (!hasTaskFilters(filters)) {
    const result = await filteredResultPromise;
    return { filteredTasks: result.tasks, projectTasks: result.tasks };
  }

  const [filteredResult, projectResult] = await Promise.all([filteredResultPromise, api.tasks({ projectId })]);
  return { filteredTasks: filteredResult.tasks, projectTasks: projectResult.tasks };
}

export function App() {
  const [initialRoute] = useState(() => parseWorkboardRoute(typeof window === "undefined" ? "/" : window.location));
  const [meta, setMeta] = useState({
    roles: [],
    statuses: [],
    completionTypes: [],
    workItemTypes: [],
    capabilityStatuses: [],
    server: null,
    integrationStatus: null,
    blockerTypes: [],
    operatorApprovalDecisions: []
  });
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [projectTasks, setProjectTasks] = useState([]);
  const [talks, setTalks] = useState([]);
  const [activityEvents, setActivityEvents] = useState([]);
  const [capabilities, setCapabilities] = useState([]);
  const [agentSlots, setAgentSlots] = useState({ types: [], slots: [] });
  const [deploymentSettings, setDeploymentSettings] = useState({
    processOverrides: "",
    updatedAt: "",
    updatedBy: ""
  });
  const [agentDocsOverview, setAgentDocsOverview] = useState({ usage: { promptTemplate: "" } });
  const [selectedProjectId, setSelectedProjectId] = useState(initialRoute.projectId);
  const [selectedTaskId, setSelectedTaskId] = useState(initialRoute.taskId);
  const [filters, setFilters] = useState(initialRoute.filters);
  const [talkFilters, setTalkFilters] = useState({ kind: "", agentId: "", taskId: "" });
  const [activityFilters, setActivityFilters] = useState({ q: "", type: "" });
  const [staleWork, setStaleWork] = useState([]);
  const [staleWorkNotes, setStaleWorkNotes] = useState({});
  const [worktreeCleanup, setWorktreeCleanup] = useState(() => emptyWorktreeCleanup());
  const [cleanupActionKey, setCleanupActionKey] = useState("");
  const [agentControlPending, setAgentControlPending] = useState("");
  const [capabilityFilters, setCapabilityFilters] = useState({ q: "", status: "" });
  const [view, setView] = useState(initialRoute.view);
  const [workspaceTab, setWorkspaceTab] = useState(initialRoute.workspaceTab);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(SIDEBAR_PREFERENCE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [isSidebarOverlayOpen, setIsSidebarOverlayOpen] = useState(false);
  const [isNarrowViewport, setIsNarrowViewport] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(SIDEBAR_NARROW_QUERY).matches;
  });
  const [error, setError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshState, setRefreshState] = useState({
    status: "connecting",
    lastCheckedAt: "",
    lastUpdatedAt: "",
    nextRetryAt: "",
    error: ""
  });
  const boardVersionRef = useRef("");
  const boardProjectRef = useRef("");
  const pollBoardStateRef = useRef(null);
  const pollingNeedsMetaRefreshRef = useRef(false);
  const initialLoadStartedRef = useRef(false);
  const routeWriteModeRef = useRef("replace");

  const selectedTask = projectTasks.find((task) => task.id === selectedTaskId);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);
  const sidebarVisible = isNarrowViewport ? isSidebarOverlayOpen : !isSidebarCollapsed;
  const sidebarToggleLabel = sidebarVisible ? (isNarrowViewport ? "Close sidebar" : "Collapse sidebar") : "Open sidebar";
  const appShellClassName = [
    "appShell",
    isSidebarCollapsed ? "sidebarCollapsed" : "",
    isSidebarOverlayOpen ? "sidebarOverlayOpen" : ""
  ]
    .filter(Boolean)
    .join(" ");

  function markRouteChange(mode = "push") {
    routeWriteModeRef.current = mode;
  }

  function navigateView(nextView, nextWorkspaceTab = workspaceTab) {
    markRouteChange();
    setView(nextView);
    if (nextView === "board") setWorkspaceTab(nextWorkspaceTab);
  }

  function navigateWorkspaceTab(nextWorkspaceTab) {
    markRouteChange();
    setWorkspaceTab(nextWorkspaceTab);
  }

  function selectTask(nextTaskId, mode = "push") {
    markRouteChange(mode);
    setSelectedTaskId(nextTaskId);
  }

  function selectProject(nextProjectId) {
    markRouteChange();
    setSelectedTaskId("");
    setSelectedProjectId(nextProjectId);
  }

  function persistSidebarCollapsed(nextCollapsed) {
    setIsSidebarCollapsed(nextCollapsed);
    try {
      window.localStorage.setItem(SIDEBAR_PREFERENCE_KEY, String(nextCollapsed));
    } catch {
      // Preference persistence is best-effort; toggling should still work.
    }
  }

  function toggleSidebar() {
    if (isNarrowViewport) {
      setIsSidebarOverlayOpen((current) => !current);
      return;
    }
    persistSidebarCollapsed(!isSidebarCollapsed);
  }

  function closeSidebar() {
    if (isNarrowViewport) {
      setIsSidebarOverlayOpen(false);
      return;
    }
    persistSidebarCollapsed(true);
  }

  function closeSidebarOverlay() {
    if (isNarrowViewport) {
      setIsSidebarOverlayOpen(false);
    }
  }

  async function fetchWorktreeCleanup() {
    try {
      const result = await api.worktreeCleanup();
      return { ...emptyWorktreeCleanup(), ...result.report, error: "", loaded: true, loading: false };
    } catch (nextError) {
      return { ...emptyWorktreeCleanup(nextError.message), loaded: true };
    }
  }

  async function loadAll(projectId = selectedProjectId) {
    setError("");
    const [metaResult, projectsResult, agentSlotsResult, deploymentSettingsResult, agentDocsResult] = await Promise.all([
      api.meta(),
      api.projects(),
      api.agentSlots(),
      api.deploymentSettings(),
      api.agentDocs()
    ]);
    const nextProjects = projectsResult.projects;
    const requestedProjectId = projectId || nextProjects[0]?.id || "";
    const nextProjectId = nextProjects.some((project) => project.id === requestedProjectId)
      ? requestedProjectId
      : nextProjects[0]?.id || "";
    const [taskListsResult, talksResult, staleResult, capabilitiesResult, activityResult, cleanupResult, integrationResult] = nextProjectId
      ? await Promise.all([
          fetchTaskLists(nextProjectId, {
            q: filters.q,
            role: filters.role,
            assignee: filters.assignee,
            workItemType: filters.workItemType
          }),
          api.talks(nextProjectId, talkFilters),
          api.staleInProgressTasks({ projectId: nextProjectId }),
          api.capabilities({ projectId: nextProjectId, ...capabilityFilters }),
          api.projectActivity(nextProjectId, activityFilters),
          fetchWorktreeCleanup(),
          api.integrationStatus(nextProjectId)
        ])
      : [
          { filteredTasks: [], projectTasks: [] },
          { messages: [] },
          { tasks: [] },
          { capabilities: [] },
          { activity: [] },
          emptyWorktreeCleanup(),
          { integrationStatus: metaResult.integrationStatus }
        ];
    setMeta({ ...metaResult, integrationStatus: integrationResult.integrationStatus });
    setProjects(nextProjects);
    setSelectedProjectId(nextProjectId);
    setTasks(taskListsResult.filteredTasks);
    setProjectTasks(taskListsResult.projectTasks);
    setTalks(talksResult.messages);
    setStaleWork(staleResult.tasks);
    setCapabilities(capabilitiesResult.capabilities);
    setActivityEvents(activityResult.activity);
    setAgentSlots(agentSlotsResult);
    setDeploymentSettings(deploymentSettingsResult.settings);
    setAgentDocsOverview(agentDocsResult);
    setWorktreeCleanup(cleanupResult);
    setLoading(false);
  }

  async function refreshTasks(overrides = null, { routeMode = "" } = {}) {
    const nextFilters = overrides ? { ...filters, ...overrides } : filters;
    if (overrides) {
      if (routeMode) markRouteChange(routeMode);
      setFilters(nextFilters);
    }
    if (!selectedProjectId) return;
    const [taskListsResult, staleResult] = await Promise.all([
      fetchTaskLists(selectedProjectId, nextFilters),
      api.staleInProgressTasks({ projectId: selectedProjectId })
    ]);
    setTasks(taskListsResult.filteredTasks);
    setProjectTasks(taskListsResult.projectTasks);
    setStaleWork(staleResult.tasks);
    return taskListsResult.filteredTasks;
  }

  async function refreshIntegrationStatus(projectId = selectedProjectId) {
    const result = await api.integrationStatus(projectId);
    setMeta((current) => ({ ...current, integrationStatus: result.integrationStatus }));
    return result.integrationStatus;
  }

  async function refreshTalks(overrides = {}, projectId = selectedProjectId) {
    const nextFilters = { ...talkFilters, ...overrides };
    setTalkFilters(nextFilters);
    if (!projectId) return;
    const result = await api.talks(projectId, nextFilters);
    setTalks(result.messages);
    return result.messages;
  }

  async function refreshActivity(overrides = {}, projectId = selectedProjectId) {
    const nextFilters = { ...activityFilters, ...overrides };
    setActivityFilters(nextFilters);
    if (!projectId) return;
    const result = await api.projectActivity(projectId, nextFilters);
    setActivityEvents(result.activity);
    return result.activity;
  }

  async function pollBoardState({ refreshOnChange = true } = {}) {
    if (!selectedProjectId) return;

    const checkedAt = new Date().toISOString();
    const result = await api.boardState({ projectId: selectedProjectId });
    if (pollingNeedsMetaRefreshRef.current) {
      const recoveredMeta = await api.meta();
      setMeta(recoveredMeta);
      pollingNeedsMetaRefreshRef.current = false;
    }
    const previousVersion = boardVersionRef.current;
    const changed = Boolean(previousVersion && previousVersion !== result.state.version);

    if (changed && refreshOnChange) {
      setRefreshState({
        status: "updating",
        lastCheckedAt: checkedAt,
        lastUpdatedAt: result.state.latestUpdatedAt || "",
        nextRetryAt: "",
        error: ""
      });
      await Promise.all([refreshTasks(), refreshActivity()]);
    }

    boardVersionRef.current = result.state.version;
    setRefreshState({
      status: changed && refreshOnChange ? "updated" : "live",
      lastCheckedAt: new Date().toISOString(),
      lastUpdatedAt: result.state.latestUpdatedAt || "",
      nextRetryAt: "",
      error: ""
    });
  }

  pollBoardStateRef.current = pollBoardState;

  async function refreshCapabilities(overrides = {}) {
    const nextFilters = { ...capabilityFilters, ...overrides };
    setCapabilityFilters(nextFilters);
    if (!selectedProjectId) return;
    const result = await api.capabilities({ projectId: selectedProjectId, ...nextFilters });
    setCapabilities(result.capabilities);
  }

  async function refreshAgentSlots() {
    const result = await api.agentSlots();
    setAgentSlots(result);
  }

  async function refreshDeploymentSettings() {
    const result = await api.deploymentSettings();
    setDeploymentSettings(result.settings);
    return result.settings;
  }

  async function saveDeploymentSettings(processOverrides) {
    const result = await api.updateDeploymentSettings({
      processOverrides,
      actor: "operator-ui"
    });
    setDeploymentSettings(result.settings);
    return result.settings;
  }

  async function updateAgentSlotControls(agentId, patch) {
    setError("");
    setAgentControlPending(agentId);
    try {
      await api.updateAgentSlot(agentId, patch);
      await refreshAgentSlots();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setAgentControlPending("");
    }
  }

  async function handleReleaseAgent(agent) {
    const agentId = agent.id;
    setError("");
    setAgentControlPending(agentId);
    try {
      const result = await api.releaseAgentSlot(agentId, {
        actor: "operator",
        expectedRuntimeId: agent.lease?.runtimeId || "",
        expectedAcquiredAt: agent.lease?.acquiredAt || ""
      });
      setActionNotice(
        result.notice ||
          (result.applied
            ? `Released ${agentId}${result.returnedTasks?.length ? ` and returned ${result.returnedTasks.length} task(s) to ready` : ""}.`
            : "Nothing was changed.")
      );
      await refreshAgentSlots();
      if (selectedProjectId) {
        const refreshed = await api.tasks({ projectId: selectedProjectId });
        setProjectTasks(refreshed.tasks);
      }
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setAgentControlPending("");
    }
  }

  async function updateAgentTypeCapacity(typeId, capacity) {
    setError("");
    setAgentControlPending(`type:${typeId}`);
    try {
      await api.updateAgentType(typeId, { capacity });
      await refreshAgentSlots();
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setAgentControlPending("");
    }
  }

  async function refreshWorktreeCleanup() {
    setWorktreeCleanup((current) => ({ ...current, loading: true, error: "" }));
    const result = await fetchWorktreeCleanup();
    setWorktreeCleanup(result);
    return result;
  }

  async function openLinkedTask(taskId) {
    try {
      setError("");
      markRouteChange();
      if (!projectTasks.some((task) => task.id === taskId)) {
        const result = await api.tasks({ projectId: selectedProjectId });
        setFilters({ q: "", role: "", assignee: "", workItemType: "" });
        setTasks(result.tasks);
        setProjectTasks(result.tasks);
      }
      setView("board");
      setWorkspaceTab("tasks");
      setSelectedTaskId(taskId);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function filterBoardByAgent(agentId) {
    markRouteChange();
    setView("board");
    setWorkspaceTab("tasks");
    setSelectedTaskId("");
    await refreshTasks({ q: "", role: "", assignee: agentId, workItemType: "" });
  }

  useEffect(() => {
    if (initialLoadStartedRef.current) return;
    initialLoadStartedRef.current = true;
    loadAll().catch((nextError) => {
      setError(nextError.message);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (loading || typeof window === "undefined") return;
    const nextUrl = formatWorkboardRoute({
      view,
      workspaceTab,
      projectId: selectedProjectId,
      taskId: selectedTaskId,
      filters
    });
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    const mode = routeWriteModeRef.current;
    routeWriteModeRef.current = "replace";
    if (currentUrl === nextUrl) return;
    window.history[mode === "push" ? "pushState" : "replaceState"]({}, "", nextUrl);
  }, [filters, loading, selectedProjectId, selectedTaskId, view, workspaceTab]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handlePopState = () => {
      const route = parseWorkboardRoute(window.location);
      const nextProjectId = projects.some((project) => project.id === route.projectId)
        ? route.projectId
        : projects[0]?.id || "";
      routeWriteModeRef.current = "replace";
      setView(route.view);
      setWorkspaceTab(route.workspaceTab);
      setSelectedTaskId(route.taskId);
      setFilters(route.filters);
      if (nextProjectId !== selectedProjectId) {
        setSelectedProjectId(nextProjectId);
      } else if (!loading && nextProjectId) {
        refreshTasks(route.filters).catch((nextError) => setError(nextError.message));
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [loading, projects, selectedProjectId]);

  useEffect(() => {
    if (loading || !selectedTaskId) return;
    if (projectTasks.some((task) => task.id === selectedTaskId)) return;
    selectTask("", "replace");
  }, [loading, projectTasks, selectedTaskId]);

  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const query = window.matchMedia(SIDEBAR_NARROW_QUERY);
    const handleChange = () => {
      setIsNarrowViewport(query.matches);
      if (!query.matches) {
        setIsSidebarOverlayOpen(false);
      }
    };

    handleChange();
    if (query.addEventListener) {
      query.addEventListener("change", handleChange);
      return () => query.removeEventListener("change", handleChange);
    }

    query.addListener(handleChange);
    return () => query.removeListener(handleChange);
  }, []);

  useEffect(() => {
    if (!isSidebarOverlayOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setIsSidebarOverlayOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSidebarOverlayOpen]);

  useEffect(() => {
    if (!selectedProjectId || loading) return;
    Promise.all([
      refreshTasks(),
      refreshTalks(),
      refreshActivity(),
      refreshCapabilities(),
      refreshAgentSlots(),
      refreshIntegrationStatus()
    ]).catch((nextError) => setError(nextError.message));
  }, [selectedProjectId]);

  useEffect(() => {
    if (view !== "board" || workspaceTab !== "coordination" || loading || worktreeCleanup.loaded || worktreeCleanup.loading) return;
    refreshWorktreeCleanup().catch((nextError) => setWorktreeCleanup({ ...emptyWorktreeCleanup(nextError.message), loaded: true }));
  }, [view, workspaceTab, loading, worktreeCleanup.loaded, worktreeCleanup.loading]);

  useEffect(() => {
    if (!selectedProjectId || loading) return;
    if (boardProjectRef.current !== selectedProjectId) {
      boardProjectRef.current = selectedProjectId;
      boardVersionRef.current = "";
      setRefreshState({
        status: "connecting",
        lastCheckedAt: "",
        lastUpdatedAt: "",
        nextRetryAt: "",
        error: ""
      });
    }

    const scheduler = createPollingScheduler({
      poll: (options) => pollBoardStateRef.current(options),
      intervalMs: LIVE_POLL_INTERVAL_MS,
      maxBackoffMs: LIVE_POLL_MAX_BACKOFF_MS,
      onError: (nextError, { nextDelayMs }) => {
        pollingNeedsMetaRefreshRef.current = true;
        setRefreshState((current) => ({
          ...current,
          status: "reconnecting",
          lastCheckedAt: new Date().toISOString(),
          nextRetryAt: new Date(Date.now() + nextDelayMs).toISOString(),
          error: nextError.message
        }));
      }
    });

    scheduler.start();
    return () => scheduler.stop();
  }, [selectedProjectId, loading]);

  const boardStats = useMemo(() => {
    const open = projectTasks.filter((task) => task.status !== "done").length;
    const blocked = projectTasks.filter((task) => task.status === "blocked").length;
    const review = projectTasks.filter((task) => task.status === "review").length;
    const approvals = projectTasks.filter(isPendingOperatorApproval).length;
    return { open, blocked, review, approvals };
  }, [projectTasks]);
  const taskFiltersActive = hasTaskFilters(filters);
  const capabilityStats = useMemo(() => {
    const live = capabilities.filter((capability) => capability.status === "live").length;
    const attention = capabilities.filter((capability) => ["broken", "planned", "in_progress", "review"].includes(capability.status)).length;
    const drift = capabilities.filter((capability) => capability.statusDrift?.detected).length;
    return { live, attention, drift };
  }, [capabilities]);

  const agentRegistry = useMemo(
    () => buildAgentRegistry({ agentSlots, tasks: projectTasks, roles: meta.roles, workItemTypes: meta.workItemTypes }),
    [agentSlots, projectTasks, meta.roles, meta.workItemTypes]
  );

  const operatorAttention = useMemo(
    () =>
      buildOperatorAttention({
        tasks: projectTasks,
        agentRegistry,
        staleWork,
        worktreeCleanup,
        promptTemplate: agentDocsOverview.usage?.promptTemplate || "",
        origin: typeof window === "undefined" ? "http://localhost:8088" : window.location.origin,
        projectId: selectedProjectId,
        project: selectedProject
      }),
    [agentDocsOverview, agentRegistry, projectTasks, selectedProject, selectedProjectId, staleWork, worktreeCleanup]
  );

  const coordinationAttention = useMemo(() => {
    const blockedTasks = projectTasks.filter((task) => task.status === "blocked");
    const reviewTasks = projectTasks.filter((task) => task.status === "review");
    const testingTasks = projectTasks.filter((task) => task.status === "testing");
    const staleAgents = agentRegistry.agents.filter((agent) => agent.stale || agent.status === "paused");
    const cleanupAttention =
      (worktreeCleanup.counts?.cleanupReady || 0) +
      (worktreeCleanup.counts?.quarantined || 0) +
      (worktreeCleanup.counts?.unknown || 0);
    return {
      blockedTasks,
      reviewTasks,
      testingTasks,
      staleAgents,
      cleanupAttention,
      count: staleWork.length + blockedTasks.length + reviewTasks.length + testingTasks.length + staleAgents.length + cleanupAttention
    };
  }, [agentRegistry, projectTasks, staleWork, worktreeCleanup]);
  const claimWarningsByTask = useMemo(
    () => new Map(staleWork.map((item) => [item.task?.id || item.taskId, item]).filter(([taskId]) => taskId)),
    [staleWork]
  );
  const roleClaimWarningCounts = useMemo(() => {
    const counts = new Map();
    for (const item of staleWork) {
      const role = item.task?.role;
      if (role) counts.set(role, (counts.get(role) || 0) + 1);
    }
    return counts;
  }, [staleWork]);

  const viewTitle =
    view === "capabilities"
      ? "Capability Registry"
      : view === "agents"
        ? "Agents"
        : view === "settings"
          ? "Settings"
          : selectedProject?.name || "No project";
  const viewHelpTopic = view === "agents" || view === "capabilities" || view === "settings" ? view : null;

  async function runMutation(action) {
    setError("");
    const result = await action();
    await Promise.all([refreshTasks(), refreshTalks(), refreshActivity(), refreshCapabilities(), refreshAgentSlots()]);
    return result;
  }

  async function runWorktreeCleanup(item) {
    const actionKey = `${item.worktreePath}:${item.branch}`;
    const cleanupRequest = item.cleanupRequest || {
      taskId: item.task?.id,
      branch: item.branch,
      worktreePath: item.worktreePath,
      expectedHead: item.head
    };
    setCleanupActionKey(actionKey);
    try {
      await api.cleanupWorktree({
        ...cleanupRequest,
        actor: "operator-ui"
      });
      await Promise.all([refreshWorktreeCleanup(), refreshTasks(), refreshTalks(), refreshActivity()]);
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setCleanupActionKey("");
    }
  }

  async function mutate(action) {
    try {
      await runMutation(action);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  async function recoverStaleWork(item, action) {
    const note = (staleWorkNotes[item.task.id] || "").trim();
    const warningName = item.kind === "off_script" ? "off-script" : "stale";
    const defaultNotes = {
      requeue: `Recovered ${warningName} in-progress work: requeued from ${item.assignee || "unassigned owner"}.`,
      block: `Recovered ${warningName} in-progress work: moved to blocked from ${item.assignee || "unassigned owner"}.`,
      acknowledge: `Acknowledged active ownership for ${item.assignee}.`
    };

    try {
      setActionNotice("");
      const result = await runMutation(() =>
        api.recoverStaleTask(item.task.id, {
          action,
          note: note || defaultNotes[action],
          actor: "operator-ui",
          expectedRevision: item.claim?.revision ?? item.task.revision,
          expectedAssignee: item.claim?.assignee ?? item.assignee,
          expectedClaimedAt: item.claim?.claimedAt || ""
        })
      );
      setActionNotice(result.notice || (result.applied ? "Recovery applied." : "Nothing changed."));
      setStaleWorkNotes((current) => {
        const next = { ...current };
        delete next[item.task.id];
        return next;
      });
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  return (
    <main className={appShellClassName}>
      <aside
        id="project-rail"
        className="projectRail"
        aria-hidden={isNarrowViewport && !isSidebarOverlayOpen ? "true" : undefined}
      >
        <div className="brandBlock">
          <div className="brandIcon">
            <FolderKanban size={22} />
          </div>
          <div>
            <h1>Agent Workboard</h1>
            <p>Projects, tasks, roles, files</p>
          </div>
          <button
            type="button"
            className="iconButton railCloseButton"
            aria-label={isNarrowViewport ? "Close sidebar" : "Collapse sidebar"}
            aria-expanded={sidebarVisible}
            aria-controls="project-rail"
            onClick={closeSidebar}
            title={isNarrowViewport ? "Close sidebar" : "Collapse sidebar"}
          >
            <X size={18} />
          </button>
        </div>

        <div className="railProjectActions">
          <button
            className="railAction"
            onClick={() => {
              setIsCreatingProject(true);
              closeSidebarOverlay();
            }}
          >
            <Plus size={16} />
            <span>Project</span>
          </button>
          <HelpPopover topic="projects" />
        </div>

        <div className="viewSwitch">
          <button
            className={view === "board" ? "selected" : ""}
            onClick={() => {
              navigateView("board", "tasks");
              closeSidebarOverlay();
            }}
          >
            <FolderKanban size={16} />
            <span>Board</span>
          </button>
          <button
            className={view === "agents" ? "selected" : ""}
            onClick={() => {
              navigateView("agents");
              closeSidebarOverlay();
            }}
          >
            <Bot size={16} />
            <span>Agents</span>
          </button>
          <button
            className={view === "capabilities" ? "selected" : ""}
            onClick={() => {
              navigateView("capabilities");
              closeSidebarOverlay();
            }}
          >
            <Database size={16} />
            <span>Capabilities</span>
          </button>
          <button
            className={view === "settings" ? "selected" : ""}
            onClick={() => {
              navigateView("settings");
              closeSidebarOverlay();
            }}
          >
            <Settings size={16} />
            <span>Settings</span>
          </button>
        </div>

        <div className="projectList">
          {projects.map((project) => (
            <button
              key={project.id}
              className={`projectButton ${project.id === selectedProjectId ? "selected" : ""}`}
              onClick={() => {
                selectProject(project.id);
                closeSidebarOverlay();
              }}
            >
              <span className="projectKey">{project.key}</span>
              <span className="projectName">{project.name}</span>
              <ChevronRight size={16} />
            </button>
          ))}
        </div>

        <div className="rolePanel">
          <div className="sectionLabel">Agent Roles</div>
          {meta.roles.map((role) => {
            const Icon = roleIcons[role.id] || Bot;
            const warningCount = roleClaimWarningCounts.get(role.id) || 0;
            return (
              <button
                key={role.id}
                className={`roleChip ${filters.role === role.id ? "selected" : ""} ${warningCount ? "warning" : ""}`}
                onClick={() => {
                  refreshTasks({ role: filters.role === role.id ? "" : role.id }, { routeMode: "push" });
                  closeSidebarOverlay();
                }}
                title={warningCount ? `${role.summary} ${warningCount} claim warning${warningCount === 1 ? "" : "s"}.` : role.summary}
              >
                <Icon size={15} />
                <span>{role.label}</span>
                {warningCount > 0 && (
                  <span className="roleWarningCount" aria-label={`${warningCount} claim warning${warningCount === 1 ? "" : "s"}`}>
                    <AlertCircle size={13} />
                    {warningCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </aside>

      <section className="boardArea">
        <header className="topBar">
          <div className="topTitle">
            <button
              type="button"
              className={`iconButton sidebarToggle ${sidebarVisible ? "active" : ""}`}
              aria-label={sidebarToggleLabel}
              aria-expanded={sidebarVisible}
              aria-controls="project-rail"
              onClick={toggleSidebar}
              title={sidebarToggleLabel}
            >
              <Menu size={19} />
            </button>
            <div>
              <div className="eyebrow">Project</div>
              <div className="topTitleLine">
                <h2>{viewTitle}</h2>
                {viewHelpTopic && <HelpPopover topic={viewHelpTopic} />}
              </div>
            </div>
          </div>
          <div className="topStats">
            {view === "settings" ? (
              <Stat icon={Settings} label="Scope" value="Deployment" />
            ) : view === "capabilities" ? (
              <>
                <Stat icon={CheckCircle2} label="Live" value={capabilityStats.live} />
                <Stat
                  icon={AlertCircle}
                  label="Attention"
                  value={capabilityStats.attention}
                  sublabel={`${capabilityStats.drift} status drift`}
                  title="Capabilities needing attention, including non-live capabilities whose linked implementation tasks are already done."
                />
              </>
            ) : view === "agents" ? (
              <>
                <Stat
                  icon={Bot}
                  label="Active"
                  value={agentRegistry.activeAgents}
                  sublabel={`${agentRegistry.unresponsiveAgents} unresponsive`}
                  title="Agents with a fresh presence heartbeat. Lease-fresh agents without a heartbeat are counted separately as unresponsive."
                />
                <Stat
                  icon={Clock3}
                  label="Busy"
                  value={agentRegistry.busyAgents}
                  sublabel="show workers"
                  title="Show agents with current in-progress work."
                  onClick={() => document.querySelector(".agentStatus-busy")?.scrollIntoView({ behavior: "smooth", block: "center" })}
                />
                <Stat
                  icon={CheckCircle2}
                  label="Available"
                  value={agentRegistry.availableAgents}
                  sublabel={`${agentRegistry.configuredAgentCount} seats`}
                  title="Configured seats currently available for an agent to fill."
                />
              </>
            ) : (
              <>
                <Stat icon={Clock3} label="Open" value={boardStats.open} />
                <Stat icon={AlertCircle} label="Blocked" value={boardStats.blocked} />
                <Stat icon={ShieldCheck} label="Review" value={boardStats.review} />
                <Stat icon={UserRoundCheck} label="Approvals" value={boardStats.approvals} />
              </>
            )}
          </div>
          <IntegrationStatusPill status={meta.integrationStatus} />
          <SystemStatusPill server={meta.server} refreshState={refreshState} />
          <button
            className="primaryButton"
            onClick={() => {
              if (view === "settings") {
                refreshDeploymentSettings().catch((nextError) => setError(nextError.message));
              } else if (view === "capabilities") {
                refreshCapabilities().catch((nextError) => setError(nextError.message));
              } else if (view === "agents") {
                Promise.all([refreshAgentSlots(), refreshTasks()]).catch((nextError) => setError(nextError.message));
              } else {
                setIsCreatingTask(true);
              }
            }}
            disabled={view === "board" && !selectedProjectId}
          >
            {view === "capabilities" || view === "agents" || view === "settings" ? <RefreshCw size={17} /> : <Plus size={17} />}
            <span>{view === "capabilities" || view === "agents" || view === "settings" ? "Refresh" : "Task"}</span>
          </button>
        </header>

        {view === "board" && (
          <WorkspaceTabs
            activeTab={workspaceTab}
            taskCount={taskFiltersActive ? `${tasks.length} of ${projectTasks.length}` : tasks.length}
            coordinationCount={coordinationAttention.count}
            activityCount={activityEvents.length}
            onChange={navigateWorkspaceTab}
          />
        )}

        {view === "capabilities" ? (
          <CapabilityFilters
            filters={capabilityFilters}
            statuses={meta.capabilityStatuses}
            onChange={refreshCapabilities}
          />
        ) : null}

        {error && (
          <div className="errorBanner">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}

        {actionNotice && (
          <div className="actionNoticeBanner" role="status">
            <CheckCircle2 size={18} />
            <span>{actionNotice}</span>
            <button className="iconButton" aria-label="Dismiss notice" onClick={() => setActionNotice("")}>
              <X size={15} />
            </button>
          </div>
        )}

        {view === "board" && !loading && (
          <OperatorAttentionPanel
            attention={operatorAttention}
            onSelectTask={openLinkedTask}
            onOpenCoordination={() => {
              navigateView("board", "coordination");
            }}
            onDecideApproval={(task, payload) => mutate(() => api.decideOperatorApproval(task.id, payload))}
            onCleanup={runWorktreeCleanup}
            cleanupActionKey={cleanupActionKey}
            onRetryDataSource={async () => {
              await api.refreshProjectDataSource(selectedProjectId);
              await loadAll(selectedProjectId);
            }}
          />
        )}

        {loading ? (
          <div className="emptyState">Loading workboard...</div>
        ) : view === "settings" ? (
          <DeploymentSettingsView settings={deploymentSettings} onSave={saveDeploymentSettings} />
        ) : view === "capabilities" ? (
          <CapabilityRegistry
            capabilities={capabilities}
            tasks={projectTasks}
            onOpenTask={openLinkedTask}
          />
        ) : view === "agents" ? (
          <>
            <AgentsRegistry
              registry={agentRegistry}
              onOpenTask={openLinkedTask}
              onFilterAgent={(agentId) => filterBoardByAgent(agentId).catch((nextError) => setError(nextError.message))}
              onUpdateAgentSlot={updateAgentSlotControls}
              onUpdateAgentTypeCapacity={updateAgentTypeCapacity}
              onReleaseAgent={handleReleaseAgent}
              updatingAgentId={agentControlPending}
            />
            <details className="agentsAdvanced agentsOnboardingAdvanced">
              <summary>Advanced: onboarding guide</summary>
              <AgentOnboarding
                roles={meta.roles}
                readyTaskCount={countClaimableReadyTasks(projectTasks, meta.workItemTypes)}
                activeSlotCount={agentSlots.slots.filter((slot) => slot.active).length}
              />
            </details>
          </>
        ) : workspaceTab === "coordination" ? (
          <CoordinationWorkspace
            projectId={selectedProjectId}
            talks={talks}
            tasks={projectTasks}
            filters={talkFilters}
            onFilterChange={refreshTalks}
            onSelectTask={openLinkedTask}
            onPost={(draft) =>
              mutate(async () => {
                await api.postTalk(selectedProjectId, draft);
              })
            }
            staleWork={staleWork}
            staleWorkNotes={staleWorkNotes}
            onStaleWorkNoteChange={(taskId, note) => setStaleWorkNotes((current) => ({ ...current, [taskId]: note }))}
            onRecoverStaleWork={recoverStaleWork}
            attention={coordinationAttention}
            worktreeCleanup={worktreeCleanup}
            onRefreshWorktreeCleanup={() => refreshWorktreeCleanup()}
            onCleanupWorktree={runWorktreeCleanup}
            cleanupActionKey={cleanupActionKey}
          />
        ) : workspaceTab === "activity" ? (
          <ActivityWorkspace
            events={activityEvents}
            filters={activityFilters}
            onFilterChange={refreshActivity}
            onSelectTask={openLinkedTask}
          />
        ) : (
          <TasksWorkspace
            filters={filters}
            onFilterChange={(overrides) => refreshTasks(overrides, { routeMode: "replace" })}
            statuses={meta.statuses}
            roles={meta.roles}
            workItemTypes={meta.workItemTypes}
            tasks={tasks}
            claimWarningsByTask={claimWarningsByTask}
            selectedTaskId={selectedTaskId}
            onSelectTask={selectTask}
            onRecoverClaim={(item) => recoverStaleWork(item, "requeue")}
            onMoveTask={(task, status) => {
              if (status === "done" && task.status !== "done") {
                selectTask(task.id);
                setError("Add a completion record in the task details before marking done.");
                return;
              }
              if (status === "testing" && task.status !== "testing") {
                selectTask(task.id);
                setError("Add a verification target in the task details before moving to testing.");
                return;
              }
              mutate(() => api.updateTask(task.id, { status, actor: "operator-ui" }));
            }}
          />
        )}
      </section>

      {isSidebarOverlayOpen && (
        <button
          type="button"
          className="sidebarScrim"
          aria-label="Close sidebar"
          onClick={() => setIsSidebarOverlayOpen(false)}
        />
      )}

      {selectedTask && (
        <TaskDrawer
          task={selectedTask}
          tasks={tasks}
          statuses={meta.statuses}
          roles={meta.roles}
          workItemTypes={meta.workItemTypes}
          completionTypes={meta.completionTypes}
          capabilities={capabilities}
          agentSlots={agentSlots.slots}
          onClose={() => selectTask("")}
          onMutate={runMutation}
          onReload={() => refreshTasks()}
        />
      )}

      {isCreatingTask && (
        <CreateTaskDialog
          projectId={selectedProjectId}
          roles={meta.roles}
          workItemTypes={meta.workItemTypes}
          agentSlots={agentSlots.slots}
          onClose={() => setIsCreatingTask(false)}
          onCreate={(payload) =>
            mutate(async () => {
              const result = await api.createTask(taskPayloadFromDraft(payload));
              selectTask(result.task.id);
              setIsCreatingTask(false);
            })
          }
        />
      )}

      {isCreatingProject && (
        <CreateProjectDialog
          onClose={() => setIsCreatingProject(false)}
          onPreflight={(payload) => api.preflightProject(payload)}
          onCreate={(payload) =>
            mutate(async () => {
              const result = await api.createProject(payload);
              setIsCreatingProject(false);
              await loadAll(result.project.id);
            })
          }
        />
      )}
    </main>
  );
}

function Stat({ icon: Icon, label, value, sublabel = "", title = "", onClick = null }) {
  const content = (
    <>
      <Icon size={16} />
      <span className="statLabel">
        <span>{label}</span>
        {sublabel && <small>{sublabel}</small>}
      </span>
      <strong>{value}</strong>
    </>
  );
  if (onClick) {
    return (
      <button type="button" className="stat statButton" title={title || sublabel} onClick={onClick}>
        {content}
      </button>
    );
  }
  return (
    <div className="stat" title={title || sublabel}>
      {content}
    </div>
  );
}

function DeploymentSettingsView({ settings, onSave }) {
  const [draft, setDraft] = useState(settings.processOverrides || "");
  const [saveState, setSaveState] = useState({ pending: false, message: "", error: "" });

  useEffect(() => {
    setDraft(settings.processOverrides || "");
  }, [settings.processOverrides, settings.updatedAt]);

  const savedValue = settings.processOverrides || "";
  const changed = draft !== savedValue;

  async function submit(event) {
    event.preventDefault();
    setSaveState({ pending: true, message: "", error: "" });
    try {
      await onSave(draft);
      setSaveState({ pending: false, message: "Deployment process rules saved.", error: "" });
    } catch (error) {
      setSaveState({ pending: false, message: "", error: error.message });
    }
  }

  return (
    <section className="settingsWorkspace" aria-labelledby="deployment-process-rules-title">
      <div className="settingsPanel">
        <div className="settingsPanelHeader">
          <div>
            <div className="eyebrow">Agent instructions</div>
            <h3 id="deployment-process-rules-title">Deployment process rules</h3>
          </div>
          <span className="scopeChip">All agents · all projects</span>
        </div>
        <p className="settingsLead">
          These Markdown rules are injected into every generated agent document and override the board's default workflow.
          Keep bootstrap prompts short; put deployment-specific PR, merge-authority, approval, and cleanup rules here.
        </p>
        <form onSubmit={submit}>
          <label className="fieldLabel" htmlFor="deployment-process-overrides">
            Process overrides (Markdown)
          </label>
          <textarea
            id="deployment-process-overrides"
            className="processOverridesEditor"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaveState({ pending: false, message: "", error: "" });
            }}
            maxLength={50000}
            rows={18}
            placeholder={"Example:\n- Deliver implementation through a branch and pull request.\n- Only the coordinator merges foundation-class changes."}
          />
          <div className="settingsFormFooter">
            <div className="settingsSaveStatus" aria-live="polite">
              {saveState.error ? <span className="settingsError">{saveState.error}</span> : null}
              {saveState.message ? <span className="settingsSuccess">{saveState.message}</span> : null}
              {!saveState.error && !saveState.message && settings.updatedAt ? (
                <span>
                  Last saved {formatDate(settings.updatedAt)} by {settings.updatedBy || "operator"}
                </span>
              ) : null}
              {!saveState.error && !saveState.message && !settings.updatedAt ? (
                <span>Leave empty to use the board defaults without an override section.</span>
              ) : null}
            </div>
            <button className="primaryButton" type="submit" disabled={!changed || saveState.pending}>
              {saveState.pending ? "Saving…" : "Save deployment rules"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

function workItemTypeLabel(workItemTypes, typeId) {
  return workItemTypes.find((type) => type.id === typeId)?.label || typeId || "Task";
}

function relationshipStateLabel(state) {
  if (state === "blocked") return "Blocked";
  if (state === "waiting") return "Waiting";
  if (state === "invalid") return "Invalid link";
  return "Clear";
}

function selectedOptionValues(event) {
  return Array.from(event.target.selectedOptions).map((option) => option.value).filter(Boolean);
}

function SearchableTaskSelect({ label, value, options, onChange, emptyLabel, className = "" }) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const selected = options.find((option) => option.id === value);
  const filtered = normalizedQuery
    ? options.filter((option) => `${option.title} ${option.id}`.toLowerCase().includes(normalizedQuery))
    : options;
  const visibleOptions = selected && !filtered.some((option) => option.id === selected.id)
    ? [selected, ...filtered]
    : filtered;

  return (
    <label className={["searchableTaskPicker", className].filter(Boolean).join(" ")}>
      <span>{label}</span>
      <input
        type="search"
        aria-label={`${label} search`}
        value={query}
        placeholder="Search by title or id"
        onChange={(event) => setQuery(event.target.value)}
      />
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{emptyLabel}</option>
        {visibleOptions.map((option) => (
          <option key={option.id} value={option.id}>{option.title}</option>
        ))}
      </select>
      {normalizedQuery && <small>{filtered.length} matching task{filtered.length === 1 ? "" : "s"}</small>}
    </label>
  );
}

function AssigneeCombobox({ value, onChange, agentSlots, className = "" }) {
  const listId = useId();
  const options = [...new Set((agentSlots || []).map((slot) => slot.id).filter(Boolean))].sort();
  const valid = !value || options.includes(value);
  return (
    <label className={className}>
      Assignee
      <input
        aria-label="Assignee"
        aria-invalid={!valid}
        aria-describedby={valid ? undefined : `${listId}-error`}
        list={listId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Choose a configured slot"
      />
      <datalist id={listId}>
        {options.map((agentId) => <option key={agentId} value={agentId} />)}
      </datalist>
      {!valid && <small className="fieldError" id={`${listId}-error`}>Choose a configured agent slot or leave unassigned.</small>}
    </label>
  );
}

function validConfiguredAssignee(value, agentSlots) {
  return !value || (agentSlots || []).some((slot) => slot.id === value);
}

function IntegrationStatusPill({ status }) {
  if (!status) return null;
  const needsReconcile = status.sourceOfTruth === "reconcile-first";
  const label = needsReconcile ? "Reconcile" : status.baseRef || "Unknown";
  const detail = status.pushDebt
    ? `${status.ahead} ahead, ${status.behind} behind`
    : status.clean === false
      ? "dirty"
      : "clean";
  const title = [
    status.summary,
    `local: ${status.localHead || "unknown"}`,
    `origin: ${status.originHead || "unknown"}`,
    ...(status.recoveryActions || [])
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="integrationStatusGroup">
      <div className={`integrationStatus ${needsReconcile ? "needsReconcile" : status.pushDebt ? "pushDebt" : ""}`} title={title}>
        <Link2 size={15} />
        <span>{label}</span>
        <strong>{detail}</strong>
      </div>
      <HelpPopover topic="integration" />
    </div>
  );
}

function WorkspaceTabs({ activeTab, taskCount, coordinationCount, activityCount, onChange }) {
  const tabs = [
    { id: "tasks", label: "Tasks", count: taskCount, icon: FolderKanban },
    { id: "coordination", label: "Coordination", count: coordinationCount, icon: MessageSquarePlus },
    { id: "activity", label: "Activity", count: activityCount, icon: Clock3 }
  ];

  return (
    <div className="workspaceTabsRow">
      <div className="workspaceTabs" role="tablist" aria-label="Workspace sections">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              className={activeTab === tab.id ? "selected" : ""}
              onClick={() => onChange(tab.id)}
            >
              <Icon size={16} />
              <span>{tab.label}</span>
              <strong>{tab.count}</strong>
            </button>
          );
        })}
      </div>
      <HelpPopover topic={activeTab} />
    </div>
  );
}

function TasksWorkspace({
  filters,
  onFilterChange,
  statuses,
  roles,
  workItemTypes,
  tasks,
  claimWarningsByTask,
  selectedTaskId,
  onSelectTask,
  onMoveTask,
  onRecoverClaim
}) {
  const role = roles.find((candidate) => candidate.id === filters.role);
  const activeFilters = [
    filters.q ? `Search: “${filters.q}”` : "",
    filters.role ? `Role: ${role?.label || filters.role}` : "",
    filters.assignee ? `Assignee: ${filters.assignee}` : "",
    filters.workItemType ? `Type: ${workItemTypeLabel(workItemTypes, filters.workItemType)}` : ""
  ].filter(Boolean);

  return (
    <div className="tasksWorkspace">
      <div className="filterBar">
        <label className="searchBox">
          <Search size={17} />
          <input
            value={filters.q}
            placeholder="Search tasks"
            onChange={(event) => onFilterChange({ q: event.target.value })}
          />
        </label>
        <label className="agentFilter">
          <Filter size={16} />
          <input
            value={filters.assignee}
            placeholder="Agent"
            onChange={(event) => onFilterChange({ assignee: event.target.value })}
          />
        </label>
        <label className="agentFilter">
          <Filter size={16} />
          <select
            aria-label="Work item type filter"
            value={filters.workItemType}
            onChange={(event) => onFilterChange({ workItemType: event.target.value })}
          >
            <option value="">All types</option>
            {workItemTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.label}
              </option>
            ))}
          </select>
        </label>
        {filters.role && (
          <button className="ghostButton" onClick={() => onFilterChange({ role: "" })}>
            <X size={15} />
            <span>{filters.role}</span>
          </button>
        )}
        {filters.workItemType && (
          <button className="ghostButton" onClick={() => onFilterChange({ workItemType: "" })}>
            <X size={15} />
            <span>{workItemTypeLabel(workItemTypes, filters.workItemType)}</span>
          </button>
        )}
      </div>

      {activeFilters.length > 0 && (
        <section className="activeFilterBanner" aria-label="Active task filters">
          <div>
            <Filter size={16} />
            <strong>Filtered view</strong>
            <span>{activeFilters.join(" · ")}</span>
          </div>
          <button
            type="button"
            className="ghostButton"
            onClick={() => onFilterChange({ q: "", role: "", assignee: "", workItemType: "" })}
          >
            <X size={15} />
            <span>Clear all</span>
          </button>
        </section>
      )}

      <KanbanBoard
        statuses={statuses}
        roles={roles}
        workItemTypes={workItemTypes}
        tasks={tasks}
        claimWarningsByTask={claimWarningsByTask}
        selectedTaskId={selectedTaskId}
        onSelectTask={onSelectTask}
        onMoveTask={onMoveTask}
        onRecoverClaim={onRecoverClaim}
      />
    </div>
  );
}

function CoordinationWorkspace({
  projectId,
  talks,
  tasks,
  filters,
  onFilterChange,
  onSelectTask,
  onPost,
  staleWork,
  staleWorkNotes,
  onStaleWorkNoteChange,
  onRecoverStaleWork,
  attention,
  worktreeCleanup,
  onRefreshWorktreeCleanup,
  onCleanupWorktree,
  cleanupActionKey
}) {
  return (
    <div className="coordinationWorkspace">
      <div className="coordinationSummary">
        <CoordinationStat icon={MessageSquarePlus} label="Talks" value={talks.length} targetId="coordination-talks" />
        <CoordinationStat icon={AlertCircle} label="Claim Warnings" value={staleWork.length} targetId="coordination-stale-work" />
        <CoordinationStat
          icon={Archive}
          label="Cleanup"
          value={worktreeCleanup.counts?.cleanupReady || 0}
          targetId="coordination-cleanup"
        />
        <CoordinationStat icon={Clock3} label="Blocked" value={attention.blockedTasks.length} targetId="coordination-blocked" />
        <CoordinationStat icon={ShieldCheck} label="Review" value={attention.reviewTasks.length} targetId="coordination-review" />
      </div>

      <div className="coordinationGrid">
        <div className="coordinationMain">
          <AgentTalksPanel
            projectId={projectId}
            talks={talks}
            tasks={tasks}
            filters={filters}
            onFilterChange={onFilterChange}
            onSelectTask={onSelectTask}
            onPost={onPost}
          />
        </div>

        <div className="coordinationSide">
          {staleWork.length > 0 ? (
            <StaleWorkPanel
              id="coordination-stale-work"
              items={staleWork}
              notes={staleWorkNotes}
              onNoteChange={onStaleWorkNoteChange}
              onRecover={onRecoverStaleWork}
              onSelectTask={onSelectTask}
            />
          ) : (
            <section className="coordinationPanel" id="coordination-stale-work">
              <div className="sectionLabel">Claim Warnings</div>
              <p>No stalled or off-script in-progress claims.</p>
            </section>
          )}
          <WorktreeCleanupPanel
            id="coordination-cleanup"
            report={worktreeCleanup}
            onRefresh={onRefreshWorktreeCleanup}
            onSelectTask={onSelectTask}
            onCleanup={onCleanupWorktree}
            cleanupActionKey={cleanupActionKey}
          />
          <CoordinationAttention attention={attention} onSelectTask={onSelectTask} />
        </div>
      </div>
    </div>
  );
}

function ActivityWorkspace({ events, filters, onFilterChange, onSelectTask }) {
  const extraTypes = useMemo(() => {
    const known = new Set(activityTypes.map((type) => type.id));
    return [...new Set(events.map((event) => event.type).filter((type) => type && !known.has(type)))].sort();
  }, [events]);
  const hasFilters = Boolean(filters.q || filters.type);

  return (
    <div className="activityWorkspace">
      <div className="activityHeader">
        <div>
          <div className="sectionLabel">Audit</div>
          <h3>Recent Activity</h3>
        </div>
        <span>{events.length}</span>
      </div>

      <div className="filterBar activityFilters">
        <label className="searchBox">
          <Search size={17} />
          <input
            aria-label="Search activity"
            value={filters.q}
            placeholder="Search activity"
            onChange={(event) => onFilterChange({ q: event.target.value })}
          />
        </label>
        <label className="agentFilter">
          <Filter size={16} />
          <select
            aria-label="Activity type filter"
            value={filters.type}
            onChange={(event) => onFilterChange({ type: event.target.value })}
          >
            <option value="">All activity</option>
            {activityTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.label}
              </option>
            ))}
            {extraTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        {hasFilters && (
          <button className="ghostButton" onClick={() => onFilterChange({ q: "", type: "" })}>
            <X size={15} />
            <span>Clear</span>
          </button>
        )}
      </div>

      <div className="activityFeed">
        {events.length > 0 ? (
          events.map((event) => (
            <article className={`activityEvent activityType-${activityTypeClass(event.type)}`} key={event.id}>
              <div className="activityEventHeader">
                <span className="activityTypePill">{activityTypeLabel(event.type)}</span>
                <time>{formatDate(event.createdAt)}</time>
              </div>
              <div className="activityEventBody">
                <strong>{event.message}</strong>
                {event.detail && <p>{event.detail}</p>}
              </div>
              <div className="activityEventMeta">
                <span>{event.actor}</span>
                {event.taskId ? (
                  <button className="linkButton activityTaskLink" onClick={() => onSelectTask(event.taskId)}>
                    {event.taskTitle}
                  </button>
                ) : (
                  <span>{event.projectName}</span>
                )}
                {event.taskStatus && <span>{event.taskStatus}</span>}
              </div>
            </article>
          ))
        ) : (
          <div className="activityEmpty">No activity found.</div>
        )}
      </div>
    </div>
  );
}

function activityTypeLabel(type) {
  return activityTypes.find((item) => item.id === type)?.label || type || "Activity";
}

function activityTypeClass(type) {
  return (type || "event").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
}

function CoordinationStat({ icon: Icon, label, value, targetId }) {
  return (
    <a className="coordinationStat" href={`#${targetId}`} aria-label={`${label}: ${value}. Jump to section`}>
      <Icon size={16} />
      <span>{label}</span>
      <strong>{value}</strong>
    </a>
  );
}

function WorktreeCleanupPanel({ id, report, onRefresh, onSelectTask, onCleanup, cleanupActionKey }) {
  const items = (report.items || []).filter((item) => item.status !== "active-keep");
  const activeCount = report.counts?.active || 0;
  const cleanupDisabled = report.cleanup?.mutationsEnabled === false;

  return (
    <section className="worktreeCleanupPanel" id={id} aria-label="Worktree cleanup queue">
      <div className="worktreeCleanupHeader">
        <div>
          <div className="sectionLabel">Repository</div>
          <h3>Worktree Cleanup</h3>
        </div>
        <div className="sectionHeaderActions">
          <HelpPopover topic="cleanup" />
          <button
            className="iconButton"
            onClick={onRefresh}
            title="Refresh cleanup report"
            aria-label="Refresh cleanup report"
            disabled={report.loading}
          >
            <RefreshCw size={15} />
          </button>
        </div>
      </div>

      <div className="cleanupSummary">
        <span>{report.counts?.cleanupReady || 0} ready</span>
        <span>{report.counts?.quarantined || 0} quarantined</span>
        <span>{report.counts?.unknown || 0} unknown</span>
        {activeCount > 0 && <span>{activeCount} active</span>}
        {cleanupDisabled && <span>report-only</span>}
      </div>

      {report.loading ? (
        <p>Loading cleanup report...</p>
      ) : report.error ? (
        <p className="cleanupError">{report.error}</p>
      ) : items.length > 0 ? (
        <div className="cleanupList">
          {items.map((item) => {
            const actionKey = `${item.worktreePath}:${item.branch}`;
            const cleanupBusy = cleanupActionKey === actionKey;
            return (
              <article className={`cleanupCard cleanupStatus-${item.status}`} key={actionKey}>
                <div className="cleanupCardHeader">
                  <span>{cleanupStatusLabel(item.status)}</span>
                  <small>
                    {item.aheadMain} ahead, {item.behindMain} behind
                  </small>
                </div>
                {item.task ? (
                  <button className="linkButton cleanupTaskLink" onClick={() => onSelectTask(item.task.id)}>
                    {item.task.title}
                  </button>
                ) : (
                  <strong className="cleanupTaskLink">{item.branch}</strong>
                )}
                <div className="cleanupMeta">
                  <span>{item.branch}</span>
                  <span>{item.task?.id || "No task"}</span>
                  <span>{item.completion?.commitSha || item.head || "No commit"}</span>
                </div>
                <p>{item.reason}</p>
                {item.cleanupEligible && (
                  <div className="cleanupCommands">
                    <code>{item.commands.removeWorktree}</code>
                    <code>{item.commands.deleteBranch}</code>
                    <button
                      className="cleanupActionButton"
                      onClick={() => onCleanup(item)}
                      disabled={cleanupBusy || cleanupDisabled}
                      title={cleanupDisabled ? report.cleanup?.reason : "Clean worktree"}
                    >
                      <Archive size={14} />
                      <span>{cleanupDisabled ? "Report only" : cleanupBusy ? "Cleaning" : "Clean"}</span>
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : (
        <p>No cleanup candidates.</p>
      )}
    </section>
  );
}

function cleanupStatusLabel(status) {
  if (status === "cleanup-ready") return "Ready";
  if (status === "quarantined-inaccessible") return "Inaccessible";
  if (status === "quarantined-dirty") return "Dirty";
  if (status === "quarantined-unmerged") return "Unmerged";
  if (status === "quarantined-not-done") return "Not done";
  if (status === "unknown-task") return "Unknown";
  return status;
}

function CoordinationAttention({ attention, onSelectTask }) {
  return (
    <section className="coordinationAttention" data-testid="coordination-attention">
      <div className="coordinationAttentionHeader">
        <div>
          <div className="sectionLabel">Attention</div>
          <h3>Queues</h3>
        </div>
        <span>{attention.count}</span>
      </div>
      <AttentionTaskList id="coordination-blocked" label="Blocked" tasks={attention.blockedTasks} onSelectTask={onSelectTask} />
      <AttentionTaskList id="coordination-review" label="Review" tasks={attention.reviewTasks} onSelectTask={onSelectTask} />
      <AttentionTaskList label="Testing" tasks={attention.testingTasks} onSelectTask={onSelectTask} />
      <AttentionAgentList agents={attention.staleAgents} />
    </section>
  );
}

function AttentionTaskList({ id, label, tasks, onSelectTask }) {
  return (
    <div className="attentionList" id={id}>
      <div className="attentionListHeader">
        <span>{label}</span>
        <strong>{tasks.length}</strong>
      </div>
      {tasks.length > 0 ? (
        tasks.slice(0, 5).map((task) => (
          <button key={task.id} className="linkButton attentionLink" onClick={() => onSelectTask(task.id)}>
            <span>{task.title}</span>
            <small>{task.assignee || "Unassigned"}</small>
          </button>
        ))
      ) : (
        <p>None</p>
      )}
    </div>
  );
}

function AttentionAgentList({ agents }) {
  return (
    <div className="attentionList">
      <div className="attentionListHeader">
        <span>Stale Agents</span>
        <strong>{agents.length}</strong>
      </div>
      {agents.length > 0 ? (
        agents.slice(0, 5).map((agent) => (
          <div key={agent.id} className="attentionAgent">
            <span>{agent.id}</span>
            <small>{agent.statusLabel}</small>
          </div>
        ))
      ) : (
        <p>None</p>
      )}
    </div>
  );
}

function RoleIcon({ role }) {
  const Icon = roleIcons[role] || Bot;
  return <Icon size={18} />;
}

function AgentsRegistry({ registry, onOpenTask, onFilterAgent, onUpdateAgentSlot, onUpdateAgentTypeCapacity, onReleaseAgent, updatingAgentId }) {
  const [promptRole, setPromptRole] = useState("");
  const [copiedRole, setCopiedRole] = useState("");
  const [copyFailedRole, setCopyFailedRole] = useState("");
  const groups = registry.groups;

  if (groups.length === 0) {
    return <div className="emptyState">No agents found.</div>;
  }

  async function copyPrompt(role) {
    const prompt = buildAgentBootstrapPrompt(role, window.location.origin);
    const copied = await copyTextToClipboard(prompt);
    setCopiedRole(copied ? role : "");
    setCopyFailedRole(copied ? "" : role);
    window.setTimeout(() => {
      setCopiedRole((current) => (current === role ? "" : current));
      setCopyFailedRole((current) => (current === role ? "" : current));
    }, 1600);
  }

  function copyPromptLabel(role) {
    if (copiedRole === role) return "Copied";
    if (copyFailedRole === role) return "Copy failed";
    return "Copy prompt";
  }

  return (
    <section className="agentsRegistry" aria-label="Agents">
      {groups.map((group) => (
        <section className={`agentGroup roleSummary ${group.needsAttention ? "needsAttention" : ""}`} key={group.role}>
          <div className="roleSummaryHeader">
            <div className="roleSummaryIdentity">
              <span className="agentIcon">
                <RoleIcon role={group.role} />
              </span>
              <div>
                <div className="sectionLabel">{group.role}</div>
                <h3>{group.label}</h3>
                <p>
                  {group.active} active / {group.configured} seats ({group.available} available)
                  {group.unresponsive > 0 ? ` · ${group.unresponsive} unresponsive` : ""}
                </p>
              </div>
            </div>
            {group.canFill ? (
              <button
                type="button"
                className="ghostButton fillSeatButton"
                aria-expanded={promptRole === group.role}
                aria-controls={`fill-prompt-${group.role}`}
                onClick={() => setPromptRole((current) => (current === group.role ? "" : group.role))}
              >
                <Plus size={15} />
                <span>Fill a seat</span>
              </button>
            ) : (
              <span className="noSeatsLabel">No configured seats</span>
            )}
          </div>

          {group.needsAttention && (
            <div className="roleWarning" role="status">
              <AlertCircle size={16} />
              <span>{group.queuedWork} queued item(s), but no agent has a fresh heartbeat.</span>
            </div>
          )}

          {promptRole === group.role && (
            <div className="fillPrompt" id={`fill-prompt-${group.role}`}>
              <code>{buildAgentBootstrapPrompt(group.role, window.location.origin)}</code>
              <button type="button" className="ghostButton" onClick={() => copyPrompt(group.role)}>
                <ClipboardList size={15} />
                <span aria-live="polite">{copyPromptLabel(group.role)}</span>
              </button>
            </div>
          )}

          {group.visibleAgents.length > 0 ? (
            <div className="agentGrid liveAgentGrid">
              {group.visibleAgents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  onOpenTask={onOpenTask}
                  onFilterAgent={onFilterAgent}
                  onUpdateAgentSlot={onUpdateAgentSlot}
                  onReleaseAgent={onReleaseAgent}
                  updatingAgentId={updatingAgentId}
                />
              ))}
            </div>
          ) : (
            <p className="roleQuietState">No active or problem agents.</p>
          )}

          {group.hiddenAgents.length > 0 && (
            <details className="roleSeatsDisclosure">
              <summary>Show all seats and history ({group.hiddenAgents.length} more)</summary>
              <div className="agentGrid historicalAgentGrid">
                {group.hiddenAgents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    onOpenTask={onOpenTask}
                    onFilterAgent={onFilterAgent}
                    onUpdateAgentSlot={onUpdateAgentSlot}
                    onReleaseAgent={onReleaseAgent}
                    updatingAgentId={updatingAgentId}
                  />
                ))}
              </div>
            </details>
          )}
        </section>
      ))}

      <details className="agentsAdvanced">
        <summary>Advanced: agent types and capacity</summary>
        <p>Type taxonomy, specialties, desired capacity, and individual slot diagnostics.</p>
        <AgentTypeCapacityPanel
          types={registry.typeSummaries}
          onUpdateCapacity={onUpdateAgentTypeCapacity}
          updatingAgentId={updatingAgentId}
        />
      </details>
    </section>
  );
}

function AgentTypeCapacityPanel({ types, onUpdateCapacity, updatingAgentId }) {
  if (!types?.length) return null;

  return (
    <section className="agentTypeCapacityPanel" aria-label="Agent type capacity">
      {types.map((type) => {
        const isUpdating = updatingAgentId === `type:${type.id}`;
        const nextLower = Math.max(0, type.capacity - 1);
        const nextHigher = type.capacity + 1;
        return (
          <article className="agentTypeCard" key={type.id}>
            <div className="agentTypeHeader">
              <div>
                <div className="sectionLabel">{type.roleLabel}</div>
                <h3>{type.label}</h3>
              </div>
              <div className="capacityStepper" aria-label={`${type.id} capacity controls`}>
                <button
                  className="iconButton"
                  aria-label={`Decrease ${type.id} capacity`}
                  disabled={isUpdating || type.capacity <= 0}
                  onClick={() => onUpdateCapacity(type.id, nextLower)}
                  title={`Decrease ${type.id} capacity`}
                >
                  <Minus size={16} />
                </button>
                <label>
                  <span>Desired</span>
                  <input
                    aria-label={`${type.id} desired slots`}
                    type="number"
                    min="0"
                    max="20"
                    value={type.capacity}
                    disabled={isUpdating}
                    onChange={(event) => onUpdateCapacity(type.id, Number(event.target.value))}
                  />
                </label>
                <button
                  className="iconButton"
                  aria-label={`Increase ${type.id} capacity`}
                  disabled={isUpdating || type.capacity >= 20}
                  onClick={() => onUpdateCapacity(type.id, nextHigher)}
                  title={`Increase ${type.id} capacity`}
                >
                  <Plus size={16} />
                </button>
              </div>
            </div>

            <div className="agentTypeStats">
              <span>{type.capacity} desired</span>
              <span>{type.occupied} occupied</span>
              <span>{type.free} available</span>
              <span>{type.stale} needs cleanup</span>
              <span>{type.configured} configured</span>
            </div>

            {type.specialties.length > 0 && (
              <div className="tagRow agentSpecialties">
                {type.specialties.slice(0, 5).map((specialty) => (
                  <span key={specialty}>{specialty}</span>
                ))}
              </div>
            )}

            <div className="agentTypeSlots" aria-label={`${type.id} slots`}>
              {type.slots.map((slot) => (
                <span
                  key={slot.id}
                  className={`agentSlotChip ${slot.active ? "active" : ""} ${slot.available ? "free" : ""} ${slot.stale ? "stale" : ""} ${
                    slot.withinCapacity ? "" : "outsideCapacity"
                  }`}
                  title={slot.currentTask ? slot.currentTask.title : slot.statusLabel}
                >
                  {slot.id}
                  <small>
                    {slot.currentTask ? "occupied" : slot.available ? "available" : slot.stale ? "needs cleanup" : slot.statusLabel.toLowerCase()}
                  </small>
                </span>
              ))}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function AgentCard({ agent, onOpenTask, onFilterAgent, onUpdateAgentSlot, onReleaseAgent, updatingAgentId }) {
  const Icon = roleIcons[agent.role] || Bot;
  const linkedTasks = agent.assignedTasks.slice(0, 4);
  const isConfiguredSlot = agent.source === "slot";
  const isUpdating = updatingAgentId === agent.id;
  const isPaused = Boolean(agent.paused);
  const returnableTasks = (agent.assignedTasks || []).filter((task) => task.status === "in_progress");
  const selectedWorkMode = workModeOptions.some((option) => option.id === agent.workMode)
    ? agent.workMode
    : workModeOptions[0].id;
  const displayStatus = agent.paused
    ? "Paused"
    : agent.unresponsive
      ? "Unresponsive"
      : agent.stalled
        ? "Stalled"
        : agent.presenceFresh
          ? "Active"
          : agent.statusLabel;

  function confirmForceRelease() {
    const taskNames = returnableTasks.map((task) => task.title).join(", ");
    const detail = returnableTasks.length
      ? `${returnableTasks.length} task(s) will be returned to ready: ${taskNames}`
      : "No in-progress tasks claimed by this slot.";
    // eslint-disable-next-line no-alert
    if (window.confirm(`Force-release agent slot ${agent.id}? This ignores its lease. ${detail}`)) {
      onReleaseAgent(agent);
    }
  }

  return (
    <article
      className={`agentCard agentStatus-${agent.status} agentSource-${agent.source} ${agent.problem ? "agentProblem" : ""}`}
      data-testid="agent-card"
    >
      <div className="agentCardHeader">
        <div className="agentIdentity">
          <span className="agentIcon">
            <Icon size={18} />
          </span>
          <div>
            <h4>{agent.id}</h4>
            <p>{agent.typeLabel}</p>
          </div>
        </div>
        <span className="agentStatusBadge">{displayStatus}</span>
      </div>

      <div className="agentMeta">
        <span>{agent.roleLabel}</span>
        {agent.source === "task-assignee" && <span>historical assignee</span>}
        <span>{formatHeartbeatAge(agent.heartbeatAt)}</span>
      </div>

      <div className="agentPresenceMessage">
        <div className="sectionLabel">Last message</div>
        <p>{agent.presenceMessage || "No presence message"}</p>
      </div>

      <div className="agentCurrentTask">
        <div className="sectionLabel">Current Task</div>
        {agent.currentTask ? (
          <button className="linkButton" onClick={() => onOpenTask(agent.currentTask.id)}>
            {agent.currentTask.title}
          </button>
        ) : (
          <p>No current task</p>
        )}
      </div>

      <details className="agentDetailsDisclosure">
        <summary>Details{isConfiguredSlot ? " and controls" : ""}</summary>
        <div className="agentMeta">
          {agent.workMode && <span>{agent.workMode}</span>}
          {agent.stale && <span>stale</span>}
          {agent.available && <span>available</span>}
          <span>{agent.lastActivityAt ? formatDate(agent.lastActivityAt) : "No activity"}</span>
        </div>

        {isConfiguredSlot && (
          <div className="agentControls" aria-label={`${agent.id} controls`}>
          <label className="agentModeControl">
            <span>Mode</span>
            <select
              aria-label={`${agent.id} work mode`}
              value={selectedWorkMode}
              disabled={isUpdating}
              onChange={(event) => onUpdateAgentSlot(agent.id, { workMode: event.target.value })}
            >
              {workModeOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ghostButton agentPauseButton"
            disabled={isUpdating}
            aria-label={`${isPaused ? "Resume" : "Pause"} ${agent.id}`}
            onClick={() => onUpdateAgentSlot(agent.id, { paused: !isPaused })}
          >
            {isPaused ? <PlayCircle size={15} /> : <PauseCircle size={15} />}
            <span>{isPaused ? "Resume" : "Pause"}</span>
          </button>
          <button
            className="ghostButton dangerButton agentReleaseButton"
            disabled={isUpdating}
            aria-label={`Force-release ${agent.id}`}
            onClick={confirmForceRelease}
            title="Force-release this slot, ignoring its lease and returning its in-progress tasks to the queue (operator override)"
          >
            <span>Force release</span>
          </button>
          </div>
        )}

      <div className="agentCounts">
        <span>{agent.openTaskCount} open</span>
        <span>{agent.blockedTaskCount} blocked</span>
        <span>{agent.reviewTaskCount} review</span>
      </div>

      {agent.specialties.length > 0 && (
        <div className="tagRow agentSpecialties">
          {agent.specialties.slice(0, 6).map((specialty) => (
            <span key={specialty}>{specialty}</span>
          ))}
        </div>
      )}

      <div className="agentTaskLinks">
        <div className="sectionLabel">Assigned Tasks</div>
        {linkedTasks.length > 0 ? (
          <div>
            {linkedTasks.map((task) => (
              <button key={task.id} className="linkButton" onClick={() => onOpenTask(task.id)}>
                <span>{task.title}</span>
                <small>{task.status}</small>
              </button>
            ))}
          </div>
        ) : (
          <p>No project tasks</p>
        )}
      </div>

      <div className="agentCardActions">
        <button className="ghostButton" onClick={() => onFilterAgent(agent.id)}>
          <Filter size={15} />
          <span>Assigned tasks</span>
        </button>
      </div>
      </details>
    </article>
  );
}

function AgentTalksPanel({ projectId, talks, tasks, filters, onFilterChange, onSelectTask, onPost }) {
  const [draft, setDraft] = useState({
    authorAgentId: "operator-ui",
    kind: "update",
    relatedTaskId: "",
    mentions: "",
    body: ""
  });
  const [visibleTalkCount, setVisibleTalkCount] = useState(TALK_PAGE_SIZE);
  const activeFilterCount = [filters.kind, filters.agentId, filters.taskId].filter(Boolean).length;
  const visibleTalks = talks.slice(0, visibleTalkCount);
  const remainingTalkCount = Math.max(0, talks.length - visibleTalks.length);

  useEffect(() => {
    setVisibleTalkCount(TALK_PAGE_SIZE);
  }, [filters.kind, filters.agentId, filters.taskId, projectId]);

  async function submitTalk() {
    await onPost(draft);
    setDraft({ ...draft, relatedTaskId: "", mentions: "", body: "" });
  }

  return (
    <section className="talksPanel" id="coordination-talks">
      <div className="talksHeader">
        <div>
          <div className="eyebrow">Agent Talks</div>
          <h3>Coordination</h3>
        </div>
        <div className="talksHeaderMeta">
          <span>
            {visibleTalks.length} of {talks.length} shown
          </span>
          {activeFilterCount > 0 && (
            <button className="ghostButton" onClick={() => onFilterChange({ kind: "", agentId: "", taskId: "" })}>
              <Filter size={15} />
              <span>Clear</span>
            </button>
          )}
        </div>
      </div>

      <div className="talksControlDeck">
        <div className="talkFilterPanel">
          <div className="sectionLabel">Filters</div>
          <div className="talkFilters">
            <select
              aria-label="Talk kind filter"
              value={filters.kind}
              onChange={(event) => onFilterChange({ kind: event.target.value })}
            >
              <option value="">All kinds</option>
              {talkKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <input
              aria-label="Talk agent filter"
              value={filters.agentId}
              placeholder="Agent"
              onChange={(event) => onFilterChange({ agentId: event.target.value })}
            />
            <SearchableTaskSelect
              label="Talk task filter"
              value={filters.taskId}
              options={tasks}
              emptyLabel="All tasks"
              onChange={(taskId) => onFilterChange({ taskId })}
            />
          </div>
        </div>

        <div className="talkComposerPanel">
          <div className="talkComposerHeader">
            <div className="sectionLabel">Message</div>
          </div>
          <div className="talkComposer">
            <input
              aria-label="Talk author"
              value={draft.authorAgentId}
              onChange={(event) => setDraft({ ...draft, authorAgentId: event.target.value })}
              placeholder="Author"
            />
            <select aria-label="Talk kind" value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}>
              {talkKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <select
              aria-label="Related talk task"
              value={draft.relatedTaskId}
              onChange={(event) => setDraft({ ...draft, relatedTaskId: event.target.value })}
            >
              <option value="">No task</option>
              {tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
            <input
              aria-label="Talk mentions"
              value={draft.mentions}
              onChange={(event) => setDraft({ ...draft, mentions: event.target.value })}
              placeholder="Mentions"
            />
            <textarea
              aria-label="Talk message"
              value={draft.body}
              onChange={(event) => setDraft({ ...draft, body: event.target.value })}
              placeholder="Message"
            />
          </div>
          <div className="talkComposerActions">
            <button
              className="primaryButton"
              onClick={submitTalk}
              disabled={!draft.authorAgentId.trim() || !draft.body.trim()}
            >
              <Send size={16} />
              <span>Post</span>
            </button>
          </div>
        </div>
      </div>

      <div className="talkList">
        {visibleTalks.map((message) => (
          <article className={`talkMessage talkKind-${message.kind}`} key={message.id}>
            <div className="talkMessageHeader">
              <span className="talkKind">{message.kind}</span>
              <strong>{message.authorAgentId}</strong>
              <time>{formatDate(message.createdAt)}</time>
            </div>
            <p><LinkifiedText>{message.body}</LinkifiedText></p>
            <div className="talkMeta">
              {message.relatedTask && (
                <button onClick={() => onSelectTask(message.relatedTask.id)}>{message.relatedTask.title}</button>
              )}
              {(message.mentions || []).map((mention) => (
                <span key={mention}>@{mention}</span>
              ))}
            </div>
          </article>
        ))}
        {talks.length === 0 && <div className="talkEmpty">No talks</div>}
        {remainingTalkCount > 0 && (
          <div className="talkPagination">
            <span>{remainingTalkCount} older messages</span>
            <button
              className="ghostButton"
              onClick={() => setVisibleTalkCount((count) => count + TALK_PAGE_SIZE)}
            >
              Load {Math.min(TALK_PAGE_SIZE, remainingTalkCount)} more
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function isPendingOperatorApproval(task) {
  return task.blocker?.type === "operator_approval" && task.blocker.status === "pending";
}

function latestTaskComment(task) {
  return task.comments?.[0] || null;
}

function formatDateTime(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function OperatorAttentionPanel({
  attention,
  onSelectTask,
  onOpenCoordination,
  onDecideApproval,
  onCleanup,
  cleanupActionKey,
  onRetryDataSource
}) {
  const [approvalNotes, setApprovalNotes] = useState({});
  const [pendingActionId, setPendingActionId] = useState("");
  const [copiedActionId, setCopiedActionId] = useState("");

  async function copyAction(action, value) {
    if (!value || !navigator.clipboard) return;
    await navigator.clipboard.writeText(value);
    setCopiedActionId(action.id);
    window.setTimeout(() => setCopiedActionId((current) => (current === action.id ? "" : current)), 1800);
  }

  async function decide(action, decision) {
    const note = approvalNotes[action.id]?.trim() || "";
    if (decision !== "approved" && !note) return;
    setPendingActionId(action.id);
    try {
      await onDecideApproval(action.task, {
        decision,
        decidedBy: "operator-ui",
        note,
        nextStatus: decision === "approved" ? action.task.blocker?.nextStatus || "in_progress" : undefined
      });
    } finally {
      setPendingActionId("");
    }
  }

  return (
    <section className="operatorAttention" aria-label="Needs you" data-testid="operator-attention">
      <div className="operatorAttentionHeader">
        <div>
          <div className="sectionLabel">Operator inbox</div>
          <h3>Needs you</h3>
        </div>
        <div className="sectionHeaderActions">
          <HelpPopover topic="attention" />
          <span className="operatorAttentionCount">{attention.actions.length}</span>
        </div>
      </div>

      {attention.actions.length === 0 ? (
        <div className="operatorAttentionEmpty">
          <CheckCircle2 size={18} />
          <span>
            All flowing — {attention.activeAgentCount} {attention.activeAgentCount === 1 ? "agent" : "agents"} active, next expected
            event: {attention.nextExpectedEvent}.
          </span>
        </div>
      ) : (
        <div className="operatorAttentionList">
          {attention.actions.map((action) => {
            const Icon = attentionIcon(action.kind);
            const approvalNote = approvalNotes[action.id] || "";
            const actionBusy = pendingActionId === action.id;
            const cleanupKey = action.cleanupItem
              ? `${action.cleanupItem.worktreePath}:${action.cleanupItem.branch}`
              : "";
            return (
              <article className={`operatorAttentionItem attentionKind-${action.kind}`} data-kind={action.kind} key={action.id}>
                <div className="operatorAttentionIcon" aria-hidden="true">
                  <Icon size={17} />
                </div>
                <div className="operatorAttentionBody">
                  <div className="operatorAttentionTitle">
                    {action.taskId && !["role_gap", "grooming"].includes(action.kind) ? (
                      <button
                        className={`linkButton ${action.kind === "approval" ? "approvalQueueItem" : ""}`}
                        onClick={() => onSelectTask(action.taskId)}
                      >
                        {action.title}
                      </button>
                    ) : (
                      <strong>{action.title}</strong>
                    )}
                    {action.downstreamCount > 1 && <span>{action.downstreamCount - 1} downstream</span>}
                  </div>
                  <div className="operatorActionSentences">
                    <p><strong>What happened:</strong> {action.what}</p>
                    <p><strong>Why it matters:</strong> {action.why}</p>
                    <p><strong>Do this:</strong> {action.doThis}</p>
                  </div>
                  {action.kind === "approval" && (
                    <label className="operatorApprovalNote">
                      Decision note
                      <input
                        value={approvalNote}
                        placeholder="Required to deny"
                        onChange={(event) =>
                          setApprovalNotes((current) => ({ ...current, [action.id]: event.target.value }))
                        }
                      />
                    </label>
                  )}
                  {action.spawnPrompt && <code className="operatorPromptPreview">{action.spawnPrompt}</code>}
                  {action.commands?.length > 0 && action.remedy === "copy_commands" && (
                    <div className="operatorCleanupCommands">
                      {action.commands.map((command) => (
                        <code key={command}>{command}</code>
                      ))}
                    </div>
                  )}
                </div>
                <div className="operatorAttentionActions">
                  {action.spawnPrompt && !usesDedicatedSpawnRemedy(action.kind) && (
                    <button className="attentionSecondaryAction" onClick={() => copyAction(action, action.spawnPrompt)}>
                      <Copy size={14} />
                      <span>{copiedActionId === action.id ? "Copied" : `Copy ${action.spawnRole} prompt`}</span>
                    </button>
                  )}
                  {action.remedy === "decide" && (
                    <>
                      <button className="attentionPrimaryAction" disabled={actionBusy} onClick={() => decide(action, "approved")}>
                        <CheckCircle2 size={14} />
                        <span>{actionBusy ? "Saving" : "Approve"}</span>
                      </button>
                      <button
                        className="attentionSecondaryAction dangerButton"
                        disabled={actionBusy || !approvalNote.trim()}
                        onClick={() => decide(action, "rejected")}
                      >
                        <X size={14} />
                        <span>Deny</span>
                      </button>
                    </>
                  )}
                  {action.remedy === "open_task" && (
                    <button className="attentionPrimaryAction" onClick={() => onSelectTask(action.taskId)}>
                      <ChevronRight size={14} />
                      <span>
                        {action.kind === "merge"
                          ? "Open delivery"
                          : action.kind === "collision"
                            ? "Inspect overlap"
                            : action.kind === "external"
                              ? "Open item"
                              : "Fix blocker"}
                      </span>
                    </button>
                  )}
                  {action.remedy === "open_coordination" && (
                    <button className="attentionPrimaryAction" onClick={onOpenCoordination}>
                      <ChevronRight size={14} />
                      <span>Recover</span>
                    </button>
                  )}
                  {action.remedy === "copy_prompt" && (
                    <button className="attentionPrimaryAction" disabled={!action.prompt} onClick={() => copyAction(action, action.prompt)}>
                      <Copy size={14} />
                      <span>{copiedActionId === action.id ? "Copied" : "Copy spawn prompt"}</span>
                    </button>
                  )}
                  {action.remedy === "groom" && (
                    <>
                      <button className="attentionPrimaryAction" onClick={() => onSelectTask(action.taskId)}>
                        <ClipboardList size={14} />
                        <span>Groom now</span>
                      </button>
                      <button
                        className="attentionSecondaryAction"
                        disabled={!action.prompt}
                        onClick={() => copyAction(action, action.prompt)}
                      >
                        <Copy size={14} />
                        <span>{copiedActionId === action.id ? "Copied" : "Spawn PM"}</span>
                      </button>
                    </>
                  )}
                  {action.remedy === "cleanup" && (
                    <button
                      className="attentionPrimaryAction"
                      disabled={cleanupActionKey === cleanupKey}
                      onClick={() => onCleanup(action.cleanupItem)}
                    >
                      <Archive size={14} />
                      <span>{cleanupActionKey === cleanupKey ? "Cleaning" : "Clean"}</span>
                    </button>
                  )}
                  {action.remedy === "copy_commands" && (
                    <button className="attentionPrimaryAction" onClick={() => copyAction(action, action.commands.join("\n"))}>
                      <Copy size={14} />
                      <span>{copiedActionId === action.id ? "Copied" : "Copy host commands"}</span>
                    </button>
                  )}
                  {action.remedy === "retry_data_source" && (
                    <button className="attentionPrimaryAction" onClick={onRetryDataSource}>
                      <RefreshCw size={14} />
                      <span>Retry source</span>
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function attentionIcon(kind) {
  if (kind === "approval") return UserRoundCheck;
  if (kind === "merge") return GitMerge;
  if (kind === "review_changes") return AlertCircle;
  if (kind === "blocker") return AlertCircle;
  if (kind === "stalled") return WifiOff;
  if (kind === "off_script") return AlertCircle;
  if (kind === "collision") return GitMerge;
  if (kind === "grooming") return ClipboardList;
  if (kind === "cleanup") return Archive;
  if (["data_source", "data_source_mapping"].includes(kind)) return Database;
  if (kind === "external") return Link2;
  return Bot;
}

function StaleWorkPanel({ id, items, notes, onNoteChange, onRecover, onSelectTask }) {
  return (
    <section className="staleWorkPanel" id={id} aria-label="In-progress claim warnings">
      <div className="staleWorkHeader">
        <div>
          <div className="sectionLabel">Needs Attention</div>
          <h3>In-Progress Claim Warnings</h3>
        </div>
        <span>{items.length}</span>
      </div>
      <div className="staleWorkList">
        {items.map((item) => (
          <article className="staleWorkCard" data-testid="stale-work-card" key={item.task.id}>
            <div className="staleWorkBody">
              <button className="linkButton staleTaskLink" onClick={() => onSelectTask(item.task.id)}>
                {item.task.title}
              </button>
              <div className="staleWorkMeta">
                <span className={`claimWarningLabel claimWarning-${item.kind || "stalled"}`}>{item.warningLabel || "STALLED"}</span>
                <span>{item.reasonLabel}</span>
                <span>{item.assignee || "Unassigned"}</span>
                <span>{formatShortDateTime(item.lastProgressAt)}</span>
                {item.freshness?.summary && <span>{item.freshness.summary}</span>}
                {item.freshness?.lastOwnerProgressAt && (
                  <span>Owner {formatShortDateTime(item.freshness.lastOwnerProgressAt)}</span>
                )}
              </div>
            </div>
            <textarea
              placeholder="Recovery note"
              value={notes[item.task.id] || ""}
              onChange={(event) => onNoteChange(item.task.id, event.target.value)}
            />
            <div className="staleWorkActions">
              <button disabled={!(notes[item.task.id] || "").trim()} onClick={() => onRecover(item, "comment")}>
                <MessageSquarePlus size={15} />
                <span>Comment</span>
              </button>
              <button onClick={() => onRecover(item, "requeue")}>
                <ChevronRight size={15} />
                <span>Requeue</span>
              </button>
              <button onClick={() => onRecover(item, "block")}>
                <AlertCircle size={15} />
                <span>Block</span>
              </button>
              <button disabled={!item.canAcknowledge} onClick={() => onRecover(item, "acknowledge")}>
                <CheckCircle2 size={15} />
                <span>Acknowledge</span>
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function CapabilityFilters({ filters, statuses, onChange }) {
  return (
    <div className="filterBar">
      <label className="searchBox">
        <Search size={17} />
        <input
          value={filters.q}
          placeholder="Search capabilities"
          onChange={(event) => onChange({ q: event.target.value })}
        />
      </label>
      <label className="agentFilter">
        <Filter size={16} />
        <select value={filters.status} onChange={(event) => onChange({ status: event.target.value })}>
          <option value="">Any status</option>
          {statuses.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </label>
      {filters.status && (
        <button className="ghostButton" onClick={() => onChange({ status: "" })}>
          <X size={15} />
          <span>{filters.status}</span>
        </button>
      )}
    </div>
  );
}

function SystemStatusPill({ server, refreshState }) {
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  useEffect(() => {
    const intervalId = window.setInterval(() => setCurrentTime(Date.now()), 30_000);
    return () => window.clearInterval(intervalId);
  }, []);
  const status = describeSystemStatus({ server, refreshState, now: currentTime });
  const Icon = status.tone === "disconnected" || status.tone === "reconnecting" ? WifiOff : RefreshCw;

  return (
    <div
      className={`refreshStatus ${status.tone}`}
      aria-live="polite"
      title={status.title}
      data-testid="system-status-pill"
    >
      <Icon size={15} />
      <span>{status.label}</span>
      <small>{status.uptimeLabel} · {status.storageMode} · v{status.version}</small>
      <time>{status.refreshDetail}</time>
    </div>
  );
}

function CapabilityRegistry({ capabilities, tasks, onOpenTask }) {
  if (capabilities.length === 0) {
    return <div className="emptyState">No capabilities match the current filters.</div>;
  }

  return (
    <div className="capabilityRegistry">
      {capabilities.map((capability) => (
        <article className={`capabilityCard ${capability.statusDrift?.detected ? "hasStatusDrift" : ""}`} key={capability.id}>
          <div className="capabilityHeader">
            <div>
              <div className="capabilityTitleRow">
                <h3>{capability.name}</h3>
                <span className={`capabilityStatus ${capability.status}`}>{capability.status}</span>
                {capability.live && <span className="liveBadge">live</span>}
              </div>
              <p>{capability.summary || "No summary recorded."}</p>
            </div>
            <code>{capability.id}</code>
          </div>

          <div className="capabilityMeta">
            <span>{capability.ownerAgent || capability.ownerRole || "No owner"}</span>
            <span>
              {capability.lastVerifiedAt
                ? `Verified ${new Date(capability.lastVerifiedAt).toLocaleString()}`
                : "Never verified"}
            </span>
          </div>

          {capability.statusDrift?.detected && (
            <div className="capabilityDriftWarning" role="status" aria-label="Capability status drift">
              <AlertCircle size={17} />
              <div>
                <strong>Status may be stale</strong>
                <span>{capability.statusDrift.summary}</span>
              </div>
            </div>
          )}

          {capability.surfaces.length > 0 && (
            <div className="tagRow">
              {capability.surfaces.map((surface) => (
                <span key={surface}>{surface}</span>
              ))}
            </div>
          )}

          {capability.relatedTaskIds.length > 0 && (
            <div className="capabilityLinkedTasks">
              <div className="sectionLabel">Linked Tasks</div>
              {capability.relatedTaskIds.map((taskId) => (
                <button
                  key={taskId}
                  className="ghostButton capabilityTaskLink"
                  aria-label={`Open linked task ${taskTitle(tasks, taskId)}`}
                  onClick={() => onOpenTask(taskId)}
                >
                  <Link2 size={14} />
                  <span className="capabilityTaskIdentity">
                    <span>{taskTitle(tasks, taskId)}</span>
                    <small>{taskId}</small>
                  </span>
                  <span className={`capabilityTaskStatus ${linkedTaskStatus(capability, tasks, taskId)}`}>
                    {linkedTaskStatus(capability, tasks, taskId)}
                  </span>
                </button>
              ))}
            </div>
          )}

          {(capability.blockers.length > 0 || capability.dependencies.length > 0) && (
            <div className="capabilityNotes">
              {capability.dependencies.length > 0 && <p>Dependencies: {capability.dependencies.join(", ")}</p>}
              {capability.blockers.length > 0 && <p>Blockers: {capability.blockers.join(", ")}</p>}
            </div>
          )}

          {capability.acceptanceNotes.length > 0 && (
            <div className="capabilityNotes">
              <strong>Acceptance</strong>
              {capability.acceptanceNotes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          )}

          {capability.verificationEvidence.length > 0 && (
            <div className="capabilityNotes">
              <strong>Evidence</strong>
              {capability.verificationEvidence.slice(0, 3).map((evidence) => (
                <p key={evidence}>{evidence}</p>
              ))}
            </div>
          )}

          {capability.notes && <p className="capabilityFreeform">{capability.notes}</p>}
        </article>
      ))}
    </div>
  );
}

function taskTitle(tasks, taskId) {
  const linkedTask = tasks.find((candidate) => candidate.id === taskId);
  return linkedTask?.title || taskId;
}

function linkedTaskStatus(capability, tasks, taskId) {
  const describedTask = capability.linkedTasks?.find((candidate) => candidate.id === taskId);
  if (describedTask) return describedTask.status;
  const task = tasks.find((candidate) => candidate.id === taskId);
  return task?.status || "missing";
}

function capabilityName(capabilities, capabilityId) {
  const capability = capabilities.find((candidate) => candidate.id === capabilityId);
  return capability?.name || capabilityId;
}

function KanbanBoard({
  statuses,
  roles,
  workItemTypes,
  tasks,
  claimWarningsByTask,
  selectedTaskId,
  onSelectTask,
  onMoveTask,
  onRecoverClaim
}) {
  const [draggedTaskId, setDraggedTaskId] = useState("");
  const [dropStatusId, setDropStatusId] = useState("");
  const dragSession = useRef(null);
  const suppressSelectTaskId = useRef("");

  function clearDragState() {
    dragSession.current = null;
    setDraggedTaskId("");
    setDropStatusId("");
  }

  function statusFromPoint(x, y) {
    return document.elementFromPoint(x, y)?.closest("[data-status-id]")?.dataset.statusId || "";
  }

  function handleMouseDown(event, task) {
    if (event.button !== 0 || event.target.closest?.("button, a, input, textarea, select")) return;

    dragSession.current = {
      active: false,
      startX: event.clientX,
      startY: event.clientY,
      taskId: task.id
    };

    window.addEventListener("mousemove", handleWindowMouseMove);
    window.addEventListener("mouseup", handleWindowMouseUp);
  }

  function handleWindowMouseMove(event) {
    const drag = dragSession.current;
    if (!drag) return;

    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.active && distance < DRAG_START_THRESHOLD) return;

    if (!drag.active) {
      drag.active = true;
      suppressSelectTaskId.current = drag.taskId;
      setDraggedTaskId(drag.taskId);
    }

    event.preventDefault();
    const statusId = statusFromPoint(event.clientX, event.clientY);
    setDropStatusId(getTaskDropMove(tasks, drag.taskId, statusId) ? statusId : "");
  }

  function handleWindowMouseUp(event) {
    const drag = dragSession.current;
    window.removeEventListener("mousemove", handleWindowMouseMove);
    window.removeEventListener("mouseup", handleWindowMouseUp);
    if (!drag) return;

    if (!drag.active) {
      clearDragState();
      return;
    }

    event.preventDefault();
    const statusId = statusFromPoint(event.clientX, event.clientY);
    const move = getTaskDropMove(tasks, drag.taskId, statusId);
    clearDragState();

    if (move) {
      onMoveTask(move.task, move.statusId);
    }

    setTimeout(() => {
      if (suppressSelectTaskId.current === drag.taskId) {
        suppressSelectTaskId.current = "";
      }
    }, 0);
  }

  return (
    <div className="kanbanBoard">
      {statuses.map((status) => {
        const columnTasks = tasks.filter((task) => task.status === status.id);
        return (
          <section
            className={`kanbanColumn ${dropStatusId === status.id ? "dropTarget" : ""}`}
            data-status-id={status.id}
            key={status.id}
          >
            <div className="columnHeader">
              <h3>{status.label}</h3>
              <span>{columnTasks.length}</span>
            </div>
            <div className="taskStack">
              {columnTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  claimWarning={claimWarningsByTask.get(task.id)}
                  roles={roles}
                  workItemTypes={workItemTypes}
                  selected={task.id === selectedTaskId}
                  dragging={task.id === draggedTaskId}
                  onSelect={() => {
                    if (suppressSelectTaskId.current === task.id) {
                      suppressSelectTaskId.current = "";
                      return;
                    }
                    onSelectTask(task.id);
                  }}
                  onMouseDown={(event) => handleMouseDown(event, task)}
                  onMove={(nextStatus) => onMoveTask(task, nextStatus)}
                  onRecoverClaim={onRecoverClaim}
                  statuses={statuses}
                />
              ))}
              {columnTasks.length === 0 && <div className="columnEmpty">No tasks</div>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({
  task,
  claimWarning,
  roles,
  workItemTypes,
  statuses,
  selected,
  dragging,
  onSelect,
  onMouseDown,
  onMove,
  onRecoverClaim
}) {
  const role = roles.find((candidate) => candidate.id === task.role);
  const workItemType = workItemTypes.find((candidate) => candidate.id === task.workItemType) || workItemTypes.find((candidate) => candidate.id === "task");
  const dependencyState = task.dependencyStatus?.state || "clear";
  const Icon = roleIcons[task.role] || Bot;
  const statusIndex = statuses.findIndex((status) => status.id === task.status);
  const currentStatus = statuses[statusIndex];
  const nextStatus = statusIndex >= 0 ? statuses[Math.min(statusIndex + 1, statuses.length - 1)] : null;
  const workflowCue = taskWorkflowCue(task);

  return (
    <article
      className={`taskCard ${selected ? "selected" : ""} ${dragging ? "dragging" : ""}`}
      onClick={onSelect}
      onMouseDown={onMouseDown}
    >
      <div className="taskCardTop">
        <span className={`priorityPill ${priorityClass[task.priority]}`}>{task.priority}</span>
        {workItemType && (
          <span className={`workItemTypePill ${workItemType.claimable ? "" : "container"}`}>
            {workItemType.label}
          </span>
        )}
        <span className="roleNamePill" title={role?.summary || task.role}>
          <Icon size={13} />
          {role?.label || task.role}
        </span>
        {currentStatus && <span className="statusPill">{statusControlLabel(task.status, currentStatus)}</span>}
        {task.reviewedBy && <span className="stageOwnerPill">Review: {task.reviewedBy}</span>}
        {task.testedBy && <span className="stageOwnerPill">Testing: {task.testedBy}</span>}
        {task.status === "testing" && task.verificationTarget && (
          <span className="verificationTargetPill" title={verificationTargetTitle(task.verificationTarget)}>
            Verify {verificationTargetLabel(task.verificationTarget)}
          </span>
        )}
        {task.reviewVerdict?.decision === "request_changes" && (
          <span className="changesRequestedPill">Changes requested ({task.reviewVerdict.findingsCount})</span>
        )}
        {task.reviewVerdict?.decision === "approve" && <span className="reviewApprovedPill">Review approved</span>}
        {workflowCue && <span className="workflowPill">{workflowCue}</span>}
        {dependencyState !== "clear" && <span className={`relationshipPill ${dependencyState}`}>{relationshipStateLabel(dependencyState)}</span>}
        {task.collision?.detected && (
          <span
            className="collisionPill"
            title={`Overlaps ${task.collision.taskIds.length} active task${task.collision.taskIds.length === 1 ? "" : "s"}: ${task.collision.paths.join(", ")}`}
          >
            <GitMerge size={13} />
            overlap {task.collision.taskIds.length}
          </span>
        )}
        {task.childTaskIds?.length > 0 && <span className="relationshipPill clear">{task.childTaskIds.length} child</span>}
        {task.status === "done" && task.completion && (
          <span className={`completionPill ${task.completion.completionType === "legacy-needs-audit" ? "needsAudit" : ""}`}>
            {task.completion.completionType}
          </span>
        )}
        {isPendingOperatorApproval(task) && (
          <span className="approvalPill">
            <UserRoundCheck size={13} />
            approval
          </span>
        )}
        {claimWarning && (
          <button
            type="button"
            className={`claimWarningChip claimWarning-${claimWarning.kind || "stalled"}`}
            aria-label={`${claimWarning.warningLabel || "STALLED"}: return ${task.title} to Ready`}
            title={`${claimWarning.freshness?.summary || claimWarning.reasonLabel}. Return this claim to Ready.`}
            onClick={(event) => {
              event.stopPropagation();
              onRecoverClaim(claimWarning);
            }}
          >
            <AlertCircle size={13} />
            <span>{claimWarning.warningLabel || "STALLED"}</span>
            <small>Return to Ready</small>
          </button>
        )}
        {task.attachments.length > 0 && (
          <span className="attachmentPill">
            <Paperclip size={13} />
            {task.attachments.length}
          </span>
        )}
      </div>
      <h4>{task.title}</h4>
      <SafeMarkdown compact>{task.description || "No description yet."}</SafeMarkdown>
      <TaskDeliveryLinks task={task} compact />
      <div className="taskMeta">
        <span title={task.assignee || "Unassigned"}>{task.assignee || "Unassigned"}</span>
      </div>
      <div className="taskActions">
        {nextStatus?.id !== task.status && (
          <button
            aria-label={statusActionLabel(nextStatus)}
            onClick={(event) => {
              event.stopPropagation();
              onMove(nextStatus.id);
            }}
          >
            <ChevronRight size={14} />
            <span>{statusActionLabel(nextStatus)}</span>
          </button>
        )}
      </div>
    </article>
  );
}

function TaskDrawer({ task, tasks, statuses, roles, workItemTypes, completionTypes, capabilities, agentSlots, onClose, onMutate, onReload }) {
  const [comment, setComment] = useState("");
  const [drawerError, setDrawerError] = useState(null);
  const [retryAction, setRetryAction] = useState(null);
  const [draft, setDraft] = useState(() => taskDraftFromTask(task));
  const [hasDraftEdits, setHasDraftEdits] = useState(false);
  const [liveUpdateNotice, setLiveUpdateNotice] = useState(false);
  const [showCompletionForm, setShowCompletionForm] = useState(false);
  const [completionDraft, setCompletionDraft] = useState(() => defaultCompletionDraft(task));
  const [showVerificationForm, setShowVerificationForm] = useState(false);
  const [verificationDraft, setVerificationDraft] = useState(() => defaultVerificationDraft(task));
  const taskVersionRef = useRef({ id: task.id, revision: task.revision, updatedAt: task.updatedAt });
  const relationshipOptions = tasks.filter((candidate) => candidate.projectId === task.projectId && candidate.id !== task.id);
  const assigneeValid = validConfiguredAssignee(draft.assignee, agentSlots);

  useEffect(() => {
    const previous = taskVersionRef.current;
    const isNewTask = previous.id !== task.id;
    const changedElsewhere = previous.revision !== task.revision || previous.updatedAt !== task.updatedAt;
    if (!isNewTask && !changedElsewhere) return;

    taskVersionRef.current = { id: task.id, revision: task.revision, updatedAt: task.updatedAt };
    if (!isNewTask && hasDraftEdits) {
      setLiveUpdateNotice(true);
      return;
    }

    setDraft(taskDraftFromTask(task));
    setCompletionDraft(defaultCompletionDraft(task));
    setVerificationDraft(defaultVerificationDraft(task));
    setShowCompletionForm(false);
    setShowVerificationForm(false);
    setDrawerError(null);
    setRetryAction(null);
    setHasDraftEdits(false);
    setLiveUpdateNotice(false);
  }, [task.id, task.revision, task.updatedAt, hasDraftEdits]);

  function updateDraft(patch) {
    setHasDraftEdits(true);
    setDraft((current) => ({ ...current, ...patch }));
  }

  function updateCompletionDraft(nextDraft) {
    setHasDraftEdits(true);
    setCompletionDraft(nextDraft);
  }

  async function runDrawerMutation(action) {
    try {
      setDrawerError(null);
      setRetryAction(() => action);
      await onMutate(action);
      setRetryAction(null);
    } catch (nextError) {
      setDrawerError(describeTaskSaveError(nextError));
      setRetryAction(() => action);
    }
  }

  async function reloadTaskContext() {
    const wasDirty = hasDraftEdits;
    try {
      await onReload();
      setDraft(taskDraftFromTask(task));
      setCompletionDraft(defaultCompletionDraft(task));
      setVerificationDraft(defaultVerificationDraft(task));
      setShowCompletionForm(false);
      setShowVerificationForm(false);
      setHasDraftEdits(false);
      setDrawerError(null);
      setLiveUpdateNotice(false);
    } catch (nextError) {
      setHasDraftEdits(wasDirty);
      setDrawerError(describeTaskSaveError(nextError));
    }
  }

  const saveCompletion = () =>
    runDrawerMutation(async () => {
      await api.updateTask(task.id, {
        status: "done",
        actor: "operator-ui",
        expectedRevision: task.revision,
        completion: completionPayload(completionDraft)
      });
      setHasDraftEdits(false);
      setLiveUpdateNotice(false);
    });

  const saveVerificationTarget = () =>
    runDrawerMutation(async () => {
      await api.updateTask(task.id, {
        status: "testing",
        actor: "operator-ui",
        expectedRevision: task.revision,
        verificationTarget: verificationTargetPayload(verificationDraft)
      });
      setShowVerificationForm(false);
    });

  return (
    <aside className="drawer">
      <div className="drawerHeader">
        <div>
          <div className="eyebrow">Task</div>
          <h2>{task.title}</h2>
          <TaskDeliveryLinks task={task} />
        </div>
        <button className="iconButton" onClick={onClose} title="Close">
          <X size={18} />
        </button>
      </div>

      <div className="drawerSection statusRow">
        {statuses.map((status) => (
          <button
            key={status.id}
            className={task.status === status.id ? "selected" : ""}
            disabled={task.status === status.id}
            onClick={() => {
              if (status.id === "done" && task.status !== "done") {
                setShowCompletionForm(true);
                return;
              }
              if (status.id === "testing" && task.status !== "testing") {
                setShowVerificationForm(true);
                return;
              }
              runDrawerMutation(() => api.updateTask(task.id, { status: status.id, actor: "operator-ui" }));
            }}
          >
            {statusControlLabel(task.status, status)}
          </button>
        ))}
      </div>

      {drawerError && (
        <TaskSaveErrorPanel
          error={drawerError}
          onRetry={() => retryAction && runDrawerMutation(retryAction)}
          onReload={reloadTaskContext}
        />
      )}

      {liveUpdateNotice && (
        <div className="drawerSection liveUpdateNotice">
          <div>
            <strong>Task changed elsewhere</strong>
            <p>Your draft is still here. Save it when ready or reload the latest task details.</p>
          </div>
          <button className="ghostButton" onClick={reloadTaskContext}>
            <RefreshCw size={16} />
            <span>Reload</span>
          </button>
        </div>
      )}

      <OperatorApprovalPanel
        task={task}
        statuses={statuses}
        onDecide={(payload) => runDrawerMutation(() => api.decideOperatorApproval(task.id, payload))}
      />

      {(task.reviewedBy || task.testedBy || task.reviewVerdict) && (
        <div className="drawerSection stageRecord">
          <div className="sectionTitle">
            <UserRoundCheck size={17} />
            <span>Stage ownership and verdict</span>
          </div>
          {task.reviewedBy && <p>Review claimed by <strong>{task.reviewedBy}</strong></p>}
          {task.testedBy && <p>Testing claimed by <strong>{task.testedBy}</strong></p>}
          {task.reviewVerdict && (
            <div className={`reviewVerdictRecord ${task.reviewVerdict.decision}`}>
              <strong>{task.reviewVerdict.decision === "approve" ? "Approved" : "Changes requested"}</strong>
              <span>{task.reviewVerdict.findingsCount} findings · {task.reviewVerdict.reviewer}</span>
              <code>{task.reviewVerdict.commitSha}</code>
            </div>
          )}
        </div>
      )}

      <VerificationTargetPanel
        task={task}
        draft={verificationDraft}
        setDraft={setVerificationDraft}
        showForm={showVerificationForm}
        setShowForm={setShowVerificationForm}
        onSave={saveVerificationTarget}
      />

      <CompletionPanel
        task={task}
        completionTypes={completionTypes}
        capabilities={capabilities}
        draft={completionDraft}
        setDraft={updateCompletionDraft}
        showForm={showCompletionForm}
        setShowForm={setShowCompletionForm}
        onComplete={saveCompletion}
      />

      <div className="drawerSection formGrid">
        <label>
          Title
          <input value={draft.title} onChange={(event) => updateDraft({ title: event.target.value })} />
        </label>
        <AssigneeCombobox value={draft.assignee} onChange={(assignee) => updateDraft({ assignee })} agentSlots={agentSlots} />
        <label>
          Role
          <select value={draft.role} onChange={(event) => updateDraft({ role: event.target.value })}>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type
          <select
            aria-label="Work item type"
            value={draft.workItemType}
            onChange={(event) => updateDraft({ workItemType: event.target.value })}
          >
            {workItemTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select value={draft.priority} onChange={(event) => updateDraft({ priority: event.target.value })}>
            {["low", "normal", "high", "urgent"].map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </label>
        <label className="wide">
          Labels
          <input value={draft.labels} onChange={(event) => updateDraft({ labels: event.target.value })} />
        </label>
        <label className="wide">
          Touched paths
          <input
            value={draft.touches}
            placeholder="src/App.jsx, server/storage/**"
            onChange={(event) => updateDraft({ touches: event.target.value })}
          />
          <small>Optional file or glob hints used to warn about parallel work.</small>
        </label>
        <label className="wide">
          Description
          <textarea
            value={draft.description}
            onChange={(event) => updateDraft({ description: event.target.value })}
          />
          <span className="fieldPreviewLabel">Preview</span>
          <SafeMarkdown className="descriptionPreview">{draft.description || "No description yet."}</SafeMarkdown>
        </label>
        <label className="wide">
          Pull request URL
          <input
            type="url"
            value={draft.pullRequestUrl}
            onChange={(event) => updateDraft({ pullRequestUrl: event.target.value })}
            placeholder="https://github.com/owner/repo/pull/123"
          />
        </label>
        <label className="wide">
          Branch
          <input
            value={draft.branch}
            onChange={(event) => updateDraft({ branch: event.target.value })}
            placeholder="implementer/task-slug"
          />
        </label>
        <SearchableTaskSelect
          className="wide"
          label="Parent task"
          value={draft.parentTaskId}
          options={relationshipOptions}
          emptyLabel="No parent"
          onChange={(parentTaskId) => updateDraft({ parentTaskId })}
        />
        <label>
          Depends on
          <select
            aria-label="Depends on"
            multiple
            value={draft.dependsOn}
            onChange={(event) => updateDraft({ dependsOn: selectedOptionValues(event) })}
          >
            {relationshipOptions.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Blocked by
          <select
            aria-label="Blocked by"
            multiple
            value={draft.blockedBy}
            onChange={(event) => updateDraft({ blockedBy: selectedOptionValues(event) })}
          >
            {relationshipOptions.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title}
              </option>
            ))}
          </select>
        </label>
        <label className="wide">
          Child tasks
          <select
            aria-label="Child tasks"
            multiple
            value={draft.childTaskIds}
            onChange={(event) => updateDraft({ childTaskIds: selectedOptionValues(event) })}
          >
            {relationshipOptions.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title}
              </option>
            ))}
          </select>
        </label>
        <button
          className="primaryButton wide"
          disabled={!assigneeValid}
          onClick={() =>
            runDrawerMutation(async () => {
              await api.updateTask(task.id, {
                ...taskPayloadFromDraft(draft),
                actor: "operator-ui",
                expectedRevision: task.revision
              });
              setHasDraftEdits(false);
              setLiveUpdateNotice(false);
            })
          }
        >
          <CheckCircle2 size={17} />
          <span>Save</span>
        </button>
      </div>

      <div className="drawerSection">
        <div className="sectionTitle">
          <Paperclip size={17} />
          <span>Files</span>
        </div>
        <label className="uploadButton">
          <FileUp size={16} />
          <span>Upload file</span>
          <input
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) {
                runDrawerMutation(() => api.uploadAttachment(task.id, file, "operator-ui"));
              }
              event.target.value = "";
            }}
          />
        </label>
        <div className="fileList">
          {task.attachments.map((attachment) => (
            <a
              key={attachment.id}
              href={`/api/tasks/${task.id}/attachments/${attachment.id}/download`}
              className="fileItem"
            >
              <Paperclip size={14} />
              <span>{attachment.filename}</span>
            </a>
          ))}
          {task.attachments.length === 0 && <span className="muted">No files yet.</span>}
        </div>
      </div>

      <div className="drawerSection">
        <div className="sectionTitle">
          <MessageSquarePlus size={17} />
          <span>Comments</span>
        </div>
        <div className="commentComposer">
          <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Write an update" />
          <button
            className="primaryButton"
            onClick={() =>
              runDrawerMutation(async () => {
                await api.addComment(task.id, { author: "operator-ui", body: comment });
                setComment("");
              })
            }
            disabled={!comment.trim()}
          >
            <Send size={16} />
          </button>
        </div>
        <div className="commentList">
          {task.comments.map((item) => (
            <div className="comment" key={item.id}>
              <strong>{item.author}</strong>
              <span>{new Date(item.createdAt).toLocaleString()}</span>
              <p><LinkifiedText>{item.body}</LinkifiedText></p>
            </div>
          ))}
        </div>
      </div>

      <div className="drawerSection">
        <div className="sectionTitle">
          <Sparkles size={17} />
          <span>Activity</span>
        </div>
        <div className="activityList">
          {task.activity.map((event) => (
            <div className="activityItem" key={event.id}>
              <span>{event.actor}</span>
              <p>{event.message}</p>
              <time>{new Date(event.createdAt).toLocaleString()}</time>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function OperatorApprovalPanel({ task, statuses, onDecide }) {
  const blocker = task.blocker;
  const comment = latestTaskComment(task);
  const statusOptions = statuses.filter((status) => !["blocked", "done"].includes(status.id));
  const defaultNextStatus = statusOptions.some((status) => status.id === blocker?.nextStatus) ? blocker.nextStatus : "review";
  const [nextStatus, setNextStatus] = useState(defaultNextStatus);
  const [note, setNote] = useState("");
  const [verificationDraft, setVerificationDraft] = useState({ commitSha: "", mergedTo: "", artifactNote: "" });
  const hasVerificationTarget = Boolean(
    verificationDraft.commitSha.trim() || verificationDraft.mergedTo.trim() || verificationDraft.artifactNote.trim()
  );

  useEffect(() => {
    setNextStatus(defaultNextStatus);
    setNote("");
    setVerificationDraft({ commitSha: "", mergedTo: "", artifactNote: "" });
  }, [task.id, blocker?.requestedAt, defaultNextStatus]);

  if (!isPendingOperatorApproval(task)) {
    return null;
  }

  return (
    <div className="drawerSection approvalPanel">
      <div className="sectionTitle">
        <UserRoundCheck size={17} />
        <span>Operator Approval</span>
      </div>
      <div className="approvalFacts">
        <span>{blocker.requestedBy || task.assignee || "agent"}</span>
        <span>{formatDateTime(blocker.requestedAt)}</span>
      </div>
      <div className="approvalRequest">
        <strong>{blocker.requestedAction}</strong>
        {blocker.reason && <p>{blocker.reason}</p>}
        {comment && (
          <blockquote>
            <span>{comment.author}</span>
            <p>{comment.body}</p>
          </blockquote>
        )}
      </div>
      <div className="formGrid approvalDecisionForm">
        <label>
          Approved status
          <select value={nextStatus} onChange={(event) => setNextStatus(event.target.value)}>
            {statusOptions.map((status) => (
              <option key={status.id} value={status.id}>
                {status.label}
              </option>
            ))}
          </select>
        </label>
        <label className="wide">
          Decision note
          <textarea value={note} onChange={(event) => setNote(event.target.value)} />
        </label>
        {nextStatus === "testing" && (
          <>
            <label>
              Verification commit SHA
              <input
                value={verificationDraft.commitSha}
                onChange={(event) => setVerificationDraft({ ...verificationDraft, commitSha: event.target.value })}
              />
            </label>
            <label>
              Verification merged to
              <input
                value={verificationDraft.mergedTo}
                onChange={(event) => setVerificationDraft({ ...verificationDraft, mergedTo: event.target.value })}
              />
            </label>
            <label className="wide">
              Verification artifact note
              <textarea
                value={verificationDraft.artifactNote}
                onChange={(event) => setVerificationDraft({ ...verificationDraft, artifactNote: event.target.value })}
              />
            </label>
          </>
        )}
      </div>
      <div className="approvalActions">
        <button
          className="primaryButton"
          onClick={() =>
            onDecide({
              decision: "approved",
              decidedBy: "operator-ui",
              note,
              nextStatus,
              ...(nextStatus === "testing" ? { verificationTarget: verificationTargetPayload(verificationDraft) } : {})
            })
          }
          disabled={nextStatus === "testing" && !hasVerificationTarget}
        >
          <CheckCircle2 size={16} />
          <span>Approve</span>
        </button>
        <button
          className="ghostButton"
          onClick={() => onDecide({ decision: "changes_requested", decidedBy: "operator-ui", note, nextStatus: "ready" })}
          disabled={!note.trim()}
        >
          <AlertCircle size={16} />
          <span>Changes</span>
        </button>
        <button
          className="ghostButton dangerButton"
          onClick={() => onDecide({ decision: "rejected", decidedBy: "operator-ui", note })}
          disabled={!note.trim()}
        >
          <X size={16} />
          <span>Reject</span>
        </button>
      </div>
    </div>
  );
}

function TaskSaveErrorPanel({ error, onRetry, onReload }) {
  return (
    <div className={`drawerSection saveErrorPanel ${error.tone}`}>
      <div>
        <strong>{error.title}</strong>
        <p>{error.message}</p>
        {error.detail && <span>{error.detail}</span>}
      </div>
      <div className="saveErrorActions">
        {error.canRetry && (
          <button className="primaryButton" onClick={onRetry}>
            <CheckCircle2 size={16} />
            <span>Retry</span>
          </button>
        )}
        {error.canReload && (
          <button className="ghostButton" onClick={onReload}>
            <Clock3 size={16} />
            <span>Reload</span>
          </button>
        )}
      </div>
    </div>
  );
}

function taskDraftFromTask(task) {
  return {
    title: task.title,
    description: task.description,
    pullRequestUrl: task.pullRequestUrl || "",
    branch: task.branch || "",
    assignee: task.assignee,
    role: task.role,
    workItemType: task.workItemType || "task",
    priority: task.priority,
    labels: task.labels.join(", "),
    touches: (task.touches || []).join(", "),
    dependsOn: task.dependsOn || [],
    blockedBy: task.blockedBy || [],
    parentTaskId: task.parentTaskId || "",
    childTaskIds: task.childTaskIds || []
  };
}

function taskPayloadFromDraft(draft) {
  return {
    ...draft,
    workItemType: draft.workItemType || "task",
    dependsOn: draft.dependsOn || [],
    blockedBy: draft.blockedBy || [],
    parentTaskId: draft.parentTaskId || "",
    labels: labelsFromText(draft.labels),
    touches: touchesFromText(draft.touches)
  };
}

function labelsFromText(value) {
  return String(value || "")
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

function defaultVerificationDraft(task) {
  return {
    commitSha: task.verificationTarget?.commitSha || task.reviewVerdict?.commitSha || "",
    mergedTo: task.verificationTarget?.mergedTo || "",
    artifactNote: task.verificationTarget?.artifactNote || ""
  };
}

function verificationTargetPayload(draft) {
  return {
    commitSha: draft.commitSha.trim(),
    mergedTo: draft.mergedTo.trim(),
    artifactNote: draft.artifactNote.trim()
  };
}

function verificationTargetLabel(target) {
  return target.commitSha || target.mergedTo || target.artifactNote || "target";
}

function verificationTargetTitle(target) {
  return [
    target.commitSha ? `Commit: ${target.commitSha}` : "",
    target.mergedTo ? `Merged to: ${target.mergedTo}` : "",
    target.artifactNote ? `Artifact: ${target.artifactNote}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function VerificationTargetPanel({ task, draft, setDraft, showForm, setShowForm, onSave }) {
  const target = task.verificationTarget;
  const canSave = draft.commitSha.trim() || draft.mergedTo.trim() || draft.artifactNote.trim();

  return (
    <div className="drawerSection verificationTargetSection">
      <div className="sectionTitle">
        <TestTube2 size={17} />
        <span>Verification Target</span>
      </div>
      {task.status === "testing" && target && !showForm ? (
        <div className="verificationTargetRecord">
          {target.commitSha && <code>{target.commitSha}</code>}
          {target.mergedTo && <p>Merged to: {target.mergedTo}</p>}
          {target.artifactNote && <p>{target.artifactNote}</p>}
          <button className="ghostButton" onClick={() => setShowForm(true)}>
            Edit target
          </button>
        </div>
      ) : showForm ? (
        <div className="formGrid verificationTargetForm">
          <p className="wide muted">Name the running artifact a tester must verify. At least one field is required.</p>
          <label>
            Commit SHA
            <input value={draft.commitSha} onChange={(event) => setDraft({ ...draft, commitSha: event.target.value })} />
          </label>
          <label>
            Merged To
            <input value={draft.mergedTo} onChange={(event) => setDraft({ ...draft, mergedTo: event.target.value })} placeholder="main or deployment" />
          </label>
          <label className="wide">
            Artifact Note
            <textarea
              value={draft.artifactNote}
              onChange={(event) => setDraft({ ...draft, artifactNote: event.target.value })}
              placeholder="URL, image tag, environment, or manual verification target"
            />
          </label>
          <button className="primaryButton wide" onClick={onSave} disabled={!canSave}>
            <TestTube2 size={17} />
            <span>{task.status === "testing" ? "Save Target" : "Move to Testing"}</span>
          </button>
        </div>
      ) : (
        <button className="ghostButton wide" onClick={() => setShowForm(true)}>
          <TestTube2 size={17} />
          <span>Prepare Testing Target</span>
        </button>
      )}
    </div>
  );
}

function touchesFromText(value) {
  return String(value || "")
    .split(",")
    .map((touch) => touch.trim())
    .filter(Boolean);
}

function defaultCompletionDraft(task) {
  const completion = task.completion || {};
  return {
    completionType: completion.completionType === "legacy-needs-audit" ? "audit-only" : completion.completionType || defaultCompletionType(task),
    branch: completion.branch || "",
    commitSha: completion.commitSha || "",
    mergedTo: completion.mergedTo || "main",
    tests: (completion.tests || []).join("\n"),
    reviewTaskId: completion.reviewTaskId || "",
    supersededByTaskId: completion.supersededByTaskId || "",
    capabilityIds: completion.capabilityIds || [],
    notes: completion.notes || ""
  };
}

function defaultCompletionType(task) {
  return task.role === "implementer" ? "merged" : "no-code";
}

function completionPayload(draft) {
  return {
    ...draft,
    tests: draft.tests
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean),
    capabilityIds: draft.capabilityIds || []
  };
}

function CompletionPanel({ task, completionTypes, capabilities, draft, setDraft, showForm, setShowForm, onComplete }) {
  const completion = task.completion;
  const editableTypes = (completionTypes || []).filter((type) => type !== "legacy-needs-audit");
  const type = draft.completionType;
  const capabilityIds = draft.capabilityIds || [];
  const canComplete =
    type === "merged"
      ? draft.commitSha.trim()
      : type === "superseded"
        ? draft.supersededByTaskId.trim() || draft.notes.trim()
        : draft.notes.trim();
  const toggleCapability = (capabilityId) => {
    const nextIds = capabilityIds.includes(capabilityId)
      ? capabilityIds.filter((idValue) => idValue !== capabilityId)
      : [...capabilityIds, capabilityId];
    setDraft({ ...draft, capabilityIds: nextIds });
  };

  return (
    <div className="drawerSection completionSection">
      <div className="sectionTitle">
        <CheckCircle2 size={17} />
        <span>Completion Record</span>
      </div>

      {task.status === "done" && completion ? (
        <div className={`completionRecord ${completion.completionType === "legacy-needs-audit" ? "needsAudit" : ""}`}>
          <div>
            <strong>{completion.completionType}</strong>
            <span>{completion.completedBy || "unknown"} - {completion.completedAt ? new Date(completion.completedAt).toLocaleString() : "no date"}</span>
          </div>
          {completion.commitSha && <code>{completion.commitSha}</code>}
          {completion.branch && <p>Branch: {completion.branch}</p>}
          {completion.mergedTo && <p>Merged to: {completion.mergedTo}</p>}
          {completion.tests?.length > 0 && <p>Tests: {completion.tests.join(", ")}</p>}
          {completion.reviewTaskId && <p>Review task: {completion.reviewTaskId}</p>}
          {completion.supersededByTaskId && <p>Superseded by: {completion.supersededByTaskId}</p>}
          {completion.capabilityIds?.length > 0 && (
            <p>Capabilities: {completion.capabilityIds.map((capabilityId) => capabilityName(capabilities, capabilityId)).join(", ")}</p>
          )}
          {completion.notes && <p>{completion.notes}</p>}
        </div>
      ) : (
        <>
          {!showForm && (
            <button className="primaryButton wide" onClick={() => setShowForm(true)}>
              <CheckCircle2 size={17} />
              <span>Complete With Record</span>
            </button>
          )}
          {showForm && (
            <div className="formGrid completionForm">
              <label>
                Type
                <select
                  value={draft.completionType}
                  onChange={(event) => setDraft({ ...draft, completionType: event.target.value })}
                >
                  {(editableTypes.length ? editableTypes : ["merged", "no-code", "audit-only", "superseded"]).map((completionType) => (
                    <option key={completionType} value={completionType}>
                      {completionType}
                    </option>
                  ))}
                </select>
              </label>

              {type === "merged" && (
                <>
                  <label>
                    Branch
                    <input value={draft.branch} onChange={(event) => setDraft({ ...draft, branch: event.target.value })} />
                  </label>
                  <label>
                    Commit SHA
                    <input value={draft.commitSha} onChange={(event) => setDraft({ ...draft, commitSha: event.target.value })} />
                  </label>
                  <label>
                    Merged To
                    <input value={draft.mergedTo} onChange={(event) => setDraft({ ...draft, mergedTo: event.target.value })} />
                  </label>
                  <label className="wide">
                    Tests
                    <textarea value={draft.tests} onChange={(event) => setDraft({ ...draft, tests: event.target.value })} />
                  </label>
                </>
              )}

              {type === "superseded" && (
                <label className="wide">
                  Superseded By Task
                  <input
                    value={draft.supersededByTaskId}
                    onChange={(event) => setDraft({ ...draft, supersededByTaskId: event.target.value })}
                  />
                </label>
              )}

              <label className="wide">
                Review Task
                <input value={draft.reviewTaskId} onChange={(event) => setDraft({ ...draft, reviewTaskId: event.target.value })} />
              </label>
              {capabilities.length > 0 && (
                <div className="wide capabilityPicker">
                  <div className="sectionTitle">
                    <Database size={16} />
                    <span>Capability Evidence</span>
                  </div>
                  <div className="capabilityCheckboxes">
                    {capabilities.map((capability) => (
                      <label key={capability.id}>
                        <input
                          type="checkbox"
                          checked={capabilityIds.includes(capability.id)}
                          onChange={() => toggleCapability(capability.id)}
                        />
                        <span>{capability.name}</span>
                        <code>{capability.status}</code>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <label className="wide">
                Notes
                <textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} />
              </label>
              <button className="primaryButton wide" onClick={onComplete} disabled={!canComplete}>
                <CheckCircle2 size={17} />
                <span>Mark Done</span>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CreateTaskDialog({ projectId, roles, workItemTypes, agentSlots, onClose, onCreate }) {
  const [draft, setDraft] = useState({
    projectId,
    title: "",
    description: "",
    pullRequestUrl: "",
    branch: "",
    role: "implementer",
    workItemType: "task",
    priority: "normal",
    assignee: "",
    labels: "",
    touches: ""
  });
  const assigneeValid = validConfiguredAssignee(draft.assignee, agentSlots);

  return (
    <Dialog title="New task" onClose={onClose}>
      <div className="formGrid">
        <label className="wide">
          Title
          <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </label>
        <label>
          Role
          <select value={draft.role} onChange={(event) => setDraft({ ...draft, role: event.target.value })}>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type
          <select
            aria-label="Work item type"
            value={draft.workItemType}
            onChange={(event) => setDraft({ ...draft, workItemType: event.target.value })}
          >
            {workItemTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {type.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value })}>
            {["low", "normal", "high", "urgent"].map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </label>
        <AssigneeCombobox
          className="wide"
          value={draft.assignee}
          onChange={(assignee) => setDraft({ ...draft, assignee })}
          agentSlots={agentSlots}
        />
        <label className="wide">
          Labels
          <input value={draft.labels} onChange={(event) => setDraft({ ...draft, labels: event.target.value })} />
        </label>
        <label className="wide">
          Touched paths
          <input
            value={draft.touches}
            placeholder="src/App.jsx, server/storage/**"
            onChange={(event) => setDraft({ ...draft, touches: event.target.value })}
          />
          <small>Optional file or glob hints used to warn about parallel work.</small>
        </label>
        <label className="wide">
          Description
          <textarea
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </label>
        <label className="wide">
          Pull request URL
          <input
            type="url"
            value={draft.pullRequestUrl}
            onChange={(event) => setDraft({ ...draft, pullRequestUrl: event.target.value })}
            placeholder="https://github.com/owner/repo/pull/123"
          />
        </label>
        <label className="wide">
          Branch
          <input
            value={draft.branch}
            onChange={(event) => setDraft({ ...draft, branch: event.target.value })}
            placeholder="implementer/task-slug"
          />
        </label>
        <button className="primaryButton wide" onClick={() => onCreate(draft)} disabled={!draft.title.trim() || !assigneeValid}>
          <Plus size={17} />
          <span>Create task</span>
        </button>
      </div>
    </Dialog>
  );
}

function CreateProjectDialog({ onClose, onCreate, onPreflight }) {
  const [draft, setDraft] = useState({ name: "", key: "", description: "", tasksDir: "", repoDir: "" });
  const [preflight, setPreflight] = useState({ pending: false, report: null, confirmationToken: "", error: "" });
  const [confirmed, setConfirmed] = useState(false);
  const hasTasksDir = Boolean(draft.tasksDir.trim());

  function updateDraft(patch) {
    setDraft((current) => ({ ...current, ...patch }));
    if (Object.prototype.hasOwnProperty.call(patch, "tasksDir")) {
      setPreflight({ pending: false, report: null, confirmationToken: "", error: "" });
      setConfirmed(false);
    }
  }

  async function runPreflight() {
    setPreflight({ pending: true, report: null, confirmationToken: "", error: "" });
    setConfirmed(false);
    try {
      const result = await onPreflight({ tasksDir: draft.tasksDir, repoDir: draft.repoDir });
      setPreflight({ pending: false, report: result.report, confirmationToken: result.confirmationToken || "", error: "" });
    } catch (error) {
      setPreflight({ pending: false, report: null, confirmationToken: "", error: error.message });
    }
  }

  function createPayload() {
    const { tasksDir, repoDir, ...project } = draft;
    if (!tasksDir.trim()) return project;
    return {
      ...project,
      dataSource: {
        tasksDir: tasksDir.trim(),
        ...(repoDir.trim() ? { repoDir: repoDir.trim() } : {})
      },
      preflightToken: preflight.confirmationToken
    };
  }

  const sourceReady = !hasTasksDir || (preflight.report?.go && preflight.confirmationToken && confirmed);
  return (
    <Dialog title="New project" onClose={onClose}>
      <div className="formGrid">
        <label>
          Name
          <input value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} />
        </label>
        <label>
          Key
          <input value={draft.key} onChange={(event) => updateDraft({ key: event.target.value })} />
        </label>
        <label className="wide">
          Description
          <textarea
            value={draft.description}
            onChange={(event) => updateDraft({ description: event.target.value })}
          />
        </label>
        <label className="wide">
          Tasks folder path <span className="muted">(optional)</span>
          <input
            value={draft.tasksDir}
            onChange={(event) => updateDraft({ tasksDir: event.target.value })}
            placeholder="C:\\repo\\tasks"
          />
        </label>
        <label className="wide">
          Repository path <span className="muted">(optional)</span>
          <input
            value={draft.repoDir}
            onChange={(event) => updateDraft({ repoDir: event.target.value })}
            placeholder="C:\\repo"
          />
        </label>
        {hasTasksDir && (
          <button className="ghostButton wide" onClick={runPreflight} disabled={preflight.pending}>
            <ShieldCheck size={17} />
            <span>{preflight.pending ? "Checking folder…" : "Check tasks folder"}</span>
          </button>
        )}
        {preflight.error && <div className="projectPreflight error wide">{preflight.error}</div>}
        {preflight.report && (
          <div className={`projectPreflight wide ${preflight.report.go ? "go" : "noGo"}`}>
            <strong>{preflight.report.go ? "Preflight passed" : "Preflight blocked"}</strong>
            <span>
              {preflight.report.summary.parsed} parsed, {preflight.report.summary.failed} failed across {preflight.report.summary.taskFiles} task files
            </span>
            {preflight.report.blockers.length > 0 && (
              <ul>{preflight.report.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
            )}
            <details>
              <summary>Full doctor report</summary>
              <pre>{JSON.stringify(preflight.report, null, 2)}</pre>
            </details>
            {preflight.report.go && (
              <label className="projectPreflightConfirmation">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                I reviewed this report and want to bind the project to this folder.
              </label>
            )}
          </div>
        )}
        <button
          className="primaryButton wide"
          onClick={() => onCreate(createPayload())}
          disabled={!draft.name.trim() || !sourceReady}
        >
          <Archive size={17} />
          <span>Create project</span>
        </button>
      </div>
    </Dialog>
  );
}

function formatShortDateTime(value) {
  if (!value) return "No progress";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function Dialog({ title, children, onClose }) {
  return (
    <div className="dialogBackdrop">
      <section className="dialog">
        <div className="drawerHeader">
          <h2>{title}</h2>
          <button className="iconButton" onClick={onClose} title="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
