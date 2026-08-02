# Security policy

Agent Workboard is pre-release and does not yet promise a support window. Security
fixes land on `main` and ship in the next tagged release.

## Reporting a vulnerability

Do not open public issues for suspected vulnerabilities, and do not attach board
exports, task attachments, agent transcripts, or anything else that may contain
credentials or personal data. Use the repository host's private security-advisory
feature or email `hello@ventus.works`.

Include the affected version, a minimal reproduction using synthetic data, the
impact, and any suggested mitigation. Never test against a deployment you do not
own or have explicit permission to assess.

## Threat model in brief

Agent Workboard is a **local-first, unauthenticated** board. There are no users,
roles, or permissions: any process that can reach the HTTP port can read and write
every project and task, and the MCP server grants the same access to any agent that
can spawn it.

By default the API server, the Vite dev server, and the Docker Compose port publish
all bind to `127.0.0.1`, so the board is reachable only from the local machine.

The following are therefore **not** vulnerabilities in the default configuration:

- Unauthenticated access to the API, MCP tools, or attachments from localhost.
- One agent reading or modifying another agent's tasks.
- Absence of audit-proof or tamper-evident activity records.

The following **are** in scope:

- Anything that escapes the loopback boundary without the operator explicitly
  setting `WORKBOARD_HOST` or changing the Docker port mapping.
- Path traversal, arbitrary file read/write, or command injection through the API,
  MCP tools, attachment upload/download, or worktree helpers.
- Reading or writing files outside `WORKBOARD_DATA_DIR`.
- Denial of service that a single malformed request can trigger.

If you deliberately expose a deployment beyond loopback, put it behind a VPN,
reverse-proxy authentication, or another operator-approved boundary. That
configuration is unsupported and untested; report issues with it as bugs, not as
vulnerabilities.
