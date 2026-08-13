#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { parseTaskFile, serializeTaskFile, validateTaskFileStructure } from "./storage/frontmatterTaskFile.js";
import { previewFileTaskMapping } from "./storage/tasksdirPersistence.js";

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "id",
  "title",
  "status",
  "type",
  "owner",
  "priority",
  "labels",
  "created",
  "board"
]);
const KNOWN_BOARD_KEYS = new Set([
  "role",
  "revision",
  "createdAt",
  "updatedAt",
  "completion",
  "verificationTarget",
  "blocker",
  "dependsOn",
  "blockedBy",
  "parentTaskId"
]);

function relativeFile(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function compareText(a, b) {
  return a.localeCompare(b, "en", { sensitivity: "base" });
}

async function discoverTaskFiles(root) {
  const rootEntries = await readdir(root, { withFileTypes: true });
  const topFolders = rootEntries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  const files = rootEntries
    .filter((entry) => entry.isFile() && entry.name === "task.md")
    .map((entry) => path.join(root, entry.name));

  async function walk(dirPath) {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile() && entry.name === "task.md") files.push(entryPath);
    }
  }

  for (const folder of topFolders) await walk(path.join(root, folder.name));
  files.sort((a, b) => compareText(relativeFile(root, a), relativeFile(root, b)));
  return { files, folders: topFolders.map((folder) => folder.name).sort(compareText), foldersScanned: topFolders.length };
}

function addCount(map, key, file, extra = {}) {
  let item = map.get(key);
  if (!item) {
    item = { ...extra, count: 0, files: new Set() };
    map.set(key, item);
  }
  item.count += 1;
  item.files.add(file);
}

function toSortedItems(map) {
  return [...map.values()]
    .map((item) => ({ ...item, files: [...item.files].sort(compareText) }))
    .sort((a, b) => compareText(`${a.source ?? a.key}\0${a.target ?? ""}`, `${b.source ?? b.key}\0${b.target ?? ""}`));
}

function mappingTarget(kind, item) {
  if (kind === "status" && item.completionType) return `${item.target}/${item.completionType}`;
  if (kind === "priority") return item.target || "none";
  return item.target;
}

export async function inspectTasksDir(tasksDir) {
  const startedAt = performance.now();
  const root = path.resolve(String(tasksDir || ""));
  const { files, folders, foldersScanned } = await discoverTaskFiles(root);
  const failures = [];
  const layoutIssues = [];
  const mismatches = [];
  const successful = [];
  const unknownKeys = new Map();
  const mappingMaps = {
    status: new Map(),
    type: new Map(),
    priority: new Map()
  };
  let totalBytes = 0;
  let unknownKeysPreserved = true;
  const fingerprint = createHash("sha256");
  for (const folder of folders) fingerprint.update("directory\0").update(folder).update("\0");
  for (const filePath of files) fingerprint.update("file\0").update(relativeFile(root, filePath)).update("\0");

  for (const filePath of files) {
    const file = relativeFile(root, filePath);
    let raw;
    try {
      raw = await readFile(filePath, "utf8");
      totalBytes += Buffer.byteLength(raw);
      fingerprint.update(raw).update("\0");
    } catch (error) {
      failures.push({ file, line: null, reason: `could not read file: ${error.message}` });
      continue;
    }

    const structuralFailures = validateTaskFileStructure(raw);
    if (structuralFailures.length > 0) {
      failures.push(...structuralFailures.map((failure) => ({ file, ...failure })));
      continue;
    }

    let doc;
    try {
      doc = parseTaskFile(raw);
    } catch (error) {
      failures.push({ file, line: null, reason: `parser error: ${error.message}` });
      continue;
    }
    if (!doc.hadFrontmatter) {
      failures.push({ file, line: 1, reason: "frontmatter could not be parsed" });
      continue;
    }
    if (serializeTaskFile(doc) !== raw) {
      unknownKeysPreserved = false;
      failures.push({ file, line: 1, reason: "parser round-trip changed file bytes" });
      continue;
    }

    const relativeParts = file.split("/");
    const folderName = relativeParts.at(-2) || "";
    if (relativeParts.length !== 2) {
      layoutIssues.push({
        file,
        reason: "unsupported layout; tasksdir storage only loads <folder>/task.md"
      });
    }

    let preview;
    try {
      preview = previewFileTaskMapping(doc, folderName, { fallbackTimestamp: "1970-01-01T00:00:00.000Z" });
    } catch (error) {
      failures.push({ file, line: null, reason: `mapping error: ${error.message}` });
      continue;
    }
    successful.push({ file, id: preview.id });
    if (preview.id !== folderName) mismatches.push({ file, folder: folderName, id: preview.id });

    for (const kind of ["status", "type", "priority"]) {
      const item = preview.mapping[kind];
      const source = item.source || "(missing)";
      const target = mappingTarget(kind, item);
      addCount(mappingMaps[kind], `${source}\0${target}`, file, {
        source,
        target,
        known: item.known
      });
    }

    for (const entry of doc.entries) {
      if (!entry.key) continue;
      if (!KNOWN_TOP_LEVEL_KEYS.has(entry.key)) {
        addCount(unknownKeys, entry.key, file, { key: entry.key });
      }
      if (entry.key === "board") {
        for (const child of entry.children) {
          if (!KNOWN_BOARD_KEYS.has(child.key)) {
            addCount(unknownKeys, `board.${child.key}`, file, { key: `board.${child.key}` });
          }
        }
      }
    }
  }

  failures.sort((a, b) => compareText(`${a.file}:${a.line ?? ""}`, `${b.file}:${b.line ?? ""}`));
  mismatches.sort((a, b) => compareText(a.file, b.file));
  layoutIssues.sort((a, b) => compareText(a.file, b.file));

  const byId = new Map();
  for (const item of successful) {
    const current = byId.get(item.id) || [];
    current.push(item.file);
    byId.set(item.id, current);
  }
  const duplicates = [...byId.entries()]
    .filter(([, duplicateFiles]) => duplicateFiles.length > 1)
    .map(([id, duplicateFiles]) => ({ id, files: duplicateFiles.sort(compareText) }))
    .sort((a, b) => compareText(a.id, b.id));

  const mappingPreview = {};
  const unknownMappingValues = [];
  for (const kind of ["status", "type", "priority"]) {
    const histogram = toSortedItems(mappingMaps[kind]);
    const unknown = histogram
      .filter((item) => !item.known)
      .map(({ source: value, target, count, files: itemFiles }) => ({ value, target, count, files: itemFiles }));
    mappingPreview[kind] = { histogram, unknown };
    for (const item of unknown) unknownMappingValues.push(`${kind}=${item.value}`);
  }

  const blockers = [];
  if (failures.length > 0) blockers.push(`${failures.length} parse/round-trip failure(s)`);
  if (layoutIssues.length > 0) blockers.push(`${layoutIssues.length} unsupported task.md layout(s)`);
  if (duplicates.length > 0) blockers.push(`${duplicates.length} duplicate task id(s)`);
  if (mismatches.length > 0) blockers.push(`${mismatches.length} id/folder mismatch(es)`);
  if (unknownMappingValues.length > 0) {
    blockers.push(`unknown mapping value(s): ${[...new Set(unknownMappingValues)].sort(compareText).join(", ")}`);
  }

  return {
    schemaVersion: 1,
    tasksDir: root,
    sourceFingerprint: fingerprint.digest("hex"),
    generatedAt: new Date().toISOString(),
    go: blockers.length === 0,
    blockers,
    summary: {
      foldersScanned,
      taskFiles: files.length,
      parsed: successful.length,
      failed: new Set(failures.map((failure) => failure.file)).size,
      totalBytes,
      parseTimeMs: Number((performance.now() - startedAt).toFixed(2))
    },
    parse: {
      ok: successful.map((item) => item.file).sort(compareText),
      failed: failures
    },
    mappingPreview,
    unknownFrontmatterKeys: {
      preserved: unknownKeysPreserved,
      items: toSortedItems(unknownKeys)
    },
    idChecks: { mismatches, duplicates, layoutIssues }
  };
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function section(lines, title, items, render) {
  lines.push("", `${title}:`);
  if (items.length === 0) lines.push("  None");
  else for (const item of items) lines.push(`  ${render(item)}`);
}

export function renderTasksdirDoctorReport(report) {
  const lines = [
    `TASKSDIR PREFLIGHT: ${report.go ? "GO" : "NO-GO"}`,
    `Directory: ${report.tasksDir}`,
    `Scanned: ${report.summary.foldersScanned} folders, ${report.summary.taskFiles} task.md files, ${formatBytes(report.summary.totalBytes)} in ${report.summary.parseTimeMs.toFixed(2)} ms`,
    `Parsed: ${report.summary.parsed} ok, ${report.summary.failed} failed`
  ];

  section(lines, "Parse failures", report.parse.failed, (item) => `${item.file}${item.line ? `:${item.line}` : ""} - ${item.reason}`);
  lines.push("", "Mapping preview:");
  for (const kind of ["status", "type", "priority"]) {
    lines.push(`  ${kind}:`);
    const items = report.mappingPreview[kind].histogram;
    if (items.length === 0) lines.push("    None");
    else {
      for (const item of items) {
        lines.push(`    ${item.source} -> ${item.target}: ${item.count}${item.known ? "" : " [UNKNOWN]"}`);
      }
    }
  }
  section(
    lines,
    `Unknown frontmatter keys (preserved byte-for-byte: ${report.unknownFrontmatterKeys.preserved ? "yes" : "NO"})`,
    report.unknownFrontmatterKeys.items,
    (item) => `${item.key}: ${item.count} (${item.files.join(", ")})`
  );
  section(lines, "ID/folder mismatches", report.idChecks.mismatches, (item) => `${item.file}: id=${item.id}, folder=${item.folder}`);
  section(lines, "Duplicate IDs", report.idChecks.duplicates, (item) => `${item.id}: ${item.files.join(", ")}`);
  section(lines, "Unsupported layouts", report.idChecks.layoutIssues, (item) => `${item.file}: ${item.reason}`);
  section(lines, "Import blockers", report.blockers, (item) => item);
  lines.push("", report.go ? "Result: safe to enable tasksdir storage." : "Result: fix the blockers above before enabling tasksdir storage.");
  return `${lines.join("\n")}\n`;
}

export async function runTasksdirDoctorCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const args = [...argv];
  const json = args.includes("--json");
  const help = args.includes("--help") || args.includes("-h");
  const positional = args.filter((arg) => !["--json", "--help", "-h"].includes(arg));
  const usage = "Usage: node server/tasksdirDoctor.js <tasks-dir> [--json]\n";
  if (help) {
    stdout.write(usage);
    return 0;
  }
  if (positional.length !== 1) {
    stderr.write(usage);
    return 2;
  }
  try {
    const report = await inspectTasksDir(positional[0]);
    stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderTasksdirDoctorReport(report));
    return report.go ? 0 : 1;
  } catch (error) {
    stderr.write(`tasksdir doctor failed: ${error.message}\n`);
    return 2;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  process.exitCode = await runTasksdirDoctorCli(process.argv.slice(2));
}
