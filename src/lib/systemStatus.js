export const RECENT_RESTART_MS = 10 * 60 * 1000;

export function describeSystemStatus({ server = {}, refreshState = {}, now = Date.now() } = {}) {
  server = server || {};
  refreshState = refreshState || {};
  const startedAtMs = Date.parse(server.startedAt || "");
  const nowMs = typeof now === "number" ? now : new Date(now).getTime();
  const hasStartedAt = Number.isFinite(startedAtMs) && Number.isFinite(nowMs);
  const uptimeMs = hasStartedAt ? Math.max(0, nowMs - startedAtMs) : null;
  const refreshStatus = refreshState.status || "connecting";
  const hasRefreshError = Boolean(String(refreshState.error || "").trim());
  const disconnected = refreshStatus === "disconnected";
  const reconnecting = !disconnected && (refreshStatus === "reconnecting" || hasRefreshError);
  const connecting = refreshStatus === "connecting";
  const updating = refreshStatus === "updating";
  const updated = refreshStatus === "updated";
  const recentRestart =
    !disconnected && !reconnecting && !connecting && !updating && !updated && uptimeMs !== null && uptimeMs < RECENT_RESTART_MS;
  const label = disconnected
    ? "Disconnected"
    : reconnecting
      ? "Reconnecting…"
      : connecting
      ? "Connecting"
      : updating
        ? "Updating"
        : updated
          ? "Updated"
          : recentRestart
            ? "Recent restart"
            : "Live";
  const tone = disconnected
    ? "disconnected"
    : reconnecting
      ? "reconnecting"
      : connecting
        ? "connecting"
        : updating || updated
          ? refreshStatus
          : recentRestart
            ? "recentRestart"
            : "live";
  const checkedAt = formatStatusClock(refreshState.lastCheckedAt);
  const updatedAt = formatStatusClock(refreshState.lastUpdatedAt);
  const nextRetryAt = formatStatusClock(refreshState.nextRetryAt);
  const refreshDetail = disconnected || reconnecting
    ? nextRetryAt
      ? `Retry at ${nextRetryAt}`
      : "Retry pending"
    : updated && updatedAt
      ? `Updated ${updatedAt}`
      : checkedAt
        ? `Checked ${checkedAt}`
        : updating
          ? "Updating board"
          : "Checking";

  return {
    label,
    tone,
    uptimeMs,
    uptimeLabel: uptimeMs === null ? "Uptime unknown" : `Up ${formatUptime(uptimeMs)}`,
    storageMode: server.storageMode || "unknown",
    version: server.version || "unknown",
    recentRestart,
    refreshDetail,
    title: [
      server.startedAt ? `Started ${server.startedAt}` : "Start time unavailable",
      refreshDetail,
      refreshState.error || ""
    ]
      .filter(Boolean)
      .join("\n")
  };
}

export function formatStatusClock(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function formatUptime(uptimeMs) {
  const totalMinutes = Math.max(0, Math.floor(Number(uptimeMs || 0) / 60_000));
  if (totalMinutes < 1) return "<1m";
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;
  const days = Math.floor(totalHours / 24);
  return `${days}d ${totalHours % 24}h`;
}
