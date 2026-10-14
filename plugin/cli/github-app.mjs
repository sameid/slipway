// The deployer's GitHub App, for `slipway setup`. It's created with GitHub's manifest
// flow, so nobody copies keys around: a page on 127.0.0.1 posts the App's settings to
// GitHub, GitHub sends the browser back with a code, and the code is exchanged for the
// App's ID, private key and webhook secret. Then the App is installed on all of the
// owner's repositories, which the deployer needs so every new app repo is covered.
import { spawn } from "node:child_process";
import { createSign, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { githubToken } from "./config.mjs";
import { CliError, print, sleep } from "./util.mjs";

const API = () => (process.env.SLIPWAY_GITHUB_API || "https://api.github.com").replace(/\/+$/, "");
const WEB = () => (process.env.SLIPWAY_GITHUB_WEB || "https://github.com").replace(/\/+$/, "");

export class GithubError extends CliError {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// A GitHub REST call. auth: "user" (the gh CLI's token), a JWT string, or null.
export async function github(method, path, { auth = "user", body } = {}) {
  const token = auth === "user" ? githubToken() : auth;
  let res;
  try {
    res = await fetch(`${API()}${path}`, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "slipway-setup",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new GithubError(0, `Can't reach GitHub (${err.cause?.code ?? err.name}).`);
  }
  const raw = await res.text();
  let data = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  if (!res.ok) throw new GithubError(res.status, `GitHub answered ${res.status} to ${method} ${path}: ${data?.message ?? raw.slice(0, 200)}`);
  return data;
}

// A JSON Web Token that authenticates as the App itself (valid for 9 minutes).
export function appJwt(appId, privateKey, now = Date.now()) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const iat = Math.floor(now / 1000) - 60; // allow for clock drift
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iat, exp: iat + 600, iss: String(appId) })}`;
  return `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url")}`;
}

// The App's settings. Permissions match what the deployer does: protect main
// (administration), read code and merge (contents, pull_requests), report its check
// (statuses), and in an org, check membership (members).
export function manifest({ owner, isOrg, deployerUrl, redirectUrl }) {
  return {
    name: `slipway-${owner}`.slice(0, 34),
    url: deployerUrl,
    description: "slipway's deployer: builds and deploys the apps in this account's slipway repos.",
    hook_attributes: { url: `${deployerUrl}/webhooks/github`, active: true },
    redirect_url: redirectUrl,
    public: false,
    default_permissions: {
      administration: "write",
      contents: "write",
      metadata: "read",
      pull_requests: "write",
      statuses: "write",
      ...(isOrg ? { members: "read" } : {}),
    },
    default_events: ["push", "pull_request"],
  };
}

export function newAppUrl(owner, isOrg, state) {
  const base = isOrg ? `${WEB()}/organizations/${encodeURIComponent(owner)}/settings/apps/new` : `${WEB()}/settings/apps/new`;
  return `${base}?state=${state}`;
}

const escapeHtml = (text) =>
  String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(title, body) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:4rem auto;padding:0 1rem;color:#1f2328}
button{font:inherit;padding:.5rem 1rem;border-radius:6px;border:1px solid #1f883d;background:#1f883d;color:#fff;cursor:pointer}
code{background:#f6f8fa;padding:.1rem .3rem;border-radius:4px}</style></head><body>${body}</body></html>`;
}

export function openInBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser here (an SSH session, say): the URL is printed anyway.
  }
}

// The manifest flow's local server. Returns { url, created, close }: open url in a
// browser; created resolves with { appId, slug, privateKey, webhookSecret } once GitHub
// has sent the browser back and the code is exchanged.
export async function manifestFlow({ owner, isOrg, deployerUrl }) {
  const state = randomBytes(16).toString("hex");
  let settle;
  const done = new Promise((resolve, reject) => (settle = { resolve, reject }));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, html, headers = {}) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers });
      res.end(html);
    };
    if (url.pathname === "/") {
      const redirectUrl = `http://127.0.0.1:${server.address().port}/created`;
      const json = JSON.stringify(manifest({ owner, isOrg, deployerUrl, redirectUrl }));
      return send(
        200,
        page(
          "Create slipway's GitHub App",
          `<h1>Create slipway's GitHub App</h1>
<p>GitHub will show the App's settings for <b>${escapeHtml(owner)}</b>. You can change its name if it's taken, then choose <b>Create GitHub App</b>.</p>
<form id="f" method="post" action="${escapeHtml(newAppUrl(owner, isOrg, state))}">
<input type="hidden" name="manifest" value="${escapeHtml(json)}"><button>Continue to GitHub</button></form>
<script>document.getElementById("f").submit()</script>`,
        ),
      );
    }
    if (url.pathname === "/created") {
      if (url.searchParams.get("state") !== state || !url.searchParams.get("code")) {
        return send(400, page("Not this setup", "<p>This link isn't from the setup that's running. Go back to Claude Code.</p>"));
      }
      try {
        // The code is single-use and only valid for an hour; the exchange needs no token.
        const app = await github("POST", `/app-manifests/${encodeURIComponent(url.searchParams.get("code"))}/conversions`, { auth: null });
        const created = { appId: String(app.id), slug: app.slug, privateKey: app.pem, webhookSecret: app.webhook_secret };
        if (!created.webhookSecret) {
          // Older responses had no webhook secret: set one.
          created.webhookSecret = randomBytes(32).toString("hex");
          await github("PATCH", "/app/hook/config", {
            auth: appJwt(created.appId, created.privateKey),
            body: { secret: created.webhookSecret, content_type: "json", url: `${deployerUrl}/webhooks/github` },
          });
        }
        send(302, "", { location: `${WEB()}/apps/${encodeURIComponent(app.slug)}/installations/new` });
        settle.resolve(created);
      } catch (err) {
        send(500, page("Something went wrong", `<p>${escapeHtml(err.message)}</p><p>Go back to Claude Code and run setup again.</p>`));
        settle.reject(err);
      }
      return;
    }
    send(404, page("Not found", "<p>Nothing here.</p>"));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    created: done,
    close: () => server.close(),
  };
}

// Create the App: ask the user to go through the manifest flow in their browser.
export async function createApp({ owner, isOrg, deployerUrl, browser = true, timeoutMs = 20 * 60_000 }) {
  const flow = await manifestFlow({ owner, isOrg, deployerUrl });
  print(
    `ACTION: create slipway's GitHub App on ${owner}. Open ${flow.url} in your browser`,
    `        (it should have opened), choose Create GitHub App on GitHub, then install it on`,
    `        All repositories. Waiting for you...`,
  );
  if (browser) openInBrowser(flow.url);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new CliError(`Nobody created the GitHub App within ${Math.round(timeoutMs / 60_000)} minutes. Run setup again.`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([flow.created, timeout]);
  } finally {
    clearTimeout(timer);
    flow.close();
  }
}

// The App as GitHub sees it, or null if its key no longer works (App deleted, key revoked).
export async function appInfo(app) {
  try {
    return await github("GET", "/app", { auth: appJwt(app.appId, app.privateKey) });
  } catch (err) {
    if (err instanceof GithubError && [401, 403, 404].includes(err.status)) return null;
    throw err;
  }
}

export async function findInstallation(app, owner) {
  const installations = await github("GET", "/app/installations?per_page=100", { auth: appJwt(app.appId, app.privateKey) });
  return installations.find((i) => i.account?.login?.toLowerCase() === owner.toLowerCase()) ?? null;
}

// Wait until the App is installed on the owner with access to all repositories.
export async function waitForInstallation(app, slug, owner, { timeoutMs = 20 * 60_000, intervalMs = 3000 } = {}) {
  const until = Date.now() + timeoutMs;
  let told = "";
  for (;;) {
    const installation = await findInstallation(app, owner);
    if (installation?.repository_selection === "all") return installation;
    const say = installation
      ? `ACTION: the GitHub App is installed on selected repositories only. Change it to All repositories: ${installation.html_url}`
      : `ACTION: install the GitHub App on ${owner}, with All repositories: ${WEB()}/apps/${slug}/installations/new`;
    if (say !== told) print(say);
    told = say;
    if (Date.now() > until) throw new CliError(`The GitHub App isn't installed on all of ${owner}'s repositories yet. Do that, then run setup again.`);
    await sleep(intervalMs);
  }
}
