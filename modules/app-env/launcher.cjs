// The staging launcher (design 5.11). On staging, the container runs this in
// place of the image's command: it starts the app (the image's command, from
// SLIPWAY_APP_COMMAND) on a private port and passes the load balancer's
// requests on to it. When a deploy points current.json in the environment's
// swap bucket at another release built on the same image base, it downloads
// that release's /app, runs its migrations if asked to, and restarts the app
// from it while holding requests, so a staging deploy takes seconds instead of
// an ECS rollout. A release that doesn't come up healthy is dropped and the
// previous one restarted. Prod never runs this.
//
// Plain CommonJS without dependencies: deploy-env passes it to the image's
// node as `node -e`, so it works in any app image.
"use strict";

const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const env = process.env;
const PORT = Number(env.PORT); // the container port the load balancer targets
const APP_COMMAND = JSON.parse(env.SLIPWAY_APP_COMMAND || "[]"); // the image's CMD
const HEALTH_PATH = env.SLIPWAY_HEALTH_PATH || "/api/health";
const BUCKET = env.SLIPWAY_SWAP_BUCKET || "";
const REGION = env.SLIPWAY_REGION || env.AWS_REGION; // the app-env module sets SLIPWAY_REGION
// Releases built on another base (Dockerfile, base image, command) need a new image.
const BASE = env.SLIPWAY_SWAP_BASE || "";
const S3_ENDPOINT = env.SLIPWAY_S3_ENDPOINT || `https://${BUCKET}.s3.${REGION}.amazonaws.com`;
const WORK = env.SLIPWAY_WORK_DIR || "/tmp/slipway";
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};
const IMAGE_ROOT = real(env.SLIPWAY_IMAGE_ROOT || "/app"); // what a bundle holds (contract: the app lives under /app)
const IMAGE_CWD = real(process.cwd()); // the image's WORKDIR
const POLL_MS = Number(env.SLIPWAY_POLL_MS || 2000);
const HEALTH_TIMEOUT_MS = Number(env.SLIPWAY_HEALTH_TIMEOUT_MS || 120_000);
const HOLD_TIMEOUT_MS = 90_000; // a request held through a swap gets a 503 after this
const STATUS_PATH = "/__slipway/launcher";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message, fields) =>
  console.log(`[slipway-launcher] ${message}${fields ? ` ${JSON.stringify(fields)}` : ""}`);

// --- AWS: task credentials, Signature Version 4, S3 GET ------------------------

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();
const encode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Signature Version 4 headers for a request without a body. `headers` are signed too. */
function sign({ method, url, region, service, credentials, headers = {}, date = new Date() }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const payload = lower["x-amz-content-sha256"] ?? "UNSIGNED-PAYLOAD";
  const all = {
    ...lower,
    host: url.host,
    "x-amz-content-sha256": payload,
    "x-amz-date": amzDate,
    ...(credentials.token ? { "x-amz-security-token": credentials.token } : {}),
  };
  const names = Object.keys(all).sort();
  const query = [...url.searchParams]
    .map(([k, v]) => `${encode(k)}=${encode(v)}`)
    .sort()
    .join("&");
  const canonical = [method, url.pathname, query, names.map((n) => `${n}:${all[n]}\n`).join(""), names.join(";"), payload].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secret}`, day), region), service), "aws4_request");
  const signature = hmac(key, ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n")).toString("hex");
  return {
    ...all,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.id}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

let cachedCredentials = null;
/** The task role's credentials, from ECS's container credentials endpoint. */
async function credentials() {
  if (cachedCredentials && cachedCredentials.expires - Date.now() > 300_000) return cachedCredentials;
  const url = env.AWS_CONTAINER_CREDENTIALS_FULL_URI || `http://169.254.170.2${env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || ""}`;
  const headers = env.AWS_CONTAINER_AUTHORIZATION_TOKEN ? { authorization: env.AWS_CONTAINER_AUTHORIZATION_TOKEN } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`task credentials: HTTP ${res.status}`);
  const c = await res.json();
  cachedCredentials = {
    id: c.AccessKeyId,
    secret: c.SecretAccessKey,
    token: c.Token,
    expires: Date.parse(c.Expiration) || Date.now() + 600_000,
  };
  return cachedCredentials;
}

async function s3Get(key, unsigned = {}) {
  const url = new URL(`${S3_ENDPOINT}/${key.split("/").map(encode).join("/")}`);
  const { host: _host, ...signed } = sign({ method: "GET", url, region: REGION, service: "s3", credentials: await credentials() });
  return fetch(url, { headers: { ...signed, ...unsigned }, signal: AbortSignal.timeout(120_000) });
}

// --- The app's processes ---------------------------------------------------------

let active = null; // { release, deployId, cwd, dir, port, child, exited, inflight, sockets }
let accepting = false; // whether requests go to `active` now, or wait
let held = []; // requests waiting for a release to take them
let swapping = null; // the deploy id being swapped to
let lastFailure = null; // { deployId, release, reason, at }
const failedDeploys = new Set(); // not retried by this task

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** The app's environment: the container's, without ours, with its own port and release. */
function appEnv(spec, port) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith("SLIPWAY_")) out[k] = v;
  return { ...out, PORT: String(port), RELEASE: spec.release, DEPLOY_ID: spec.deployId };
}

function exitOf(child) {
  return new Promise((resolve) => {
    child.once("error", (err) => resolve({ code: null, signal: null, error: err.message }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}
const describeExit = (x) => x.error ?? (x.signal ? `signal ${x.signal}` : `exit code ${x.code}`);

async function startApp(spec) {
  const port = await freePort();
  const child = spawn(APP_COMMAND[0], APP_COMMAND.slice(1), { cwd: spec.cwd, env: appEnv(spec, port), stdio: "inherit" });
  const app = { ...spec, port, child, exited: null, inflight: 0, sockets: new Set() };
  app.exit = exitOf(child).then((x) => (app.exited = x));
  log("app started", { release: spec.release, deployId: spec.deployId, port });
  return app;
}

/** Make `app` the one requests go to; if it dies on its own, so does the task (ECS replaces it). */
function takeTraffic(app) {
  active = app;
  accepting = true;
  app.exit.then((x) => {
    if (active === app && !app.stopping) {
      log("the app exited", { release: app.release, how: describeExit(x) });
      shutdown(x.code || 1);
    }
  });
  const waiting = held;
  held = [];
  for (const entry of waiting) {
    clearTimeout(entry.timer);
    entry.go(app);
  }
}

/** Resolves once something listens on the app's port (or it stops, or `ms` pass). */
async function waitListening(app, ms) {
  const deadline = Date.now() + ms;
  while (!app.exited && Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect(app.port, "127.0.0.1");
      socket.once("connect", () => resolve(socket.end() && true));
      socket.once("error", () => resolve(false));
    });
    if (open) return;
    await sleep(100);
  }
}

function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: HEALTH_PATH, timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}

async function waitHealthy(app, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (app.exited) throw new Error(`the app stopped before it was healthy (${describeExit(app.exited)})`);
    if (await probe(app.port)) return;
    if (Date.now() > deadline) throw new Error(`${HEALTH_PATH} didn't answer 200 within ${Math.round(ms / 1000)}s`);
    await sleep(500);
  }
}

async function stopApp(app, ms = 20_000) {
  app.stopping = true;
  for (const socket of app.sockets) socket.destroy();
  if (!app.exited) app.child.kill("SIGTERM");
  const timer = setTimeout(() => app.exited || app.child.kill("SIGKILL"), ms);
  await app.exit;
  clearTimeout(timer);
}

async function drain(app, ms) {
  const deadline = Date.now() + ms;
  while (app.inflight > 0 && Date.now() < deadline) await sleep(100);
}

/** Run a one-off command (the migrations) from a release, failing on a non-zero exit. */
async function runOnce(command, spec) {
  const child = spawn(command[0], command.slice(1), { cwd: spec.cwd, env: appEnv(spec, 0), stdio: "inherit" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 30 * 60_000);
  const x = await exitOf(child);
  clearTimeout(timer);
  if (x.code !== 0) throw new Error(`${command.join(" ")} failed (${describeExit(x)})`);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"] });
    exitOf(child).then((x) => (x.code === 0 ? resolve() : reject(new Error(`${command} failed (${describeExit(x)})`))));
  });
}

// --- Swapping ------------------------------------------------------------------------

/** A current.json this task should act on: a swap, on its base, that it isn't running and hasn't failed. */
const wanted = (cur) =>
  cur?.mode === "swap" && cur.base === BASE && Boolean(cur.deployId) && !failedDeploys.has(cur.deployId) && cur.deployId !== active?.deployId;

async function unpack(cur) {
  const name = String(cur.deployId).replace(/[^A-Za-z0-9._-]/g, "_");
  const dir = path.join(WORK, "releases", name);
  const file = path.join(WORK, `${name}.tgz`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const res = await s3Get(cur.bundle);
  if (!res.ok) throw new Error(`couldn't download ${cur.bundle} (HTTP ${res.status})`);
  const hash = crypto.createHash("sha256");
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (chunks) {
      for await (const chunk of chunks) {
        hash.update(chunk);
        yield chunk;
      }
    },
    fs.createWriteStream(file),
  );
  if (cur.sha256 && hash.digest("hex") !== cur.sha256) throw new Error(`${cur.bundle} doesn't match its checksum`);
  await run("tar", ["-xzf", file, "-C", dir]);
  fs.rmSync(file, { force: true });
  // The bundle is the image's /app, so the app runs from the same place inside it.
  const cwd = path.join(dir, path.basename(IMAGE_ROOT), path.relative(IMAGE_ROOT, IMAGE_CWD));
  if (!fs.existsSync(cwd)) throw new Error(`${cur.bundle} has no ${path.relative(path.dirname(IMAGE_ROOT), IMAGE_CWD)}`);
  return { release: cur.release, deployId: cur.deployId, cwd, dir };
}

/**
 * Switch to the release current.json names: unpack it and run its migrations
 * while the old one still serves, then hold requests, stop the old one and
 * start the new one (one at a time: a small task has room for one app). If the
 * new one isn't healthy, the old one comes back.
 */
async function swapTo(cur, { boot = false } = {}) {
  swapping = cur.deployId;
  log("swapping", { from: active?.release ?? null, to: cur.release, deployId: cur.deployId });
  let spec;
  try {
    if (active && cur.release === active.release) {
      // Same code, a new deploy of it (a redeploy or rollback to what runs).
      active.deployId = cur.deployId;
      return;
    }
    spec = await unpack(cur);
    // At boot the database already has them: they ran when this release was swapped in.
    if (cur.migrate && !boot && Array.isArray(cur.migrateCommand) && cur.migrateCommand.length) {
      log("running migrations", { command: cur.migrateCommand });
      await runOnce(cur.migrateCommand, spec);
    }
    const old = active;
    accepting = false;
    if (old) {
      await drain(old, 15_000);
      await stopApp(old);
    }
    const next = await startApp(spec);
    try {
      await waitHealthy(next, HEALTH_TIMEOUT_MS);
    } catch (err) {
      await stopApp(next);
      if (old) {
        const back = await startApp(old);
        await waitHealthy(back, HEALTH_TIMEOUT_MS).catch(() => {});
        takeTraffic(back);
      }
      throw err;
    }
    takeTraffic(next);
    log("swapped", { release: next.release, deployId: next.deployId });
    if (old?.dir) fs.rmSync(old.dir, { recursive: true, force: true });
  } catch (err) {
    failedDeploys.add(cur.deployId);
    lastFailure = { deployId: cur.deployId, release: cur.release, reason: err.message, at: new Date().toISOString() };
    log("swap failed", lastFailure);
    if (spec?.dir && spec.dir !== active?.dir) fs.rmSync(spec.dir, { recursive: true, force: true });
  } finally {
    swapping = null;
  }
}

let etag = null;
/** current.json, or null when it hasn't changed since the last read (or doesn't exist). */
async function readCurrent() {
  const res = await s3Get("current.json", etag ? { "if-none-match": etag } : {});
  if (res.status === 304 || res.status === 404) return null;
  if (!res.ok) throw new Error(`current.json: HTTP ${res.status}`);
  const cur = await res.json();
  etag = res.headers.get("etag");
  return cur;
}

async function poll() {
  let lastError = "";
  for (;;) {
    await sleep(POLL_MS);
    if (shuttingDown) return;
    try {
      const cur = await readCurrent();
      if (wanted(cur)) await swapTo(cur);
      lastError = "";
    } catch (err) {
      if (err.message !== lastError) log("couldn't read current.json", { error: err.message });
      lastError = err.message;
    }
  }
}

// --- The load balancer's side ------------------------------------------------------

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade"]);
function endToEnd(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i += 2) if (!HOP_BY_HOP.has(raw[i].toLowerCase())) out.push(raw[i], raw[i + 1]);
  return out;
}
const agent = new http.Agent({ keepAlive: true });

/** Run go(app) with the release taking traffic, now or once a swap is over. */
function withApp(go, onTimeout) {
  if (accepting && active) return go(active);
  const entry = { go };
  entry.timer = setTimeout(() => {
    held = held.filter((e) => e !== entry);
    onTimeout();
  }, HOLD_TIMEOUT_MS);
  held.push(entry);
}

function forward(app, req, res) {
  app.inflight++;
  let finished = false;
  const done = () => {
    if (!finished) {
      finished = true;
      app.inflight--;
    }
  };
  res.on("close", done);
  const upstream = http.request(
    { host: "127.0.0.1", port: app.port, method: req.method, path: req.url, headers: endToEnd(req.rawHeaders), agent },
    (answer) => {
      res.writeHead(answer.statusCode, answer.statusMessage, endToEnd(answer.rawHeaders));
      answer.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end(`the app didn't answer: ${err.code ?? err.message}\n`);
    } else {
      res.destroy();
    }
    done();
  });
  req.pipe(upstream);
}

function tunnel(app, req, socket, head) {
  const upstream = net.connect(app.port, "127.0.0.1");
  app.sockets.add(socket);
  const close = () => {
    app.sockets.delete(socket);
    socket.destroy();
    upstream.destroy();
  };
  upstream.on("connect", () => {
    let lines = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    upstream.write(`${lines}\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", close);
  upstream.on("close", close);
  socket.on("error", close);
  socket.on("close", close);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === STATUS_PATH) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ release: active?.release ?? null, deployId: active?.deployId ?? null, swapping, failed: lastFailure, base: BASE }));
    return;
  }
  // While a swap holds requests, the load balancer's health checks would time
  // out and ECS could replace the task mid-swap; this one answers for the app.
  // Its release is null, so deploy-env's own check keeps waiting for the new one.
  if (!accepting && swapping && req.method === "GET" && req.url.split("?")[0] === HEALTH_PATH) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, release: null, swapping: true }));
    return;
  }
  withApp(
    (app) => forward(app, req, res),
    () => {
      res.writeHead(503, { "content-type": "text/plain", "retry-after": "5" });
      res.end("a deploy is in progress; try again\n");
    },
  );
});
server.on("upgrade", (req, socket, head) => withApp((app) => tunnel(app, req, socket, head), () => socket.destroy()));
// Longer than the load balancer's idle timeout (60s), so it never reuses a connection we just closed.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 0;

// --- Start and stop ---------------------------------------------------------------

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  if (active && !active.exited) await stopApp(active, 25_000);
  process.exit(code);
}

async function boot() {
  if (!PORT || !APP_COMMAND.length) {
    console.error("[slipway-launcher] PORT and SLIPWAY_APP_COMMAND are required");
    process.exit(1);
  }
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  await new Promise((resolve) => server.listen(PORT, resolve));
  log("listening", { port: PORT, release: env.RELEASE, base: BASE });
  const image = { release: env.RELEASE || "", deployId: env.DEPLOY_ID || "", cwd: IMAGE_CWD, dir: null };
  // A task that starts after code swaps runs the swapped release, not its image's.
  let cur = null;
  if (BUCKET) {
    try {
      cur = await readCurrent();
    } catch (err) {
      log("couldn't read current.json; starting the image's release", { error: err.message });
    }
  }
  if (wanted(cur) && cur.release !== image.release) await swapTo(cur, { boot: true });
  if (!active) {
    if (cur?.mode === "swap" && cur.base === BASE && cur.release === image.release) image.deployId = cur.deployId;
    // Requests wait until the app listens, as they would for any task starting
    // (the load balancer's health checks decide when it's ready).
    const app = await startApp(image);
    await waitListening(app, HEALTH_TIMEOUT_MS);
    takeTraffic(app);
  }
  if (BUCKET) poll();
}

module.exports = { sign };
// `node -e` (in the container) or `node launcher.cjs` (tests); not when required.
if (require.main === module || module.id === "[eval]") boot();
