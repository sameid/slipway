// modules/app-env/launcher.cjs, run as on staging: a real process in front of a
// fake app, with a fake S3 (current.json and bundles) and credentials endpoint.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(new URL("../../modules/app-env/launcher.cjs", import.meta.url));
const { sign } = createRequire(import.meta.url)(LAUNCHER);

const APP = `
const http = require("node:http");
const fs = require("node:fs");
const behaviour = JSON.parse(fs.readFileSync(__dirname + "/behaviour.json", "utf8"));
const release = process.env.RELEASE;
http.createServer((req, res) => {
  if (req.url === "/api/health") {
    res.writeHead(behaviour.healthy ? 200 : 500, { "content-type": "application/json" });
    return res.end(JSON.stringify({ release }));
  }
  let body = "";
  req.on("data", (d) => (body += d)).on("end", () => {
    setTimeout(() => {
      res.setHeader("set-cookie", ["a=1", "b=2"]);
      res.end(req.method + " " + req.url + " from " + release + (body ? " body=" + body : ""));
    }, req.url === "/slow" ? 300 : 0);
  });
}).listen(Number(process.env.PORT), "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;
const MIGRATE = `require("node:fs").writeFileSync(process.env.MARKER_DIR + "/migrated-" + process.env.RELEASE, "");`;

const root = mkdtempSync(path.join(tmpdir(), "launcher-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** An app tree like the image's /app: app/api/{app.js,migrate.js,behaviour.json}. */
function appTree(dir, behaviour = { healthy: true }) {
  mkdirSync(path.join(dir, "app", "api"), { recursive: true });
  writeFileSync(path.join(dir, "app", "api", "app.js"), APP);
  writeFileSync(path.join(dir, "app", "api", "migrate.js"), MIGRATE);
  writeFileSync(path.join(dir, "app", "api", "behaviour.json"), JSON.stringify(behaviour));
  return path.join(dir, "app");
}
const image = appTree(path.join(root, "image"));

/** A release bundle as build-release makes it (a tar of /app), with its checksum. */
function bundle(name, behaviour) {
  const dir = path.join(root, "bundles", name);
  appTree(dir, behaviour);
  const file = path.join(root, "bundles", `${name}.tgz`);
  execFileSync("tar", ["-czf", file, "-C", dir, "app"]);
  const data = readFileSync(file);
  return { key: `bundles/${name}.tgz`, data, sha256: createHash("sha256").update(data).digest("hex") };
}

/** S3 with what the swap bucket holds, plus the container credentials endpoint. */
function fakeS3() {
  const objects = new Map();
  let unsigned = 0;
  const server = http.createServer((req, res) => {
    if (req.url === "/creds") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ AccessKeyId: "AKIDTEST", SecretAccessKey: "secret", Token: "token", Expiration: new Date(Date.now() + 3600e3).toISOString() }));
    }
    if (!/^AWS4-HMAC-SHA256 Credential=AKIDTEST\//.test(req.headers.authorization ?? "") || req.headers["x-amz-security-token"] !== "token") unsigned++;
    const object = objects.get(decodeURIComponent(req.url.slice(1)));
    if (!object) return res.writeHead(404).end();
    const etag = `"${createHash("md5").update(object).digest("hex")}"`;
    if (req.headers["if-none-match"] === etag) return res.writeHead(304).end();
    res.writeHead(200, { etag });
    res.end(object);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        put: (key, value) => objects.set(key, Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))),
        unsigned: () => unsigned,
        close: () => server.close(),
      }),
    ),
  );
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function launch(s3, extraEnv = {}) {
  const port = await freePort();
  const work = mkdtempSync(path.join(root, "work-"));
  const child = spawn(process.execPath, [LAUNCHER], {
    cwd: path.join(image, "api"),
    env: {
      PATH: process.env.PATH,
      PORT: String(port),
      RELEASE: "r1",
      DEPLOY_ID: "1",
      MARKER_DIR: work,
      SLIPWAY_APP_COMMAND: JSON.stringify(["node", "app.js"]),
      SLIPWAY_SWAP_BUCKET: "swap",
      SLIPWAY_SWAP_BASE: "base-1",
      SLIPWAY_REGION: "eu-west-1",
      SLIPWAY_S3_ENDPOINT: s3.url,
      AWS_CONTAINER_CREDENTIALS_FULL_URI: `${s3.url}/creds`,
      SLIPWAY_IMAGE_ROOT: image,
      SLIPWAY_WORK_DIR: work,
      SLIPWAY_POLL_MS: "50",
      SLIPWAY_HEALTH_TIMEOUT_MS: "3000",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const request = (urlPath, init) => fetch(`http://127.0.0.1:${port}${urlPath}`, init);
  const status = async () => (await request("/__slipway/launcher")).json();
  const until = async (check, what, ms = 10_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      try {
        if (await check()) return;
      } catch {}
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${output}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  await until(async () => (await request("/")).ok, "the image's app");
  return { child, port, work, request, status, until, exited, output: () => output, stop: () => child.kill("SIGTERM") };
}

const current = (b, fields) => ({ mode: "swap", base: "base-1", bundle: b.key, sha256: b.sha256, migrateCommand: ["node", "migrate.js"], ...fields });

test("signs requests the way AWS documents (S3 GET example)", () => {
  const headers = sign({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    region: "us-east-1",
    service: "s3",
    credentials: { id: "AKIAIOSFODNN7EXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    headers: { range: "bytes=0-9", "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
    date: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test("runs the image's release and passes requests and answers through untouched", async () => {
  const s3 = await fakeS3();
  const l = await launch(s3);
  try {
    const res = await l.request("/things?x=1", { method: "POST", body: "hello" });
    assert.equal(await res.text(), "POST /things?x=1 from r1 body=hello");
    assert.deepEqual(res.headers.getSetCookie(), ["a=1", "b=2"]);
    assert.deepEqual(await l.status(), { release: "r1", deployId: "1", swapping: null, failed: null, base: "base-1" });
  } finally {
    l.stop();
    await l.exited;
    s3.close();
  }
});

test("swaps to the release current.json names: migrations first, no request dropped", async () => {
  const s3 = await fakeS3();
  const l = await launch(s3);
  try {
    const r2 = bundle("r2");
    s3.put(r2.key, r2.data);
    s3.put("current.json", current(r2, { release: "r2", deployId: "2", migrate: true }));
    // Requests keep coming through the swap: held while the app restarts, never
    // failed. Health checks are answered meanwhile, so ECS doesn't replace the task.
    const answers = [];
    const health = [];
    let swapped = false;
    const traffic = (async () => {
      while (!swapped) answers.push(await l.request("/slow").then((r) => r.status, () => "error"));
    })();
    const checks = (async () => {
      while (!swapped) {
        health.push(await l.request("/api/health").then(async (r) => [r.status, (await r.json()).release], () => ["error"]));
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    try {
      await l.until(async () => (await l.status()).deployId === "2", "the swap");
    } finally {
      swapped = true;
      await Promise.all([traffic, checks]);
    }
    assert.ok(answers.length > 0);
    assert.deepEqual([...new Set(answers)], [200]);
    assert.deepEqual([...new Set(health.map(([status]) => status))], [200]);
    assert.ok(health.some(([, release]) => release === null), "the launcher answered while the app restarted");
    assert.equal(await (await l.request("/")).text(), "GET / from r2");
    assert.ok(existsSync(path.join(l.work, "migrated-r2")), "migrations ran");
    assert.equal(s3.unsigned(), 0);
  } finally {
    l.stop();
    await l.exited;
    s3.close();
  }
});

test("keeps the running release when the new one isn't healthy, and doesn't retry it", async () => {
  const s3 = await fakeS3();
  const l = await launch(s3);
  try {
    const bad = bundle("r3", { healthy: false });
    s3.put(bad.key, bad.data);
    s3.put("current.json", current(bad, { release: "r3", deployId: "3" }));
    await l.until(async () => (await l.status()).failed?.deployId === "3", "the failure");
    const status = await l.status();
    assert.equal(status.release, "r1");
    assert.match(status.failed.reason, /didn't answer 200/);
    assert.equal(await (await l.request("/")).text(), "GET / from r1");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((l.output().match(/swapping \{/g) ?? []).length, 1, "tried once");
  } finally {
    l.stop();
    await l.exited;
    s3.close();
  }
});

test("leaves rollouts, other bases and bundles that don't match their checksum alone", async () => {
  const s3 = await fakeS3();
  const l = await launch(s3);
  try {
    const r4 = bundle("r4");
    s3.put(r4.key, r4.data);
    s3.put("current.json", current(r4, { release: "r4", deployId: "4", base: "base-2" }));
    await new Promise((r) => setTimeout(r, 300));
    s3.put("current.json", current(r4, { release: "r4", deployId: "5", mode: "rollout" }));
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await l.status(), { release: "r1", deployId: "1", swapping: null, failed: null, base: "base-1" });
    s3.put("current.json", current(r4, { release: "r4", deployId: "6", sha256: "0".repeat(64) }));
    await l.until(async () => (await l.status()).failed?.deployId === "6", "the checksum failure");
    assert.match((await l.status()).failed.reason, /doesn't match its checksum/);
    assert.equal(await (await l.request("/")).text(), "GET / from r1");
  } finally {
    l.stop();
    await l.exited;
    s3.close();
  }
});

test("starts on the swapped release when the task restarts, without migrating again", async () => {
  const s3 = await fakeS3();
  const r2 = bundle("r2b");
  s3.put(r2.key, r2.data);
  s3.put("current.json", current(r2, { release: "r2", deployId: "7", migrate: true }));
  const l = await launch(s3);
  try {
    assert.equal(await (await l.request("/")).text(), "GET / from r2");
    assert.equal((await l.status()).deployId, "7");
    assert.ok(!existsSync(path.join(l.work, "migrated-r2")));
    assert.doesNotMatch(l.output(), /app started \{"release":"r1"/);
  } finally {
    l.stop();
    await l.exited;
    s3.close();
  }
});

test("stops the app and exits when ECS stops the task", async () => {
  const s3 = await fakeS3();
  const l = await launch(s3);
  const appPort = Number(/"port":(\d+)/.exec(l.output())[1]);
  l.stop();
  assert.equal(await l.exited, 0);
  await assert.rejects(fetch(`http://127.0.0.1:${appPort}/`));
  s3.close();
});

test("runs as node -e, the way the container starts it", async () => {
  const port = await freePort();
  const child = spawn(process.execPath, ["-e", readFileSync(LAUNCHER, "utf8")], {
    cwd: path.join(image, "api"),
    env: { PATH: process.env.PATH, PORT: String(port), RELEASE: "r1", DEPLOY_ID: "1", SLIPWAY_APP_COMMAND: JSON.stringify(["node", "app.js"]) },
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 10_000;
    let text = "";
    while (Date.now() < deadline) {
      text = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text(), () => "");
      if (text) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(text, "GET / from r1");
  } finally {
    child.kill("SIGTERM");
  }
});
