import { isClientDisconnectError } from "./httpResilience.js";

const STATE_INTEGRITY_ERROR_CODE = "WORKBOARD_STATE_INTEGRITY";

export function installProcessErrorGuards({ processTarget = process, logger = console, terminate } = {}) {
  const stopProcess = terminate || (() => processTarget.exit(1));

  const onUncaughtException = (error, origin) => {
    if (isClientDisconnectError(error)) {
      logger.debug?.("Ignored an uncaught client disconnect error.", errorDetails(error, { origin }));
      return;
    }

    logger.error?.(
      "Uncaught exception; stopping because in-memory state integrity cannot be guaranteed.",
      errorDetails(error, { origin })
    );
    stopProcess(error, origin);
  };

  const onUnhandledRejection = (reason) => {
    if (isClientDisconnectError(reason)) {
      logger.debug?.("Ignored an unhandled client disconnect rejection.", errorDetails(reason));
      return;
    }

    if (hasStateIntegrityRisk(reason)) {
      logger.error?.(
        "Unhandled rejection marked as a state-integrity risk; stopping the process.",
        errorDetails(reason)
      );
      stopProcess(reason, "unhandledRejection");
      return;
    }

    logger.error?.(
      "Unhandled promise rejection; continuing because persisted writes are serialized and atomically committed.",
      errorDetails(reason)
    );
  };

  processTarget.on("uncaughtException", onUncaughtException);
  processTarget.on("unhandledRejection", onUnhandledRejection);

  return () => {
    processTarget.off("uncaughtException", onUncaughtException);
    processTarget.off("unhandledRejection", onUnhandledRejection);
  };
}

export function hasStateIntegrityRisk(error) {
  const seen = new Set();
  let current = error;

  while (current && (typeof current === "object" || typeof current === "function") && !seen.has(current)) {
    seen.add(current);
    if (current.stateIntegrityRisk === true || current.code === STATE_INTEGRITY_ERROR_CODE) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

function errorDetails(error, extra = {}) {
  return {
    ...extra,
    code: error?.code,
    message: error?.message || String(error),
    stack: error?.stack
  };
}
