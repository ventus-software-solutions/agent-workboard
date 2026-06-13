export const DEFAULT_LISTEN_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8080;

export function readListenConfig(env = process.env) {
  return {
    host: readHost(env.WORKBOARD_HOST),
    port: readPort(env.PORT)
  };
}

export function formatListenUrl({ host, port }) {
  const displayHost = isNetworkExposedHost(host) ? "localhost" : host;
  return `http://${formatHostForUrl(displayHost)}:${port}`;
}

export function isNetworkExposedHost(host) {
  return host === "0.0.0.0" || host === "::";
}

function readHost(value) {
  const host = String(value || "").trim();
  return host || DEFAULT_LISTEN_HOST;
}

function readPort(value) {
  const port = value === undefined || value === null || value === "" ? DEFAULT_PORT : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer from 1 to 65535; received ${JSON.stringify(value)}.`);
  }
  return port;
}

function formatHostForUrl(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
