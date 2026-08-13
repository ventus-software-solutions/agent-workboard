import { describe, expect, it } from "vitest";
import {
  AGENT_BOOTSTRAP_ROLE_IDS,
  bootstrapPromptFor,
  buildBootstrapCards,
  showIdleSpawnNudge
} from "../src/lib/agentBootstrap.js";

const roles = [
  { id: "pm", label: "PM Agent", summary: "Breaks goals into tasks." },
  { id: "implementer", label: "Implementer Agent", summary: "Builds the change." },
  { id: "reviewer", label: "Reviewer Agent", summary: "Reviews readiness." },
  { id: "tester", label: "Test Agent", summary: "Runs checks." },
  { id: "researcher", label: "Research Agent", summary: "Collects evidence." }
];

describe("agentBootstrap", () => {
  it("builds one bootstrap card per spawnable role from the roles list", () => {
    const cards = buildBootstrapCards(roles, "https://board.example");
    expect(cards.map((card) => card.role)).toEqual(AGENT_BOOTSTRAP_ROLE_IDS);
    expect(cards).toHaveLength(5);
    for (const card of cards) {
      expect(card.label).toBeTruthy();
    }
  });

  it("prompt contains the current origin and the resolved agent-docs URL", () => {
    const cards = buildBootstrapCards(roles, "http://127.0.0.1:5174");
    for (const card of cards) {
      expect(card.prompt).toContain(`http://127.0.0.1:5174/api/agent-docs/${card.role}?format=md`);
    }
  });

  it("skips any role missing from the configured roles list", () => {
    const cards = buildBootstrapCards(roles.slice(0, 3), "https://board.example");
    expect(cards.map((card) => card.role)).toEqual(["pm", "implementer", "reviewer"]);
  });

  it("formats the one-line bootstrap prompt", () => {
    expect(bootstrapPromptFor("implementer", "https://board.example")).toBe(
      "You are implementer. Read https://board.example/api/agent-docs/implementer?format=md and do what it tells you."
    );
  });

  it("shows the idle nudge only when there are ready tasks and zero active slots", () => {
    expect(showIdleSpawnNudge({ readyTaskCount: 3, activeSlotCount: 0 })).toBe(true);
    expect(showIdleSpawnNudge({ readyTaskCount: 0, activeSlotCount: 0 })).toBe(false);
    expect(showIdleSpawnNudge({ readyTaskCount: 3, activeSlotCount: 1 })).toBe(false);
  });
});
