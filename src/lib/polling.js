export function pollingDelay({ failedAttempts, intervalMs, maxBackoffMs }) {
  if (failedAttempts <= 0) return intervalMs;
  return Math.min(intervalMs * 2 ** failedAttempts, maxBackoffMs);
}

export function createPollingScheduler({
  poll,
  onError = () => {},
  intervalMs,
  maxBackoffMs,
  schedule = (callback, delay) => globalThis.setTimeout(callback, delay),
  cancel = (timerId) => globalThis.clearTimeout(timerId)
}) {
  let failedAttempts = 0;
  let inFlight = false;
  let stopped = true;
  let timerId = null;

  async function run(options = {}) {
    if (stopped || inFlight) return;

    inFlight = true;
    try {
      await poll(options);
      failedAttempts = 0;
    } catch (error) {
      failedAttempts += 1;
      const nextDelayMs = pollingDelay({ failedAttempts, intervalMs, maxBackoffMs });
      if (!stopped) {
        onError(error, { failedAttempts, nextDelayMs });
      }
    } finally {
      inFlight = false;
      if (!stopped) {
        const delay = pollingDelay({ failedAttempts, intervalMs, maxBackoffMs });
        timerId = schedule(() => run(), delay);
      }
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      return run({ refreshOnChange: false });
    },
    stop() {
      stopped = true;
      if (timerId !== null) {
        cancel(timerId);
        timerId = null;
      }
    }
  };
}
