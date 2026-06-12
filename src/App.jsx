import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Archive,
  Bot,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock3,
  Database,
  FileUp,
  Filter,
  FolderKanban,
  Link2,
  MessageSquarePlus,
  Paperclip,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  TestTube2,
  UserRoundCheck,
  WifiOff,
  X
} from "lucide-react";
import { api } from "./lib/api.js";
import { describeTaskSaveError } from "./lib/taskSaveErrors.js";
import { getTaskDropMove } from "./lib/kanbanDrag.js";

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
const LIVE_POLL_INTERVAL_MS = 2500;

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

function formatClock(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function App() {
  const [meta, setMeta] = useState({ roles: [], statuses: [], completionTypes: [], capabilityStatuses: [] });
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [projectTasks, setProjectTasks] = useState([]);
  const [talks, setTalks] = useState([]);
  const [capabilities, setCapabilities] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [filters, setFilters] = useState({ q: "", role: "", assignee: "" });
  const [talkFilters, setTalkFilters] = useState({ kind: "", agentId: "", taskId: "" });
  const [staleWork, setStaleWork] = useState([]);
  const [staleWorkNotes, setStaleWorkNotes] = useState({});
  const [capabilityFilters, setCapabilityFilters] = useState({ q: "", status: "" });
  const [view, setView] = useState("board");
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshState, setRefreshState] = useState({
    status: "connecting",
    lastCheckedAt: "",
    lastUpdatedAt: "",
    error: ""
  });
  const boardVersionRef = useRef("");
  const boardProjectRef = useRef("");

  const selectedTask = projectTasks.find((task) => task.id === selectedTaskId);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  async function loadAll(projectId = selectedProjectId) {
    setError("");
    const [metaResult, projectsResult] = await Promise.all([api.meta(), api.projects()]);
    const nextProjects = projectsResult.projects;
    const nextProjectId = projectId || nextProjects[0]?.id || "";
    const [tasksResult, projectTasksResult, talksResult, staleResult, capabilitiesResult] = nextProjectId
      ? await Promise.all([
          api.tasks({
            projectId: nextProjectId,
            q: filters.q,
            role: filters.role,
            assignee: filters.assignee
          }),
          api.tasks({ projectId: nextProjectId }),
          api.talks(nextProjectId, talkFilters),
          api.staleInProgressTasks({ projectId: nextProjectId }),
          api.capabilities({ projectId: nextProjectId, ...capabilityFilters })
        ])
      : [{ tasks: [] }, { tasks: [] }, { messages: [] }, { tasks: [] }, { capabilities: [] }];
    setMeta(metaResult);
    setProjects(nextProjects);
    setSelectedProjectId(nextProjectId);
    setTasks(tasksResult.tasks);
    setProjectTasks(projectTasksResult.tasks);
    setTalks(talksResult.messages);
    setStaleWork(staleResult.tasks);
    setCapabilities(capabilitiesResult.capabilities);
    setLoading(false);
  }

  async function refreshTasks(overrides = null) {
    const nextFilters = overrides ? { ...filters, ...overrides } : filters;
    if (overrides) {
      setFilters(nextFilters);
    }
    if (!selectedProjectId) return;
    const [result, projectResult, staleResult] = await Promise.all([
      api.tasks({ projectId: selectedProjectId, ...nextFilters }),
      api.tasks({ projectId: selectedProjectId }),
      api.staleInProgressTasks({ projectId: selectedProjectId })
    ]);
    setTasks(result.tasks);
    setProjectTasks(projectResult.tasks);
    setStaleWork(staleResult.tasks);
    return result.tasks;
  }

  async function refreshTalks(overrides = {}, projectId = selectedProjectId) {
    const nextFilters = { ...talkFilters, ...overrides };
    setTalkFilters(nextFilters);
    if (!projectId) return;
    const result = await api.talks(projectId, nextFilters);
    setTalks(result.messages);
    return result.messages;
  }

  async function pollBoardState({ refreshOnChange = true } = {}) {
    if (!selectedProjectId) return;

    const checkedAt = new Date().toISOString();
    try {
      const result = await api.boardState({ projectId: selectedProjectId });
      const previousVersion = boardVersionRef.current;
      const changed = Boolean(previousVersion && previousVersion !== result.state.version);

      if (changed && refreshOnChange) {
        setRefreshState({
          status: "updating",
          lastCheckedAt: checkedAt,
          lastUpdatedAt: result.state.latestUpdatedAt || "",
          error: ""
        });
        await refreshTasks();
      }

      boardVersionRef.current = result.state.version;
      setRefreshState({
        status: changed && refreshOnChange ? "updated" : "live",
        lastCheckedAt: new Date().toISOString(),
        lastUpdatedAt: result.state.latestUpdatedAt || "",
        error: ""
      });
    } catch (nextError) {
      setRefreshState((current) => ({
        ...current,
        status: "disconnected",
        lastCheckedAt: checkedAt,
        error: nextError.message
      }));
    }
  }

  async function refreshCapabilities(overrides = {}) {
    const nextFilters = { ...capabilityFilters, ...overrides };
    setCapabilityFilters(nextFilters);
    if (!selectedProjectId) return;
    const result = await api.capabilities({ projectId: selectedProjectId, ...nextFilters });
    setCapabilities(result.capabilities);
  }

  async function openLinkedTask(taskId) {
    try {
      setError("");
      if (!projectTasks.some((task) => task.id === taskId)) {
        const result = await api.tasks({ projectId: selectedProjectId });
        setFilters({ q: "", role: "", assignee: "" });
        setTasks(result.tasks);
        setProjectTasks(result.tasks);
      }
      setView("board");
      setSelectedTaskId(taskId);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  useEffect(() => {
    loadAll().catch((nextError) => {
      setError(nextError.message);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!selectedProjectId || loading) return;
    Promise.all([refreshTasks(), refreshTalks(), refreshCapabilities()]).catch((nextError) => setError(nextError.message));
  }, [selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId || loading) return;
    if (boardProjectRef.current !== selectedProjectId) {
      boardProjectRef.current = selectedProjectId;
      boardVersionRef.current = "";
      setRefreshState({
        status: "connecting",
        lastCheckedAt: "",
        lastUpdatedAt: "",
        error: ""
      });
    }

    let stopped = false;
    const poll = (options) =>
      pollBoardState(options).catch((nextError) => {
        if (!stopped) {
          setRefreshState((current) => ({
            ...current,
            status: "disconnected",
            lastCheckedAt: new Date().toISOString(),
            error: nextError.message
          }));
        }
      });

    poll({ refreshOnChange: false });
    const intervalId = window.setInterval(() => poll(), LIVE_POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearInterval(intervalId);
    };
  }, [selectedProjectId, filters, loading]);

  const boardStats = useMemo(() => {
    const open = tasks.filter((task) => task.status !== "done").length;
    const blocked = tasks.filter((task) => task.status === "blocked").length;
    const review = tasks.filter((task) => task.status === "review").length;
    return { open, blocked, review };
  }, [tasks]);

  const capabilityStats = useMemo(() => {
    const live = capabilities.filter((capability) => capability.status === "live").length;
    const attention = capabilities.filter((capability) => ["broken", "planned", "in_progress", "review"].includes(capability.status)).length;
    return { live, attention };
  }, [capabilities]);

  async function runMutation(action) {
    setError("");
    const result = await action();
    await Promise.all([refreshTasks(), refreshTalks(), refreshCapabilities()]);
    return result;
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
    const defaultNotes = {
      requeue: `Recovered stale in-progress work: requeued from ${item.assignee || "unassigned owner"}.`,
      block: `Recovered stale in-progress work: moved to blocked from ${item.assignee || "unassigned owner"}.`,
      acknowledge: `Acknowledged active ownership for ${item.assignee}.`
    };

    try {
      await runMutation(async () => {
        const body = note || defaultNotes[action];
        if (body) {
          await api.addComment(item.task.id, { author: "operator-ui", body });
        }
        if (action === "requeue") {
          await api.updateTask(item.task.id, { status: "ready", assignee: "", actor: "operator-ui" });
        } else if (action === "block") {
          await api.updateTask(item.task.id, { status: "blocked", actor: "operator-ui" });
        } else if (action === "acknowledge") {
          await api.updatePresence(item.assignee, {
            state: "active",
            currentTaskId: item.task.id,
            message: body || "Ownership acknowledged from operator UI."
          });
        }
      });
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
    <main className="appShell">
      <aside className="projectRail">
        <div className="brandBlock">
          <div className="brandIcon">
            <FolderKanban size={22} />
          </div>
          <div>
            <h1>Agent Workboard</h1>
            <p>Projects, tasks, roles, files</p>
          </div>
        </div>

        <button className="railAction" onClick={() => setIsCreatingProject(true)}>
          <Plus size={16} />
          <span>Project</span>
        </button>

        <div className="viewSwitch">
          <button className={view === "board" ? "selected" : ""} onClick={() => setView("board")}>
            <FolderKanban size={16} />
            <span>Board</span>
          </button>
          <button className={view === "capabilities" ? "selected" : ""} onClick={() => setView("capabilities")}>
            <Database size={16} />
            <span>Capabilities</span>
          </button>
        </div>

        <div className="projectList">
          {projects.map((project) => (
            <button
              key={project.id}
              className={`projectButton ${project.id === selectedProjectId ? "selected" : ""}`}
              onClick={() => setSelectedProjectId(project.id)}
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
            return (
              <button
                key={role.id}
                className={`roleChip ${filters.role === role.id ? "selected" : ""}`}
                onClick={() => refreshTasks({ role: filters.role === role.id ? "" : role.id })}
                title={role.summary}
              >
                <Icon size={15} />
                <span>{role.label}</span>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="boardArea">
        <header className="topBar">
          <div>
            <div className="eyebrow">Project</div>
            <h2>{view === "capabilities" ? "Capability Registry" : selectedProject?.name || "No project"}</h2>
          </div>
          <div className="topStats">
            {view === "capabilities" ? (
              <>
                <Stat icon={CheckCircle2} label="Live" value={capabilityStats.live} />
                <Stat icon={AlertCircle} label="Attention" value={capabilityStats.attention} />
              </>
            ) : (
              <>
                <Stat icon={Clock3} label="Open" value={boardStats.open} />
                <Stat icon={AlertCircle} label="Blocked" value={boardStats.blocked} />
                <Stat icon={ShieldCheck} label="Review" value={boardStats.review} />
              </>
            )}
          </div>
          <BoardRefreshStatus state={refreshState} />
          <button
            className="primaryButton"
            onClick={() => (view === "capabilities" ? refreshCapabilities() : setIsCreatingTask(true))}
            disabled={!selectedProjectId}
          >
            {view === "capabilities" ? <RefreshCw size={17} /> : <Plus size={17} />}
            <span>{view === "capabilities" ? "Refresh" : "Task"}</span>
          </button>
        </header>

        {view === "capabilities" ? (
          <CapabilityFilters
            filters={capabilityFilters}
            statuses={meta.capabilityStatuses}
            onChange={refreshCapabilities}
          />
        ) : (
          <div className="filterBar">
            <label className="searchBox">
              <Search size={17} />
              <input
                value={filters.q}
                placeholder="Search tasks"
                onChange={(event) => refreshTasks({ q: event.target.value })}
              />
            </label>
            <label className="agentFilter">
              <Filter size={16} />
              <input
                value={filters.assignee}
                placeholder="Agent"
                onChange={(event) => refreshTasks({ assignee: event.target.value })}
              />
            </label>
            {filters.role && (
              <button className="ghostButton" onClick={() => refreshTasks({ role: "" })}>
                <X size={15} />
                <span>{filters.role}</span>
              </button>
            )}
          </div>
        )}

        <AgentTalksPanel
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
        />

        {error && (
          <div className="errorBanner">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}

        {staleWork.length > 0 && (
          <StaleWorkPanel
            items={staleWork}
            notes={staleWorkNotes}
            onNoteChange={(taskId, note) => setStaleWorkNotes((current) => ({ ...current, [taskId]: note }))}
            onRecover={recoverStaleWork}
            onSelectTask={setSelectedTaskId}
          />
        )}

        {loading ? (
          <div className="emptyState">Loading workboard...</div>
        ) : view === "capabilities" ? (
          <CapabilityRegistry
            capabilities={capabilities}
            tasks={projectTasks}
            onOpenTask={openLinkedTask}
          />
        ) : (
          <KanbanBoard
            statuses={meta.statuses}
            roles={meta.roles}
            tasks={tasks}
            selectedTaskId={selectedTaskId}
            onSelectTask={setSelectedTaskId}
            onMoveTask={(task, status) => {
              if (status === "done" && task.status !== "done") {
                setSelectedTaskId(task.id);
                setError("Add a completion record in the task details before marking done.");
                return;
              }
              mutate(() => api.updateTask(task.id, { status, actor: "operator-ui" }));
            }}
          />
        )}
      </section>

      {selectedTask && (
        <TaskDrawer
          task={selectedTask}
          statuses={meta.statuses}
          roles={meta.roles}
          completionTypes={meta.completionTypes}
          capabilities={capabilities}
          onClose={() => setSelectedTaskId("")}
          onMutate={runMutation}
          onReload={() => refreshTasks()}
        />
      )}

      {isCreatingTask && (
        <CreateTaskDialog
          projectId={selectedProjectId}
          roles={meta.roles}
          onClose={() => setIsCreatingTask(false)}
          onCreate={(payload) =>
            mutate(async () => {
              const result = await api.createTask(payload);
              setSelectedTaskId(result.task.id);
              setIsCreatingTask(false);
            })
          }
        />
      )}

      {isCreatingProject && (
        <CreateProjectDialog
          onClose={() => setIsCreatingProject(false)}
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

function Stat({ icon: Icon, label, value }) {
  return (
    <div className="stat">
      <Icon size={16} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AgentTalksPanel({ talks, tasks, filters, onFilterChange, onSelectTask, onPost }) {
  const [draft, setDraft] = useState({
    authorAgentId: "operator-ui",
    kind: "update",
    relatedTaskId: "",
    mentions: "",
    body: ""
  });

  async function submitTalk() {
    await onPost(draft);
    setDraft({ ...draft, relatedTaskId: "", mentions: "", body: "" });
  }

  return (
    <section className="talksPanel">
      <div className="talksHeader">
        <div>
          <div className="eyebrow">Agent Talks</div>
          <h3>Coordination</h3>
        </div>
        <div className="talkFilters">
          <select value={filters.kind} onChange={(event) => onFilterChange({ kind: event.target.value })}>
            <option value="">All kinds</option>
            {talkKinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
          <input
            value={filters.agentId}
            placeholder="Agent"
            onChange={(event) => onFilterChange({ agentId: event.target.value })}
          />
          <select value={filters.taskId} onChange={(event) => onFilterChange({ taskId: event.target.value })}>
            <option value="">All tasks</option>
            {tasks.map((task) => (
              <option key={task.id} value={task.id}>
                {task.title}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="talkComposer">
        <input
          value={draft.authorAgentId}
          onChange={(event) => setDraft({ ...draft, authorAgentId: event.target.value })}
          placeholder="Author"
        />
        <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}>
          {talkKinds.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
        <select value={draft.relatedTaskId} onChange={(event) => setDraft({ ...draft, relatedTaskId: event.target.value })}>
          <option value="">No task</option>
          {tasks.map((task) => (
            <option key={task.id} value={task.id}>
              {task.title}
            </option>
          ))}
        </select>
        <input
          value={draft.mentions}
          onChange={(event) => setDraft({ ...draft, mentions: event.target.value })}
          placeholder="Mentions"
        />
        <textarea
          value={draft.body}
          onChange={(event) => setDraft({ ...draft, body: event.target.value })}
          placeholder="Message"
        />
        <button className="primaryButton" onClick={submitTalk} disabled={!draft.authorAgentId.trim() || !draft.body.trim()}>
          <Send size={16} />
          <span>Post</span>
        </button>
      </div>

      <div className="talkList">
        {talks.map((message) => (
          <article className={`talkMessage talkKind-${message.kind}`} key={message.id}>
            <div className="talkMessageHeader">
              <span className="talkKind">{message.kind}</span>
              <strong>{message.authorAgentId}</strong>
              <time>{formatDate(message.createdAt)}</time>
            </div>
            <p>{message.body}</p>
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
      </div>
    </section>
  );
}

function StaleWorkPanel({ items, notes, onNoteChange, onRecover, onSelectTask }) {
  return (
    <section className="staleWorkPanel" aria-label="Stale in-progress work">
      <div className="staleWorkHeader">
        <div>
          <div className="sectionLabel">Needs Attention</div>
          <h3>Stale In-Progress Work</h3>
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
                <span>{item.reasonLabel}</span>
                <span>{item.assignee || "Unassigned"}</span>
                <span>{formatShortDateTime(item.lastProgressAt)}</span>
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

function BoardRefreshStatus({ state }) {
  const disconnected = state.status === "disconnected";
  const Icon = disconnected ? WifiOff : RefreshCw;
  const label =
    state.status === "updated"
      ? "Updated"
      : state.status === "updating"
        ? "Updating"
        : disconnected
          ? "Disconnected"
          : state.status === "connecting"
            ? "Connecting"
            : "Live";
  const checkedAt = formatClock(state.lastCheckedAt);
  const updatedAt = formatClock(state.lastUpdatedAt);

  return (
    <div className={`refreshStatus ${state.status}`} aria-live="polite" title={state.error || "Board refresh status"}>
      <Icon size={15} />
      <span>{label}</span>
      <time>{checkedAt ? `Checked ${checkedAt}` : updatedAt ? `Updated ${updatedAt}` : "Checking"}</time>
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
        <article className="capabilityCard" key={capability.id}>
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
            {capability.lastVerifiedAt && <span>Verified {new Date(capability.lastVerifiedAt).toLocaleString()}</span>}
          </div>

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
                <button key={taskId} className="ghostButton" onClick={() => onOpenTask(taskId)}>
                  <Link2 size={14} />
                  <span>{taskTitle(tasks, taskId)}</span>
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
  const task = tasks.find((candidate) => candidate.id === taskId);
  return task?.title || taskId;
}

function capabilityName(capabilities, capabilityId) {
  const capability = capabilities.find((candidate) => candidate.id === capabilityId);
  return capability?.name || capabilityId;
}

function KanbanBoard({ statuses, roles, tasks, selectedTaskId, onSelectTask, onMoveTask }) {
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
                  roles={roles}
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
  roles,
  statuses,
  selected,
  dragging,
  onSelect,
  onMouseDown,
  onMove
}) {
  const role = roles.find((candidate) => candidate.id === task.role);
  const Icon = roleIcons[task.role] || Bot;
  const nextStatus = statuses[Math.min(statuses.findIndex((status) => status.id === task.status) + 1, statuses.length - 1)];

  return (
    <article
      className={`taskCard ${selected ? "selected" : ""} ${dragging ? "dragging" : ""}`}
      onClick={onSelect}
      onMouseDown={onMouseDown}
    >
      <div className="taskCardTop">
        <span className={`priorityPill ${priorityClass[task.priority]}`}>{task.priority}</span>
        {task.status === "done" && task.completion && (
          <span className={`completionPill ${task.completion.completionType === "legacy-needs-audit" ? "needsAudit" : ""}`}>
            {task.completion.completionType}
          </span>
        )}
        {task.attachments.length > 0 && (
          <span className="attachmentPill">
            <Paperclip size={13} />
            {task.attachments.length}
          </span>
        )}
      </div>
      <h4>{task.title}</h4>
      <p>{task.description || "No description yet."}</p>
      <div className="taskMeta">
        <span title={role?.summary}>
          <Icon size={14} />
          {role?.label || task.role}
        </span>
        <span title={task.assignee || "Unassigned"}>{task.assignee || "Unassigned"}</span>
      </div>
      <div className="taskActions">
        {nextStatus?.id !== task.status && (
          <button
            onClick={(event) => {
              event.stopPropagation();
              onMove(nextStatus.id);
            }}
          >
            <ChevronRight size={14} />
            <span>{nextStatus.label}</span>
          </button>
        )}
      </div>
    </article>
  );
}

function TaskDrawer({ task, statuses, roles, completionTypes, capabilities, onClose, onMutate, onReload }) {
  const [comment, setComment] = useState("");
  const [drawerError, setDrawerError] = useState(null);
  const [retryAction, setRetryAction] = useState(null);
  const [draft, setDraft] = useState(() => taskDraftFromTask(task));
  const [hasDraftEdits, setHasDraftEdits] = useState(false);
  const [liveUpdateNotice, setLiveUpdateNotice] = useState(false);
  const [showCompletionForm, setShowCompletionForm] = useState(false);
  const [completionDraft, setCompletionDraft] = useState(() => defaultCompletionDraft(task));
  const taskVersionRef = useRef({ id: task.id, updatedAt: task.updatedAt });

  useEffect(() => {
    const previous = taskVersionRef.current;
    const isNewTask = previous.id !== task.id;
    const changedElsewhere = previous.updatedAt !== task.updatedAt;
    if (!isNewTask && !changedElsewhere) return;

    taskVersionRef.current = { id: task.id, updatedAt: task.updatedAt };
    if (!isNewTask && hasDraftEdits) {
      setLiveUpdateNotice(true);
      return;
    }

    setDraft(taskDraftFromTask(task));
    setCompletionDraft(defaultCompletionDraft(task));
    setShowCompletionForm(false);
    setDrawerError(null);
    setRetryAction(null);
    setHasDraftEdits(false);
    setLiveUpdateNotice(false);
  }, [task.id, task.updatedAt, hasDraftEdits]);

  function updateDraft(patch) {
    setHasDraftEdits(true);
    setDraft({ ...draft, ...patch });
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
      setShowCompletionForm(false);
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
        completion: completionPayload(completionDraft)
      });
      setHasDraftEdits(false);
      setLiveUpdateNotice(false);
    });

  return (
    <aside className="drawer">
      <div className="drawerHeader">
        <div>
          <div className="eyebrow">Task</div>
          <h2>{task.title}</h2>
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
            onClick={() => {
              if (status.id === "done" && task.status !== "done") {
                setShowCompletionForm(true);
                return;
              }
              runDrawerMutation(() => api.updateTask(task.id, { status: status.id, actor: "operator-ui" }));
            }}
          >
            {status.label}
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
        <label>
          Assignee
          <input
            value={draft.assignee}
            onChange={(event) => updateDraft({ assignee: event.target.value })}
            placeholder="agent name"
          />
        </label>
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
          Description
          <textarea
            value={draft.description}
            onChange={(event) => updateDraft({ description: event.target.value })}
          />
        </label>
        <button
          className="primaryButton wide"
          onClick={() =>
            runDrawerMutation(async () => {
              await api.updateTask(task.id, {
                ...draft,
                labels: draft.labels,
                actor: "operator-ui"
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
              <p>{item.body}</p>
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
    assignee: task.assignee,
    role: task.role,
    priority: task.priority,
    labels: task.labels.join(", ")
  };
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

function CreateTaskDialog({ projectId, roles, onClose, onCreate }) {
  const [draft, setDraft] = useState({
    projectId,
    title: "",
    description: "",
    role: "implementer",
    priority: "normal",
    assignee: "",
    labels: ""
  });

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
          Priority
          <select value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: event.target.value })}>
            {["low", "normal", "high", "urgent"].map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
        </label>
        <label className="wide">
          Assignee
          <input value={draft.assignee} onChange={(event) => setDraft({ ...draft, assignee: event.target.value })} />
        </label>
        <label className="wide">
          Labels
          <input value={draft.labels} onChange={(event) => setDraft({ ...draft, labels: event.target.value })} />
        </label>
        <label className="wide">
          Description
          <textarea
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </label>
        <button className="primaryButton wide" onClick={() => onCreate(draft)} disabled={!draft.title.trim()}>
          <Plus size={17} />
          <span>Create task</span>
        </button>
      </div>
    </Dialog>
  );
}

function CreateProjectDialog({ onClose, onCreate }) {
  const [draft, setDraft] = useState({ name: "", key: "", description: "" });
  return (
    <Dialog title="New project" onClose={onClose}>
      <div className="formGrid">
        <label>
          Name
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <label>
          Key
          <input value={draft.key} onChange={(event) => setDraft({ ...draft, key: event.target.value })} />
        </label>
        <label className="wide">
          Description
          <textarea
            value={draft.description}
            onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          />
        </label>
        <button className="primaryButton wide" onClick={() => onCreate(draft)} disabled={!draft.name.trim()}>
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
