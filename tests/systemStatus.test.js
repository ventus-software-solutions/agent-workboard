import { describe, expect, it } from "vitest";
import { describeSystemStatus, formatUptime } from "../src/lib/systemStatus.js";

describe("system status pill model", () => {
  it("flags a healthy recent restart and exposes runtime identity", () => {
    expect(
      describeSystemStatus({
        server: { startedAt: "2026-08-13T09:00:00.000Z", version: "1.2.3", storageMode: "sqlite" },
        refreshState: { status: "live", lastCheckedAt: "2026-08-13T09:04:00.000Z" },
        now: "2026-08-13T09:05:00.000Z"
      })
    ).toMatchObject({
      label: "Recent restart",
      tone: "recentRestart",
      uptimeLabel: "Up 5m",
      version: "1.2.3",
      storageMode: "sqlite",
      recentRestart: true
    });
  });

  it("shows long-running, disconnected, and unknown-start states honestly", () => {
    expect(
      describeSystemStatus({
        server: { startedAt: "2026-08-12T08:00:00.000Z", version: "0.1.0", storageMode: "tasksdir" },
        refreshState: { status: "live" },
        now: "2026-08-13T10:30:00.000Z"
      })
    ).toMatchObject({ label: "Live", uptimeLabel: "Up 1d 2h", recentRestart: false });
    expect(
      describeSystemStatus({
        server: { startedAt: "2026-08-13T10:29:00.000Z", version: "0.1.0", storageMode: "json" },
        refreshState: { status: "disconnected", error: "Network unavailable" },
        now: "2026-08-13T10:30:00.000Z"
      })
    ).toMatchObject({ label: "Disconnected", tone: "disconnected", recentRestart: false });
    expect(describeSystemStatus({ server: {}, refreshState: { status: "live" } }).uptimeLabel).toBe("Uptime unknown");
  });

  it("keeps reconnect and error state above a recent-restart warning", () => {
    const server = { startedAt: "2026-08-13T10:29:00.000Z", version: "0.1.0", storageMode: "sqlite" };
    const reconnecting = describeSystemStatus({
      server,
      refreshState: {
        status: "reconnecting",
        error: "Synthetic poll failure",
        nextRetryAt: "2026-08-13T10:31:00.000Z"
      },
      now: "2026-08-13T10:30:00.000Z"
    });
    expect(reconnecting).toMatchObject({
      label: "Reconnecting…",
      tone: "reconnecting",
      recentRestart: false
    });
    expect(reconnecting.refreshDetail).toMatch(/^Retry at /);
    expect(reconnecting.title).toContain("Synthetic poll failure");

    expect(
      describeSystemStatus({
        server,
        refreshState: { status: "live", error: "A retained polling error" },
        now: "2026-08-13T10:30:00.000Z"
      })
    ).toMatchObject({ label: "Reconnecting…", tone: "reconnecting", refreshDetail: "Retry pending" });
  });

  it("shows active update state before a recent-restart warning", () => {
    const server = { startedAt: "2026-08-13T10:29:00.000Z" };
    expect(
      describeSystemStatus({ server, refreshState: { status: "updating" }, now: "2026-08-13T10:30:00.000Z" })
    ).toMatchObject({ label: "Updating", tone: "updating", recentRestart: false });
  });

  it("formats uptime at minute, hour, and day boundaries", () => {
    expect(formatUptime(20_000)).toBe("<1m");
    expect(formatUptime(61 * 60_000)).toBe("1h 1m");
    expect(formatUptime(49 * 60 * 60_000)).toBe("2d 1h");
  });
});
