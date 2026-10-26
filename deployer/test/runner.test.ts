import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRunnerServer, listenOnSocket } from "../src/runner/api.js";
import type { RunnerConfig } from "../src/runner/config.js";
import { Runner } from "../src/runner/runner.js";
import { SocketRuns, type RunInfo } from "../src/runs.js";

// Stand-ins for jobs/build-release.sh and jobs/deploy-env.sh that report what
// each phase saw. The app name picks the behaviour.
const BUILD_RELEASE = `#!/usr/bin/env bash
set -euo pipefail
phase=$1
echo "==> step: $phase"
case "$phase" in
  prepare) [[ -f "$SLIPWAY_SOURCE_ZIP" ]] || { echo "ERROR: no source zip"; exit 1; } ;;
  verify)
    # Untrusted code: nothing AWS, nowhere to export to.
    if [[ -n "\${AWS_PROFILE:-}\${AWS_REGION:-}\${AWS_ACCOUNT_ID:-}\${AWS_CONFIG_FILE:-}\${RELEASES_BUCKET:-}\${SLIPWAY_SOURCE_ZIP:-}" || "$SLIPWAY_EXPORTS" != /dev/null ]]; then
      echo "ERROR: verify saw the runner's settings"; exit 1
    fi
    [[ "$APP" != fails-verify ]] || { echo "ERROR: 2 tests failed"; exit 1; }
    [[ "$APP" != sleepy-app ]] || sleep 30
    ;;
  image) echo "built $SLIPWAY_IMAGE" ;;
  publish)
    echo "publish profile=\${AWS_PROFILE:-none}"
    { echo "IMAGE_DIGEST=sha256:abc"; echo "IMAGE_URI=repo@sha256:abc"; echo "WEB_ARTIFACT=s3://b/releases/$APP/$COMMIT_SHA/web.tgz"; echo "APP_URL=https://nope"; } >>"$SLIPWAY_EXPORTS"
    ;;
esac
`;
const DEPLOY_ENV = `#!/usr/bin/env bash
set -euo pipefail
echo "==> step: deploy"
echo "deploy profile=\${AWS_PROFILE:-none}"
[[ "$APP" != sleepy-app ]] || sleep 30
echo "APP_URL=https://d123.cloudfront.net" >>"$SLIPWAY_EXPORTS"
`;

const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);

let dir: string;
let servers: Server[];
let runners: Runner[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "runner-test-"));
  mkdirSync(join(dir, "home", "jobs"), { recursive: true });
  writeFileSync(join(dir, "home", "jobs", "build-release.sh"), BUILD_RELEASE);
  writeFileSync(join(dir, "home", "jobs", "deploy-env.sh"), DEPLOY_ENV);
  chmodSync(join(dir, "home", "jobs", "build-release.sh"), 0o755);
  chmodSync(join(dir, "home", "jobs", "deploy-env.sh"), 0o755);
  servers = [];
  runners = [];
});

afterEach(async () => {
  for (const r of runners) {
    // Stop whatever a test left running.
    (r as unknown as { config: RunnerConfig }).config.shutdownGraceMs = 0;
    await r.drain();
  }
  for (const s of servers) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function config(over: Partial<RunnerConfig> = {}): RunnerConfig {
  return {
    socket: join(dir, "runner.sock"),
    dataDir: join(dir, "data"),
    buildUser: "",
    dev: false,
    maxBuilds: 1,
    maxDeploys: 2,
    home: join(dir, "home"),
    region: "us-east-1",
    accountId: "123456789012",
    releasesBucket: "slipway-releases-test",
    stateBucket: "slipway-tfstate-test",
    publishProfile: "slipway-publish",
    deployProfile: "slipway-deploy",
    buildTimeoutMs: 60_000,
    deployTimeoutMs: 60_000,
    retentionDays: 30,
    shutdownGraceMs: 60_000,
    ...over,
  };
}

async function start(over: Partial<RunnerConfig> = {}): Promise<{ runner: Runner; client: SocketRuns }> {
  const c = config(over);
  const runner = new Runner(c);
  runner.recover();
  const server = createRunnerServer(runner);
  await listenOnSocket(server, c.socket);
  servers.push(server);
  runners.push(runner);
  runner.pump();
  return { runner, client: new SocketRuns(c.socket, 5_000) };
}

async function until(client: SocketRuns, id: string, statuses: RunInfo["status"][], ms = 10_000): Promise<RunInfo> {
  const deadline = Date.now() + ms;
  for (;;) {
    const run = await client.get(id);
    if (run && statuses.includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`run ${id} is still ${run?.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const release = (app = "loan-tracker") => ({
  kind: "build-release" as const,
  env: { APP: app, COMMIT_SHA: "a".repeat(40), MODE: "release" },
  sourceZip: ZIP,
});

describe("runner", () => {
  it("runs build-release phase by phase and returns only the contract's exports", async () => {
    const { client } = await start();
    const id = await client.start(release());
    const run = await until(client, id, ["succeeded", "failed"]);
    expect(run).toMatchObject({ kind: "build-release", status: "succeeded", exitCode: 0 });
    expect(run.exported).toEqual({
      IMAGE_DIGEST: "sha256:abc",
      IMAGE_URI: "repo@sha256:abc",
      WEB_ARTIFACT: `s3://b/releases/loan-tracker/${"a".repeat(40)}/web.tgz`,
    });
    const log = (await client.logTail(id, 1000)).join("\n");
    expect(log).toMatch(/==> step: prepare[\s\S]*==> step: verify[\s\S]*==> step: image[\s\S]*==> step: publish/);
    expect(log).toContain("ignored export APP_URL");
    expect(log).toContain("publish profile=slipway-publish");
    expect(log).toContain(`built slipway-local/app-loan-tracker:${id}`);
    expect(await client.logTail(id, 2)).toHaveLength(2);
  });

  it("builds no image for checks and verify runs, and runs deploys with the deploy profile", async () => {
    const { client } = await start({ maxBuilds: 2 });
    const check = await client.start({ ...release(), env: { APP: "loan-tracker", COMMIT_SHA: "b".repeat(40), MODE: "check", PR_NUMBER: "7" } });
    const verify = await client.start({ ...release(), env: { APP: "loan-tracker", COMMIT_SHA: "c".repeat(40), MODE: "verify" } });
    const deploy = await client.start({
      kind: "deploy-env",
      env: {
        APP: "loan-tracker", ENV: "staging", ACTION: "apply", DEPLOY_ID: "12",
        // A custom domain's inputs pass the contract too.
        CUSTOM_DOMAIN: "loans.example.com",
        CERTIFICATE_ARN: "arn:aws:acm:us-east-1:123456789012:certificate/0f0e0d0c-0000-4000-8000-000000000001",
      },
    });
    for (const id of [check, verify]) {
      expect(await until(client, id, ["succeeded", "failed"])).toMatchObject({ status: "succeeded", exported: {} });
      const log = (await client.logTail(id, 100)).join("\n");
      expect(log).toMatch(/==> step: prepare[\s\S]*==> step: verify/);
      expect(log).not.toMatch(/step: (image|publish)/);
    }
    const done = await until(client, deploy, ["succeeded", "failed"]);
    expect(done).toMatchObject({ status: "succeeded", exported: { APP_URL: "https://d123.cloudfront.net" } });
    expect((await client.logTail(deploy, 100)).join("\n")).toContain("deploy profile=slipway-deploy");
  });

  it("uses the instance role directly when no profiles are configured", async () => {
    const { client } = await start({ publishProfile: "", deployProfile: "" });
    const build = await client.start(release());
    const deploy = await client.start({
      kind: "deploy-env",
      env: { APP: "loan-tracker", ENV: "staging", ACTION: "apply", DEPLOY_ID: "13" },
    });
    expect((await until(client, build, ["succeeded", "failed"])).status).toBe("succeeded");
    expect((await until(client, deploy, ["succeeded", "failed"])).status).toBe("succeeded");
    expect((await client.logTail(build, 100)).join("\n")).toContain("publish profile=none");
    expect((await client.logTail(deploy, 100)).join("\n")).toContain("deploy profile=none");
  });

  it("fails a run at the failing phase, with the step and error in its log", async () => {
    const { client } = await start();
    const id = await client.start(release("fails-verify"));
    const run = await until(client, id, ["succeeded", "failed"]);
    expect(run).toMatchObject({ status: "failed", exitCode: 1, exported: {} });
    const log = await client.logTail(id, 100);
    expect(log.join("\n")).not.toContain("step: image");
    expect(log).toContain("ERROR: 2 tests failed");
  });

  it("refuses inputs outside the contract", async () => {
    const { client } = await start();
    await expect(client.start({ kind: "deploy-env", env: { APP: "x-app", ENV: "staging", PATH: "/tmp" } })).rejects.toThrow(/doesn't take PATH/);
    await expect(client.start({ kind: "deploy-env", env: { APP: "x-app", ENV: "$(reboot)" } })).rejects.toThrow(/invalid value for ENV/);
    await expect(client.start({ kind: "build-release", env: { APP: "x-app", COMMIT_SHA: "a", MODE: "check" } })).rejects.toThrow(/needs sourceZip/);
    await expect(
      client.start({ kind: "build-release", env: { APP: "x-app", COMMIT_SHA: "a", MODE: "check" }, sourceZip: Buffer.from("not a zip at all, really not") }),
    ).rejects.toThrow(/isn't a zip/);
    expect(await client.get("1760000000000-deadbeef")).toBeNull();
  });

  it("caps concurrent builds; cancelling one lets the next start", async () => {
    const { client } = await start({ maxBuilds: 1 });
    const first = await client.start(release("sleepy-app"));
    const second = await client.start(release());
    await until(client, first, ["running"]);
    await new Promise((r) => setTimeout(r, 200));
    expect((await client.get(second))!.status).toBe("queued");
    await client.cancel(first);
    expect(await until(client, first, ["failed"])).toMatchObject({ status: "failed" });
    expect((await client.logTail(first, 5)).join("\n")).toContain("ERROR: cancelled");
    expect((await until(client, second, ["succeeded", "failed"])).status).toBe("succeeded");
  });

  it("deploys don't wait for builds", async () => {
    const { client } = await start({ maxBuilds: 1 });
    const build = await client.start(release("sleepy-app"));
    await until(client, build, ["running"]);
    const deploy = await client.start({ kind: "deploy-env", env: { APP: "loan-tracker", ENV: "shared", ACTION: "apply", DEPLOY_ID: "3" } });
    expect((await until(client, deploy, ["succeeded", "failed"])).status).toBe("succeeded");
    expect((await client.get(build))!.status).toBe("running");
  });

  it("stops a run that takes too long", async () => {
    const { client } = await start({ buildTimeoutMs: 300 });
    const id = await client.start(release("sleepy-app"));
    await until(client, id, ["failed"]);
    expect((await client.logTail(id, 5)).join("\n")).toContain("took longer than");
  });

  it("after a restart, fails runs that were running and still runs queued ones", async () => {
    const first = new Runner(config());
    const running = first.store.create("deploy-env", { APP: "loan-tracker", ENV: "staging", ACTION: "apply" }, undefined, new Date());
    first.store.save({ ...running, status: "running", startedAt: new Date().toISOString() });
    const queued = first.store.create("deploy-env", { APP: "loan-tracker", ENV: "prod", ACTION: "apply" }, undefined, new Date(Date.now() + 1));

    const { client } = await start();
    const was = await client.get(running.id);
    expect(was).toMatchObject({ status: "failed", exitCode: null });
    expect(await client.logTail(running.id, 5)).toContain("ERROR: runner restarted during this run");
    expect((await until(client, queued.id, ["succeeded", "failed"])).status).toBe("succeeded");
  });

  it("drains on shutdown: waits for active runs, then stops them after the grace period", async () => {
    const { runner, client } = await start({ shutdownGraceMs: 300 });
    const id = await client.start(release("sleepy-app"));
    await until(client, id, ["running"]);
    await runner.drain();
    const run = runner.store.get(id)!;
    expect(run.status).toBe("failed");
    expect(readFileSync(runner.store.logPath(id), "utf8")).toContain("ERROR: the runner was stopped during this run");
    await expect(client.start(release())).rejects.toThrow(/shutting down/);
  });

  it("deletes work dirs when runs finish and old runs after the retention period", async () => {
    const now = { t: Date.now() };
    const c = config({ retentionDays: 1 });
    const runner = new Runner(c, { now: () => new Date(now.t) });
    runners.push(runner);
    const server = createRunnerServer(runner);
    await listenOnSocket(server, c.socket);
    servers.push(server);
    const client = new SocketRuns(c.socket);
    const id = await client.start(release());
    await until(client, id, ["succeeded"]);
    await new Promise((r) => setTimeout(r, 100));
    expect(() => readFileSync(runner.store.sourcePath(id))).toThrow();
    now.t += 2 * 86400_000;
    runner.prune();
    expect(await client.get(id)).toBeNull();
  });
});
