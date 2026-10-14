// Test harness: an in-process mock deployer, a stub `gh`, temp app repos, and a way to
// run bin/slipway as a subprocess (asynchronously, so the mock server keeps serving).
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const CLI = path.join(ROOT, "bin", "slipway");
export const GUARD = path.join(ROOT, "hooks", "guard.mjs");

// routes: [method, RegExp, (ctx) => ({ status, json } | { status, text })]
export async function mockDeployer(routes) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, "http://localhost");
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method, path: url.pathname, query: url.search, body, auth: req.headers.authorization });
    for (const [method, pattern, handler] of routes) {
      const match = req.method === method && pattern.exec(url.pathname);
      if (!match) continue;
      const out = await handler({ match, url, body, req });
      res.statusCode = out.status ?? 200;
      if (out.text !== undefined) {
        res.setHeader("content-type", "text/plain");
        return res.end(out.text);
      }
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(out.json ?? {}));
    }
    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: `no mock route for ${req.method} ${url.pathname}` }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export function tempDir(prefix = "slipway-test-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A `gh` that logs its arguments and answers the calls the CLI makes.
export function stubGh(dir, { repoExists = false, prState = "" } = {}) {
  const bin = path.join(dir, "stub-bin");
  mkdirSync(bin, { recursive: true });
  const log = path.join(dir, "gh.log");
  writeFileSync(
    path.join(bin, "gh"),
    `#!/usr/bin/env bash
echo "$*" >> "${log}"
case "$1 $2" in
  "auth token") echo stub-token ;;
  "repo view") ${repoExists ? 'echo \'{"name":"x"}\'' : 'echo "Could not resolve to a Repository" >&2; exit 1'} ;;
  "repo create") echo "https://github.com/$3" ;;
  "pr list") echo "${prState}" ;;
  *) echo "stub gh: unexpected $*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  return { bin, log };
}

const NO_CONFIG = path.join(tmpdir(), "slipway-test-no-config");

export const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
};

// A git repo that looks like a slipway app.
export function appRepo(dir, { name = "loan-tracker", secrets = [] } = {}) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: dir });
  writeFileSync(
    path.join(dir, "app.yaml"),
    [
      `name: ${name}`,
      "template: react-express",
      'description: "Tracks loans"',
      "owner: alice              # GitHub username",
      "",
      "api:",
      "  port: 3000",
      "",
      secrets.length ? `secrets:\n${secrets.map((s) => `  - ${s}`).join("\n")}` : "secrets: []",
      "",
      "# Platform-owned (dev team approval required to change)",
      "auth: clerk",
      "auto_merge: true",
      "sizes:",
      "  staging: small",
      "  prod: small",
      "",
    ].join("\n"),
  );
  return dir;
}

export function runCli(args, { cwd = ROOT, env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      // XDG_CONFIG_HOME: never read the developer's own `slipway setup` config.
      env: { ...process.env, ...GIT_ENV, XDG_CONFIG_HOME: NO_CONFIG, SLIPWAY_GH_TOKEN: "fake:alice", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

export function runGuard(input, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [GUARD], { cwd: cwd ?? ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// Fixtures in the deployer API's shapes.
export function job(overrides = {}) {
  return {
    id: 7,
    app: "loan-tracker",
    env: "staging",
    kind: "deploy",
    status: "running",
    releaseId: 3,
    commitSha: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
    prNumber: null,
    requestedBy: "system",
    failedStep: null,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logPath: `/api/apps/loan-tracker/jobs/${overrides.id ?? 7}/log`,
    dashboardUrl: `https://deployer.example/apps/loan-tracker/jobs/${overrides.id ?? 7}`,
    ...overrides,
  };
}

export function app(overrides = {}) {
  const release = { id: 3, commitSha: "a1b2c3d4e5f6", shortSha: "a1b2c3d", status: "ready", imageDigest: "sha256:abc", createdAt: new Date().toISOString() };
  return {
    name: "loan-tracker",
    repo: "acme/loan-tracker",
    repoUrl: "https://github.com/acme/loan-tracker",
    owner: "alice",
    status: "active",
    autoMerge: true,
    dashboardUrl: "https://deployer.example/apps/loan-tracker",
    phase: "live",
    error: null,
    staging: { url: "https://dstaging.cloudfront.net", release, lastDeploy: job({ status: "succeeded" }) },
    prod: { url: null, release: null, lastDeploy: null },
    activeJobs: [],
    recentJobs: [],
    ...overrides,
  };
}
