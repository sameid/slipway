import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apps, releases } from "../src/db/schema.js";
import { getApp, queueBuildAndDeploy, queueCheck, queueDeploy, getRelease } from "../src/jobs.js";
import { registerApp } from "../src/registration.js";
import { appJson, pullJson } from "../src/serialize.js";
import { concurrencyKey } from "../src/worker.js";
import { upsertPull } from "../src/events.js";
import { finishRunning, jobsOf, liveApp, running, setup } from "./helpers.js";

const summary = (t: ReturnType<typeof setup>, app = "loan-tracker") =>
  jobsOf(t, app).map((j) => `${j.kind}:${j.env}:${j.status}`);

describe("registration chain", () => {
  it("runs shared, then build, then staging, one after the other", async () => {
    const t = setup();
    await registerApp(t.deps, "loan-tracker", "alice");
    await t.worker.tick();
    expect(summary(t)).toEqual(["deploy:shared:running", "build:build:queued", "deploy:staging:queued"]);
    expect(appJson(t.deps, getApp(t.deps, "loan-tracker")!).phase).toBe("deploying_shared");

    await finishRunning(t);
    expect(summary(t)).toEqual(["deploy:shared:succeeded", "build:build:running", "deploy:staging:queued"]);
    expect(appJson(t.deps, getApp(t.deps, "loan-tracker")!).phase).toBe("building");

    await finishRunning(t);
    expect(summary(t)).toEqual(["deploy:shared:succeeded", "build:build:succeeded", "deploy:staging:running"]);
    const release = t.deps.db.select().from(releases).get()!;
    expect(release.status).toBe("ready");
    expect(release.imageDigest).toMatch(/^sha256:/);

    await finishRunning(t);
    const app = getApp(t.deps, "loan-tracker")!;
    expect(app.status).toBe("active");
    expect(app.stagingReleaseId).toBe(release.id);
    expect(app.stagingUrl).toMatch(/^https:\/\/d\w+\.cloudfront\.net$/);
    expect(appJson(t.deps, app).phase).toBe("live");
  });

  it("passes the contract's variables to the runner", async () => {
    const t = setup();
    await liveApp(t);
    const starts = [...t.runs.runs.values()].map((r) => r.input);
    expect(starts[0]).toMatchObject({ kind: "deploy-env", env: { APP: "loan-tracker", ENV: "shared", ACTION: "apply" } });
    expect(starts[0]!.sourceZip).toBeUndefined();
    expect(starts[1]).toMatchObject({ kind: "build-release", env: { MODE: "release" } });
    expect(starts[1]!.sourceZip?.length).toBeGreaterThan(0);
    const deploy = starts[2]!;
    expect(deploy.env).toMatchObject({ ENV: "staging", ACTION: "apply" });
    expect(deploy.env.IMAGE_DIGEST).toMatch(/^sha256:/);
    expect(deploy.env.WEB_ARTIFACT).toMatch(/web\.tgz$/);
    expect(deploy.env.DEPLOY_ID).toBe(String(jobsOf(t)[2]!.id));
    expect(deploy.env.COMMIT_SHA).toMatch(/^[0-9a-f]{40}$/);

    queueCheck(t.deps, "loan-tracker", 1, t.github.repo("acme/loan-tracker")!.main, "bob");
    await t.worker.tick();
    const check = [...t.runs.runs.values()].at(-1)!.input;
    expect(check).toMatchObject({ kind: "build-release", env: { MODE: "check", PR_NUMBER: "1" } });
    expect(Object.keys(check.env).sort()).toEqual(["APP", "COMMIT_SHA", "MODE", "PR_NUMBER"]);
  });

  it("fails the whole chain, and the app, when the shared stack fails", async () => {
    const t = setup();
    await registerApp(t.deps, "loan-tracker", "alice");
    await t.worker.tick();
    await finishRunning(t, "failed", () => true, { failStep: "terraform-apply", error: "AccessDenied" });
    expect(summary(t)).toEqual(["deploy:shared:failed", "build:build:failed", "deploy:staging:failed"]);
    const app = getApp(t.deps, "loan-tracker")!;
    expect(app.status).toBe("failed");
    expect(app.error).toBe("AccessDenied");
    const json = appJson(t.deps, app);
    expect(json.phase).toBe("failed");
    expect(json.failedJob).toMatchObject({ kind: "deploy", env: "shared", failedStep: "terraform-apply" });
    expect(json.failedJob!.logPath).toBe(`/api/apps/loan-tracker/jobs/${json.failedJob!.id}/log`);
  });

  it("points at the build when the first build fails", async () => {
    const t = setup();
    await registerApp(t.deps, "loan-tracker", "alice");
    await t.worker.tick();
    await finishRunning(t);
    await finishRunning(t, "failed", () => true, { failStep: "test", error: "2 tests failed" });
    const json = appJson(t.deps, getApp(t.deps, "loan-tracker")!);
    expect(json.error).toBe("2 tests failed");
    expect(json.failedJob).toMatchObject({ kind: "build", failedStep: "test" });
    expect(json.recentJobs.map((j) => j.id)).toContain(json.failedJob!.id);
  });

  it("lets the owner retry a failed registration", async () => {
    const t = setup();
    await registerApp(t.deps, "loan-tracker", "alice");
    await t.worker.tick();
    await finishRunning(t, "failed");
    await expect(registerApp(t.deps, "loan-tracker", "bob")).rejects.toMatchObject({ status: 403 });
    await registerApp(t.deps, "loan-tracker", "alice");
    expect(getApp(t.deps, "loan-tracker")).toMatchObject({ status: "registering", error: null, failedJobId: null });
    await t.worker.tick();
    for (let i = 0; i < 3; i++) await finishRunning(t);
    expect(getApp(t.deps, "loan-tracker")!.status).toBe("active");
    await expect(registerApp(t.deps, "loan-tracker", "alice")).rejects.toMatchObject({ status: 409 });
  });
});

describe("concurrency", () => {
  it("keys checks per PR and everything else per app and environment", () => {
    const base = { app: "a", prNumber: null };
    expect(concurrencyKey({ ...base, env: "check", kind: "check", prNumber: 4 })).toBe("a:check:4");
    expect(concurrencyKey({ ...base, env: "staging", kind: "deploy" })).toBe("a:staging");
    expect(concurrencyKey({ ...base, env: "staging", kind: "destroy" })).toBe("a:staging");
    expect(concurrencyKey({ ...base, env: "build", kind: "build" })).toBe("a:build");
  });

  it("runs checks for different PRs together, but one at a time per PR", async () => {
    const t = setup();
    await liveApp(t);
    const sha = t.github.repo("acme/loan-tracker")!.main;
    queueCheck(t.deps, "loan-tracker", 1, sha, "bob");
    queueCheck(t.deps, "loan-tracker", 2, sha, "bob");
    await t.worker.tick();
    expect(running(t).map((j) => j.prNumber)).toEqual([1, 2]);
  });

  it("never runs two deploys of one environment at once, but runs other apps in parallel", async () => {
    const t = setup();
    await liveApp(t, "app-one");
    await liveApp(t, "app-two");
    const one = getRelease(t.deps, getApp(t.deps, "app-one")!.stagingReleaseId)!;
    const two = getRelease(t.deps, getApp(t.deps, "app-two")!.stagingReleaseId)!;
    queueDeploy(t.deps, "app-one", "prod", one, "admin@x");
    queueDeploy(t.deps, "app-one", "prod", one, "admin@x");
    queueDeploy(t.deps, "app-two", "prod", two, "admin@x");
    await t.worker.tick();
    expect(running(t).map((j) => `${j.app}:${j.env}`)).toEqual(["app-one:prod", "app-two:prod"]);
    await finishRunning(t);
    expect(running(t).map((j) => `${j.app}:${j.env}`)).toEqual(["app-one:prod"]);
  });

  it("makes builds wait until the shared stack exists", async () => {
    const t = setup();
    await registerApp(t.deps, "loan-tracker", "alice");
    queueBuildAndDeploy(t.deps, "loan-tracker", t.github.pushToMain("acme/loan-tracker"), "bob");
    await t.worker.tick();
    expect(running(t).map((j) => j.env)).toEqual(["shared"]);
  });
});

describe("superseding", () => {
  it("runs only the newest of several queued staging deploys", async () => {
    const t = setup();
    await liveApp(t);
    const shas = [1, 2, 3].map((i) => t.github.pushToMain("acme/loan-tracker", { [`f${i}`]: "x" }));
    for (const sha of shas) queueBuildAndDeploy(t.deps, "loan-tracker", sha, "github");
    // Builds run one at a time; each finished build makes its deploy ready.
    for (let i = 0; i < 5; i++) await finishRunning(t);
    const deploys = jobsOf(t).filter((j) => j.kind === "deploy" && j.env === "staging").slice(1);
    expect(deploys.map((j) => j.status)).toEqual(["superseded", "superseded", "succeeded"]);
    expect(getRelease(t.deps, getApp(t.deps, "loan-tracker")!.stagingReleaseId)!.commitSha).toBe(shas[2]);
  });

  it("supersedes queued checks when the PR gets a new head", async () => {
    const t = setup();
    await liveApp(t);
    upsertPull(t.deps, "loan-tracker", 7, { headSha: "a".repeat(40), status: "checking" });
    const first = queueCheck(t.deps, "loan-tracker", 7, "a".repeat(40), "bob");
    expect(queueCheck(t.deps, "loan-tracker", 7, "a".repeat(40), "bob").id).toBe(first.id); // no duplicate
    queueCheck(t.deps, "loan-tracker", 7, "b".repeat(40), "bob");
    expect(jobsOf(t).filter((j) => j.kind === "check").map((j) => j.status)).toEqual(["superseded", "queued"]);
  });

  it("shows a merged PR as failed at the build, not the deploy that depended on it", async () => {
    const t = setup();
    await liveApp(t);
    const sha = t.github.pushToMain("acme/loan-tracker");
    upsertPull(t.deps, "loan-tracker", 3, { headSha: "c".repeat(40), status: "merged", mergedSha: sha });
    queueBuildAndDeploy(t.deps, "loan-tracker", sha, "github");
    await t.worker.tick();
    await finishRunning(t, "failed", () => true, { failStep: "docker-build", error: "COPY failed" });
    const pr = pullJson(t.deps, getApp(t.deps, "loan-tracker")!, 3);
    expect(pr.deploy?.status).toBe("failed");
    expect(pr.failure).toMatchObject({ step: "docker-build", message: "COPY failed" });
    const build = jobsOf(t).filter((j) => j.kind === "build").at(-1)!;
    expect(pr.failure!.logPath).toBe(`/api/apps/loan-tracker/jobs/${build.id}/log`);
    expect(t.github.repo("acme/loan-tracker")!.comments.at(-1)!.body).toMatch(/failed in step `docker-build`/);
  });
});

describe("finished deploys", () => {
  it("records failed deploys for the alarm and the prod alert", async () => {
    const t = setup();
    await liveApp(t);
    const app = getApp(t.deps, "loan-tracker")!;
    queueDeploy(t.deps, "loan-tracker", "prod", getRelease(t.deps, app.stagingReleaseId)!, "admin@x");
    await t.worker.tick();
    await finishRunning(t, "failed", () => true, { failStep: "migrate", error: "relation exists" });
    expect(t.platform.failedDeploys).toEqual([
      { app: "loan-tracker", env: "prod", summary: expect.stringContaining("relation exists") },
    ]);
    expect(getApp(t.deps, "loan-tracker")!.prodReleaseId).toBeNull();
    const statuses = t.github.repo("acme/loan-tracker")!.statuses;
    expect(statuses.at(-1)!.status).toMatchObject({ context: "slipway/deploy-prod", state: "failure" });
  });

  it("archives the repo and forgets secrets when teardown finishes", async () => {
    const t = setup();
    await liveApp(t);
    t.deps.db.update(apps).set({ status: "destroying" }).where(eq(apps.name, "loan-tracker")).run();
    const { enqueue } = await import("../src/jobs.js");
    const prod = enqueue(t.deps, { app: "loan-tracker", env: "prod", kind: "destroy", requestedBy: "x" });
    const staging = enqueue(t.deps, { app: "loan-tracker", env: "staging", kind: "destroy", requestedBy: "x", afterJobId: prod.id });
    enqueue(t.deps, { app: "loan-tracker", env: "shared", kind: "destroy", requestedBy: "x", afterJobId: staging.id });
    await t.worker.tick();
    for (let i = 0; i < 3; i++) await finishRunning(t);
    expect(getApp(t.deps, "loan-tracker")!.status).toBe("destroyed");
    expect(t.github.repo("acme/loan-tracker")!.archived).toBe(true);
  });
});
