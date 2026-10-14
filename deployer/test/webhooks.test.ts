import { desc } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { webhookDeliveries } from "../src/db/schema.js";
import { KEEP_DELIVERIES, recordRejected } from "../src/deliveries.js";
import { getApp } from "../src/jobs.js";
import { jobsOf, liveApp, serve, setup, sign, type TestEnv } from "./helpers.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function deliver(url: string, event: string, payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  return fetch(`${url}/webhooks/github`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": "test-delivery",
      ...(signature === undefined ? { "x-hub-signature-256": sign(body) } : signature ? { "x-hub-signature-256": signature } : {}),
    },
    body,
  });
}

const push = (sha: string, ref = "refs/heads/main", repo = "acme/loan-tracker") => ({
  ref,
  after: sha,
  repository: { full_name: repo },
  sender: { login: "alice" },
});

const deliveries = (t: TestEnv) =>
  t.deps.db.select().from(webhookDeliveries).orderBy(desc(webhookDeliveries.id)).all();

const pullEvent = (
  action: string,
  number: number,
  sha: string,
  extra: Record<string, unknown> = {},
  repo = "acme/loan-tracker",
) => ({
  action,
  number,
  repository: { full_name: repo },
  sender: { login: "alice" },
  pull_request: {
    number,
    state: action === "closed" ? "closed" : "open",
    merged: false,
    merge_commit_sha: null,
    head: { sha, ref: "feat/x" },
    base: { ref: "main" },
    ...extra,
  },
});

describe("POST /webhooks/github", () => {
  it("rejects deliveries without a valid signature", async () => {
    const t = setup();
    await liveApp(t);
    const before = jobsOf(t).length;
    const s = await serve(t);
    close = s.close;
    expect((await deliver(s.url, "push", push("f".repeat(40)), "sha256=" + "0".repeat(64))).status).toBe(401);
    expect((await deliver(s.url, "push", push("f".repeat(40)), "")).status).toBe(401);
    expect((await deliver(s.url, "push", push("f".repeat(40)), sign("{}", "another-secret"))).status).toBe(401);
    expect(jobsOf(t)).toHaveLength(before);
  });

  it("queues a build and a staging deploy for a push to main", async () => {
    const t = setup();
    await liveApp(t);
    const before = jobsOf(t).length;
    const s = await serve(t);
    close = s.close;
    const sha = "a".repeat(40);
    expect((await deliver(s.url, "push", push(sha))).status).toBe(202);
    const queued = jobsOf(t).slice(before);
    expect(queued.map((j) => `${j.kind}:${j.env}:${j.commitSha === sha}`)).toEqual(["build:build:true", "deploy:staging:true"]);
    // A repeated delivery doesn't queue the same work twice.
    await deliver(s.url, "push", push(sha));
    expect(jobsOf(t).slice(before)).toHaveLength(2);
  });

  it("ignores other branches, branch deletions and unknown repos", async () => {
    const t = setup();
    await liveApp(t);
    const before = jobsOf(t).length;
    const s = await serve(t);
    close = s.close;
    await deliver(s.url, "push", push("a".repeat(40), "refs/heads/feat/x"));
    await deliver(s.url, "push", push("0".repeat(40)));
    await deliver(s.url, "push", push("a".repeat(40), "refs/heads/main", "acme/someone-else"));
    await deliver(s.url, "ping", { zen: "hi" });
    expect(jobsOf(t)).toHaveLength(before);
  });

  it("checks PR heads, supersedes stale checks and records merges", async () => {
    const t = setup();
    await liveApp(t);
    const s = await serve(t);
    close = s.close;
    await deliver(s.url, "pull_request", pullEvent("opened", 5, "b".repeat(40)));
    await deliver(s.url, "pull_request", pullEvent("synchronize", 5, "c".repeat(40)));
    const checks = jobsOf(t).filter((j) => j.kind === "check");
    expect(checks.map((j) => `${j.commitSha![0]}:${j.status}`)).toEqual(["b:superseded", "c:queued"]);

    await deliver(
      s.url,
      "pull_request",
      pullEvent("closed", 5, "c".repeat(40), { merged: true, merge_commit_sha: "d".repeat(40) }),
    );
    const res = await fetch(`${s.url}/api/apps/loan-tracker/pulls/5`, { headers: { authorization: "Bearer fake:alice" } });
    expect(await res.json()).toMatchObject({ status: "merged", mergedSha: "d".repeat(40) });
    expect(jobsOf(t).filter((j) => j.kind === "check").map((j) => j.status)).toEqual(["superseded", "superseded"]);
  });

  it("follows auto_merge from main's app.yaml", async () => {
    const t = setup();
    await liveApp(t);
    const s = await serve(t);
    close = s.close;
    const repo = t.github.repo("acme/loan-tracker")!;
    const yaml = repo.commits.get(repo.main)!.files["app.yaml"]!.replace("auto_merge: true", "auto_merge: false");
    const sha = t.github.pushToMain("acme/loan-tracker", { "app.yaml": yaml });
    await deliver(s.url, "push", push(sha));
    expect(getApp(t.deps, "loan-tracker")!.autoMerge).toBe(false);
  });

  it("matches repos case-insensitively, as GitHub does", async () => {
    // GitHub spells the org "Acme" in payloads; apps.repo says "acme".
    const t = setup();
    await liveApp(t);
    const s = await serve(t);
    close = s.close;
    await deliver(s.url, "pull_request", pullEvent("opened", 7, "b".repeat(40), {}, "Acme/Loan-Tracker"));
    expect(jobsOf(t).filter((j) => j.kind === "check").map((j) => j.prNumber)).toEqual([7]);
  });

  it("logs every delivery with what the deployer did", async () => {
    const t = setup();
    await liveApp(t);
    const s = await serve(t);
    close = s.close;
    await deliver(s.url, "pull_request", pullEvent("opened", 5, "b".repeat(40)));
    await deliver(s.url, "push", push("a".repeat(40), "refs/heads/feat/x"));
    await deliver(s.url, "push", push("a".repeat(40), "refs/heads/main", "acme/someone-else"));
    await deliver(s.url, "pull_request", pullEvent("labeled", 5, "b".repeat(40)));
    await deliver(s.url, "push", { ref: "refs/heads/main", repository: { full_name: "x/y" } }, "sha256=" + "0".repeat(64));

    const check = jobsOf(t).find((j) => j.kind === "check")!;
    expect(deliveries(t).map(({ event, app, summary, outcome, detail, jobId, deliveryId }) => ({ event, app, summary, outcome, detail, jobId, deliveryId }))).toEqual([
      { event: "push", app: null, summary: null, outcome: "rejected", detail: "The signature doesn't match webhookSecret", jobId: null, deliveryId: "test-delivery" },
      { event: "pull_request", app: "loan-tracker", summary: "PR #5 labeled at bbbbbbb", outcome: "ignored", detail: 'Nothing to do for "labeled"', jobId: null, deliveryId: "test-delivery" },
      { event: "push", app: null, summary: "Push to main at aaaaaaa", outcome: "ignored", detail: "No app is registered for acme/someone-else", jobId: null, deliveryId: "test-delivery" },
      { event: "push", app: "loan-tracker", summary: "Push to feat/x at aaaaaaa", outcome: "ignored", detail: "Only pushes to main deploy (this was refs/heads/feat/x)", jobId: null, deliveryId: "test-delivery" },
      { event: "pull_request", app: "loan-tracker", summary: "PR #5 opened at bbbbbbb", outcome: "handled", detail: `Check job #${check.id} for bbbbbbb`, jobId: check.id, deliveryId: "test-delivery" },
    ]);
  });

  it("keeps only the newest deliveries", () => {
    const t = setup();
    for (let i = 0; i < KEEP_DELIVERIES + 5; i++) recordRejected(t.deps, { event: "push", deliveryId: String(i) }, "test");
    const rows = deliveries(t);
    expect(rows).toHaveLength(KEEP_DELIVERIES);
    expect(rows[0]!.deliveryId).toBe(String(KEEP_DELIVERIES + 4));
  });
});
