import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Archive,
  Bot,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock3,
  FileUp,
  Filter,
  FolderKanban,
  MessageSquarePlus,
  Paperclip,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  TestTube2,
  UserRoundCheck,
  X
} from "lucide-react";
import { api } from "./lib/api.js";

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

export function App() {
  const [meta, setMeta] = useState({ roles: [], statuses: [], completionTypes: [] });
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [filters, setFilters] = useState({ q: "", role: "", assignee: "" });
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const selectedTask = tasks.find((task) => task.id === selectedTaskId);
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  async function loadAll(projectId = selectedProjectId) {
    setError("");
    const [metaResult, projectsResult] = await Promise.all([api.meta(), api.projects()]);
    const nextProjects = projectsResult.projects;
    const nextProjectId = projectId || nextProjects[0]?.id || "";
    const tasksResult = await api.tasks({
      projectId: nextProjectId,
      q: filters.q,
      role: filters.role,
      assignee: filters.assignee
    });
    setMeta(metaResult);
    setProjects(nextProjects);
    setSelectedProjectId(nextProjectId);
    setTasks(tasksResult.tasks);
    setLoading(false);
  }

  async function refreshTasks(overrides = {}) {
    const nextFilters = { ...filters, ...overrides };
    setFilters(nextFilters);
    if (!selectedProjectId) return;
    const result = await api.tasks({ projectId: selectedProjectId, ...nextFilters });
    setTasks(result.tasks);
  }

  useEffect(() => {
    loadAll().catch((nextError) => {
      setError(nextError.message);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!selectedProjectId || loading) return;
    refreshTasks().catch((nextError) => setError(nextError.message));
  }, [selectedProjectId]);

  const boardStats = useMemo(() => {
    const open = tasks.filter((task) => task.status !== "done").length;
    const blocked = tasks.filter((task) => task.status === "blocked").length;
    const review = tasks.filter((task) => task.status === "review").length;
    return { open, blocked, review };
  }, [tasks]);

  async function mutate(action) {
    try {
      setError("");
      await action();
      await refreshTasks();
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
            <h2>{selectedProject?.name || "No project"}</h2>
          </div>
          <div className="topStats">
            <Stat icon={Clock3} label="Open" value={boardStats.open} />
            <Stat icon={AlertCircle} label="Blocked" value={boardStats.blocked} />
            <Stat icon={ShieldCheck} label="Review" value={boardStats.review} />
          </div>
          <button className="primaryButton" onClick={() => setIsCreatingTask(true)} disabled={!selectedProjectId}>
            <Plus size={17} />
            <span>Task</span>
          </button>
        </header>

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

        {error && (
          <div className="errorBanner">
            <AlertCircle size={18} />
            <span>{error}</span>
          </div>
        )}

        {loading ? (
          <div className="emptyState">Loading workboard...</div>
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
          onClose={() => setSelectedTaskId("")}
          onMutate={mutate}
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

function KanbanBoard({ statuses, roles, tasks, selectedTaskId, onSelectTask, onMoveTask }) {
  return (
    <div className="kanbanBoard">
      {statuses.map((status) => {
        const columnTasks = tasks.filter((task) => task.status === status.id);
        return (
          <section className="kanbanColumn" key={status.id}>
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
                  onSelect={() => onSelectTask(task.id)}
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

function TaskCard({ task, roles, statuses, selected, onSelect, onMove }) {
  const role = roles.find((candidate) => candidate.id === task.role);
  const Icon = roleIcons[task.role] || Bot;
  const nextStatus = statuses[Math.min(statuses.findIndex((status) => status.id === task.status) + 1, statuses.length - 1)];

  return (
    <article className={`taskCard ${selected ? "selected" : ""}`} onClick={onSelect}>
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

function TaskDrawer({ task, statuses, roles, completionTypes, onClose, onMutate }) {
  const [comment, setComment] = useState("");
  const [draft, setDraft] = useState({
    title: task.title,
    description: task.description,
    assignee: task.assignee,
    role: task.role,
    priority: task.priority,
    labels: task.labels.join(", ")
  });
  const [showCompletionForm, setShowCompletionForm] = useState(false);
  const [completionDraft, setCompletionDraft] = useState(() => defaultCompletionDraft(task));

  useEffect(() => {
    setDraft({
      title: task.title,
      description: task.description,
      assignee: task.assignee,
      role: task.role,
      priority: task.priority,
      labels: task.labels.join(", ")
    });
    setCompletionDraft(defaultCompletionDraft(task));
    setShowCompletionForm(false);
  }, [task.id, task.status]);

  const saveCompletion = () =>
    onMutate(() =>
      api.updateTask(task.id, {
        status: "done",
        actor: "operator-ui",
        completion: completionPayload(completionDraft)
      })
    );

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
              onMutate(() => api.updateTask(task.id, { status: status.id, actor: "operator-ui" }));
            }}
          >
            {status.label}
          </button>
        ))}
      </div>

      <CompletionPanel
        task={task}
        completionTypes={completionTypes}
        draft={completionDraft}
        setDraft={setCompletionDraft}
        showForm={showCompletionForm}
        setShowForm={setShowCompletionForm}
        onComplete={saveCompletion}
      />

      <div className="drawerSection formGrid">
        <label>
          Title
          <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        </label>
        <label>
          Assignee
          <input
            value={draft.assignee}
            onChange={(event) => setDraft({ ...draft, assignee: event.target.value })}
            placeholder="agent name"
          />
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
        <button
          className="primaryButton wide"
          onClick={() =>
            onMutate(() =>
              api.updateTask(task.id, {
                ...draft,
                labels: draft.labels,
                actor: "operator-ui"
              })
            )
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
                onMutate(() => api.uploadAttachment(task.id, file, "operator-ui"));
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
              onMutate(async () => {
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
      .filter(Boolean)
  };
}

function CompletionPanel({ task, completionTypes, draft, setDraft, showForm, setShowForm, onComplete }) {
  const completion = task.completion;
  const editableTypes = (completionTypes || []).filter((type) => type !== "legacy-needs-audit");
  const type = draft.completionType;
  const canComplete =
    type === "merged"
      ? draft.commitSha.trim()
      : type === "superseded"
        ? draft.supersededByTaskId.trim() || draft.notes.trim()
        : draft.notes.trim();

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
