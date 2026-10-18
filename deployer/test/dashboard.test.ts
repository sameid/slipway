import { afterEach, describe, expect, it } from "vitest";
import { ago, duration } from "../src/app.js";
import { jobs, pullRequests, releases } from "../src/db/schema.js";
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

    const app = await b.request("/apps/loan-tracker?tab=code");
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

describe("the app page", () => {
  it("splits into tabs, each with its own sections", async () => {
    const t = setup();
    await liveApp(t);
    const b = await signedIn(t);
    const tab = async (query: string) => (await b.request(`/apps/loan-tracker${query}`)).text;

    const jobsTab = await tab("");
    expect(jobsTab).toMatch(/href="\/apps\/loan-tracker" data-selected="true" aria-current="page">\s*Jobs/);
    expect(jobsTab).toContain('id="job-');
    expect(jobsTab).not.toContain("Recent webhooks");
    expect(jobsTab).not.toContain("Teardown");
    expect(await tab("?tab=nonsense")).toContain('href="/apps/loan-tracker" data-selected="true"');

    const releasesTab = await tab("?tab=releases");
    expect(releasesTab).toContain("Roll back or redeploy");
    expect(releasesTab).toContain('id="release-');
    const code = await tab("?tab=code");
    expect(code).toContain("Pull requests");
    expect(code).toContain("Recent webhooks");
    const settings = await tab("?tab=settings");
    expect(settings).toContain("Secrets");
    expect(settings).toContain("Teardown");
    expect(settings).not.toContain('id="job-');
  });

  it("shows 25 rows of a long list, and 25 more each time Load more is clicked", async () => {
    const t = setup();
    await liveApp(t);
    const at = new Date(t.clock.now).toISOString();
    const before = t.deps.db.select().from(jobs).all().length;
    for (let i = 0; i < 40; i++) {
      t.deps.db.insert(jobs).values({ app: "loan-tracker", env: "build", kind: "build", status: "succeeded", requestedBy: "push", createdAt: at }).run();
      t.deps.db.insert(releases).values({ app: "loan-tracker", commitSha: String(i).padStart(40, "c"), status: "ready", createdAt: at }).run();
      t.deps.db.insert(pullRequests).values({ app: "loan-tracker", number: 100 + i, headSha: "d".repeat(40), status: "merged", updatedAt: at }).run();
    }
    const b = await signedIn(t);
    const rows = (html: string, prefix: string) => [...html.matchAll(new RegExp(`id="${prefix}-(\\d+)"`, "g"))].map((m) => Number(m[1]));

    const first = (await b.request("/apps/loan-tracker")).text;
    const shown = rows(first, "job");
    expect(shown).toHaveLength(25);
    expect(first).toContain(`Showing 25 of ${before + 40}`);
    expect(first).toContain(`href="/apps/loan-tracker?tab=jobs&amp;jobs=50#job-${shown.at(-1)}">Load more</a>`);
    const second = (await b.request("/apps/loan-tracker?tab=jobs&jobs=50")).text;
    expect(rows(second, "job")).toHaveLength(Math.min(50, before + 40));
    expect((await b.request("/apps/loan-tracker?tab=jobs&jobs=5000")).text).not.toContain("Load more");

    const code = (await b.request("/apps/loan-tracker?tab=code")).text;
    expect(rows(code, "pr")).toHaveLength(25);
    expect(code).toContain("Showing 25 of 40");
    expect(code).toMatch(/href="\/apps\/loan-tracker\?tab=code&amp;prs=50#pr-\d+">Load more/);

    // The rollback form offers every release that built, not only the 25 listed,
    // and a release's Deploy… link picks it in the form.
    const all = t.deps.db.select().from(releases).all();
    const oldest = all[0]!;
    const releasesTab = (await b.request("/apps/loan-tracker?tab=releases")).text;
    expect(rows(releasesTab, "release")).toHaveLength(25);
    expect(releasesTab.match(/<option value="\d+" /g)).toHaveLength(all.filter((r) => r.status === "ready").length);
    expect(releasesTab).toContain(`href="/apps/loan-tracker?tab=releases&amp;release=${all.at(-1)!.id}#rollback">Deploy…</a>`);
    const picked = (await b.request(`/apps/loan-tracker?tab=releases&release=${oldest.id}`)).text;
    expect(picked).toContain(`<option value="${oldest.id}" selected>`);
  });

  it("comes back to the tab an action was taken on", async () => {
    const t = setup();
    await liveApp(t);
    const b = await signedIn(t);
    const _csrf = await b.csrf("/apps/loan-tracker");
    const location = async (path: string, form: Record<string, string>) =>
      (await b.request(path, { form: { _csrf, ...form } })).res.headers.get("location");

    expect(await location("/apps/loan-tracker/sync", { tab: "code" })).toBe("/apps/loan-tracker?tab=code");
    expect(await location("/apps/loan-tracker/sync", {})).toBe("/apps/loan-tracker");
    expect(await location("/apps/loan-tracker/rollback", { env: "staging", release_id: "999" })).toBe("/apps/loan-tracker?tab=releases");
    const release = t.deps.db.select().from(releases).all()[0]!;
    expect(await location("/apps/loan-tracker/rollback", { env: "staging", release_id: String(release.id) })).toBe("/apps/loan-tracker");
    expect(await location("/apps/loan-tracker/destroy/cancel", {})).toBe("/apps/loan-tracker?tab=settings");
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
