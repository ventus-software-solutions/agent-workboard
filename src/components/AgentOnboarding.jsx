import { useEffect, useMemo, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import {
  AGENT_BOOTSTRAP_ROLE_IDS,
  bootstrapPromptFor,
  buildBootstrapCards
} from "../lib/agentBootstrap.js";

const FIRST_RUN_DISMISS_KEY = "agentWorkboard.onboardingStripDismissed";

function currentOrigin() {
  if (typeof window === "undefined" || !window.location) return "";
  return window.location.origin;
}

function BootstrapCopyControl({ text }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can be unavailable in some embedded contexts; fall back to a
      // textarea select so the operator can still copy by hand.
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      } finally {
        document.body.removeChild(textarea);
      }
    }
  }

  return (
    <button className="bootstrapCopyButton" type="button" onClick={handleCopy} aria-label="Copy bootstrap prompt">
      {copied ? <Check size={16} /> : <Copy size={16} />}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

function HowItWorksStrip() {
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(FIRST_RUN_DISMISS_KEY) === "true";
    } catch {
      return false;
    }
  });

  function dismiss() {
    setDismissed(true);
    try {
      window.localStorage.setItem(FIRST_RUN_DISMISS_KEY, "true");
    } catch {
      // Persistence is best-effort.
    }
  }

  if (dismissed) return null;

  const steps = [
    "Create tasks",
    "Mark them ready",
    "Hand an agent the bootstrap prompt",
    "The agent claims and posts progress",
    "Approvals and review-requests surface here"
  ];

  return (
    <section className="howItWorksStrip" aria-label="How it works">
      <div className="howItWorksBody">
        <strong>How it works</strong>
        <div className="howItWorksSteps">
          {steps.map((step, index) => (
            <span key={step} className="howItWorksStep">
              {index > 0 && <span className="howItWorksArrow">→</span>}
              <span>{step}</span>
            </span>
          ))}
        </div>
      </div>
      <button className="iconButton" type="button" aria-label="Dismiss how it works strip" onClick={dismiss}>
        <X size={16} />
      </button>
    </section>
  );
}

function IdleSpawnBanner({ readyTaskCount, roles, origin }) {
  const cards = buildBootstrapCards(roles, origin);
  const primaryRole = (cards[0] && cards[0].role) || AGENT_BOOTSTRAP_ROLE_IDS[0];
  const prompt = bootstrapPromptFor(primaryRole, origin);
  if (!prompt) return null;

  return (
    <section className="idleSpawnBanner" aria-label="No agents working">
      <div className="idleSpawnText">
        <strong>{readyTaskCount} tasks ready, no agents working — spawn one:</strong>
        <code className="idleSpawnPrompt">{prompt}</code>
      </div>
      <BootstrapCopyControl text={prompt} />
    </section>
  );
}

function BootstrapRoleCards({ roles, origin }) {
  const cards = useMemo(() => buildBootstrapCards(roles, origin), [roles, origin]);
  if (cards.length === 0) return null;

  return (
    <section className="bootstrapSection" aria-label="Spawn an agent">
      <div className="bootstrapSectionHeader">
        <div className="sectionLabel">Spawn an agent</div>
        <h3>Give an agent this prompt to put it to work</h3>
        <p>Copy the one-line bootstrap prompt for a role, then paste it to start the agent.</p>
      </div>
      <div className="bootstrapCardGrid">
        {cards.map((card) => (
          <article className="bootstrapRoleCard" key={card.role} data-testid={`bootstrap-card-${card.role}`}>
            <div className="bootstrapRoleHeader">
              <div>
                <h4>{card.label}</h4>
                {card.summary && <p>{card.summary}</p>}
              </div>
              <BootstrapCopyControl text={card.prompt} />
            </div>
            <code className="bootstrapPrompt">{card.prompt}</code>
          </article>
        ))}
      </div>
    </section>
  );
}

export function AgentOnboarding({ roles = [], readyTaskCount = 0, activeSlotCount = 0 }) {
  const origin = currentOrigin();
  const cards = useMemo(() => buildBootstrapCards(roles, origin), [roles, origin]);
  const showIdle = readyTaskCount > 0 && activeSlotCount === 0;

  if (cards.length === 0) return null;

  return (
    <div className="agentOnboarding">
      <HowItWorksStrip />
      {showIdle && <IdleSpawnBanner readyTaskCount={readyTaskCount} roles={roles} origin={origin} />}
      <BootstrapRoleCards roles={roles} origin={origin} />
    </div>
  );
}
