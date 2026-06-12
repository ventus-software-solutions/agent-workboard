import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, request } from "../src/lib/api.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("API client errors", () => {
  it("throws status-aware API errors with server details", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Task was changed by another operator.",
            details: { expectedRevision: 2, actualRevision: 3 }
          }
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" }
        }
      )
    );

    await expect(request("/api/tasks/task_123", { method: "PATCH", body: "{}" })).rejects.toMatchObject({
      name: "ApiError",
      message: "Task was changed by another operator.",
      status: 409,
      details: { expectedRevision: 2, actualRevision: 3 }
    });
  });

  it("falls back to response status text when the server sends no JSON message", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 500, statusText: "Server Error" }));

    await expect(request("/api/tasks/task_123")).rejects.toEqual(
      new ApiError("Request failed with 500", { status: 500, details: null })
    );
  });
});
