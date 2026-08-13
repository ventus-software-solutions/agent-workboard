import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../server/app.js";
import {
  clientDisconnectMiddleware,
  finishHttpError,
  isClientDisconnectError
} from "../server/httpResilience.js";
import { hasStateIntegrityRisk, installProcessErrorGuards } from "../server/processResilience.js";
import { runSqliteScript } from "../server/storage/persistence.js";

const openServers = new Set();
const tempDirs = new Set();

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections();
          server.close(resolve);
        })
    )
  );
  openServers.clear();
  await Promise.all([...tempDirs].map((tempDir) => rm(tempDir, { recursive: true, force: true })));
  tempDirs.clear();
});

describe("HTTP disconnect resilience", () => {
  it("recognizes direct and wrapped client disconnect errors", () => {
    expect(isClientDisconnectError(Object.assign(new Error("broken pipe"), { code: "EPIPE" }))).toBe(true);
    expect(
      isClientDisconnectError(new Error("send failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }))
    ).toBe(true);
    expect(isClientDisconnectError(Object.assign(new Error("disk failed"), { code: "EIO" }))).toBe(false);
  });

  it("guards request, response, and socket error events without rethrowing", () => {
    const logger = { debug: vi.fn(), error: vi.fn() };
    const socket = Object.assign(new EventEmitter(), { remoteAddress: "127.0.0.1", remotePort: 1234 });
    const req = Object.assign(new EventEmitter(), {
      method: "GET",
      originalUrl: "/large-response",
      socket
    });
    const res = new EventEmitter();
    const next = vi.fn();

    clientDisconnectMiddleware({ logger })(req, res, next);
    req.emit("error", Object.assign(new Error("request reset"), { code: "ECONNRESET" }));
    res.emit("error", Object.assign(new Error("response pipe"), { code: "EPIPE" }));
    socket.emit("error", Object.assign(new Error("socket reset"), { code: "ECONNRESET" }));

    expect(next).toHaveBeenCalledOnce();
    expect(logger.debug).toHaveBeenCalledTimes(3);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("does not try to write an error response after a disconnect", () => {
    const logger = { debug: vi.fn(), error: vi.fn() };
    const req = { method: "GET", originalUrl: "/file", aborted: true };
    const res = { destroyed: true, headersSent: true };
    const next = vi.fn();

    expect(finishHttpError(new Error("late file error"), req, res, next, { logger })).toBe(true);
    expect(logger.debug).toHaveBeenCalledOnce();
    expect(next).not.toHaveBeenCalled();
  });

  it("keeps the same HTTP server answering after a client kills a large response", async () => {
    const logger = { debug: vi.fn(), error: vi.fn() };
    const hugeValue = "x".repeat(16 * 1024 * 1024);
    const store = {
      roles: () => [hugeValue],
      statuses: () => [],
      completionTypes: () => [],
      workItemTypes: () => [],
      capabilityStatuses: () => [],
      blockerTypes: () => [],
      operatorApprovalDecisions: () => []
    };
    const app = createApp({
      store,
      logger,
      integrationStatusProvider: () => ({ sourceOfTruth: "test", baseRef: "test" })
    });
    const server = app.listen(0, "127.0.0.1");
    openServers.add(server);
    await once(server, "listening");
    const { port } = server.address();

    await abortAfterFirstChunk(`http://127.0.0.1:${port}/api/meta`);
    await request(server).get("/api/health").expect(200, { ok: true, service: "agent-workboard" });
    expect(server.listening).toBe(true);
  });

  it("keeps serving after a client kills the static SPA fallback mid-response", async () => {
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "agent-workboard-static-"));
    tempDirs.add(staticDir);
    await writeFile(path.join(staticDir, "index.html"), "x".repeat(16 * 1024 * 1024));
    const logger = { debug: vi.fn(), error: vi.fn() };
    const app = createApp({
      store: {},
      logger,
      staticDir,
      integrationStatusProvider: () => ({ sourceOfTruth: "test", baseRef: "test" })
    });
    const server = app.listen(0, "127.0.0.1");
    openServers.add(server);
    await once(server, "listening");
    const { port } = server.address();

    await abortAfterFirstChunk(`http://127.0.0.1:${port}/client-route`);
    await request(server).get("/api/health").expect(200, { ok: true, service: "agent-workboard" });
    expect(server.listening).toBe(true);
  });
});

describe("process error policy", () => {
  it("continues for disconnects and ordinary rejections, but terminates when integrity is uncertain", () => {
    const processTarget = new EventEmitter();
    const logger = { debug: vi.fn(), error: vi.fn() };
    const terminate = vi.fn();
    const removeGuards = installProcessErrorGuards({ processTarget, logger, terminate });

    processTarget.emit("uncaughtException", Object.assign(new Error("pipe"), { code: "EPIPE" }), "uncaughtException");
    processTarget.emit("unhandledRejection", new Error("background operation failed"), Promise.resolve());
    expect(terminate).not.toHaveBeenCalled();

    const integrityError = Object.assign(new Error("partial mutation"), { stateIntegrityRisk: true });
    expect(hasStateIntegrityRisk(integrityError)).toBe(true);
    processTarget.emit("unhandledRejection", integrityError, Promise.resolve());
    processTarget.emit("uncaughtException", new Error("unexpected synchronous failure"), "uncaughtException");

    expect(terminate).toHaveBeenCalledTimes(2);
    expect(logger.debug).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledTimes(3);
    removeGuards();
    expect(processTarget.listenerCount("uncaughtException")).toBe(0);
    expect(processTarget.listenerCount("unhandledRejection")).toBe(0);
  });
});

describe("child-process stream resilience", () => {
  it("rejects a SQLite script cleanly when the child stdin pipe emits EPIPE", async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough()
    });
    const spawnProcess = vi.fn(() => child);
    const result = runSqliteScript("sqlite3", "workboard.sqlite", "SELECT 1;", spawnProcess);

    child.stdin.emit("error", Object.assign(new Error("broken sqlite stdin"), { code: "EPIPE" }));

    await expect(result).rejects.toMatchObject({
      status: 500,
      cause: expect.objectContaining({ code: "EPIPE" })
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      "sqlite3",
      ["-batch", "workboard.sqlite"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] })
    );
  });
});

function abortAfterFirstChunk(url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for the large response.")), 5000);
    const req = http.get(url, (res) => {
      res.once("data", () => {
        clearTimeout(timeout);
        res.destroy();
        req.destroy();
        resolve();
      });
    });
    req.once("error", (error) => {
      if (isClientDisconnectError(error)) {
        clearTimeout(timeout);
        resolve();
        return;
      }
      clearTimeout(timeout);
      reject(error);
    });
  });
}
