# Releasing

How to cut an Agent Workboard release. A release is a git tag plus a GitHub release; tagging also publishes a container image to GHCR through `.github/workflows/publish-image.yml`. There is no npm package publish.

Replace `X.Y.Z` below with the version being released.

## Preflight

- [ ] `main` is the intended release head.
- [ ] The worktree is clean.
- [ ] `package.json` has the version you are about to tag.
- [ ] `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/architecture.md`, and `docs/roadmap.md` describe current behavior, especially the local-first boundary.
- [ ] No local operator data is tracked: `.workboard-data/`, uploads, screenshots.

```bash
git checkout main
git pull --ff-only origin main
git status --short --branch
node -p "require('./package.json').version"
git status --ignored --short .workboard-data
```

## Verification Gate

Run from a clean checkout. Requires the `sqlite3` command on `PATH` for the SQLite persistence tests.

```bash
npm ci
npm test
npm run build
npm run test:e2e
```

If Playwright cannot create `test-results/` in a restricted environment, rerun in a normal shell and note the reason in the release notes. Remove generated `test-results/` before tagging.

```bash
git status --short
git diff --check
```

## Docker Smoke

The supported one-command local run path is Docker Compose.

```bash
docker compose up -d --build agent-workboard
```

```bash
curl http://127.0.0.1:8088/api/health
```

Expected:

```json
{ "ok": true, "service": "agent-workboard" }
```

```bash
docker compose down
```

## Release Notes

Write the release body against the actual commit range. Cover:

- Highlights, described in terms of what an operator or agent can now do.
- Verification actually run (`npm test`, `npm run build`, `npm run test:e2e`, Docker smoke).
- Breaking changes to the HTTP API, MCP tool schemas, stored data shape, or environment variables.
- Known limitations. At minimum, restate that the board is local-first and unauthenticated by default, that operators own their own backups of `.workboard-data/`, and that there is no hosted, RBAC, SSO, or audit-export model.

Screenshots are optional. If you attach them, capture from `http://127.0.0.1:8088` after the Docker smoke passes, and store them outside the repository unless the release deliberately adds media assets.

## Tag And Publish

Only tag after the verification gate and Docker smoke pass and the notes are written.

```bash
git checkout main
git pull --ff-only origin main
git tag -a vX.Y.Z -m "Agent Workboard vX.Y.Z"
git push origin vX.Y.Z
```

```bash
gh release create vX.Y.Z --title "Agent Workboard vX.Y.Z" --notes-file release-notes-vX.Y.Z.md --draft
```

Before publishing the draft:

- [ ] Release notes reflect the final commit range.
- [ ] The local-first, unauthenticated boundary is stated in the body.
- [ ] Known limitations are visible.
- [ ] No generated local data or screenshots were committed.

Publishing the release triggers the GHCR image build. Confirm the workflow succeeds and that `ghcr.io/ventus-software-solutions/agent-workboard:X.Y.Z` and `:latest` resolve.

## If A Tag Is Wrong

Do not silently retag or force-push a published tag; downstream clones and the published image digest already reference it. Cut a corrective patch release instead, and note what changed.

## After The Release

- [ ] Open follow-up issues for anything deferred as a release blocker.
- [ ] Update `docs/roadmap.md` if the release changed the near-term picture.
