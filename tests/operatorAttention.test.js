import { describe, expect, it } from "vitest";
import {
  buildBootstrapPrompt,
  buildOperatorAttention,
  describeOperatorAction,
  usesDedicatedSpawnRemedy
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
      task("review-changes", {
        status: "ready",
        reviewVerdict: { decision: "request_changes", findingsCount: 2, reviewer: "reviewer-agent", commitSha: "abc1234" }
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
      expect.arrayContaining(["approval", "merge", "review_changes", "blocker", "stalled", "role_gap", "grooming", "cleanup"])
    );
    expect(result.actions.find((action) => action.kind === "review_changes")).toMatchObject({
      taskId: "review-changes",
      detail: expect.stringContaining("2 review findings")
    });
    expect(result.actions[0]).toMatchObject({ kind: "approval", taskId: "approval", downstreamCount: 4 });
    expect(result.actions.find((action) => action.id === "role-gap:implementer")).toMatchObject({
      remedy: "copy_prompt",
      prompt: expect.stringContaining("http://workboard.test/api/agent-docs/implementer")
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
    expect(result.actions.every((action) => action.what && action.why && action.doThis)).toBe(true);
    expect(result.actions.map((action) => action.what).join(" ")).not.toMatch(/expired_heartbeat|missing_slot|role_gap/);
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

  it("appends a role spawn remedy only when the affected role has no living agent", () => {
    const stalledTask = task("stalled", { status: "in_progress", assignee: "missing-agent", role: "implementer" });
    const withoutLivingAgent = buildOperatorAttention({
      tasks: [stalledTask],
      agentRegistry: registry(),
      promptTemplate: PROMPT_TEMPLATE,
      origin: "https://board.example"
    }).actions.find((action) => action.kind === "stalled");
    expect(withoutLivingAgent).toMatchObject({ spawnRole: "implementer" });
    expect(withoutLivingAgent.doThis).toContain("then spawn an implementer");
    expect(withoutLivingAgent.spawnPrompt).toContain("https://board.example/api/agent-docs/implementer");

    const withLivingAgent = buildOperatorAttention({
      tasks: [stalledTask],
      agentRegistry: registry(activeAgent("implementer-live", "implementer")),
      promptTemplate: PROMPT_TEMPLATE
    }).actions.find((action) => action.kind === "stalled");
    expect(withLivingAgent.spawnPrompt).toBe("");
    expect(withLivingAgent.doThis).not.toContain("then spawn");
  });

  it("keeps grooming's dedicated PM spawn remedy singular when no PM is active", () => {
    const result = buildOperatorAttention({
      tasks: [task("groom", { status: "backlog", priority: "", role: "" })],
      agentRegistry: registry(),
      promptTemplate: PROMPT_TEMPLATE,
      origin: "https://board.example"
    });
    const grooming = result.actions.find((action) => action.kind === "grooming");

    expect(grooming).toMatchObject({
      doThis: "Click Groom now to open the first item, or Spawn PM to delegate grooming.",
      spawnRole: "pm",
      spawnPrompt: expect.stringContaining("https://board.example/api/agent-docs/pm")
    });
    expect(grooming.doThis).not.toContain("then spawn");
    expect(usesDedicatedSpawnRemedy(grooming.kind)).toBe(true);
  });

  it("gives unknown inbox kinds an honest imperative fallback", () => {
    expect(describeOperatorAction({ kind: "new_exception", title: "Unexpected item", taskId: "task_x" })).toMatchObject({
      what: expect.stringContaining("cannot classify"),
      why: expect.stringContaining("cannot determine"),
      doThis: expect.stringMatching(/^Open the task/)
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
