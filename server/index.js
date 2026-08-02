import path from "node:path";
import { createApp } from "./app.js";
import { formatListenUrl, isNetworkExposedHost, readListenConfig } from "./listenConfig.js";
import { WorkboardStore } from "./storage/workboardStore.js";

const listenConfig = readListenConfig(process.env);
const dataDir = process.env.WORKBOARD_DATA_DIR || path.resolve(".workboard-data");
const storageMode = process.env.WORKBOARD_STORAGE || "sqlite";

const store = new WorkboardStore({ dataDir, storageMode });
await store.init();

const app = createApp({ store });
app.listen(listenConfig.port, listenConfig.host, () => {
  console.log(`Agent Workboard listening on ${formatListenUrl(listenConfig)} (bound to ${listenConfig.host})`);
  if (isNetworkExposedHost(listenConfig.host)) {
    console.warn(
      "Agent Workboard has no built-in authentication; expose remote deployments only behind trusted access controls."
    );
  }
});
