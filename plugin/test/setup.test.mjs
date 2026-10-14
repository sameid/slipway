// slipway setup: the pure parts, the GitHub App manifest flow against a mock GitHub, and
// whole runs against stub `aws` and `terraform` commands, a stub release script and a
// mock deployer. Nothing here touches AWS or GitHub.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { appJwt, manifest, manifestFlow } from "../cli/github-app.mjs";
import {
  changedResources,
  compareVersions,
  destructiveChanges,
  foundationInputs,
  pickAz,
  shellQuote,
} from "../cli/setup.mjs";
import { CLI, GIT_ENV, mockDeployer, tempDir } from "./helpers/harness.mjs";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" });

function verifyJwt(token) {
  const [header, payload, signature] = token.split(".");
  const ok = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature, "base64url");
  return ok ? JSON.parse(Buffer.from(payload, "base64url").toString()) : null;
}

describe("setup's pure parts", () => {
  test("compareVersions ignores release suffixes", () => {
    assert.equal(compareVersions("0.4.0-20261014120000", "0.4.0"), 0);
    assert.equal(compareVersions("0.3.9", "0.4.0"), -1);
    assert.equal(compareVersions("0.10.0", "0.9.1"), 1);
    assert.equal(compareVersions("", "1.11.0"), -1);
  });

  test("shellQuote survives quotes", () => {
    assert.equal(shellQuote("O'Brien"), `'O'\\''Brien'`);
  });

  test("a plan's destructive and changed resources", () => {
    const plan = {
      resource_changes: [
        { address: "aws_instance.deployer", mode: "managed", change: { actions: ["delete", "create"] } },
        { address: "aws_ssm_parameter.github_access", mode: "managed", change: { actions: ["update"] } },
        { address: "aws_s3_bucket.artifacts", mode: "managed", change: { actions: ["no-op"] } },
        { address: "data.aws_vpc.default", mode: "data", change: { actions: ["read"] } },
      ],
    };
    assert.deepEqual(destructiveChanges(plan), [{ address: "aws_instance.deployer", replace: true }]);
    assert.deepEqual(changedResources(plan), ["aws_instance.deployer", "aws_ssm_parameter.github_access"]);
  });

  test("pickAz keeps the zone it used, or picks the first that has both", () => {
    assert.equal(pickAz("us-east-1", ["us-east-1c", "us-east-1b"], ["us-east-1b", "us-east-1c"]), "b");
    assert.equal(pickAz("us-east-1", ["us-east-1a"], ["us-east-1b"]), null);
    assert.equal(pickAz("us-east-1", ["us-east-1a", "us-east-1b"], ["us-east-1a", "us-east-1b"], "b"), "b");
    assert.equal(pickAz("us-east-1", ["us-east-1a"], ["us-east-1a"], "b"), null);
  });

  test("foundationInputs: defaults, flags over stored values, and refusals", () => {
    const ctx = { region: "eu-west-1", login: "alice" };
    assert.deepEqual(foundationInputs({}, { email: "a@example.com" }, ctx), {
      region: "eu-west-1",
      github_owner: "alice",
      alert_email: "a@example.com",
    });
    const stored = { region: "eu-west-1", github_owner: "acme", alert_email: "a@example.com", deployer_az_suffix: "b" };
    const vars = foundationInputs(stored, { "allowed-users": "Bob, carol", budget: "100" }, ctx);
    assert.deepEqual(vars.github_allowed_users, ["bob", "carol"]);
    assert.equal(vars.budget_amount, 100);
    assert.equal(vars.deployer_az_suffix, "b");
    assert.throws(() => foundationInputs(stored, {}, { ...ctx, region: "us-east-1" }), /already set up in eu-west-1/);
    assert.throws(() => foundationInputs(stored, { owner: "other" }, ctx), /can't move them/);
    assert.throws(() => foundationInputs({}, {}, ctx), /--email/);
    assert.throws(() => foundationInputs({}, { email: "a@example.com", "allowed-users": "not valid!" }, ctx), /isn't a GitHub login/);
    assert.throws(() => foundationInputs({}, { email: "a@example.com", codeowners: "team" }, ctx), /--codeowners/);
    assert.throws(() => foundationInputs({}, { email: "a@example.com", budget: "0" }, ctx), /--budget/);
  });

  test("the App's manifest", () => {
    const org = manifest({ owner: "a-very-long-organisation-name-indeed", isOrg: true, deployerUrl: "https://d.example", redirectUrl: "http://127.0.0.1:1/created" });
    assert.equal(org.name.length, 34);
    assert.equal(org.hook_attributes.url, "https://d.example/webhooks/github");
    assert.equal(org.default_permissions.members, "read");
    assert.equal(org.public, false);
    assert.deepEqual(org.default_events, ["push", "pull_request"]);
    assert.equal(manifest({ owner: "alice", isOrg: false, deployerUrl: "https://d.example" }).default_permissions.members, undefined);
  });

  test("appJwt is a valid RS256 token for the App", () => {
    const claims = verifyJwt(appJwt("123", PEM, Date.UTC(2026, 0, 1)));
    assert.equal(claims.iss, "123");
    assert.equal(claims.exp - claims.iat, 600);
    assert.equal(claims.iat, Date.UTC(2026, 0, 1) / 1000 - 60);
  });
});

// A mock GitHub API: the signed-in user, accounts, manifest conversions and the App's
// installations (which need a valid App JWT).
async function mockGithub({ ownerType = "User", plan = "pro", installed = true } = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: raw });
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const jwt = req.headers.authorization?.replace(/^Bearer /, "");
    if (req.url === "/user") return json(200, { login: "alice", name: "Alice A", plan: { name: plan } });
    if (req.url === "/users/alice") return json(200, { login: "alice", type: "User" });
    if (req.url === "/users/acme") return json(200, { login: "acme", type: ownerType });
    if (req.url === "/users/bob") return json(200, { login: "bob", type: "User" });
    if (req.url === "/user/memberships/orgs/acme") return json(200, { role: "admin" });
    if (req.url === "/app-manifests/the-code/conversions" && req.method === "POST") {
      return json(201, { id: 42, slug: "slipway-alice", pem: PEM, webhook_secret: "whsec", owner: { login: "alice" } });
    }
    if (req.url === "/app") return verifyJwt(jwt ?? "") ? json(200, { slug: "slipway-alice", owner: { login: "alice" } }) : json(401, { message: "bad jwt" });
    if (req.url.startsWith("/app/installations")) {
      if (!verifyJwt(jwt ?? "")) return json(401, { message: "bad jwt" });
      return json(200, installed ? [{ account: { login: "alice" }, repository_selection: "all", html_url: "https://github.example/i/1" }] : []);
    }
    json(404, { message: `no mock for ${req.method} ${req.url}` });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe("the GitHub App manifest flow", () => {
  let gh;
  before(async () => {
    gh = await mockGithub();
    process.env.SLIPWAY_GITHUB_API = gh.url;
    process.env.SLIPWAY_GITHUB_WEB = "https://github.example";
  });
  after(async () => {
    delete process.env.SLIPWAY_GITHUB_API;
    delete process.env.SLIPWAY_GITHUB_WEB;
    await gh.close();
  });

  test("posts the manifest to GitHub, exchanges the code and sends the browser on to install", async () => {
    const flow = await manifestFlow({ owner: "acme", isOrg: true, deployerUrl: "https://d.example" });
    try {
      const html = await (await fetch(flow.url)).text();
      const action = /action="([^"]+)"/.exec(html)[1].replace(/&amp;/g, "&");
      assert.match(action, /^https:\/\/github\.example\/organizations\/acme\/settings\/apps\/new\?state=[0-9a-f]{32}$/);
      const sent = JSON.parse(/name="manifest" value="([^"]+)"/.exec(html)[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
      assert.equal(sent.redirect_url, `${flow.url}created`);
      assert.equal(sent.hook_attributes.url, "https://d.example/webhooks/github");

      const wrong = await fetch(`${flow.url}created?code=the-code&state=nope`, { redirect: "manual" });
      assert.equal(wrong.status, 400);

      const state = new URL(action).searchParams.get("state");
      const back = await fetch(`${flow.url}created?code=the-code&state=${state}`, { redirect: "manual" });
      assert.equal(back.status, 302);
      assert.equal(back.headers.get("location"), "https://github.example/apps/slipway-alice/installations/new");
      const created = await flow.created;
      assert.deepEqual(created, { appId: "42", slug: "slipway-alice", privateKey: PEM, webhookSecret: "whsec" });
      assert.equal(gh.requests.find((r) => r.path.startsWith("/app-manifests")).auth, undefined);
    } finally {
      flow.close();
    }
  });
});

// A stub `aws` (Node) that answers what setup asks, from a JSON state file it keeps:
// each call is logged to calls.log. --query is ignored, so answers are post-query values.
const STUB_AWS = String.raw`#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dir = process.env.STUB_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), args.join(" ") + "\n");
const stateFile = path.join(dir, "state.json");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const out = (v) => { process.stdout.write(JSON.stringify(v) + "\n"); process.exit(0); };
const fail = (msg) => { process.stderr.write("\nAn error occurred (" + msg + ")\n"); process.exit(254); };
const arg = (name) => args[args.indexOf(name) + 1];
const cmd = args[0] + " " + args[1];
if (args[0] === "--version") { console.log("aws-cli/2.31.0 Python/3.13"); process.exit(0); }
switch (cmd) {
  case "sts get-caller-identity": out({ Account: "123456789012", Arn: process.env.STUB_ARN || "arn:aws:sts::123456789012:assumed-role/Admin/alice" });
  case "s3api get-bucket-location": state.bucket ? out({ LocationConstraint: state.bucket }) : fail("NoSuchBucket) when calling the GetBucketLocation operation: The specified bucket does not exist");
  case "s3api create-bucket": state.bucket = process.env.AWS_REGION; save(); out({ Location: "/x" });
  case "s3api head-object": state.applied ? out({}) : fail("404) when calling the HeadObject operation: Not Found");
  case "s3 cp": {
    const [from] = args.slice(2).filter((a) => !a.startsWith("--"));
    if (from.startsWith("s3://")) { if (!state.tfvars) fail("404) Not Found"); process.stdout.write(state.tfvars); process.exit(0); }
    state.tfvars = fs.readFileSync(from, "utf8"); save(); process.exit(0);
  }
  case "account get-region-opt-status": out({ RegionOptStatus: "ENABLED_BY_DEFAULT" });
  case "ssm get-parameters-by-path": out(["ec2", "ecr", "ecs", "elb", "logs", "rds", "s3", "secretsmanager", "sns", "ssm", "lambda"]);
  case "ssm get-parameter": state.release ? out(state.release) : fail("ParameterNotFound) when calling the GetParameter operation");
  case "ec2 describe-subnets": out(["eu-west-1c", "eu-west-1b"]);
  case "ec2 describe-instance-type-offerings": out(["eu-west-1a", "eu-west-1b", "eu-west-1c"]);
  case "rds describe-orderable-db-instance-options": out(3);
  case "ssm describe-instance-information": out({ InstanceInformationList: [{ PingStatus: "Online" }] });
  case "ssm send-command": {
    const params = JSON.parse(fs.readFileSync(arg("--parameters").replace("file://", ""), "utf8"));
    state.lastCommand = params.commands.join("\n"); save(); out("cmd-1");
  }
  case "ssm get-command-invocation": {
    const c = state.lastCommand || "";
    if (c.includes("cloud-init")) out({ Status: "Success", StandardOutputContent: "status: done\n" });
    if (c.includes("create-admin")) {
      if (state.admin) out({ Status: "Failed", StandardOutputContent: "", StandardErrorContent: "x already has an account. Use --reset" });
      state.admin = true; save();
      out({ Status: "Success", StandardOutputContent: "Created admin.\nTemporary password (shown once): Tmp-Pass-1\n" });
    }
    out({ Status: "Success", StandardOutputContent: "restarted\n" });
  }
  case "secretsmanager get-secret-value": state.secret ? out(state.secret) : fail("ResourceNotFoundException) when calling the GetSecretValue operation");
  case "secretsmanager describe-secret": state.secret ? out({}) : fail("ResourceNotFoundException)");
  case "secretsmanager create-secret":
  case "secretsmanager put-secret-value":
    state.secret = fs.readFileSync(arg("--secret-string").replace("file://", ""), "utf8"); save(); out({});
  default:
    if (args[0] === "s3api" && args[1].startsWith("put-")) out(null);
    fail("stub aws: unexpected " + args.join(" "));
}
`;

// A stub `terraform`: plans create everything the first time, nothing after that, and
// outputs point at the mock deployer.
const STUB_TERRAFORM = String.raw`#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dir = process.env.STUB_DIR;
const args = process.argv.slice(2).filter((a) => !a.startsWith("-chdir="));
fs.appendFileSync(path.join(dir, "terraform.log"), process.argv.slice(2).join(" ") + "\n");
const stateFile = path.join(dir, "state.json");
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
switch (args[0]) {
  case "version": console.log(JSON.stringify({ terraform_version: "1.14.0" })); break;
  case "init": console.log("Terraform has been successfully initialized!"); break;
  case "plan":
    if (state.applied && !process.env.STUB_REPLACE) { console.log("No changes."); process.exit(0); }
    console.log("Plan: 20 to add"); process.exit(2);
  case "show": console.log(JSON.stringify({ resource_changes: process.env.STUB_REPLACE
    ? [{ address: "aws_instance.deployer", mode: "managed", change: { actions: ["delete", "create"] } }]
    : [{ address: "aws_instance.deployer", mode: "managed", change: { actions: ["create"] } }] })); break;
  case "apply": state.applied = true; save(); console.log("Apply complete!"); break;
  case "output": console.log(JSON.stringify({
    deployer_url: { value: process.env.STUB_DEPLOYER_URL },
    deployer_instance_id: { value: "i-0abc" },
  })); break;
  default: console.error("stub terraform: unexpected " + args.join(" ")); process.exit(1);
}
`;

const STUB_RELEASE = String.raw`#!/usr/bin/env bash
echo "release.sh $* YES=$YES SKIP_CHECKS=$SKIP_CHECKS AWS_REGION=$AWS_REGION" >> "$STUB_DIR/release.log"
node -e '
const fs = require("fs"); const f = process.env.STUB_DIR + "/state.json";
const s = JSON.parse(fs.readFileSync(f, "utf8")); s.release = process.argv[1]; fs.writeFileSync(f, JSON.stringify(s));
' "$1"
echo "==> Deployer $1 is live."
`;

function stubs(dir) {
  const bin = path.join(dir, "stub-bin");
  mkdirSync(bin, { recursive: true });
  for (const [name, body] of [["aws", STUB_AWS], ["terraform", STUB_TERRAFORM]]) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  // A fake source tree: setup only needs foundation/, the release script and the version.
  const source = path.join(dir, "source");
  mkdirSync(path.join(source, "foundation", "files"), { recursive: true });
  mkdirSync(path.join(source, "deployer", "scripts"), { recursive: true });
  mkdirSync(path.join(source, ".claude-plugin"), { recursive: true });
  writeFileSync(path.join(source, "foundation", "main.tf"), "# stub\n");
  writeFileSync(path.join(source, "foundation", "files", "x.sh"), "echo\n");
  writeFileSync(path.join(source, "deployer", "scripts", "release.sh"), STUB_RELEASE);
  writeFileSync(path.join(source, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "0.4.0" }));
  return { bin, source };
}

// Run the CLI; when it prints the manifest flow's URL, act as the browser.
function runSetup(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "setup", ...args], { env: { ...process.env, ...GIT_ENV, ...env } });
    let stdout = "";
    let stderr = "";
    let browsed = false;
    child.stdout.on("data", async (d) => {
      stdout += d;
      const url = /Open (http:\/\/127\.0\.0\.1:\d+\/) in your browser/.exec(stdout)?.[1];
      if (url && !browsed) {
        browsed = true;
        const html = await (await fetch(url)).text();
        const state = /state=([0-9a-f]+)/.exec(html)[1];
        await fetch(`${url}created?code=the-code&state=${state}`, { redirect: "manual" });
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.end();
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("slipway setup against stubs", () => {
  let gh;
  let deployer;
  before(async () => {
    gh = await mockGithub();
    deployer = await mockDeployer([
      ["GET", /^\/api\/whoami$/, () => ({ json: { login: "alice", owner: "alice", ownerType: "User", codeowners: "@alice" } })],
    ]);
  });
  after(async () => {
    await gh.close();
    await deployer.close();
  });

  const environment = (t, extra = {}) => {
    const { bin, source } = stubs(t.dir);
    return {
      PATH: `${bin}:${process.env.PATH}`,
      STUB_DIR: t.dir,
      STUB_DEPLOYER_URL: deployer.url,
      SLIPWAY_SOURCE: source,
      SLIPWAY_GITHUB_API: gh.url,
      SLIPWAY_GITHUB_WEB: "https://github.example",
      SLIPWAY_GH_TOKEN: "fake:alice",
      SLIPWAY_DEPLOYER_URL: "",
      XDG_CONFIG_HOME: path.join(t.dir, "config"),
      XDG_CACHE_HOME: path.join(t.dir, "cache"),
      AWS_PROFILE: "",
      ...extra,
    };
  };

  test("without --yes it checks and changes nothing", async () => {
    const t = tempDir();
    try {
      const r = await runSetup(["--region", "eu-west-1", "--email", "alice@example.com"], environment(t));
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /AWS account {2}123456789012/);
      assert.match(r.stdout, /deployer goes in eu-west-1b/);
      assert.match(r.stdout, /apps are created under alice \(your personal account\)/);
      assert.match(r.stdout, /Nothing has changed/);
      const calls = readFileSync(path.join(t.dir, "calls.log"), "utf8");
      assert.doesNotMatch(calls, /create-bucket|put-|send-command|create-secret/);
      assert.ok(!existsSync(path.join(t.dir, "terraform.log")) || !/apply|plan/.test(readFileSync(path.join(t.dir, "terraform.log"), "utf8")));
    } finally {
      t.cleanup();
    }
  });

  test("refuses the root user and someone else's personal account", async () => {
    const t = tempDir();
    try {
      const root = await runSetup(["--region", "eu-west-1", "--email", "a@example.com"], environment(t, { STUB_ARN: "arn:aws:iam::123456789012:root" }));
      assert.equal(root.code, 1);
      assert.match(root.stderr, /root user/);
      const other = await runSetup(["--region", "eu-west-1", "--email", "a@example.com", "--owner", "bob"], environment(t));
      assert.equal(other.code, 2);
      assert.match(other.stderr, /someone else's personal account/);
    } finally {
      t.cleanup();
    }
  });

  test("--yes sets everything up, and a second run changes nothing", async () => {
    const t = tempDir();
    try {
      const env = environment(t);
      const r = await runSetup(["--region", "eu-west-1", "--email", "alice@example.com", "--yes", "--no-browser"], env);
      assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /Created slipway-tfstate-123456789012/);
      assert.match(r.stdout, /ACTION: create slipway's GitHub App on alice/);
      assert.match(r.stdout, /Created the GitHub App slipway-alice/);
      assert.match(r.stdout, /temporary password Tmp-Pass-1/);
      assert.match(r.stdout, /slipway is ready/);

      const state = JSON.parse(readFileSync(path.join(t.dir, "state.json"), "utf8"));
      assert.deepEqual(JSON.parse(state.tfvars), {
        region: "eu-west-1",
        github_owner: "alice",
        alert_email: "alice@example.com",
        deployer_az_suffix: "b",
      });
      assert.deepEqual(JSON.parse(state.secret), { appId: "42", privateKey: PEM, webhookSecret: "whsec" });
      assert.match(readFileSync(path.join(t.dir, "release.log"), "utf8"), /^release\.sh 0\.4\.0-\d{14} YES=1 SKIP_CHECKS=1 AWS_REGION=eu-west-1$/m);
      const tf = readFileSync(path.join(t.dir, "terraform.log"), "utf8");
      assert.match(tf, /init -input=false -reconfigure -backend-config=bucket=slipway-tfstate-123456789012 -backend-config=region=eu-west-1/);
      assert.ok(existsSync(path.join(t.dir, "cache", "slipway", "foundation-123456789012-eu-west-1", "files", "x.sh")));
      const config = JSON.parse(readFileSync(path.join(t.dir, "config", "slipway", "config.json"), "utf8"));
      assert.deepEqual(config, { setup: { account: "123456789012", region: "eu-west-1", profile: null }, deployerUrl: deployer.url });

      // Again, with no flags: it remembers the region and the inputs, and skips what's done.
      const again = await runSetup(["--yes", "--no-browser"], env);
      assert.equal(again.code, 0, `${again.stdout}\n${again.stderr}`);
      assert.match(again.stdout, /slipway-tfstate-123456789012 exists/);
      assert.match(again.stdout, /No changes to the foundation/);
      assert.match(again.stdout, /GitHub App slipway-alice exists/);
      assert.match(again.stdout, /Deployer 0\.4\.0-\d{14} is running/);
      assert.match(again.stdout, /your account already existed/);
      assert.equal(readFileSync(path.join(t.dir, "release.log"), "utf8").trim().split("\n").length, 1);
    } finally {
      t.cleanup();
    }
  });

  test("refuses a plan that replaces the deployer instance", async () => {
    const t = tempDir();
    try {
      const r = await runSetup(["--region", "eu-west-1", "--email", "alice@example.com", "--yes", "--no-browser"], environment(t, { STUB_REPLACE: "1" }));
      assert.equal(r.code, 3);
      assert.match(r.stderr, /aws_instance\.deployer \(replaced\)/);
      assert.match(r.stderr, /loses its database/);
      assert.doesNotMatch(readFileSync(path.join(t.dir, "terraform.log"), "utf8"), /apply/);
    } finally {
      t.cleanup();
    }
  });
});
