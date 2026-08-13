import path from "node:path";
import { createApp } from "./app.js";
import { GitHubIntakeService, readGitHubIntakeConfig } from "./githubIntake.js";
import { formatListenUrl, isNetworkExposedHost, readListenConfig } from "./listenConfig.js";
import { installProcessErrorGuards } from "./processResilience.js";
import { WorkboardStore } from "./storage/workboardStore.js";
import { acquireWriterLease } from "./storage/writerLease.js";

installProcessErrorGuards();

const listenConfig = readListenConfig(process.env);
const dataDir = process.env.WORKBOARD_DATA_DIR || path.resolve(".workboard-data");
const storageMode = process.env.WORKBOARD_STORAGE || "sqlite";
const writerLease = await acquireWriterLease(dataDir, { owner: "http-daemon" });

const store = new WorkboardStore({ dataDir, storageMode });
try {
  await store.init();
} catch (error) {
  await writerLease.release();
  throw error;
}

const githubIntake = new GitHubIntakeService({ store, config: readGitHubIntakeConfig(process.env) });
const app = createApp({ store, githubIntake });
githubIntake.start();
const httpServer = app.listen(listenConfig.port, listenConfig.host, () => {
  console.log(`Agent Workboard listening on ${formatListenUrl(listenConfig)} (bound to ${listenConfig.host})`);
  if (isNetworkExposedHost(listenConfig.host)) {
    console.warn(
      "Agent Workboard has no built-in authentication; expose remote deployments only behind trusted access controls."
    );
  }
});
httpServer.once("error", async () => {
  githubIntake.stop();
  await writerLease.release();
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    githubIntake.stop();
    httpServer.close(async () => {
      await writerLease.release();
      process.exit(0);
    });
  });
}
