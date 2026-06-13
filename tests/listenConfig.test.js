import { describe, expect, it } from "vitest";
import { DEFAULT_LISTEN_HOST, formatListenUrl, isNetworkExposedHost, readListenConfig } from "../server/listenConfig.js";

describe("listen configuration", () => {
  it("binds the server to loopback by default", () => {
    expect(readListenConfig({})).toEqual({
      host: DEFAULT_LISTEN_HOST,
      port: 8080
    });
  });

  it("honors an explicit Workboard host override for remote or container modes", () => {
    expect(readListenConfig({ WORKBOARD_HOST: "0.0.0.0", PORT: "9090" })).toEqual({
      host: "0.0.0.0",
      port: 9090
    });
  });

  it("keeps blank host overrides local-only", () => {
    expect(readListenConfig({ WORKBOARD_HOST: "  ", PORT: "" })).toEqual({
      host: DEFAULT_LISTEN_HOST,
      port: 8080
    });
  });

  it("rejects invalid port values before opening a socket", () => {
    expect(() => readListenConfig({ PORT: "not-a-port" })).toThrow(/PORT/);
    expect(() => readListenConfig({ PORT: "70000" })).toThrow(/PORT/);
  });

  it("reports network-exposed hosts distinctly from loopback hosts", () => {
    expect(isNetworkExposedHost("127.0.0.1")).toBe(false);
    expect(isNetworkExposedHost("localhost")).toBe(false);
    expect(isNetworkExposedHost("0.0.0.0")).toBe(true);
    expect(isNetworkExposedHost("::")).toBe(true);
  });

  it("formats wildcard listen hosts as a local browser URL", () => {
    expect(formatListenUrl({ host: "0.0.0.0", port: 8080 })).toBe("http://localhost:8080");
    expect(formatListenUrl({ host: "::", port: 8080 })).toBe("http://localhost:8080");
    expect(formatListenUrl({ host: "::1", port: 8080 })).toBe("http://[::1]:8080");
  });
});
