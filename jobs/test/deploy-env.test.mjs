// jobs/deploy-env.sh's staging/prod apply, run for real against stand-ins for
// aws, terraform and curl that answer from a JSON "world" and log every call:
// whether a deploy swaps code into staging's tasks or rolls out, and what it
// leaves in current.json.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { treeHash } from "../appyaml.mjs";

const HOME = fileURLToPath(new URL("../..", import.meta.url)); // jobs/ and modules/
const SCRIPT = path.join(HOME, "jobs", "deploy-env.sh");
const root = mkdtempSync(path.join(tmpdir(), "deploy-env-"));
// The instance has bash 5; macOS's /bin/bash 3.2 lacks mapfile. Run these in a
// Linux container there (jobs/README.md).
const bashMajor = Number(spawnSync("bash", ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" }).stdout.trim());
const needsBash = bashMajor >= 4 ? false : `needs bash 4+ (this is bash ${bashMajor}); run it in a Linux container`;
after(() => rmSync(root, { recursive: true, force: true }));

const SHA = "445bc13".padEnd(40, "0");
const OLD = "39432b8".padEnd(40, "0");
const PLATFORM = treeHash(path.join(HOME, "modules", "app-env"));
const BASE = "b".repeat(64);
const MIGRATIONS = "m".repeat(64).replace(/m/g, "a");

// Stand-ins. Each reads and may update world.json, and appends to calls.log.
const AWS = `#!/usr/bin/env node
const fs = require("node:fs");
const world = JSON.parse(fs.readFileSync(process.env.WORLD, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(["aws", ...args]) + "\\n");
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const save = () => fs.writeFileSync(process.env.WORLD, JSON.stringify(world));
const out = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
const [service, op] = args;
const query = opt("--query") ?? "";
if (service === "s3" && op === "cp") {
  const [src, dst] = args.slice(2, 4);
  if (args.includes("--recursive")) process.exit(0);
  if (src.startsWith("s3://") && dst.startsWith("s3://")) {
    if (!(src in world.s3)) process.exit(1);
    world.s3[dst] = world.s3[src]; save(); process.exit(0);
  }
  if (src.startsWith("s3://")) {
    const v = world.s3[src];
    if (v === undefined) { process.stderr.write("404\\n"); process.exit(1); }
    const data = typeof v === "object" ? fs.readFileSync(v.file) : v;
    if (dst === "-") process.stdout.write(data); else fs.writeFileSync(dst, data);
    process.exit(0);
  }
  world.s3[dst] = src === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(src, "utf8"); save(); process.exit(0);
}
if (service === "s3" && op === "rm") { delete world.s3[args[2]]; save(); process.exit(0); }
if (service === "s3" && op === "sync") process.exit(0);
if (service === "s3api" && op === "list-objects-v2") { out(Object.keys(world.s3).filter((k) => k.startsWith("s3://" + opt("--bucket") + "/bundles/")).map((k) => k.split("/").slice(3).join("/")).join("\\t")); process.exit(0); }
if (service === "ssm" && op === "describe-parameters") {
  const under = /Values=([^,]+)/.exec(opt("--parameter-filters"))[1] + "/";
  const params = world.ssm.filter((p) => p.name.startsWith(under));
  out(query.includes("LastModifiedDate") ? params.map((p) => p.modified) : params.map((p) => p.name).join("\\t")); process.exit(0);
}
if (service === "ecs" && op === "describe-services" && query.includes("PRIMARY")) { out("arn:aws:ecs:td/1"); process.exit(0); }
if (service === "ecs" && op === "describe-task-definition") {
  const env = world.ecs.env;
  const get = (n) => env.find((e) => e.name === n)?.value ?? "None";
  out(query.includes("command: command") ? { environment: env, command: world.ecs.command ?? null } : [world.ecs.image, get("RELEASE"), get("DEPLOY_ID")].join("\\t"));
  process.exit(0);
}
if (service === "ecs" && op === "list-tasks") { out(world.ecs.tasks.map((t) => t.arn).join("\\t")); process.exit(0); }
if (service === "ecs" && op === "describe-tasks" && query.includes("privateIPv4Address")) { out(world.ecs.tasks.map(({ ip, startedAt }) => ({ ip, startedAt }))); process.exit(0); }
if (service === "ecs" && op === "describe-tasks") { out("STOPPED\\t0\\tNone"); process.exit(0); }
if (service === "ecs" && op === "run-task") { out("arn:aws:ecs:task/migrate\\tNone"); process.exit(0); }
if (service === "logs") { out("migrate: done"); process.exit(0); }
if (service === "cloudfront") { out("I1"); process.exit(0); }
process.exit(1); // anything else (the best-effort rollout settings) fails
`;

const TERRAFORM = `#!/usr/bin/env node
const fs = require("node:fs");
const world = JSON.parse(fs.readFileSync(process.env.WORLD, "utf8"));
const args = process.argv.slice(2).filter((a) => !a.startsWith("-chdir="));
fs.appendFileSync(process.env.CALLS, JSON.stringify(["terraform", ...args]) + "\\n");
if (args[0] === "version") { process.stdout.write(JSON.stringify({ terraform_version: "1.16.5" })); process.exit(0); }
if (args[0] === "output") {
  const name = args.at(-1);
  if (!(name in world.tf)) { process.stderr.write('Output "' + name + '" not found\\n'); process.exit(1); }
  const v = world.tf[name];
  process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
  process.exit(0);
}
if (args[0] === "apply") {
  const varFile = args[args.indexOf("-var-file") + 1];
  fs.appendFileSync(process.env.CALLS, JSON.stringify(["tfvars", JSON.parse(fs.readFileSync(varFile, "utf8"))]) + "\\n");
}
process.exit(0);
`;

// The launchers' status follows current.json (or fails it); /api/health reports world.health.
const CURL = `#!/usr/bin/env node
const fs = require("node:fs");
const world = JSON.parse(fs.readFileSync(process.env.WORLD, "utf8"));
const url = process.argv.slice(2).find((a) => a.startsWith("http"));
fs.appendFileSync(process.env.CALLS, JSON.stringify(["curl", url]) + "\\n");
if (url.endsWith("/__slipway/launcher")) {
  const current = JSON.parse(world.s3["s3://swap-bucket/current.json"] ?? "{}");
  const status = world.launcher === "fail"
    ? { deployId: "173", failed: { deployId: current.deployId, reason: "/api/health didn't answer 200 within 120s" } }
    : { deployId: current.deployId };
  process.stdout.write(JSON.stringify(status));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ release: world.health }));
`;

function deployRun(world, env = {}) {
  const dir = mkdtempSync(path.join(root, "run-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  for (const [name, source] of [["aws", AWS], ["terraform", TERRAFORM], ["curl", CURL]]) {
    writeFileSync(path.join(bin, name), source);
    chmodSync(path.join(bin, name), 0o755);
  }
  const worldFile = path.join(dir, "world.json");
  writeFileSync(worldFile, JSON.stringify(world));
  const calls = path.join(dir, "calls.log");
  writeFileSync(calls, "");
  const result = spawnSync("bash", [SCRIPT], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      WORLD: worldFile,
      CALLS: calls,
      APP: "my-app",
      ENV: "staging",
      ACTION: "apply",
      COMMIT_SHA: SHA,
      IMAGE_DIGEST: "sha256:new",
      WEB_ARTIFACT: `s3://releases/releases/my-app/${SHA}/web.tgz`,
      DEPLOY_ID: "176",
      STATE_BUCKET: "state",
      RELEASES_BUCKET: "releases",
      AWS_ACCOUNT_ID: "123456789012",
      AWS_REGION: "eu-west-1",
      SLIPWAY_HOME: HOME,
      SLIPWAY_WORK: path.join(dir, "work"),
      SLIPWAY_EXPORTS: path.join(dir, "exports.env"),
      HEALTH_ATTEMPTS: "1",
      SWAP_TIMEOUT_SECONDS: "1",
      ...env,
    },
    encoding: "utf8",
  });
  const log = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    calls: log,
    world: JSON.parse(readFileSync(worldFile, "utf8")),
    applies: log.filter((c) => c[0] === "tfvars").map((c) => c[1]),
  };
}

const webTgz = (() => {
  const dir = path.join(root, "web");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "index.html"), "<!doctype html>");
  const file = path.join(root, "web.tgz");
  execFileSync("tar", ["-czf", file, "-C", dir, "."]);
  return file;
})();

const APP_YAML = `name: my-app
template: react-express
description: test
owner: sameid
api:
  port: 3000
  health_check: /api/health
  migrate_command: ["node", "dist/migrate.js"]
web:
  build_command: npm run build --workspace web
  output_dir: web/dist
secrets:
  - PUBLIC_ORIGIN
auto_merge: true
sizes:
  staging: small
  prod: small
`;

/** Staging whose tasks run the launcher on BASE, last rolled out at OLD; a new release that only changed code. */
function stagingWorld(over = {}) {
  const prefix = `s3://releases/releases/my-app/${SHA}`;
  return {
    s3: {
      [`${prefix}/app.yaml`]: APP_YAML,
      [`${prefix}/migrations.sha256`]: `${MIGRATIONS}\n`,
      [`${prefix}/image.json`]: JSON.stringify({ base: BASE, command: ["node", "dist/index.js"], bundle: "app.tgz", sha256: "c".repeat(64) }),
      [`${prefix}/app.tgz`]: "bundle bytes",
      [`${prefix}/web.tgz`]: { file: webTgz },
      "s3://swap-bucket/current.json": JSON.stringify({ mode: "swap", release: "1111111", deployId: "173", migrations: MIGRATIONS }),
    },
    ssm: [{ name: "/apps/my-app/staging/PUBLIC_ORIGIN", modified: "2026-10-20T10:00:00Z" }],
    ecs: {
      image: "123456789012.dkr.ecr.eu-west-1.amazonaws.com/app-my-app@sha256:old",
      env: [
        { name: "RELEASE", value: OLD.slice(0, 7) },
        { name: "DEPLOY_ID", value: "170" },
        { name: "SLIPWAY_APP_COMMAND", value: '["node","dist/index.js"]' },
        { name: "SLIPWAY_SWAP_BASE", value: BASE },
        { name: "SLIPWAY_PLATFORM", value: PLATFORM },
      ],
      tasks: [{ arn: "arn:task/1", ip: "10.0.0.5", startedAt: "2026-10-21T12:00:00Z" }],
      command: ["node", "-e", "// the launcher these tasks run"],
    },
    tf: {
      inputs: { size: "small", api_port: 3000, health_check_path: "/api/health", migrate_command: ["node", "dist/migrate.js"], secret_names: ["PUBLIC_ORIGIN"] },
      service_name: "app-my-app-staging-api-febb",
      cluster_name: "app-my-app-staging",
      service_image: "123456789012.dkr.ecr.eu-west-1.amazonaws.com/app-my-app@sha256:old",
      release: OLD.slice(0, 7),
      deploy_id: "170",
      migrations: MIGRATIONS,
      swap_bucket: "swap-bucket",
      custom_domain: "",
      certificate_arn: "",
      app_url: "https://d123.cloudfront.net",
      service_url: "https://ap-1.ecs.eu-west-1.on.aws",
      web_bucket: "web-bucket",
      distribution_id: "E1",
      log_group_name: "/slipway/app-my-app",
      migrate_task_definition_arn: "arn:td/migrate",
      subnet_ids: "subnet-1",
      task_security_group_id: "sg-1",
    },
    health: "445bc13",
    launcher: "follow",
    ...over,
  };
}
const current = (r) => JSON.parse(r.world.s3["s3://swap-bucket/current.json"] ?? "null");

test("staging swaps the code into its tasks when only the code changed", { skip: needsBash }, () => {
  const r = deployRun(stagingWorld());
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /only the code changed: swapping it into the running tasks/);
  assert.match(r.output, /==> step: swap/);
  assert.doesNotMatch(r.output, /step: terraform-phase1|step: migrate/);
  assert.deepEqual(r.applies, []);
  assert.equal(r.world.s3[`s3://swap-bucket/bundles/${SHA}.tgz`], "bundle bytes");
  assert.deepEqual(current(r), {
    mode: "swap", release: "445bc13", commitSha: SHA, deployId: "176", base: BASE, bundle: `bundles/${SHA}.tgz`,
    sha256: "c".repeat(64), migrate: false, migrateCommand: ["node", "dist/migrate.js"], migrations: MIGRATIONS,
  });
  assert.ok(r.calls.some((c) => c[0] === "curl" && c[1] === "http://10.0.0.5:3000/__slipway/launcher"));
  assert.match(r.output, /my-app staging is live at https:\/\/d123\.cloudfront\.net \(release 445bc13\)/);
});

test("a swap runs the release's migrations when they're new", { skip: needsBash }, () => {
  const world = stagingWorld();
  world.s3[`s3://releases/releases/my-app/${SHA}/migrations.sha256`] = `${"d".repeat(64)}\n`;
  const r = deployRun(world);
  assert.equal(r.status, 0, r.output);
  assert.equal(current(r).migrate, true);
  assert.match(r.output, /with its migrations/);
});

test("a failed swap puts current.json back and fails the deploy", { skip: needsBash }, () => {
  const world = stagingWorld({ launcher: "fail" });
  const before = world.s3["s3://swap-bucket/current.json"];
  const r = deployRun(world);
  assert.notEqual(r.status, 0);
  assert.match(r.output, /ERROR: a task couldn't switch to 445bc13: \/api\/health didn't answer 200 within 120s\. Staging still runs 1111111/);
  assert.equal(r.world.s3["s3://swap-bucket/current.json"], before);
});

for (const [why, change, reason] of [
  ["the image's base changed", (w) => (w.s3[`s3://releases/releases/my-app/${SHA}/image.json`] = JSON.stringify({ base: "e".repeat(64), command: ["node", "dist/index.js"], sha256: "c".repeat(64) })), /the image changed/],
  ["the platform changed", (w) => (w.ecs.env.find((e) => e.name === "SLIPWAY_PLATFORM").value = "old-platform"), /the platform changed/],
  ["a secret was added", (w) => w.ssm.push({ name: "/apps/my-app/staging/NEW_KEY", modified: "2026-10-20T10:00:00Z" }), /the secrets, size, port or health check changed/],
  ["a secret's value changed after the tasks started", (w) => (w.ssm[0].modified = "2026-10-21T13:00:00Z"), /a secret's value changed since the tasks started/],
  ["the service has no launcher yet", (w) => (w.ecs.env = w.ecs.env.filter((e) => !e.name.startsWith("SLIPWAY_"))), /the service has no launcher yet/],
]) {
  test(`staging rolls out when ${why}`, { skip: needsBash }, () => {
    const world = stagingWorld();
    change(world);
    const r = deployRun(world);
    assert.equal(r.status, 0, r.output);
    assert.match(r.output, reason);
    assert.match(r.output, /==> step: terraform-phase1[\s\S]*==> step: terraform-phase2/);
    // Phase 1 keeps the launcher as the tasks run it; phase 2 brings this release's.
    const running = Object.fromEntries(world.ecs.env.map((e) => [e.name, e.value]));
    assert.deepEqual(r.applies[0], {
      app_command: JSON.parse(running.SLIPWAY_APP_COMMAND ?? "[]"),
      swap_base: running.SLIPWAY_SWAP_BASE ?? "",
      platform: running.SLIPWAY_PLATFORM ?? "",
      launcher: "// the launcher these tasks run",
    });
    const image = JSON.parse(world.s3[`s3://releases/releases/my-app/${SHA}/image.json`]);
    assert.deepEqual(r.applies[1], {
      app_command: ["node", "dist/index.js"],
      swap_base: image.base,
      platform: PLATFORM,
      launcher: readFileSync(path.join(HOME, "modules", "app-env", "launcher.cjs"), "utf8"),
    });
    // New tasks start from their image; the old ones leave a rollout alone.
    assert.equal(current(r).mode, "rollout");
    assert.equal(current(r).deployId, "176");
  });
}

test("prod always rolls out and has no current.json", { skip: needsBash }, () => {
  const world = stagingWorld();
  world.tf.swap_bucket = "";
  world.ssm = [{ name: "/apps/my-app/prod/PUBLIC_ORIGIN", modified: "2026-10-20T10:00:00Z" }];
  const r = deployRun(world, { ENV: "prod" });
  assert.equal(r.status, 0, r.output);
  assert.doesNotMatch(r.output, /swapping|rolling out:/);
  assert.equal(r.applies.length, 2);
  assert.equal(r.world.s3["s3://swap-bucket/current.json"], world.s3["s3://swap-bucket/current.json"]);
  assert.ok(!r.calls.some((c) => c.some((a) => String(a).includes("swap-bucket"))));
});
