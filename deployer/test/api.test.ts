import { afterEach, describe, expect, it } from "vitest";
import { getApp } from "../src/jobs.js";
import { finishRunning, jobsOf, liveApp, serve, setup } from "./helpers.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function client(t: ReturnType<typeof setup>, login = "alice") {
  const s = await serve(t);
  close = s.close;
  return async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await fetch(s.url + path, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { authorization: `Bearer fake:${login}`, "content-type": "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: res.status, type: res.headers.get("content-type"), body };
  };
}

const JOB = {
  id: expect.any(Number),
  app: "loan-tracker",
  env: expect.any(String),
  kind: expect.any(String),
  status: expect.any(String),
  releaseId: expect.toBeOneOf([expect.any(Number), null]),
  commitSha: expect.toBeOneOf([expect.any(String), null]),
  prNumber: null,
  requestedBy: expect.any(String),
  failedStep: null,
  error: null,
  createdAt: expect.any(String),
  startedAt: expect.toBeOneOf([expect.any(String), null]),
  finishedAt: expect.toBeOneOf([expect.any(String), null]),
  logPath: expect.stringMatching(/^\/api\/apps\/loan-tracker\/jobs\/\d+\/log$/),
  dashboardUrl: expect.stringMatching(/^https:\/\/deployer\.test\/apps\/loan-tracker\/jobs\/\d+$/),
};

describe("plugin API", () => {
  it("registers an app and returns the App shape", async () => {
    const t = setup();
    const api = await client(t);
    const res = await api("/api/apps", { body: { name: "loan-tracker" } });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      name: "loan-tracker",
      repo: "acme/loan-tracker",
      repoUrl: "https://github.com/acme/loan-tracker",
      owner: "alice",
      status: "registering",
      autoMerge: true,
      dashboardUrl: "https://deployer.test/apps/loan-tracker",
      phase: "deploying_shared",
      error: null,
      failedJob: null,
      staging: { url: null, release: null, lastDeploy: { ...JOB, env: "staging", kind: "deploy", status: "queued" } },
      prod: { url: null, release: null, lastDeploy: null },
      activeJobs: [JOB, JOB, JOB],
      recentJobs: [JOB, JOB, JOB],
    });
    expect(t.github.repo("acme/loan-tracker")!.protected).toBe(true);
    expect((await api("/api/apps", { body: { name: "loan-tracker" } })).status).toBe(409);
  });

  it("refuses bad names and repos that don't exist", async () => {
    const t = setup();
    const api = await client(t);
    for (const name of ["ab", "Loan", "-x-y", "trailing-", "api", "a".repeat(21)]) {
      expect((await api("/api/apps", { body: { name } })).status).toBe(400);
    }
    const missing = await api("/api/apps", { body: { name: "missing-repo" } });
    expect(missing).toMatchObject({ status: 400, body: { error: expect.stringContaining("doesn't exist") } });
    expect(jobsOf(t)).toHaveLength(0);
  });

  it("refuses an app.yaml whose name doesn't match", async () => {
    const t = setup();
    t.github.repo("acme/loan-tracker");
    t.github.pushToMain("acme/loan-tracker", { "app.yaml": "name: something-else\n" });
    const api = await client(t);
    expect(await api("/api/apps", { body: { name: "loan-tracker" } })).toMatchObject({
      status: 400,
      body: { error: 'app.yaml on main has name "something-else", expected "loan-tracker"' },
    });
  });

  it("reports a live app with its release and URL", async () => {
    const t = setup();
    await liveApp(t);
    const api = await client(t);
    const { body } = await api("/api/apps/loan-tracker");
    expect(body).toMatchObject({
      status: "active",
      phase: "live",
      staging: {
        url: expect.stringMatching(/^https:/),
        release: { id: 1, commitSha: expect.any(String), shortSha: expect.stringMatching(/^[0-9a-f]{7}$/), status: "ready" },
        lastDeploy: { status: "succeeded" },
      },
      activeJobs: [],
    });
    expect((await api("/api/apps/nope")).status).toBe(404);
  });

  it("lists jobs and serves their logs as text", async () => {
    const t = setup();
    await liveApp(t);
    const api = await client(t);
    const { body } = await api("/api/apps/loan-tracker/jobs?limit=2");
    expect(body.jobs).toHaveLength(2);
    expect(body.jobs[0]).toEqual({ ...JOB, id: 3, env: "staging" });
    const log = await api(body.jobs[0].logPath + "?tail=3");
    expect(log.type).toMatch(/^text\/plain/);
    expect(log.body).toBe("[fake] web-sync ok\n==> step: health-check\n[fake] health-check ok\n");
    expect((await api("/api/apps/loan-tracker/jobs/999/log")).status).toBe(404);
  });

  it("reports an unknown PR as unknown", async () => {
    const t = setup();
    await liveApp(t);
    const api = await client(t);
    expect((await api("/api/apps/loan-tracker/pulls/42")).body).toMatchObject({ status: "unknown", number: 42, live: false });
  });

  it("lets only the owner request teardown", async () => {
    const t = setup();
    await liveApp(t);
    expect((await (await client(t, "bob"))("/api/apps/loan-tracker/destroy", { method: "POST" })).status).toBe(403);
    await close!();
    const api = await client(t, "alice");
    expect(await api("/api/apps/loan-tracker/destroy", { method: "POST" })).toMatchObject({
      status: 202,
      body: { status: "destroy_requested", dashboardUrl: "https://deployer.test/apps/loan-tracker" },
    });
    expect(getApp(t.deps, "loan-tracker")).toMatchObject({ status: "destroy_requested", destroyRequestedBy: "alice" });
  });

  it("hands out local-development Clerk keys, or says they're missing", async () => {
    const t = setup();
    const api = await client(t);
    expect((await api("/api/dev-config")).body).toEqual({ clerkPublishableKey: "pk_test_fake", clerkSecretKey: "sk_test_fake" });
    t.platform.devConfig = async () => {
      throw new Error("ResourceNotFoundException");
    };
    expect((await api("/api/dev-config")).status).toBe(503);
  });

  it("shows the failed job when the first deploy fails", async () => {
    const t = setup();
    const api = await client(t);
    await api("/api/apps", { body: { name: "loan-tracker" } });
    await t.worker.tick();
    await finishRunning(t);
    await finishRunning(t, "failed", () => true, { failStep: "test", error: "1 test failed" });
    const { body } = await api("/api/apps/loan-tracker");
    expect(body).toMatchObject({
      status: "failed",
      phase: "failed",
      error: "1 test failed",
      failedJob: { kind: "build", failedStep: "test", error: "1 test failed" },
    });
    const log = await api(body.failedJob.logPath);
    expect(log.body).toContain("ERROR: 1 test failed");
  });
});
