# Ventus OSS-To-Commercial Roadmap

Agent Workboard is the local-first core of the Ventus agent coordination workflow. The product direction is open-source first: make the local core credible, useful, and understandable before adding hosted, team, or enterprise layers.

## Current Boundary

Agent Workboard is a local-first OSS core. It is intended for a trusted local operator running the board, browser UI, API, and MCP tools on their own machine or local environment.

It is not ready for hosted, multi-user, team, or enterprise deployment yet. Hosted/team use needs auth, project and organization boundaries, permissions, audit posture, backups, and operational controls before it can be represented honestly.

## Phase 1: OSS-Worthy Local Core

Goal: a new user can run the project locally, understand the trust boundary, and coordinate agents without bespoke chat instructions.

Pre-OSS-launch requirements:

- Clean local and Docker install/run docs.
- Clear local security boundary and an explicit "not for hosted/team use yet" note.
- Real-time board updates across tabs and agents: `task_490bdbacb067`.
- Agent MCP loop and slot bootstrap working end to end: `task_6d16d6c9d86a` plus related slot/bootstrap work.
- Reliable review, merge, and done evidence loop with reviewer-owned merge responsibility.
- Operator approval queue for blocked or approval-needed work: `task_1f8efc4e7c4c`.
- First-class dependencies, blockers, and subtasks: `task_c3c33c226ef4`.
- Capability registry so PMs and agents can answer whether the project already has a feature: `task_1e451698cce0`.
- Responsive operator UI polish, including task-card height clipping, collapsible sidebar work, and screenshots or demo media showing the real workflow.
- License, contribution guide, issue labels, public roadmap, and contributor path.

## Phase 2: Public OSS And Community Learning

Goal: let outside users try the local core, file useful issues, and validate whether the workflow is valuable beyond the dogfood project.

Must have:

- Public README that describes the product honestly as a local agent workboard, not hosted enterprise software.
- Issue templates and labels aligned to the roadmap taxonomy.
- Contributor docs for running tests, starting agents, and submitting changes.
- A small set of good-first issues drawn from real dogfood pain.
- Maintainer process for triage, review, security reports, and roadmap updates.

## Phase 3: Later Commercial Layer

Goal: monetize the workflow only after the OSS/local product earns trust and the hosted/team boundary is clear.

Future commercial candidates:

- Auth, sessions, organizations, projects, RBAC, operator/admin controls, and team management.
- SSO/OIDC/SAML after basic auth and organization boundaries exist.
- Hosted runners or managed agent slots.
- GitHub, Jira, and Linear sync.
- Audit exports, backups, retention controls, compliance posture, and admin reporting.
- Billing, usage limits, and plan controls after the hosted product has a real deployment model.

These are candidates, not current features.

## Maintainer Note On SSO

SSO comes after auth, organizations, project isolation, RBAC, audit posture, and OSS product-market signal. Adding SSO first would create enterprise-shaped surface area before the product has the basic hosted security model or enough community signal to know which team workflows are worth commercializing.

## Current Non-Goals

- No enterprise sales promise.
- No hosted/team launch before auth, org isolation, permissions, audit, backup, and operational basics exist.
- No SSO-first implementation that distracts from making the local core excellent.
