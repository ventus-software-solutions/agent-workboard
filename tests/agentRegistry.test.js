import { describe, expect, it } from "vitest";
import { buildAgentRegistry } from "../src/lib/agentRegistry.js";

const roles = [
  { id: "pm", label: "PM Agent" },
  { id: "implementer", label: "Implementer Agent" },
  { id: "reviewer", label: "Reviewer Agent" },
  { id: "tester", label: "Test Agent" }
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
});
