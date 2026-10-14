// Client for the deployer's plugin API (see docs/contracts.md).
import { deployerUrl, githubToken } from "./config.mjs";
import { CliError } from "./util.mjs";

export class ApiError extends CliError {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, { body, text = false } = {}) {
  const url = `${deployerUrl()}${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${githubToken()}`,
        accept: text ? "text/plain" : "application/json",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof CliError) throw err;
    const reason = err.cause?.code ?? err.cause?.errors?.[0]?.code ?? err.name ?? err.message;
    throw new ApiError(0, `Can't reach the deployer at ${deployerUrl()} (${reason}).`);
  }
  const raw = await res.text();
  if (!res.ok) throw new ApiError(res.status, explain(res.status, raw));
  if (text) return raw;
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    throw new ApiError(res.status, `The deployer sent something that isn't JSON for ${method} ${path}.`);
  }
}

function explain(status, raw) {
  let message;
  try {
    message = JSON.parse(raw).error;
  } catch {
    message = raw.trim().slice(0, 300);
  }
  if (status === 401) return `${message || "invalid GitHub token"}. Run: gh auth login`;
  if (status === 403 && !message) return "The deployer doesn't let your GitHub account use it.";
  return message || `The deployer answered HTTP ${status}.`;
}

let me;

export const api = {
  get: (path) => request("GET", path),
  post: (path, body = {}) => request("POST", path, { body }),
  text: (path) => request("GET", path, { text: true }),

  whoami: () => request("GET", "/api/whoami"),

  // whoami, once per process: { login, owner, ownerType, codeowners }.
  me() {
    me ??= request("GET", "/api/whoami").catch((err) => {
      me = undefined;
      throw err;
    });
    return me;
  },

  // The app, or null if the deployer has never heard of it.
  async app(name) {
    try {
      return await request("GET", `/api/apps/${encodeURIComponent(name)}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }
  },
};

// Transient failures worth retrying while polling: network errors and 5xx.
export function isTransient(err) {
  return err instanceof ApiError && (err.status === 0 || err.status >= 500);
}
