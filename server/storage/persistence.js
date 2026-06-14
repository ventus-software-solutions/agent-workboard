import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const WORKBOARD_STORAGE_MODES = new Set(["json", "sqlite"]);
const SQLITE_MAX_BUFFER = 100 * 1024 * 1024;
const SQLITE_SCHEMA_VERSION = 1;

const SQLITE_SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS workboard_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT OR IGNORE INTO schema_migrations (version) VALUES (${SQLITE_SCHEMA_VERSION});
`;

export function normalizeStorageMode(value = "json") {
  const mode = String(value || "json").trim().toLowerCase();
  if (!WORKBOARD_STORAGE_MODES.has(mode)) {
    throw Object.assign(new Error(`Unsupported WORKBOARD_STORAGE "${value}". Use "sqlite" or "json".`), {
      status: 500
    });
  }
  return mode;
}

export function createWorkboardPersistence({
  dataDir,
  storageMode = "json",
  sqliteCommand = process.env.SQLITE3_BIN || "sqlite3"
}) {
  const mode = normalizeStorageMode(storageMode);
  if (mode === "sqlite") {
    return new SqliteWorkboardPersistence({ dataDir, sqliteCommand });
  }
  return new JsonWorkboardPersistence({ dataDir });
}

class JsonWorkboardPersistence {
  constructor({ dataDir }) {
    this.mode = "json";
    this.dataDir = dataDir;
    this.path = path.join(dataDir, "workboard.json");
    this.lockPath = path.join(dataDir, "workboard.json.lock");
  }

  async read() {
    try {
      const raw = await readFile(this.path, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async write(data) {
    await mkdir(this.dataDir, { recursive: true });
    const tmpPath = `${this.path}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(data, null, 2));
    await rename(tmpPath, this.path);
  }
}

class SqliteWorkboardPersistence {
  constructor({ dataDir, sqliteCommand }) {
    this.mode = "sqlite";
    this.dataDir = dataDir;
    this.sqliteCommand = sqliteCommand;
    this.path = path.join(dataDir, "workboard.sqlite");
    this.legacyJsonPath = path.join(dataDir, "workboard.json");
    this.lockPath = path.join(dataDir, "workboard.sqlite.lock");
  }

  async read() {
    await this.ensureSchema();
    const stdout = await execSqliteJson(this.sqliteCommand, this.path, "SELECT json FROM workboard_state WHERE id = 1;");
    const rows = JSON.parse(stdout.trim() || "[]");
    const stateRow = rows.find((row) => typeof row.json === "string");
    if (!stateRow) {
      return null;
    }
    return JSON.parse(stateRow.json);
  }

  async readLegacyData() {
    try {
      const raw = await readFile(this.legacyJsonPath, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async write(data) {
    await mkdir(this.dataDir, { recursive: true });
    const payload = JSON.stringify(data, null, 2);
    await runSqliteScript(
      this.sqliteCommand,
      this.path,
      `
.bail on
${SQLITE_SCHEMA_SQL}
BEGIN IMMEDIATE;
INSERT INTO workboard_state (id, schema_version, json, updated_at)
VALUES (1, ${SQLITE_SCHEMA_VERSION}, ${sqlString(payload)}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(id) DO UPDATE SET
  schema_version = excluded.schema_version,
  json = excluded.json,
  updated_at = excluded.updated_at;
COMMIT;
`
    );
  }

  async ensureSchema() {
    await mkdir(this.dataDir, { recursive: true });
    await runSqliteScript(
      this.sqliteCommand,
      this.path,
      `
.bail on
${SQLITE_SCHEMA_SQL}
`
    );
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function execSqliteJson(sqliteCommand, dbPath, query) {
  return new Promise((resolve, reject) => {
    execFile(
      sqliteCommand,
      ["-batch", "-json", "-cmd", ".timeout 5000", dbPath, query],
      { maxBuffer: SQLITE_MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(wrapSqliteError(error, stderr));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function runSqliteScript(sqliteCommand, dbPath, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn(sqliteCommand, ["-batch", dbPath], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      settled = true;
      reject(wrapSqliteError(error, stderr));
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`sqlite3 exited with code ${code}: ${stderr || stdout}`.trim()));
    });
    child.stdin.end(sql);
  });
}

function wrapSqliteError(error, stderr) {
  if (error.code === "ENOENT") {
    return Object.assign(
      new Error(
        "SQLite persistence requires the sqlite3 command. Install sqlite3 or set WORKBOARD_STORAGE=json to use the legacy JSON store."
      ),
      { cause: error, status: 500 }
    );
  }
  return Object.assign(new Error(stderr ? `${error.message}: ${stderr}` : error.message), {
    cause: error,
    status: 500
  });
}
