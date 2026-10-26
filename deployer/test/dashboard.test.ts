import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { ago, duration } from "../src/app.js";
import { jobs, pullRequests, releases } from "../src/db/schema.js";
import { receiveGithubEvent } from "../src/deliveries.js";
import { FakeRuns } from "../src/fake.js";
import { getApp, getRelease } from "../src/jobs.js";
import { appJson } from "../src/serialize.js";
import { addUser, Browser, finishRunning, jobsOf, liveApp, serve, setup, type TestEnv } from "./helpers.js";

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
    expect(await location(`/apps/loan-tracker/releases/${release.id}/verify`, { tab: "releases" })).toBe("/apps/loan-tracker?tab=releases");
    expect(await location(`/apps/loan-tracker/releases/${release.id}/verify`, {})).toBe("/apps/loan-tracker");
  });
});

describe("verifying releases", () => {
  it("keeps a release off prod until its type check, lint and tests pass", async () => {
    const t = setup();
    await liveApp(t);
    const release = getRelease(t.deps, getApp(t.deps, "loan-tracker")!.stagingReleaseId)!;
    expect(appJson(t.deps, getApp(t.deps, "loan-tracker")!).staging.release).toMatchObject({ id: release.id, verified: false });
    const b = await signedIn(t);
    const page = async () => (await b.request("/apps/loan-tracker")).text;
    const _csrf = await b.csrf("/apps/loan-tracker");
    const promote = () => b.request("/apps/loan-tracker/promote", { form: { _csrf } });
    const verify = () => b.request(`/apps/loan-tracker/releases/${release.id}/verify`, { form: { _csrf } });
    const prodDeploys = () => jobsOf(t).filter((j) => j.env === "prod");

    // Staging says what hasn't run, and Promote waits for it.
    let html = await page();
    expect(html).toContain("not verified");
    expect(html).toContain("Type check, lint and tests haven't run on this release.");
    expect(html).toMatch(/button--sm" disabled>Promote \w{7} to prod/);
    await promote();
    expect(prodDeploys()).toHaveLength(0);
    expect(await page()).toContain(`Verify ${release.commitSha.slice(0, 7)} before promoting it`);

    // Verify runs them on the release's commit, once at a time.
    await verify();
    await verify();
    expect(jobsOf(t).filter((j) => j.kind === "verify")).toMatchObject([
      { env: "verify", releaseId: release.id, commitSha: release.commitSha, status: "queued", requestedBy: "ada@example.com" },
    ]);
    await t.worker.tick();
    expect([...t.runs.runs.values()].at(-1)!.input).toMatchObject({
      kind: "build-release",
      env: { APP: "loan-tracker", COMMIT_SHA: release.commitSha, MODE: "verify" },
    });
    expect(await page()).toContain("Running type check, lint and tests.");

    // A failure says where, and can be run again.
    await finishRunning(t, "failed", (j) => j.kind === "verify", { failStep: "test", error: "2 tests failed" });
    html = await page();
    expect(html).toContain("verify failed");
    expect(html).toContain("test: 2 tests failed");
    expect(html).toContain("Verify again");
    await promote();
    expect(prodDeploys()).toHaveLength(0);

    await verify();
    await t.worker.tick();
    await finishRunning(t, "succeeded", (j) => j.kind === "verify");
    expect(getRelease(t.deps, release.id)!.verifiedAt).toBe(new Date(t.clock.now).toISOString());
    html = await page();
    expect(html).toContain("Type check, lint and tests passed.");
    expect(html).toMatch(/button--primary button--sm" >Promote \w{7} to prod/);
    await promote();
    expect(prodDeploys()).toMatchObject([{ kind: "deploy", releaseId: release.id, status: "queued" }]);
    await verify();
    expect(await page()).toContain("is already verified");
    expect(jobsOf(t).filter((j) => j.kind === "verify")).toHaveLength(2);
  });

  it("only rolls prod to a verified release", async () => {
    const t = setup();
    await liveApp(t);
    const release = t.deps.db.select().from(releases).all()[0]!;
    const b = await signedIn(t);
    const _csrf = await b.csrf("/apps/loan-tracker");
    const rollback = async (env: string) =>
      (await b.request("/apps/loan-tracker/rollback", { form: { _csrf, env, release_id: String(release.id) } })).res.headers.get("location");

    const releasesTab = (await b.request("/apps/loan-tracker?tab=releases")).text;
    expect(releasesTab).toContain(" · not verified</option>");
    expect(releasesTab).toContain(`action="/apps/loan-tracker/releases/${release.id}/verify"`);
    expect(await rollback("prod")).toBe("/apps/loan-tracker?tab=releases");
    expect(jobsOf(t).filter((j) => j.env === "prod")).toHaveLength(0);
    expect(await rollback("staging")).toBe("/apps/loan-tracker");

    t.deps.db.update(releases).set({ verifiedAt: new Date(t.clock.now).toISOString() }).where(eq(releases.id, release.id)).run();
    expect(await rollback("prod")).toBe("/apps/loan-tracker");
    expect(jobsOf(t).filter((j) => j.env === "prod")).toMatchObject([{ kind: "deploy", releaseId: release.id }]);
    expect((await b.request("/apps/loan-tracker?tab=releases")).text).not.toContain("not verified");
  });

  it("runs only what each mode needs: a commit whose tests fail still merges and reaches staging", async () => {
    const t = setup();
    const sha = t.github.pushToMain("acme/loan-tracker", { "src/broken.test.ts": "fails" }, "test");
    const runs = new FakeRuns({ github: t.github, autoFinishMs: 0 });
    const run = async (MODE: string) => {
      const id = await runs.start({ kind: "build-release", sourceZip: Buffer.from("zip"), env: { APP: "loan-tracker", COMMIT_SHA: sha, MODE } });
      return { status: (await runs.get(id))!.status, log: (await runs.logTail(id, 100)).join("\n") };
    };
    const check = await run("check");
    expect(check.status).toBe("succeeded");
    expect(check.log).toContain("step: secret-scan");
    expect(check.log).not.toContain("step: npm-ci");
    const build = await run("release");
    expect(build.status).toBe("succeeded");
    expect(build.log).toMatch(/step: web-build[\s\S]*step: docker-build[\s\S]*step: publish/);
    expect(build.log).not.toMatch(/step: (typecheck|lint|test)\b/);
    const verify = await run("verify");
    expect(verify.status).toBe("failed");
    expect(verify.log).toMatch(/step: typecheck[\s\S]*step: lint[\s\S]*step: test\nERROR/);
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
