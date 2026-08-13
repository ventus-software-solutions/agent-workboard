import { afterEach, describe, expect, it, vi } from "vitest";
import { createPollingScheduler, pollingDelay } from "../src/lib/polling.js";

describe("frontend polling scheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs one request per tick without overlapping a slow request", async () => {
    vi.useFakeTimers();
    let resolveFirst;
    const firstRequest = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const poll = vi.fn().mockReturnValueOnce(firstRequest).mockResolvedValue(undefined);
    const scheduler = createPollingScheduler({ poll, intervalMs: 2500, maxBackoffMs: 30_000 });

    scheduler.start();
    expect(poll).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenLastCalledWith({ refreshOnChange: false });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(1);

    resolveFirst();
    await firstRequest;
    await vi.advanceTimersByTimeAsync(2499);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);

    scheduler.stop();
  });

  it("backs off exponentially after failures and resets after recovery", async () => {
    vi.useFakeTimers();
    const poll = vi
      .fn()
      .mockRejectedValueOnce(new Error("first outage"))
      .mockRejectedValueOnce(new Error("second outage"))
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const scheduler = createPollingScheduler({ poll, onError, intervalMs: 2500, maxBackoffMs: 30_000 });

    await scheduler.start();
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ message: "first outage" }), {
      failedAttempts: 1,
      nextDelayMs: 5000
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ message: "second outage" }), {
      failedAttempts: 2,
      nextDelayMs: 10_000
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2499);
    expect(poll).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(4);

    scheduler.stop();
  });

  it("caps exponential delays", () => {
    expect(pollingDelay({ failedAttempts: 0, intervalMs: 2500, maxBackoffMs: 30_000 })).toBe(2500);
    expect(pollingDelay({ failedAttempts: 8, intervalMs: 2500, maxBackoffMs: 30_000 })).toBe(30_000);
  });
});
