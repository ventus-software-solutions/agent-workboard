import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const readProjectFile = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("production image boot smoke", () => {
  it("copies every allow-listed runtime directory required by the server", () => {
    const dockerfile = readProjectFile("Dockerfile");

    expect(dockerfile).toContain("COPY --from=build /app/dist ./dist");
    expect(dockerfile).toContain("COPY --from=build /app/server ./server");
    expect(dockerfile).toContain("COPY --from=build /app/shared ./shared");
    expect(dockerfile).toContain("Keep the runtime image allow-listed and small");
  });

  it("boots with throwaway data and fails with useful health evidence", () => {
    const smoke = readProjectFile("scripts/docker-image-smoke.sh");

    expect(smoke).toContain("--tmpfs /data:");
    expect(smoke).toContain("/api/health");
    expect(smoke).toContain("curl --fail --silent --show-error --max-time 2");
    expect(smoke).toContain("docker logs");
    expect(smoke).toContain("trap cleanup EXIT");
  });

  it("runs the image boot smoke as an independent CI job", () => {
    const workflow = readProjectFile(".github/workflows/ci.yml");

    expect(workflow).toContain("image-smoke:");
    expect(workflow).toContain("docker build --tag");
    expect(workflow).toContain("bash scripts/docker-image-smoke.sh");
  });
});
