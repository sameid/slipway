import { afterEach, describe, expect, it } from "vitest";
import { ago, duration } from "../src/app.js";
import { receiveGithubEvent } from "../src/deliveries.js";
import { addUser, Browser, jobsOf, liveApp, serve, setup, type TestEnv } from "./helpers.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function signedIn(t: TestEnv): Promise<Browser> {
  await addUser(t, "ada@example.com", "a-good-password");
  const s = await serve(t);
  close = s.close;
  const b = new Browser(s.url);
  await b.login("ada@example.com", "a-good-password");
  return b;
}

describe("dashboard", () => {
  it("lists webhook deliveries, filtered by app and outcome", async () => {
    const t = setup();
    await liveApp(t);
    const pr = (repo: string) => ({
      action: "opened",
      number: 3,
      repository: { full_name: repo },
      pull_request: { number: 3, state: "open", head: { sha: "b".repeat(40), ref: "x" }, base: { ref: "main" } },
    });
    await receiveGithubEvent(t.deps, { event: "pull_request", deliveryId: "d-1" }, pr("acme/loan-tracker"));
    await receiveGithubEvent(t.deps, { event: "pull_request", deliveryId: "d-2" }, pr("acme/unknown-repo"));
    const b = await signedIn(t);

    const all = await b.request("/deliveries");
    expect(all.res.status).toBe(200);
    expect(all.text).toContain("PR #3 opened at bbbbbbb");
    expect(all.text).toContain("No app is registered for acme/unknown-repo");

    const one = await b.request("/deliveries?app=loan-tracker&outcome=handled");
    expect(one.text).toContain("d-1");
    expect(one.text).not.toContain("d-2");

    const app = await b.request("/apps/loan-tracker");
    expect(app.text).toContain("Recent webhooks");
    expect(app.text).toMatch(/>#3<\/a>/); // the PR, from the pull_requests table
    expect(app.text).toContain("d-1");
  });

  it("syncs an app with GitHub, checking PRs whose webhooks never arrived", async () => {
    const t = setup();
    await liveApp(t);
    // No onEvent sink: GitHub "sends" the webhook, but it never reaches the deployer.
    const pull = t.github.openPull("acme/loan-tracker", { files: { "a.txt": "a" } });
    expect(jobsOf(t).filter((j) => j.kind === "check")).toHaveLength(0);
    const b = await signedIn(t);

    const _csrf = await b.csrf("/apps/loan-tracker");
    const res = await b.request("/apps/loan-tracker/sync", { form: { _csrf } });
    expect(res.res.headers.get("location")).toBe("/apps/loan-tracker");
    const checks = jobsOf(t).filter((j) => j.kind === "check");
    expect(checks.map((j) => [j.prNumber, j.commitSha])).toEqual([[pull.number, pull.headSha]]);
    expect((await b.request("/apps/loan-tracker")).text).toContain(`Checking PR #${pull.number}`);

    // Nothing more to do the second time.
    await b.request("/apps/loan-tracker/sync", { form: { _csrf } });
    expect((await b.request("/apps/loan-tracker")).text).toContain("nothing was missed");
  });

  it("reloads a job's page while the job runs, and shows how long it's been running", async () => {
    const t = setup();
    await liveApp(t);
    t.github.pushToMain("acme/loan-tracker", { "b.txt": "b" });
    const b = await signedIn(t);
    const _csrf = await b.csrf("/apps/loan-tracker");
    await b.request("/apps/loan-tracker/sync", { form: { _csrf } });
    await t.worker.tick();
    const build = jobsOf(t).at(-2)!;
    expect(build).toMatchObject({ kind: "build", status: "running" });
    t.clock.advance(192_000);
    const page = (await b.request(`/apps/loan-tracker/jobs/${build.id}`)).text;
    expect(page).toContain('http-equiv="refresh"');
    expect(page).toMatch(/Running for<\/dt><dd><span class="tabular-nums" data-elapsed="192">3m 12s<\/span>/);
    // The home page's In progress table and the app's Jobs table count up too.
    expect((await b.request("/")).text).toContain('data-elapsed="192">3m 12s');
    expect((await b.request("/apps/loan-tracker")).text).toContain('data-elapsed="192">3m 12s');

    const done = jobsOf(t)[0]!;
    const donePage = (await b.request(`/apps/loan-tracker/jobs/${done.id}`)).text;
    expect(donePage).not.toContain('http-equiv="refresh"');
    expect(donePage).toContain("Took</dt>");
    expect(donePage).not.toContain("data-elapsed");
  });
});

describe("duration", () => {
  it("is seconds, then minutes and seconds, then hours and minutes", () => {
    expect(duration(0)).toBe("0s");
    expect(duration(45.9)).toBe("45s");
    expect(duration(65)).toBe("1m 05s");
    expect(duration(865)).toBe("14m 25s");
    expect(duration(3600 + 4 * 60 + 59)).toBe("1h 04m");
    expect(duration(-3)).toBe("0s");
  });
});

describe("ago", () => {
  it("says how long ago, roughly", () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    expect(ago("2026-10-13T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-10-13T11:55:00Z", now)).toBe("5 min ago");
    expect(ago("2026-10-13T09:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-10-10T12:00:00Z", now)).toBe("3 d ago");
    expect(ago(null, now)).toBe("");
  });
});
