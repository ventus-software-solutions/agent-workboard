# Roadmap

Agent Workboard is open-source first: make the local core credible, useful, and understandable before adding anything that assumes a hosted or multi-user deployment.

This roadmap describes direction, not commitments or dates.

## Current Boundary

Agent Workboard is a local-first core. It is built for a trusted operator running the board, browser UI, HTTP API, and MCP tools on their own machine or local environment.

It is not ready for hosted, multi-user, team, or enterprise deployment. That would need authentication, project and organization boundaries, permissions, audit posture, backups, and operational controls before it could be represented honestly. See [SECURITY.md](../SECURITY.md) for the threat model that follows from this boundary.

## Near Term: A Solid Local Core

Goal: a new user can run the project locally, understand the trust boundary, and coordinate agents without bespoke chat instructions.

- Clean local and Docker install and run documentation.
- A clear local security boundary, stated explicitly rather than implied.
- Real-time board updates across tabs and agents.
- Agent MCP loop and slot bootstrap working end to end.
- A reliable review, merge, and done evidence loop with reviewer-owned merge responsibility.
- An operator approval queue for blocked or approval-needed work.
- First-class dependencies, blockers, and subtasks.
- A capability registry, so agents can answer whether the board already has a feature before proposing it again.
- Responsive operator UI polish, and screenshots or demo media showing the real workflow.

## Then: Community Signal

Goal: let outside users try the local core, file useful issues, and validate whether the workflow is valuable beyond the projects it was built for.

- A README that describes the product honestly as a local agent workboard, not hosted enterprise software.
- Issue templates and labels aligned to the roadmap taxonomy.
- Contributor docs for running tests, starting agents, and submitting changes.
- A small set of good-first issues drawn from real usage pain.
- A maintainer process for triage, review, security reports, and roadmap updates.

## Current Non-Goals

These are sequencing decisions, not refusals.

- No hosted or team deployment before authentication, project isolation, permissions, audit posture, backups, and operational basics exist.
- No SSO work before those basics exist. SSO on top of a system with no auth model and no organization boundary would add enterprise-shaped surface area with no security model underneath it.
- No promise that any particular integration or hosted capability will ship.

## Contributing To The Roadmap

Open a feature request describing the operator or agent problem you hit. Issues grounded in real usage carry more weight than feature lists; the near-term items above all came from running the board against real work.
