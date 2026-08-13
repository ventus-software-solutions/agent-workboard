const DEFAULT_ROLE = "implementer";

export const FEEDER_STATUSES_BY_ROLE = Object.freeze({
  implementer: Object.freeze(["ready", "backlog"]),
  reviewer: Object.freeze(["in_progress", "ready"]),
  tester: Object.freeze(["review", "in_progress"]),
  pm: Object.freeze(["backlog", "ready"]),
  researcher: Object.freeze(["ready", "backlog"]),
  operator: Object.freeze(["blocked"])
});

export function feederStatusesForRole(role) {
  return FEEDER_STATUSES_BY_ROLE[role] || FEEDER_STATUSES_BY_ROLE[DEFAULT_ROLE];
}
