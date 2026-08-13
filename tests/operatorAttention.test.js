import { describe, expect, it } from "vitest";
import {
  buildBootstrapPrompt,
  buildOperatorAttention,
  describeOperatorAction
} from "../src/lib/operatorAttention.js";

const PROMPT_TEMPLATE =
  "You are {agentType}. Read http://localhost:8088/api/agent-docs/{agentType}?format=md and do what it tells you.";

function task(id, patch = {}) {
  return {
    id,
    title: `Task ${id}`,
    status: "ready",
    priority: "normal",
    role: "implementer",
    workItemType: "task",
    assignee: "",
    labels: [],
    blocks: [],
    dependsOn: [],
    blockedBy: [],
    dependencyStatus: { state: "clear" },
    comments: [],
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
    ...patch
  };
}

function registry(...agents) {
  return { agents };
}

function activeAgent(id, role) {
  return { id, role, source: "slot", active: true, paused: false };
}

describe("operator attention selector", () => {
  it("aggregates every operator-facing category and orders greater downstream impact first", () => {
    const tasks = [
      task("approval", {
        status: "blocked",
        blocks: ["child-1", "child-2", "child-3"],
        blocker: {
          type: "operator_approval",
          status: "pending",
          requestedAction: "Choose the delivery policy"
        }
      }),
      task("merge", {
        status: "review",
        reviewVerdict: { decision: "approve", findingsCount: 0 }
      }),
      task("blocked", {
        status: "blocked",
        blocker: { type: "dependency", reason: "Waiting for schema" }
      }),
      task("review", { status: "review" }),
      task("testing", { status: "testing" }),
      task("ready"),
      task("stalled", { status: "in_progress", assignee: "implementer-missing" }),
      task("groom", { status: "backlog", priority: "", role: "", updatedAt: "2026-07-01T00:00:00.000Z" })
    ];
    const worktreeCleanup = {
      cleanup: { mutationsEnabled: false, reason: "Container is report-only." },
      items: [
        {
          status: "cleanup-ready",
          cleanupEligible: true,
          branch: "implementer/merged",
          worktreePath: "C:/git/wt-agent-workboard-merged",
          commands: { removeWorktree: "git worktree remove merged", deleteBranch: "git branch -d implementer/merged" }
        }
      ]
    };

    const result = buildOperatorAttention({
      tasks,
      agentRegistry: registry(activeAgent("test-agent", "tester")),
      worktreeCleanup,
      promptTemplate: PROMPT_TEMPLATE,
      origin: "http://workboard.test",
      now: new Date("2026-08-13T12:00:00.000Z")
    });

    expect(result.actions.map((action) => action.kind)).toEqual(
      expect.arrayContaining(["approval", "merge", "blocker", "stalled", "role_gap", "grooming", "cleanup"])
    );
    expect(result.actions[0]).toMatchObject({ kind: "approval", taskId: "approval", downstreamCount: 4 });
    expect(result.actions.find((action) => action.id === "role-gap:implementer")).toMatchObject({
      remedy: "copy_prompt",
      prompt: expect.stringContaining("http://workboard.test/api/agent-docs/implementer"),
      spawnPrompt: expect.stringContaining("http://workboard.test/api/agent-docs/implementer"),
      what: expect.stringContaining("no implementer agent is running"),
      why: expect.stringContaining("cannot advance"),
      doThis: "Copy the spawn prompt."
    });
    expect(result.actions.find((action) => action.kind === "grooming")).toMatchObject({
      remedy: "groom",
      taskId: "groom",
      prompt: expect.stringContaining("agent-docs/pm")
    });
    expect(result.actions.find((action) => action.kind === "cleanup")).toMatchObject({
      remedy: "copy_commands",
      commands: ["git worktree remove merged", "git branch -d implementer/merged"],
      detail: expect.stringContaining("Run on host")
    });
    expect(result.actions.filter((action) => action.id === "role-gap:tester")).toHaveLength(0);
  });

  it("orders by unique transitive downstream reach and handles relationship cycles", () => {
    const blocked = (id, blocks) =>
      task(id, {
        status: "blocked",
        blocks,
        blocker: { type: "dependency", reason: "Waiting for prerequisite work" }
      });
    const done = (id, blocks = []) => task(id, { status: "done", blocks });
    const tasks = [
      blocked("shallow-wide", ["shallow-leaf-1", "shallow-leaf-2"]),
      done("shallow-leaf-1"),
      done("shallow-leaf-2"),
      blocked("deep-chain", ["deep-1"]),
      done("deep-1", ["deep-2"]),
      done("deep-2", ["deep-3"]),
      done("deep-3"),
      blocked("cycle-a", ["cycle-b"]),
      done("cycle-b", ["cycle-a"])
    ];

    const result = buildOperatorAttention({
      tasks,
      agentRegistry: registry(activeAgent("implementer-1", "implementer"))
    });

    expect(result.actions.map((action) => action.taskId)).toEqual(["deep-chain", "shallow-wide", "cycle-a"]);
    expect(result.actions.map((action) => action.downstreamCount)).toEqual([4, 3, 2]);
  });

  it.each([
    ["backlog", "role_gap"],
    ["ready", "role_gap"],
    ["in_progress", "stalled"],
    ["review", "role_gap"],
    ["testing", "role_gap"],
    ["blocked", "blocker"],
    ["done", null]
  ])("maps the reachable %s state to a concrete action or a terminal state", (status, expectedKind) => {
    const current = task(status, {
      status,
      assignee: status === "in_progress" ? "missing-agent" : "",
      blocker: status === "blocked" ? { type: "external_issue", reason: "Vendor outage" } : null
    });
    const result = buildOperatorAttention({
      tasks: [current],
      agentRegistry: registry(),
      promptTemplate: PROMPT_TEMPLATE,
      now: new Date("2026-08-13T12:00:00.000Z")
    });

    if (expectedKind) {
      expect(result.actions.some((action) => action.kind === expectedKind)).toBe(true);
      expect(result.actions.every((action) => Boolean(action.remedy))).toBe(true);
    } else {
      expect(result.actions).toEqual([]);
    }
  });

  it("renders the all-flowing state with active-agent and next-event context", () => {
    const result = buildOperatorAttention({
      tasks: [task("work", { status: "in_progress", assignee: "implementer-1" })],
      agentRegistry: registry(activeAgent("implementer-1", "implementer")),
      promptTemplate: PROMPT_TEMPLATE
    });

    expect(result.actions).toEqual([]);
    expect(result.activeAgentCount).toBe(1);
    expect(result.nextExpectedEvent).toBe("agent progress or delivery evidence");
  });

  it("carries stale-work reason details through the selector into the rendered sentence contract", () => {
    const result = buildOperatorAttention({
      tasks: [task("stalled", { status: "in_progress", assignee: "implementer-1" })],
      staleWork: [
        {
          taskId: "stalled",
          reason: "expired_heartbeat",
          freshness: { leaseHeartbeatAt: "2026-08-13T11:26:00.000Z" }
        }
      ],
      agentRegistry: registry(),
      promptTemplate: PROMPT_TEMPLATE,
      now: new Date("2026-08-13T12:00:00.000Z")
    });

    expect(result.actions[0]).toMatchObject({
      kind: "stalled",
      staleReason: "expired_heartbeat",
      what: expect.stringContaining("no heartbeat for 34m"),
      doThis: expect.stringContaining("Click Recover")
    });
    expect(result.actions[0].what).not.toContain("expired_heartbeat");
  });

  it("recognizes explicit legacy approval comments until structured review verdicts land", () => {
    const result = buildOperatorAttention({
      tasks: [task("legacy-review", { status: "review", comments: [{ body: "VERDICT: APPROVE - focused tests pass." }] })],
      agentRegistry: registry(activeAgent("reviewer-1", "reviewer"))
    });

    expect(result.actions).toEqual([
      expect.objectContaining({ kind: "merge", remedy: "open_task", taskId: "legacy-review" })
    ]);
  });

  it("uses the latest legacy verdict and ignores active agents assigned to another project", () => {
    const otherProjectAgent = { ...activeAgent("reviewer-1", "reviewer"), activeProjectId: "project_other" };
    const result = buildOperatorAttention({
      tasks: [
        task("review-again", {
          projectId: "project_current",
          status: "review",
          comments: [
            { body: "CHANGES REQUESTED: add the missing test." },
            { body: "VERDICT: APPROVE - earlier result." }
          ]
        })
      ],
      projectId: "project_current",
      agentRegistry: registry(otherProjectAgent),
      promptTemplate: PROMPT_TEMPLATE
    });

    expect(result.actions).toEqual([
      expect.objectContaining({ id: "role-gap:reviewer", kind: "role_gap", remedy: "copy_prompt" })
    ]);
  });

  it.each([
    [
      "approval",
      {
        kind: "approval",
        taskId: "approval",
        task: task("approval", {
          role: "implementer",
          blocker: { requestedAction: "Choose the delivery policy" }
        })
      },
      "An agent needs your decision"
    ],
    ["merge", { kind: "merge", taskId: "merge", task: task("merge") }, "waiting for its final merge"],
    [
      "blocker",
      {
        kind: "blocker",
        taskId: "blocked",
        task: task("blocked", { blocker: { type: "external_issue", reason: "Vendor outage" } })
      },
      "blocked by external issue"
    ],
    [
      "stalled",
      {
        kind: "stalled",
        taskId: "stalled",
        task: task("stalled", { status: "in_progress", assignee: "implementer-1" }),
        staleReason: "expired_heartbeat",
        staleItem: { freshness: { leaseHeartbeatAt: "2026-08-13T11:26:00.000Z" } }
      },
      "no heartbeat for 34m"
    ],
    [
      "role_gap",
      { kind: "role_gap", role: "reviewer", waitingCount: 2, waitingSummary: "2 review", taskId: "review" },
      "no reviewer agent is running"
    ],
    ["grooming", { kind: "grooming", role: "pm", itemCount: 3, taskId: "groom" }, "3 backlog items"],
    [
      "cleanup",
      { kind: "cleanup", remedy: "cleanup", cleanupItem: { branch: "implementer/merged" } },
      "still has a clean worktree"
    ]
  ])("renders plain-language What / Why / Do this sentences for %s cards", (_kind, action, expectedWhat) => {
    const copy = describeOperatorAction(action, {
      activeRoles: new Map([
        ["implementer", 1],
        ["reviewer", 1],
        ["pm", 1]
      ]),
      promptTemplate: PROMPT_TEMPLATE,
      origin: "http://workboard.test",
      now: new Date("2026-08-13T12:00:00.000Z")
    });

    expect(copy.what).toContain(expectedWhat);
    expect(copy.why).toMatch(/[.!?]$/);
    expect(copy.doThis).toMatch(/[.!?]$/);
    expect(`${copy.what} ${copy.why} ${copy.doThis}`).not.toContain("expired_heartbeat");
  });

  it.each([
    ["missing_assignee", "nobody owns it"],
    ["missing_slot", "no configured agent slot exists"],
    ["paused_slot", "slot is paused"],
    ["missing_heartbeat", "never sent a heartbeat"],
    ["expired_heartbeat", "stopped reporting progress"],
    ["future_stale_reason", "does not recognize the reason"]
  ])("explains the %s stale-work reason without exposing a state code", (staleReason, expected) => {
    const copy = describeOperatorAction(
      {
        kind: "stalled",
        taskId: "stalled",
        task: task("stalled", { status: "in_progress", assignee: "implementer-1" }),
        staleReason
      },
      { activeRoles: new Map([["implementer", 1]]) }
    );

    expect(copy.what).toContain(expected);
    expect(copy.what).not.toContain(staleReason);
  });

  it("appends a role-specific spawn prompt only when that role has no living agent", () => {
    const action = {
      kind: "blocker",
      taskId: "blocked",
      task: task("blocked", {
        role: "implementer",
        blocker: { type: "dependency", reason: "Waiting for schema" }
      })
    };
    const options = { promptTemplate: PROMPT_TEMPLATE, origin: "https://board.example" };

    expect(describeOperatorAction(action, { ...options, activeRoles: new Map() })).toMatchObject({
      requiredRole: "implementer",
      liveRoleCount: 0,
      spawnPrompt: expect.stringContaining("https://board.example/api/agent-docs/implementer")
    });
    expect(
      describeOperatorAction(action, { ...options, activeRoles: new Map([["implementer", 1]]) }).spawnPrompt
    ).toBe("");
  });

  it("uses an honest generic sentence set for an unknown attention type", () => {
    expect(describeOperatorAction({ kind: "future_alert", taskId: "future" })).toMatchObject({
      what: expect.stringContaining("does not yet know how to explain"),
      why: expect.stringContaining("cannot safely infer"),
      doThis: expect.stringContaining("Open the related task")
    });
  });
});

describe("bootstrap prompt rendering", () => {
  it("uses the server-owned template while substituting the live origin and role", () => {
    expect(
      buildBootstrapPrompt({ template: PROMPT_TEMPLATE, agentType: "reviewer", origin: "https://board.example" })
    ).toBe(
      "You are reviewer. Read https://board.example/api/agent-docs/reviewer?format=md and do what it tells you."
    );
  });
});
