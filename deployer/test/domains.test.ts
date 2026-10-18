import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { domains, jobs, type JobRow } from "../src/db/schema.js";
import {
  addDomain,
  DOMAIN_POLL_MS,
  getDomain,
  hostnameProblem,
  normalizeHostname,
  pollDomains,
  removeDomain,
  retryDomain,
} from "../src/domains.js";
import { enqueue, getApp, getRelease, queueDeploy } from "../src/jobs.js";
import { addUser, Browser, finishRunning, jobsOf, liveApp, running, serve, setup, type TestEnv } from "./helpers.js";

const HOST = "loans.example.com";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const app = (t: TestEnv, name = "loan-tracker") => getApp(t.deps, name)!;
const domain = (t: TestEnv, env: "staging" | "prod" = "staging") => getDomain(t.deps, "loan-tracker", env);
const inputsOf = (t: TestEnv, job: JobRow) => t.runs.runs.get(job.runId!)!.input.env;

/** Let the poller see the certificate again (it checks each one at most once a minute). */
async function poll(t: TestEnv): Promise<void> {
  t.clock.advance(DOMAIN_POLL_MS);
  await t.worker.tick();
}

/** A live app with HOST attached to staging. */
async function attached(t: TestEnv): Promise<JobRow> {
  await liveApp(t);
  await addDomain(t.deps, app(t), "staging", HOST, "ada@example.com");
  t.platform.issue(HOST);
  await poll(t); // issued -> attaching, redeploy queued
  await t.worker.tick(); // the redeploy starts
  const deploy = running(t).find((j) => j.kind === "deploy")!;
  await finishRunning(t);
  expect(domain(t)).toMatchObject({ status: "active", jobId: deploy.id });
  return deploy;
}

describe("hostnames", () => {
  it("normalizes what people type", () => {
    expect(normalizeHostname("  Loans.Example.COM. ")).toBe("loans.example.com");
    expect(normalizeHostname("bücher.example")).toBe("xn--bcher-kva.example");
  });

  it("refuses what can't or shouldn't be a custom domain", () => {
    const t = setup();
    const problem = (h: string) => hostnameProblem(t.deps, normalizeHostname(h));
    expect(problem("loans.example.com")).toBeNull();
    expect(problem("")).toMatch(/Enter a hostname/);
    expect(problem("https://loans.example.com/")).toMatch(/just the hostname/);
    expect(problem("loans.example.com:8443")).toMatch(/just the hostname/);
    expect(problem("*.example.com")).toMatch(/Wildcards/);
    expect(problem("localhost")).toMatch(/full hostname/);
    expect(problem("10.0.0.1")).toMatch(/not an IP address/);
    expect(problem("under_score.example.com")).toMatch(/isn't a valid hostname/);
    expect(problem(`${"a".repeat(60)}.example.com`)).toMatch(/up to 64 characters/);
    expect(problem("d111111abcdef8.cloudfront.net")).toMatch(/belong to AWS/);
    expect(problem("x.ecs.ca-west-1.on.aws")).toMatch(/belong to AWS/);
    expect(problem("deployer.test")).toMatch(/deployer's own address/);
  });

  it("takes one domain per env, each hostname once, and only once the env is deployed", async () => {
    const t = setup();
    await liveApp(t);
    await liveApp(t, "other-app", "bob");
    await expect(addDomain(t.deps, app(t), "prod", HOST, "ada")).rejects.toMatchObject({ status: 409, message: /prod isn't deployed yet/ });
    await addDomain(t.deps, app(t), "staging", HOST, "ada");
    await expect(addDomain(t.deps, app(t), "staging", "two.example.com", "ada")).rejects.toThrow(/already has loans.example.com/);
    await expect(addDomain(t.deps, app(t, "other-app"), "staging", "LOANS.example.com", "bob")).rejects.toThrow(
      /already added to loan-tracker staging/,
    );
  });
});

describe("a custom domain's life", () => {
  it("requests a certificate, shows its record, and attaches the domain once it's issued", async () => {
    const t = setup();
    await liveApp(t);
    const added = await addDomain(t.deps, app(t), "staging", "Loans.Example.com", "ada@example.com");
    expect(added).toMatchObject({ hostname: HOST, status: "validating", validationName: null });
    expect(t.platform.certificate(HOST)!.tags).toEqual({ platform: "slipway", app: "loan-tracker", env: "staging" });

    // ACM makes the validation record a moment after the request.
    await t.worker.tick();
    expect(domain(t)!.validationName).toBeNull();
    t.clock.advance(10_000);
    await t.worker.tick();
    expect(domain(t)).toMatchObject({ status: "validating", validationName: expect.stringMatching(/^_\w+\.loans\.example\.com\.$/) });

    // Not issued yet, and not checked again within the minute.
    const deploysBefore = jobsOf(t).filter((j) => j.kind === "deploy").length;
    t.platform.issue(HOST);
    await t.worker.tick();
    expect(domain(t)!.status).toBe("validating");

    await poll(t);
    expect(domain(t)!.status).toBe("attaching");
    const deploys = jobsOf(t).filter((j) => j.kind === "deploy");
    expect(deploys).toHaveLength(deploysBefore + 1);
    const redeploy = deploys.at(-1)!;
    expect(redeploy).toMatchObject({ env: "staging", releaseId: app(t).stagingReleaseId, requestedBy: "ada@example.com" });

    await t.worker.tick();
    expect(inputsOf(t, getJobRow(t, redeploy.id))).toMatchObject({
      CUSTOM_DOMAIN: HOST,
      CERTIFICATE_ARN: t.platform.certificate(HOST)!.arn,
    });
    expect(domain(t)!.jobId).toBe(redeploy.id);
    await finishRunning(t);
    expect(domain(t)).toMatchObject({ status: "active", error: null });
    // The env's URL stays the CloudFront one: it works whatever the domain's DNS does.
    expect(app(t).stagingUrl).toMatch(/cloudfront\.net$/);
  });

  it("keeps the domain on later deploys of its env, and off the other env", async () => {
    const t = setup();
    await attached(t);
    const release = getRelease(t.deps, app(t).stagingReleaseId)!;
    queueDeploy(t.deps, "loan-tracker", "staging", release, "x");
    queueDeploy(t.deps, "loan-tracker", "prod", release, "x");
    await t.worker.tick();
    const [staging, prod] = running(t);
    expect(inputsOf(t, staging!)).toMatchObject({ CUSTOM_DOMAIN: HOST });
    expect(inputsOf(t, prod!)).not.toHaveProperty("CUSTOM_DOMAIN");
  });

  it("attaches with a deploy already queued instead of queueing an older release after it", async () => {
    const t = setup();
    await liveApp(t);
    await addDomain(t.deps, app(t), "staging", HOST, "ada");
    const queued = queueDeploy(t.deps, "loan-tracker", "staging", getRelease(t.deps, app(t).stagingReleaseId)!, "a push");
    t.platform.issue(HOST);
    t.clock.advance(DOMAIN_POLL_MS);
    await pollDomains(t.deps); // while that deploy is still queued
    expect(domain(t)!.status).toBe("attaching");
    expect(jobsOf(t).filter((j) => j.kind === "deploy" && j.status === "queued").map((j) => j.id)).toEqual([queued.id]);
  });

  it("fails an attach that breaks in terraform-phase1, and stops passing it", async () => {
    const t = setup();
    await liveApp(t);
    await addDomain(t.deps, app(t), "staging", HOST, "ada");
    t.platform.issue(HOST);
    await poll(t);
    await t.worker.tick();
    await finishRunning(t, "failed", () => true, { failStep: "terraform-phase1", error: `${HOST} is attached to another CloudFront distribution` });
    expect(domain(t)).toMatchObject({ status: "failed", error: expect.stringMatching(/in step terraform-phase1: .*another CloudFront/) });

    queueDeploy(t.deps, "loan-tracker", "staging", getRelease(t.deps, app(t).stagingReleaseId)!, "x");
    await t.worker.tick();
    expect(inputsOf(t, running(t)[0]!)).not.toHaveProperty("CUSTOM_DOMAIN");
    await finishRunning(t);

    // Retry: the certificate is fine, so it only needs another deploy.
    const { job, done } = await retryDomain(t.deps, app(t), "staging", "ada");
    expect(done).toBe(false);
    expect(domain(t)!.status).toBe("attaching");
    await t.worker.tick();
    expect(running(t)[0]!.id).toBe(job!.id);
    await finishRunning(t);
    expect(domain(t)!.status).toBe("active");
  });

  it("counts an attach as done when the deploy fails after terraform-phase1, and not at all when it can't start", async () => {
    const t = setup();
    await liveApp(t);
    await addDomain(t.deps, app(t), "staging", HOST, "ada");
    t.platform.issue(HOST);
    await poll(t);

    const start = t.runs.start.bind(t.runs);
    t.runs.start = async () => {
      throw new Error("runner is down");
    };
    await t.worker.tick();
    expect(jobsOf(t).at(-1)).toMatchObject({ status: "failed", failedStep: "start" });
    expect(domain(t)).toMatchObject({ status: "attaching", jobId: null });

    t.runs.start = start;
    await retryAttach(t);
    await finishRunning(t, "failed", () => true, { failStep: "migrate" });
    expect(domain(t)).toMatchObject({ status: "active" });
  });

  it("asks for a new certificate when ACM gives up", async () => {
    const t = setup();
    await liveApp(t);
    await addDomain(t.deps, app(t), "staging", HOST, "ada");
    const first = t.platform.certificate(HOST)!.arn;
    t.platform.fail(HOST, "CAA_ERROR");
    await poll(t);
    expect(domain(t)).toMatchObject({ status: "failed", error: expect.stringMatching(/CAA/) });

    const { done } = await retryDomain(t.deps, app(t), "staging", "ada");
    expect(done).toBe(true);
    expect(domain(t)).toMatchObject({ status: "validating", validationName: null });
    expect(domain(t)!.certificateArn).not.toBe(first);
    expect(t.platform.certificates.has(first)).toBe(false);
  });

  it("explains a missing permission instead of keeping a half-added domain", async () => {
    const t = setup();
    await liveApp(t);
    t.platform.requestCertificate = async () => {
      throw Object.assign(new Error("not authorized"), { name: "AccessDeniedException" });
    };
    await expect(addDomain(t.deps, app(t), "staging", HOST, "ada")).rejects.toThrow(/run slipway setup --yes again/);
    expect(domain(t)).toBeUndefined();
  });
});

describe("removing a custom domain", () => {
  it("deletes a certificate that was never attached straight away", async () => {
    const t = setup();
    await liveApp(t);
    await addDomain(t.deps, app(t), "staging", HOST, "ada");
    const { done, job } = await removeDomain(t.deps, app(t), "staging", "ada");
    expect({ done, job }).toEqual({ done: true, job: null });
    expect(domain(t)).toBeUndefined();
    expect(t.platform.certificates.size).toBe(0);
  });

  it("detaches an attached domain with a deploy, then deletes the certificate once CloudFront lets go", async () => {
    const t = setup();
    await attached(t);
    const certificate = t.platform.certificate(HOST)!;
    certificate.inUse = true;

    const { job } = await removeDomain(t.deps, app(t), "staging", "ada");
    expect(domain(t)!.status).toBe("removing");
    await t.worker.tick();
    expect(inputsOf(t, getJobRow(t, job!.id))).not.toHaveProperty("CUSTOM_DOMAIN");
    // The poller leaves it alone while the detaching deploy runs.
    await poll(t);
    expect(t.platform.certificates.has(certificate.arn)).toBe(true);

    await finishRunning(t);
    await poll(t); // CloudFront still holds it
    expect(domain(t)!.status).toBe("removing");
    certificate.inUse = false;
    await poll(t);
    expect(domain(t)).toBeUndefined();
    expect(t.platform.certificates.has(certificate.arn)).toBe(false);
  });

  it("says so when the detaching deploy fails, and retries it", async () => {
    const t = setup();
    await attached(t);
    t.platform.certificate(HOST)!.inUse = true;
    await removeDomain(t.deps, app(t), "staging", "ada");
    await t.worker.tick();
    await finishRunning(t, "failed", () => true, { failStep: "secrets-check" });
    expect(domain(t)).toMatchObject({ status: "removing", error: expect.stringMatching(/detaching it failed/) });
    const { job } = await retryDomain(t.deps, app(t), "staging", "ada");
    expect(job).toMatchObject({ kind: "deploy", status: "queued" });
    expect(domain(t)!.error).toBeNull();
  });

  it("deletes the certificates when the app is torn down", async () => {
    const t = setup();
    await attached(t);
    const arn = t.platform.certificate(HOST)!.arn;
    const prod = enqueue(t.deps, { app: "loan-tracker", env: "prod", kind: "destroy", requestedBy: "x" });
    const staging = enqueue(t.deps, { app: "loan-tracker", env: "staging", kind: "destroy", requestedBy: "x", afterJobId: prod.id });
    t.deps.db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.id, prod.id)).run();
    await t.worker.tick();
    expect(running(t).map((j) => j.id)).toEqual([staging.id]);
    await finishRunning(t); // the same tick's poll deletes the certificate: the distribution is gone
    expect(domain(t)).toBeUndefined();
    expect(t.platform.certificates.has(arn)).toBe(false);
  });

  it("isn't undone by a poll that was waiting on ACM meanwhile", async () => {
    const t = setup();
    await liveApp(t);
    await addDomain(t.deps, app(t), "staging", HOST, "ada");
    t.platform.issue(HOST);
    let answer!: () => void;
    const describe = t.platform.describeCertificate.bind(t.platform);
    t.platform.describeCertificate = async (arn) => {
      const state = await describe(arn);
      await new Promise<void>((resolve) => (answer = resolve));
      return state;
    };
    t.clock.advance(DOMAIN_POLL_MS);
    const polling = pollDomains(t.deps);
    await new Promise((resolve) => setImmediate(resolve));
    await removeDomain(t.deps, app(t), "staging", "ada"); // not attached yet: gone at once
    answer();
    await polling;
    expect(domain(t)).toBeUndefined();
    expect(jobsOf(t).filter((j) => j.kind === "deploy" && j.status === "queued")).toHaveLength(0);
  });
});

describe("the custom domain page", () => {
  it("adds a domain, shows the DNS records, and links it from the app page", async () => {
    const t = setup();
    await liveApp(t);
    await addUser(t, "ada@example.com", "a-good-password");
    const s = await serve(t);
    close = s.close;
    const b = new Browser(s.url);
    await b.login("ada@example.com", "a-good-password");

    expect((await b.request("/apps/loan-tracker")).text).toContain("Add a custom domain");
    const page = await b.request("/apps/loan-tracker/domains/staging");
    expect(page.text).toContain('name="hostname"');
    expect((await b.request("/apps/loan-tracker/domains/prod")).text).toContain("isn't deployed yet");

    expect((await b.request("/apps/loan-tracker/domains/staging", { form: { hostname: HOST } })).res.status).toBe(403);
    const _csrf = await b.csrf("/apps/loan-tracker/domains/staging");
    const bad = await b.request("/apps/loan-tracker/domains/staging", { form: { _csrf, hostname: "https://nope" } });
    expect(bad.res.status).toBe(400);
    expect(bad.text).toContain("just the hostname");
    const added = await b.request("/apps/loan-tracker/domains/staging", { form: { _csrf, hostname: HOST } });
    expect(added.res.headers.get("location")).toBe("/apps/loan-tracker/domains/staging");

    t.clock.advance(10_000);
    await t.worker.tick();
    t.clock.advance(10_000);
    await t.worker.tick();
    const shown = (await b.request("/apps/loan-tracker/domains/staging")).text;
    expect(shown).toContain("Requested a certificate for loans.example.com");
    expect(shown).toContain(domain(t)!.validationName!);
    expect(shown).toMatch(/d\w+\.cloudfront\.net/); // the routing record's target
    expect(shown).toContain('http-equiv="refresh"');
    expect((await b.request("/apps/loan-tracker")).text).toContain("waiting for DNS");

    const removed = await b.request("/apps/loan-tracker/domains/staging/remove", { form: { _csrf } });
    expect(removed.res.status).toBe(302);
    expect((await b.request("/apps/loan-tracker/domains/staging")).text).toContain("Removed loans.example.com.");
  });

  it("reports the domain to the plugin with the env", async () => {
    const t = setup();
    await liveApp(t);
    await addDomain(t.deps, app(t), "staging", HOST, "ada");
    const { appJson } = await import("../src/serialize.js");
    const json = appJson(t.deps, app(t));
    expect(json.staging.customDomain).toEqual({ hostname: HOST, status: "validating" });
    expect(json.prod.customDomain).toBeNull();
  });
});

function getJobRow(t: TestEnv, id: number): JobRow {
  return t.deps.db.select().from(jobs).where(eq(jobs.id, id)).get()!;
}

/** After a deploy that couldn't start: the domain still attaches with the next one. */
async function retryAttach(t: TestEnv): Promise<void> {
  queueDeploy(t.deps, "loan-tracker", "staging", getRelease(t.deps, app(t).stagingReleaseId)!, "x");
  await t.worker.tick();
  const deploy = running(t).find((j) => j.kind === "deploy")!;
  expect(inputsOf(t, deploy)).toMatchObject({ CUSTOM_DOMAIN: HOST });
  expect(t.deps.db.select().from(domains).get()!.jobId).toBe(deploy.id);
}
