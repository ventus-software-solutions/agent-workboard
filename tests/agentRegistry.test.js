import { describe, expect, it } from "vitest";
import { buildAgentBootstrapPrompt, buildAgentRegistry } from "../src/lib/agentRegistry.js";

const roles = [
  { id: "pm", label: "PM Agent" },
  { id: "implementer", label: "Implementer Agent" },
  { id: "reviewer", label: "Reviewer Agent" },
  { id: "tester", label: "Test Agent" }
];

const workItemTypes = [
  { id: "epic", claimable: false },
  { id: "story", claimable: false },
  { id: "task", claimable: true },
  { id: "bug", claimable: true }
];

const agentSlots = {
  types: [
    {
      id: "pm",
      role: "pm",
      specialties: ["pm", "workflow"],
      defaultWorkMode: "single-task",
      slotIds: ["pm-agent"]
    },
    {
      id: "implementer-backend",
      role: "implementer",
      specialties: ["backend", "api"],
      defaultWorkMode: "single-task",
      slotIds: ["implementer-backend-1"]
    },
    {
      id: "reviewer",
      role: "reviewer",
      specialties: ["review", "architecture"],
      defaultWorkMode: "drain-role-queue",
      slotIds: ["reviewer-agent"]
    },
    {
      id: "tester",
      role: "tester",
      specialties: ["tests", "e2e"],
      defaultWorkMode: "single-task",
      slotIds: ["test-agent"]
    }
  ],
  slots: [
    {
      id: "pm-agent",
      typeId: "pm",
      role: "pm",
      specialties: ["pm", "workflow"],
      workMode: "single-task",
      active: false,
      stale: false,
      available: true,
      updatedAt: null
    },
    {
      id: "implementer-backend-1",
      typeId: "implementer-backend",
      role: "implementer",
      specialties: ["backend", "api"],
      workMode: "single-task",
      active: true,
      stale: false,
      available: false,
      updatedAt: "2026-06-12T14:00:00.000Z",
      lease: { heartbeatAt: "2026-06-12T14:05:00.000Z" }
    },
    {
      id: "reviewer-agent",
      typeId: "reviewer",
      role: "reviewer",
      specialties: ["review", "architecture"],
      workMode: "drain-role-queue",
      active: false,
      stale: true,
      available: true,
      updatedAt: "2026-06-12T13:00:00.000Z"
    },
    {
      id: "test-agent",
      typeId: "tester",
      role: "tester",
      specialties: ["tests", "e2e"],
      workMode: "single-task",
      active: false,
      stale: false,
      available: true,
      updatedAt: null
    }
  ]
};

const tasks = [
  {
    id: "task-active",
    title: "Build registry API",
    status: "in_progress",
    priority: "high",
    role: "implementer",
    assignee: "implementer-backend-1",
    labels: ["backend"],
    updatedAt: "2026-06-12T15:00:00.000Z"
  },
  {
    id: "task-ready",
    title: "Prepare registry follow-up",
    status: "ready",
    priority: "normal",
    role: "implementer",
    assignee: "implementer-backend-1",
    labels: ["api"],
    updatedAt: "2026-06-12T15:10:00.000Z"
  },
  {
    id: "task-blocked",
    title: "Unblock ad hoc UI worker",
    status: "blocked",
    priority: "high",
    role: "implementer",
    assignee: "implementer-adhoc",
    labels: ["frontend", "ui"],
    updatedAt: "2026-06-12T15:20:00.000Z"
  },
  {
    id: "task-historical",
    title: "Closed one-off implementation",
    status: "done",
    priority: "low",
    role: "implementer",
    assignee: "implementer-retired",
    labels: ["cleanup"],
    updatedAt: "2026-06-12T12:30:00.000Z"
  },
  {
    id: "task-review",
    title: "Review registry slice",
    status: "review",
    priority: "normal",
    role: "reviewer",
    assignee: "reviewer-agent",
    labels: ["review"],
    updatedAt: "2026-06-12T15:30:00.000Z"
  },
  {
    id: "task-done",
    title: "Closed registry spike",
    status: "done",
    priority: "low",
    role: "tester",
    assignee: "test-agent",
    labels: ["tests"],
    updatedAt: "2026-06-12T13:30:00.000Z"
  }
];

describe("agent registry derivation", () => {
  it("summarizes role seats by heartbeat liveness, silent leases, and availability", () => {
    const registry = buildAgentRegistry({
      roles: [{ id: "implementer", label: "Implementer Agent" }],
      agentSlots: {
        types: [
          {
            id: "implementer-general",
            role: "implementer",
            capacity: 3,
            slotIds: ["implementer-agent", "implementer-agent-2", "implementer-agent-3"]
          }
        ],
        slots: [
          {
            id: "implementer-agent",
            typeId: "implementer-general",
            role: "implementer",
            slotNumber: 1,
            withinCapacity: true,
            active: true,
            presenceFresh: true,
            leaseFresh: true,
            available: false,
            presence: {
              status: "online",
              state: "active",
              message: "Implementing the selected task.",
              lastHeartbeat: "2026-08-13T07:30:00.000Z"
            }
          },
          {
            id: "implementer-agent-2",
            typeId: "implementer-general",
            role: "implementer",
            slotNumber: 2,
            withinCapacity: true,
            active: true,
            presenceFresh: false,
            leaseFresh: true,
            available: false,
            lease: { heartbeatAt: "2026-08-13T07:25:00.000Z" }
          },
          {
            id: "implementer-agent-3",
            typeId: "implementer-general",
            role: "implementer",
            slotNumber: 3,
            withinCapacity: true,
            active: false,
            presenceFresh: false,
            leaseFresh: false,
            available: true
          }
        ]
      },
      tasks: []
    });

    const implementers = registry.groups[0];
    expect(implementers).toMatchObject({
      configured: 3,
      active: 1,
      unresponsive: 1,
      available: 1,
      canFill: true,
      needsAttention: false
    });
    expect(implementers.visibleAgents.map((agent) => agent.id)).toEqual(["implementer-agent", "implementer-agent-2"]);
    expect(implementers.hiddenAgents.map((agent) => agent.id)).toEqual(["implementer-agent-3"]);
    expect(registry).toMatchObject({ activeAgents: 1, unresponsiveAgents: 1, availableAgents: 1, problemAgents: 1 });
    expect(implementers.activeAgents[0]).toMatchObject({
      presenceMessage: "Implementing the selected task.",
      heartbeatAt: "2026-08-13T07:30:00.000Z"
    });
  });

  it("flags queued roles with zero heartbeat-active agents", () => {
    const registry = buildAgentRegistry({
      roles: [{ id: "tester", label: "Test Agent" }],
      agentSlots: {
        types: [{ id: "tester", role: "tester", capacity: 1, slotIds: ["test-agent"] }],
        slots: [
          {
            id: "test-agent",
            typeId: "tester",
            role: "tester",
            withinCapacity: true,
            available: true,
            presenceFresh: false,
            leaseFresh: false
          }
        ]
      },
      tasks: [{ id: "task-ready", title: "Verify release", role: "tester", status: "ready", workItemType: "task", assignee: "" }],
      workItemTypes
    });

    expect(registry.groups[0]).toMatchObject({ active: 0, queuedWork: 1, needsAttention: true });
  });

  it("does not warn for backlog or non-claimable ready containers", () => {
    const registry = buildAgentRegistry({
      roles: [{ id: "tester", label: "Test Agent" }],
      agentSlots: {
        types: [{ id: "tester", role: "tester", capacity: 1, slotIds: ["test-agent"] }],
        slots: [
          {
            id: "test-agent",
            typeId: "tester",
            role: "tester",
            withinCapacity: true,
            available: true,
            presenceFresh: false,
            leaseFresh: false
          }
        ]
      },
      tasks: [
        { id: "task-backlog", title: "Future test idea", role: "tester", status: "backlog", workItemType: "task" },
        { id: "epic-ready", title: "Test program", role: "tester", status: "ready", workItemType: "epic" }
      ],
      workItemTypes
    });

    expect(registry.groups[0]).toMatchObject({ active: 0, queuedWork: 0, needsAttention: false });
  });

  it("keeps a task-only current worker visible as a stalled problem agent", () => {
    const registry = buildAgentRegistry({
      roles: [{ id: "implementer", label: "Implementer Agent" }],
      agentSlots: { types: [], slots: [] },
      tasks: [
        {
          id: "task-ghost-busy",
          title: "Continue work without a registered slot",
          role: "implementer",
          status: "in_progress",
          assignee: "ghost-busy-agent"
        }
      ]
    });

    const ghost = registry.agents.find((agent) => agent.id === "ghost-busy-agent");
    expect(ghost).toMatchObject({ status: "busy", stalled: true, problem: true });
    expect(registry.groups[0].visibleAgents.map((agent) => agent.id)).toContain("ghost-busy-agent");
    expect(registry.groups[0].hiddenAgents.map((agent) => agent.id)).not.toContain("ghost-busy-agent");
  });

  it("builds the copyable one-line role bootstrap prompt", () => {
    expect(buildAgentBootstrapPrompt("implementer", "http://localhost:8088/")).toBe(
      "You are implementer. Read http://localhost:8088/api/agent-docs/implementer?format=md and do what it tells you."
    );
  });

  it("groups configured and task-only agents by role with status and task summaries", () => {
    const registry = buildAgentRegistry({ agentSlots, tasks, roles });

    expect(registry.groups.map((group) => group.role)).toEqual(["pm", "implementer", "reviewer", "tester"]);
    expect(registry.totalAgents).toBe(6);
    expect(registry.configuredAgentCount).toBe(4);
    expect(registry.historicalAssigneeCount).toBe(2);
    expect(registry.busyAgents).toBe(1);
    expect(registry.blockedAgents).toBe(1);
    expect(registry.idleAgents).toBe(3);

    const implementerGroup = registry.groups.find((group) => group.role === "implementer");
    expect(implementerGroup).toMatchObject({
      total: 3,
      configured: 1,
      historical: 2
    });
    expect(implementerGroup.agents.map((agent) => agent.id)).toEqual([
      "implementer-backend-1",
      "implementer-adhoc",
      "implementer-retired"
    ]);
    expect(implementerGroup.configuredAgents.map((agent) => agent.id)).toEqual(["implementer-backend-1"]);
    expect(implementerGroup.historicalAgents.map((agent) => agent.id)).toEqual(["implementer-adhoc", "implementer-retired"]);

    const backendAgent = registry.agents.find((agent) => agent.id === "implementer-backend-1");
    expect(backendAgent).toMatchObject({
      id: "implementer-backend-1",
      role: "implementer",
      typeId: "implementer-backend",
      typeLabel: "Implementer Backend",
      status: "busy",
      statusLabel: "Busy",
      currentTask: {
        id: "task-active",
        title: "Build registry API"
      },
      assignedTaskCount: 2,
      openTaskCount: 2,
      blockedTaskCount: 0,
      specialties: ["backend", "api"],
      lastActivityAt: "2026-06-12T15:10:00.000Z"
    });

    const adHocAgent = registry.agents.find((agent) => agent.id === "implementer-adhoc");
    expect(adHocAgent).toMatchObject({
      id: "implementer-adhoc",
      source: "task-assignee",
      role: "implementer",
      typeLabel: "Task Assignee",
      status: "blocked",
      statusLabel: "Blocked",
      blockedTaskCount: 1,
      specialties: ["frontend", "ui"]
    });

    const retiredAgent = registry.agents.find((agent) => agent.id === "implementer-retired");
    expect(retiredAgent).toMatchObject({
      source: "task-assignee",
      status: "idle",
      assignedTaskCount: 1,
      openTaskCount: 0,
      specialties: ["cleanup"]
    });

    const reviewerAgent = registry.agents.find((agent) => agent.id === "reviewer-agent");
    expect(reviewerAgent).toMatchObject({
      status: "review",
      reviewTaskCount: 1,
      assignedTasks: [{ id: "task-review" }]
    });

    const testerAgent = registry.agents.find((agent) => agent.id === "test-agent");
    expect(testerAgent).toMatchObject({
      status: "idle",
      assignedTaskCount: 1,
      openTaskCount: 0
    });
  });

  it("uses deterministic status precedence and hides done tasks from assigned quick links", () => {
    const registry = buildAgentRegistry({
      roles,
      agentSlots: {
        types: agentSlots.types,
        slots: [
          {
            id: "implementer-frontend-1",
            typeId: "implementer-backend",
            role: "implementer",
            specialties: ["frontend"],
            stale: true,
            active: true,
            available: false,
            workMode: "single-task"
          }
        ]
      },
      tasks: [
        {
          id: "task-blocked",
          title: "Blocked task",
          status: "blocked",
          role: "implementer",
          assignee: "implementer-frontend-1",
          labels: ["frontend"],
          updatedAt: "2026-06-12T11:00:00.000Z"
        },
        {
          id: "task-current",
          title: "Current task wins",
          status: "in_progress",
          role: "implementer",
          assignee: "implementer-frontend-1",
          labels: ["frontend"],
          updatedAt: "2026-06-12T12:00:00.000Z"
        },
        {
          id: "task-done",
          title: "Done task",
          status: "done",
          role: "implementer",
          assignee: "implementer-frontend-1",
          labels: ["frontend"],
          updatedAt: "2026-06-12T13:00:00.000Z"
        }
      ]
    });

    const agent = registry.agents.find((candidate) => candidate.id === "implementer-frontend-1");
    expect(agent.status).toBe("busy");
    expect(agent.currentTask.id).toBe("task-current");
    expect(agent.assignedTasks.map((task) => task.id)).toEqual(["task-current", "task-blocked"]);
    expect(agent.assignedTaskCount).toBe(3);
    expect(agent.openTaskCount).toBe(2);
    expect(agent.blockedTaskCount).toBe(1);
  });

  it("exposes pause state for configured slots", () => {
    const registry = buildAgentRegistry({
      roles,
      agentSlots: {
        types: agentSlots.types,
        slots: [
          {
            id: "test-agent",
            typeId: "tester",
            role: "tester",
            specialties: ["tests"],
            workMode: "single-task",
            paused: true,
            active: false,
            available: false
          }
        ]
      },
      tasks: []
    });

    expect(registry.agents.find((agent) => agent.id === "test-agent")).toMatchObject({
      paused: true,
      status: "paused",
      statusLabel: "Paused"
    });
  });

  it("keeps fresh waiting agents visible without treating them as idle or stale", () => {
    const registry = buildAgentRegistry({
      roles,
      agentSlots: {
        types: agentSlots.types,
        slots: [
          {
            id: "test-agent",
            typeId: "tester",
            role: "tester",
            specialties: ["tests"],
            workMode: "single-task",
            active: true,
            stale: false,
            available: false,
            presence: {
              state: "waiting",
              status: "waiting",
              stale: false,
              upstreamSignal: {
                role: "tester",
                statuses: ["review", "in_progress"],
                counts: { review: 1, in_progress: 1 },
                total: 2,
                active: true,
                recheckAfterSeconds: 90
              }
            }
          }
        ]
      },
      tasks: []
    });

    expect(registry).toMatchObject({
      waitingAgents: 1,
      idleAgents: 0
    });
    expect(registry.groups.find((group) => group.role === "tester")).toMatchObject({
      waiting: 1,
      idle: 0
    });
    expect(registry.agents.find((agent) => agent.id === "test-agent")).toMatchObject({
      status: "waiting",
      statusLabel: "Waiting",
      waiting: true,
      stale: false,
      active: true,
      upstreamSignal: { total: 2 }
    });
  });

  it("summarizes agent type capacity and slot identity state", () => {
    const registry = buildAgentRegistry({
      roles,
      agentSlots: {
        types: [
          {
            id: "implementer-frontend",
            role: "implementer",
            capacity: 2,
            configured: 3,
            active: 1,
            available: 1,
            slotIds: ["implementer-frontend-1", "implementer-frontend-2", "implementer-frontend-3"],
            specialties: ["frontend", "ui"],
            defaultWorkMode: "single-task"
          }
        ],
        slots: [
          {
            id: "implementer-frontend-1",
            typeId: "implementer-frontend",
            role: "implementer",
            slotNumber: 1,
            active: true,
            stale: false,
            available: false,
            withinCapacity: true,
            specialties: ["frontend"],
            workMode: "single-task"
          },
          {
            id: "implementer-frontend-2",
            typeId: "implementer-frontend",
            role: "implementer",
            slotNumber: 2,
            active: false,
            stale: false,
            available: true,
            withinCapacity: true,
            specialties: ["frontend"],
            workMode: "single-task"
          },
          {
            id: "implementer-frontend-3",
            typeId: "implementer-frontend",
            role: "implementer",
            slotNumber: 3,
            active: false,
            stale: true,
            available: false,
            withinCapacity: false,
            specialties: ["frontend"],
            workMode: "single-task"
          }
        ]
      },
      tasks: [
        {
          id: "task-current",
          title: "Build capacity controls",
          status: "in_progress",
          role: "implementer",
          assignee: "implementer-frontend-1",
          labels: ["frontend"],
          updatedAt: "2026-06-12T12:00:00.000Z"
        }
      ]
    });

    expect(registry.typeSummaries.find((type) => type.id === "implementer-frontend")).toMatchObject({
      id: "implementer-frontend",
      label: "Implementer Frontend",
      capacity: 2,
      configured: 3,
      active: 1,
      available: 1,
      occupied: 1,
      free: 1,
      stale: 1,
      slots: [
        expect.objectContaining({
          id: "implementer-frontend-1",
          statusLabel: "Busy",
          currentTask: expect.objectContaining({ id: "task-current" })
        }),
        expect.objectContaining({ id: "implementer-frontend-2", statusLabel: "Idle" }),
        expect.objectContaining({ id: "implementer-frontend-3", withinCapacity: false, statusLabel: "Stale" })
      ]
    });
  });
});
