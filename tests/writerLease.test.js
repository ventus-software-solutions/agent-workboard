import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireWriterLease, writerLeasePath } from "../server/storage/writerLease.js";

const tempDirs = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("workboard writer lease", () => {
  it("allows exactly one live process to own a data directory", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "workboard-writer-"));
    tempDirs.push(dataDir);
    const first = await acquireWriterLease(dataDir, { owner: "http-daemon", pid: 101, isPidAlive: () => true });

    await expect(
      acquireWriterLease(dataDir, { owner: "mcp-stdio", pid: 202, isPidAlive: () => true })
    ).rejects.toMatchObject({
      code: "WORKBOARD_WRITER_ACTIVE",
      owner: "http-daemon",
      ownerPid: 101
    });

    expect(await first.release()).toBe(true);
    const second = await acquireWriterLease(dataDir, { owner: "mcp-stdio", pid: 202, isPidAlive: () => true });
    expect(await second.release()).toBe(true);
  });

  it("recovers a stale process lease without deleting a replacement owner", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "workboard-writer-stale-"));
    tempDirs.push(dataDir);
    await writeFile(
      writerLeasePath(dataDir),
      `${JSON.stringify({ schemaVersion: 1, token: "dead", pid: 303, owner: "mcp-stdio" })}\n`
    );

    const lease = await acquireWriterLease(dataDir, { owner: "http-daemon", pid: 404, isPidAlive: () => false });
    await writeFile(
      writerLeasePath(dataDir),
      `${JSON.stringify({ schemaVersion: 1, token: "replacement", pid: 505, owner: "replacement" })}\n`
    );

    expect(await lease.release()).toBe(false);
    await expect(
      acquireWriterLease(dataDir, { owner: "third", pid: 606, isPidAlive: () => true })
    ).rejects.toMatchObject({ owner: "replacement", ownerPid: 505 });
  });

  it("never exposes an incomplete lease that a delayed live initializer can lose", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "workboard-writer-delayed-"));
    tempDirs.push(dataDir);
    let signalPrepared;
    let resumeFirst;
    const prepared = new Promise((resolve) => {
      signalPrepared = resolve;
    });
    const resume = new Promise((resolve) => {
      resumeFirst = resolve;
    });

    const firstAttempt = acquireWriterLease(dataDir, {
      owner: "delayed-http-daemon",
      pid: 707,
      isPidAlive: () => true,
      beforePublish: async () => {
        signalPrepared();
        await resume;
      }
    });
    await prepared;

    await expect(stat(writerLeasePath(dataDir))).rejects.toMatchObject({ code: "ENOENT" });
    const second = await acquireWriterLease(dataDir, {
      owner: "mcp-stdio",
      pid: 808,
      now: () => new Date(Date.now() + 10_000),
      isPidAlive: () => true
    });
    const published = JSON.parse(await readFile(writerLeasePath(dataDir), "utf8"));
    expect(published).toMatchObject({ owner: "mcp-stdio", pid: 808 });

    resumeFirst();
    await expect(firstAttempt).rejects.toMatchObject({
      code: "WORKBOARD_WRITER_ACTIVE",
      owner: "mcp-stdio",
      ownerPid: 808
    });
    expect(await second.release()).toBe(true);
  });
});
