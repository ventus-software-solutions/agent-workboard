import path from "node:path";
import { createApp } from "./app.js";
import { WorkboardStore } from "./storage/workboardStore.js";

const port = Number(process.env.PORT || 8080);
const dataDir = process.env.WORKBOARD_DATA_DIR || path.resolve(".workboard-data");

const store = new WorkboardStore({ dataDir });
await store.init();

const app = createApp({ store });
app.listen(port, () => {
  console.log(`Agent Workboard listening on http://localhost:${port}`);
});
