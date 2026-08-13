const CLIENT_DISCONNECT_CODES = new Set(["EPIPE", "ECONNRESET"]);
const guardedSocket = Symbol("agent-workboard-client-error-guard");

export function isClientDisconnectError(error) {
  const seen = new Set();
  let current = error;

  while (current && (typeof current === "object" || typeof current === "function") && !seen.has(current)) {
    seen.add(current);
    const code = String(current.code || "").toUpperCase();
    if (CLIENT_DISCONNECT_CODES.has(code)) {
      return true;
    }
    current = current.cause;
  }

  return false;
}

export function installClientDisconnectGuards(req, res, { logger = console } = {}) {
  req.on("error", (error) => {
    logStreamError(logger, "request", error, requestContext(req));
  });

  res.on("error", (error) => {
    logStreamError(logger, "response", error, requestContext(req));
  });

  const socket = req.socket;
  if (socket && !socket[guardedSocket]) {
    Object.defineProperty(socket, guardedSocket, { value: true });
    socket.on("error", (error) => {
      logStreamError(logger, "socket", error, {
        remoteAddress: socket.remoteAddress,
        remotePort: socket.remotePort
      });
    });
  }
}

export function clientDisconnectMiddleware({ logger = console } = {}) {
  return (req, res, next) => {
    installClientDisconnectGuards(req, res, { logger });
    next();
  };
}

export function finishHttpError(error, req, res, next, { logger = console } = {}) {
  if (isClientDisconnectError(error) || req.aborted || res.destroyed) {
    logAt(logger, "debug", "Client disconnected before the HTTP response completed.", error, requestContext(req));
    return true;
  }

  if (res.headersSent) {
    next(error);
    return true;
  }

  return false;
}

function logStreamError(logger, stream, error, context) {
  if (isClientDisconnectError(error)) {
    logAt(logger, "debug", `Client ${stream} closed before the HTTP response completed.`, error, context);
    return;
  }

  logAt(logger, "error", `Unexpected HTTP ${stream} error.`, error, context);
}

function logAt(logger, level, message, error, context) {
  logger?.[level]?.(message, {
    ...context,
    code: error?.code,
    error: error?.message || String(error)
  });
}

function requestContext(req) {
  return {
    method: req.method,
    path: req.originalUrl || req.url
  };
}
