import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apps, secretLinks, secrets } from "../src/db/schema.js";
import { defaultAppYaml } from "../src/fake.js";
import { getApp, getRelease, queueDeploy } from "../src/jobs.js";
import { createLink, LINK_TTL_MS, parseEnvFile, secretStatuses, setSecret } from "../src/secrets.js";
import { addUser, Browser, finishRunning, jobsOf, liveApp, running, serve, setup, type TestEnv } from "./helpers.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const tokenOf = (url: string) => url.split("/").at(-1)!;

describe("secret links", () => {
  it("hands out links for new names too, but not for ones the platform or app.yaml alone may use", async () => {
    const t = setup();
    await liveApp(t);
    const app = getApp(t.deps, "loan-tracker")!;
    await expect(createLink(t.deps, app, "staging", "NOT_DECLARED_YET", "alice")).resolves.toBeTruthy();
    await expect(createLink(t.deps, app, "staging", "DB_HOST", "alice")).rejects.toThrow(/DB_HOST is set by the platform/);
    await expect(createLink(t.deps, app, "staging", "NODE_OPTIONS", "alice")).rejects.toThrow(/only be added under secrets: in app.yaml/);
    await expect(createLink(t.deps, app, "staging", "lower_case", "alice")).rejects.toMatchObject({ status: 400 });
    for (let i = 0; i < 49; i++) t.platform.parameters.add(`/apps/loan-tracker/staging/KEY_${i}`);
    await expect(createLink(t.deps, app, "staging", "ONE_TOO_MANY", "alice")).rejects.toThrow(/at most 50 secrets/);
    const link = await createLink(t.deps, app, "staging", "EXAMPLE_API_KEY", "alice");
    expect(link.url).toMatch(/^https:\/\/deployer\.test\/secrets\/set\/[\w-]{43}$/);
    expect(Date.parse(link.expiresAt) - t.clock.now).toBe(LINK_TTL_MS);
  });

  it("stores only the token's hash and never the value", async () => {
    const t = setup();
    await liveApp(t);
    const link = await createLink(t.deps, getApp(t.deps, "loan-tracker")!, "staging", "EXAMPLE_API_KEY", "alice");
    await setSecret(t.deps, tokenOf(link.url), "super-secret-value");
    const dump = JSON.stringify([t.deps.db.select().from(secretLinks).all(), t.deps.db.select().from(secrets).all()]);
    expect(dump).not.toContain(tokenOf(link.url));
    expect(dump).not.toContain("super-secret-value");
    expect(t.platform.written).toEqual(["/apps/loan-tracker/staging/EXAMPLE_API_KEY"]);
  });

  it("works once, and not after it expires", async () => {
    const t = setup();
    await liveApp(t);
    const app = getApp(t.deps, "loan-tracker")!;
    const link = await createLink(t.deps, app, "staging", "EXAMPLE_API_KEY", "alice");
    await setSecret(t.deps, tokenOf(link.url), "v1");
    await expect(setSecret(t.deps, tokenOf(link.url), "v2")).rejects.toMatchObject({ status: 410 });
    const late = await createLink(t.deps, app, "prod", "EXAMPLE_API_KEY", "alice");
    t.clock.advance(LINK_TTL_MS);
    await expect(setSecret(t.deps, tokenOf(late.url), "v3")).rejects.toMatchObject({ status: 410 });
    await expect(setSecret(t.deps, "x".repeat(43), "v4")).rejects.toMatchObject({ status: 404 });
    expect(t.platform.written).toHaveLength(1);
  });

  it("frees the link again if Parameter Store refuses the write", async () => {
    const t = setup();
    await liveApp(t);
    const link = await createLink(t.deps, getApp(t.deps, "loan-tracker")!, "staging", "EXAMPLE_API_KEY", "alice");
    t.platform.putAppSecret = async () => {
      throw new Error("AccessDenied");
    };
    await expect(setSecret(t.deps, tokenOf(link.url), "v1")).rejects.toMatchObject({ status: 502 });
    t.platform.putAppSecret = async () => {};
    await expect(setSecret(t.deps, tokenOf(link.url), "v1")).resolves.toBeTruthy();
  });

  it("redeploys the environment's current release, or the deploy already queued", async () => {
    const t = setup();
    await liveApp(t);
    const app = getApp(t.deps, "loan-tracker")!;
    const first = await setSecret(t.deps, tokenOf((await createLink(t.deps, app, "staging", "EXAMPLE_API_KEY", "alice")).url), "v1");
    expect(first.redeploy).toMatchObject({ env: "staging", kind: "deploy", releaseId: app.stagingReleaseId, requestedBy: "alice" });
    const second = await setSecret(t.deps, tokenOf((await createLink(t.deps, app, "staging", "EXAMPLE_API_KEY", "bob")).url), "v2");
    expect(second.redeploy!.id).toBe(first.redeploy!.id); // still queued, so it picks up v2 too
    // Prod has never been deployed: the first promote picks the value up.
    const prod = await setSecret(t.deps, tokenOf((await createLink(t.deps, app, "prod", "EXAMPLE_API_KEY", "alice")).url), "p");
    expect(prod.redeploy).toBeNull();
  });

  it("saves without deploying when asked, leaving the value for the next deploy", async () => {
    const t = setup();
    await liveApp(t);
    const app = getApp(t.deps, "loan-tracker")!;
    const before = jobsOf(t).length;
    t.clock.advance(60_000);
    const { link, redeploy } = await setSecret(t.deps, tokenOf((await createLink(t.deps, app, "staging", "SLACK_TOKEN", "alice")).url), "v1", false);
    expect(redeploy).toBeNull();
    expect(link.deployRequested).toBe(false);
    expect(jobsOf(t)).toHaveLength(before);
    const row = (await secretStatuses(t.deps, app)).find((r) => r.key === "SLACK_TOKEN")!;
    expect(row).toMatchObject({ required: false, staging: { set: true, notDeployed: true, removing: false }, prod: { set: false } });
  });

  it("redeploys after a deploy that's already running", async () => {
    const t = setup();
    await liveApp(t);
    const app = getApp(t.deps, "loan-tracker")!;
    const running = queueDeploy(t.deps, "loan-tracker", "staging", getRelease(t.deps, app.stagingReleaseId)!, "x");
    await t.worker.tick();
    const { redeploy } = await setSecret(
      t.deps,
      tokenOf((await createLink(t.deps, app, "staging", "EXAMPLE_API_KEY", "alice")).url),
      "v1",
    );
    expect(redeploy!.id).toBeGreaterThan(running.id);
    expect(jobsOf(t).find((j) => j.id === running.id)!.status).toBe("running");
  });
});

describe("the one-time form", () => {
  it("sets a value through the browser and reports the redeploy to the plugin", async () => {
    const t = setup();
    await liveApp(t);
    const s = await serve(t);
    close = s.close;
    const api = (path: string, method = "GET") =>
      fetch(s.url + path, { method, headers: { authorization: "Bearer fake:alice" } }).then(async (r) => ({
        status: r.status,
        body: (await r.json()) as Record<string, unknown>,
      }));
    const { status, body } = await api("/api/apps/loan-tracker/secrets/staging/EXAMPLE_API_KEY/link", "POST");
    expect(status).toBe(201);
    const path = new URL(body.url as string).pathname;
    expect((await api(`/api/apps/loan-tracker/secret-links/${body.linkId}`)).body).toMatchObject({ status: "pending", redeploy: null });

    const b = new Browser(s.url);
    const page = await b.request(path);
    expect(page.res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.text).toContain('type="password"');
    expect(page.text).toContain("Save and deploy staging");
    expect(page.text).toContain('name="deploy" value="0">Save only');
    const _csrf = await b.csrf(path);
    const saved = await b.request(path, { form: { _csrf, value: "sk_live_abc", deploy: "1" } });
    expect(saved.text).toContain("Deploying staging so the app picks it up");
    expect(saved.text).not.toContain("sk_live_abc");
    expect((await b.request(path)).res.status).toBe(410);

    const after = await api(`/api/apps/loan-tracker/secret-links/${body.linkId}`);
    expect(after.body).toMatchObject({ status: "used", deployRequested: true, redeploy: { env: "staging", status: "queued" } });
    const list = await api("/api/apps/loan-tracker/secrets");
    expect(list.body).toEqual({
      secrets: [
        {
          key: "EXAMPLE_API_KEY",
          required: true,
          staging: { set: true, lastSetBy: "alice", lastSetAt: expect.any(String), notDeployed: false, removing: false },
          prod: { set: false, lastSetBy: null, lastSetAt: null, notDeployed: false, removing: false },
        },
      ],
    });

    // Save only, for a name app.yaml doesn't list.
    const second = await api("/api/apps/loan-tracker/secrets/staging/SLACK_TOKEN/link", "POST");
    const secondPath = new URL(second.body.url as string).pathname;
    const savedOnly = await b.request(secondPath, { form: { _csrf: await b.csrf(secondPath), value: "xoxb-1", deploy: "0" } });
    expect(savedOnly.text).toContain("SLACK_TOKEN is saved for loan-tracker (staging) without deploying");
    expect((await api(`/api/apps/loan-tracker/secret-links/${second.body.linkId}`)).body).toMatchObject({
      status: "used",
      deployRequested: false,
      redeploy: null,
    });
  });
});

describe("parseEnvFile", () => {
  it("reads KEY=value lines the way .env files write them", () => {
    const text = [
      "# Stripe",
      "",
      "export STRIPE_KEY=sk_live_abc # the live key",
      "PLAIN=a#b",
      'DOUBLE="has \\"quotes\\" and a\\nnewline"',
      "SINGLE='kept \\n as is'",
      'PEM="-----BEGIN KEY-----',
      "abc",
      '-----END KEY-----"',
      "EMPTY=",
      "  SPACED = value  ",
    ].join("\r\n");
    const { values, badLines } = parseEnvFile(text);
    expect(badLines).toEqual([]);
    expect(Object.fromEntries(values)).toEqual({
      STRIPE_KEY: "sk_live_abc",
      PLAIN: "a#b",
      DOUBLE: 'has "quotes" and a\nnewline',
      SINGLE: "kept \\n as is",
      PEM: "-----BEGIN KEY-----\nabc\n-----END KEY-----",
      EMPTY: "",
      SPACED: "value",
    });
  });

  it("reports unreadable lines by number", () => {
    expect(parseEnvFile("A=1\nnot a pair\nB=\"open\nC=3").badLines).toEqual([2, 3]);
    expect(parseEnvFile('A="x" trailing').badLines).toEqual([1]);
  });
});

describe("the dashboard's secrets page", () => {
  const DECLARED = ["EXAMPLE_API_KEY", "STRIPE_KEY", "OPENAI_KEY"];

  /** A live app declaring three secrets, a signed-in browser, and what Parameter Store was sent. */
  async function page(t: TestEnv = setup()) {
    await liveApp(t);
    const yaml = defaultAppYaml("loan-tracker").replace("  - EXAMPLE_API_KEY\n", DECLARED.map((k) => `  - ${k}\n`).join(""));
    t.github.pushToMain("acme/loan-tracker", { "app.yaml": yaml });
    const put: Record<string, string> = {};
    const write = t.platform.putAppSecret.bind(t.platform);
    t.platform.putAppSecret = async (name, value) => {
      put[name] = value;
      await write(name, value);
    };
    await addUser(t, "ada@example.com", "a-good-password");
    const s = await serve(t);
    close = s.close;
    const b = new Browser(s.url);
    await b.login("ada@example.com", "a-good-password");
    const submit = async (env: string, form: Record<string, string>) =>
      b.request(`/apps/loan-tracker/secrets/${env}`, { form: { _csrf: await b.csrf(`/apps/loan-tracker/secrets/${env}`), ...form } });
    return { t, b, put, submit };
  }

  it("sets several values from fields and a pasted .env, then redeploys once", async () => {
    const { t, b, put, submit } = await page();
    expect((await b.request("/apps/loan-tracker?tab=settings")).text).toContain('href="/apps/loan-tracker/secrets/staging"');
    const form = await b.request("/apps/loan-tracker/secrets/staging");
    for (const key of DECLARED) expect(form.text).toContain(`name="value:${key}"`);
    expect(form.text).toContain('autocomplete="new-password"');
    const jobsBefore = jobsOf(t).length;

    expect(form.text).toContain("Save and deploy staging");
    expect(form.text).toContain('name="deploy" value="0">Save only');

    const res = await submit("staging", {
      "value:EXAMPLE_API_KEY": "example-value",
      "value:OPENAI_KEY": "",
      new_name: "slack_token",
      new_value: "xoxb-1",
      env_file: 'export STRIPE_KEY="sk_live_123"\n# not this one\nOPENAI_KEY=\nAIRTABLE_KEY=pat123\n',
      deploy: "1",
    });
    expect(res.res.status).toBe(302);
    expect(res.res.headers.get("location")).toBe("/apps/loan-tracker/secrets/staging");
    expect(put).toEqual({
      "/apps/loan-tracker/staging/EXAMPLE_API_KEY": "example-value",
      "/apps/loan-tracker/staging/SLACK_TOKEN": "xoxb-1",
      "/apps/loan-tracker/staging/STRIPE_KEY": "sk_live_123",
      "/apps/loan-tracker/staging/AIRTABLE_KEY": "pat123",
    });
    const added = jobsOf(t).slice(jobsBefore);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: "deploy", env: "staging", requestedBy: "ada@example.com" });

    const after = await b.request("/apps/loan-tracker/secrets/staging");
    expect(after.text).toContain(
      `Saved EXAMPLE_API_KEY, SLACK_TOKEN, STRIPE_KEY and AIRTABLE_KEY for staging. Deploying staging so the app picks up the changes (job #${added[0]!.id}).`,
    );
    expect(after.text).not.toContain("sk_live_123");
    // The new names are listed for prod too, where they aren't set yet.
    expect((await b.request("/apps/loan-tracker/secrets/prod")).text).toContain('name="value:SLACK_TOKEN"');
    const rows = t.deps.db.select().from(secrets).all();
    expect(rows.map((r) => [r.env, r.key, r.lastSetBy])).toEqual([
      ["staging", "EXAMPLE_API_KEY", "ada@example.com"],
      ["staging", "SLACK_TOKEN", "ada@example.com"],
      ["staging", "STRIPE_KEY", "ada@example.com"],
      ["staging", "AIRTABLE_KEY", "ada@example.com"],
    ]);
    expect(JSON.stringify(rows)).not.toContain("sk_live_123");
  });

  it("saves nothing when the form has a problem, and never echoes a value", async () => {
    const { put, submit } = await page();
    const bad = await submit("staging", { "value:STRIPE_KEY": "sk_live_1", env_file: "OPENAI_KEY=sk-abc\noops sk-leaked" });
    expect(bad.res.status).toBe(400);
    expect(bad.text).toContain("Line 2 of the pasted text isn&#39;t KEY=value. Nothing was saved.");
    expect(bad.text).not.toContain("sk-leaked");
    expect(bad.text).not.toContain("sk_live_1");

    const both = await submit("staging", { "value:STRIPE_KEY": "one", env_file: "STRIPE_KEY=two" });
    expect(both.res.status).toBe(400);
    expect(both.text).toContain("STRIPE_KEY has one value in its field and another in the pasted text.");

    expect((await submit("staging", {})).text).toContain("Enter at least one value.");
    expect((await submit("staging", { env_file: "DATABASE_URL=postgres://x\nOK_KEY=1" })).text).toContain("DATABASE_URL is set by the platform. Nothing was saved.");
    expect((await submit("staging", { new_name: "NODE_OPTIONS", new_value: "--require x" })).text).toContain(
      "NODE_OPTIONS changes how the app runs, so it can only be added under secrets: in app.yaml. Nothing was saved.",
    );
    expect((await submit("staging", { new_name: "NEW_KEY" })).text).toContain("Enter a value for NEW_KEY.");
    expect((await submit("staging", { new_value: "orphan" })).text).toContain("Enter a name for the new secret.");
    expect((await submit("staging", { remove: "STRIPE_KEY" })).text).toContain("STRIPE_KEY is required by app.yaml, so it can&#39;t be removed.");
    expect((await submit("staging", { "value:OPENAI_KEY": "x".repeat(4097) })).text).toContain("OPENAI_KEY is longer");
    expect(put).toEqual({});
  });

  it("keeps the values it could save when Parameter Store refuses one", async () => {
    const { t, b, put, submit } = await page();
    const write = t.platform.putAppSecret;
    t.platform.putAppSecret = async (name, value) => {
      if (name.endsWith("/STRIPE_KEY")) throw new Error("ThrottlingException");
      await write(name, value);
    };
    await submit("staging", { "value:EXAMPLE_API_KEY": "a", "value:STRIPE_KEY": "b", "value:OPENAI_KEY": "c" });
    expect(Object.keys(put)).toEqual(["/apps/loan-tracker/staging/EXAMPLE_API_KEY", "/apps/loan-tracker/staging/OPENAI_KEY"]);
    const after = await b.request("/apps/loan-tracker/secrets/staging");
    expect(after.text).toContain("Saved EXAMPLE_API_KEY and OPENAI_KEY for staging.");
    expect(after.text).toContain("Couldn&#39;t change STRIPE_KEY: try it again.");
    expect(jobsOf(t).at(-1)).toMatchObject({ kind: "deploy", env: "staging", status: "queued" });
  });

  it("leaves prod's first deploy to pick values up, and refuses changes during a teardown", async () => {
    const { t, b, put, submit } = await page();
    expect((await b.request("/apps/loan-tracker/secrets/prod")).text).toContain("its first deploy will use these values");
    const jobsBefore = jobsOf(t).length;
    await submit("prod", { "value:STRIPE_KEY": "sk_live_prod" });
    expect(put).toEqual({ "/apps/loan-tracker/prod/STRIPE_KEY": "sk_live_prod" });
    expect(jobsOf(t)).toHaveLength(jobsBefore);
    expect((await b.request("/apps/loan-tracker")).text).toContain("Prod hasn&#39;t been deployed yet, so its first deploy will use it.");

    t.deps.db.update(apps).set({ status: "destroying" }).where(eq(apps.name, "loan-tracker")).run();
    expect((await b.request("/apps/loan-tracker/secrets/staging")).text).toContain("loan-tracker is destroying, so its secrets can't be changed.");
    const refused = await submit("staging", { "value:STRIPE_KEY": "late" });
    expect(refused.res.status).toBe(409);
    expect(put).not.toHaveProperty("/apps/loan-tracker/staging/STRIPE_KEY");
    expect((await b.request("/apps/loan-tracker/secrets/qa")).res.status).toBe(404);
  });
  it("Save only keeps the changes for the next deploy, which Deploy starts", async () => {
    const { t, b, put, submit } = await page();
    const csrf = () => b.csrf("/apps/loan-tracker/secrets/staging");
    t.clock.advance(60_000);
    const before = jobsOf(t).length;
    await submit("staging", { "value:STRIPE_KEY": "sk_live_1", deploy: "0" });
    expect(put).toHaveProperty("/apps/loan-tracker/staging/STRIPE_KEY");
    expect(jobsOf(t)).toHaveLength(before);
    const pending = await b.request("/apps/loan-tracker/secrets/staging");
    expect(pending.text).toContain("Saved STRIPE_KEY for staging. Staging keeps what it has until its next deploy.");
    expect(pending.text).toContain("Not deployed yet");
    expect(pending.text).toContain("Deploy staging</button>");
    expect((await b.request("/apps/loan-tracker?tab=settings")).text).toContain("not deployed");

    const deploy = await b.request("/apps/loan-tracker/secrets/staging/deploy", { form: { _csrf: await csrf() } });
    expect(deploy.res.status).toBe(302);
    const job = jobsOf(t).at(-1)!;
    expect(job).toMatchObject({ kind: "deploy", env: "staging", status: "queued", requestedBy: "ada@example.com" });
    const deploying = await b.request("/apps/loan-tracker/secrets/staging");
    expect(deploying.text).toContain(`Deploying staging with the saved changes (job #${job.id}).`);
    expect(deploying.text).toContain(`Deploy job #${job.id}</a> is queued`);
    t.clock.advance(1000);
    await t.worker.tick();
    await finishRunning(t);
    expect((await b.request("/apps/loan-tracker/secrets/staging")).text).not.toContain("Not deployed yet");
  });

  it("removes a secret once a deploy has left it out, and Keep takes a removal back", async () => {
    const { t, b, submit } = await page();
    const csrf = () => b.csrf("/apps/loan-tracker/secrets/staging");
    const parameter = "/apps/loan-tracker/staging/SLACK_TOKEN";
    const row = () => t.deps.db.select().from(secrets).where(eq(secrets.key, "SLACK_TOKEN")).get();
    await submit("staging", { new_name: "SLACK_TOKEN", new_value: "xoxb-1", deploy: "1" });
    await t.worker.tick();
    await finishRunning(t);
    expect(t.platform.parameters.has(parameter)).toBe(true);

    // Marked but not deployed: Keep takes it back.
    t.clock.advance(1000);
    await submit("staging", { remove: "SLACK_TOKEN", deploy: "0" });
    let html = (await b.request("/apps/loan-tracker/secrets/staging")).text;
    expect(html).toContain("Marked SLACK_TOKEN for removal from staging. Staging keeps what it has until its next deploy.");
    expect(html).toContain("SLACK_TOKEN (to remove)");
    expect(html).toContain('formaction="/apps/loan-tracker/secrets/staging/keep" name="key" value="SLACK_TOKEN"');
    await b.request("/apps/loan-tracker/secrets/staging/keep", { form: { _csrf: await csrf(), key: "SLACK_TOKEN" } });
    html = (await b.request("/apps/loan-tracker/secrets/staging")).text;
    expect(html).toContain("Kept SLACK_TOKEN in staging.");
    expect(html).not.toContain("(to remove)");
    expect(row()!.removeRequestedAt).toBeNull();

    // Remove and deploy: the deploy leaves it out, and it's deleted once that succeeds.
    await submit("staging", { remove: "SLACK_TOKEN", deploy: "1" });
    await t.worker.tick();
    const job = running(t).at(-1)!;
    expect(t.runs.runs.get(job.runId!)!.input.env.SECRETS_REMOVED).toBe("SLACK_TOKEN");
    expect(row()!.removeJobId).toBe(job.id);
    const again = await submit("staging", { "value:SLACK_TOKEN": "again" });
    expect(again.res.status).toBe(409);
    expect(again.text).toContain(`Deploy job #${job.id} is removing SLACK_TOKEN from staging.`);
    await finishRunning(t);
    expect(t.platform.parameters.has(parameter)).toBe(false);
    expect(row()).toBeUndefined();
    expect((await b.request("/apps/loan-tracker/secrets/staging")).text).not.toContain("SLACK_TOKEN");
  });

  it("carries a removal over to the next deploy if one fails, and removes at once where nothing was deployed", async () => {
    const { t, b, submit } = await page();
    const parameter = "/apps/loan-tracker/staging/SLACK_TOKEN";
    const row = () => t.deps.db.select().from(secrets).where(eq(secrets.key, "SLACK_TOKEN")).get();
    await submit("staging", { new_name: "SLACK_TOKEN", new_value: "xoxb-1", deploy: "0" });
    await submit("staging", { remove: "SLACK_TOKEN" }); // Enter: the first button, Save and deploy
    await t.worker.tick();
    await finishRunning(t, "failed", () => true, { failStep: "terraform-phase2" });
    expect(row()).toMatchObject({ removeRequestedBy: "ada@example.com", removeJobId: null });
    expect(t.platform.parameters.has(parameter)).toBe(true);

    await b.request("/apps/loan-tracker/secrets/staging/deploy", { form: { _csrf: await b.csrf("/apps/loan-tracker/secrets/staging") } });
    await t.worker.tick();
    expect(t.runs.runs.get(running(t).at(-1)!.runId!)!.input.env.SECRETS_REMOVED).toBe("SLACK_TOKEN");
    await finishRunning(t);
    expect(t.platform.parameters.has(parameter)).toBe(false);

    await submit("prod", { new_name: "PROD_ONLY", new_value: "p" });
    expect(t.platform.parameters.has("/apps/loan-tracker/prod/PROD_ONLY")).toBe(true);
    await submit("prod", { remove: "PROD_ONLY" });
    expect(t.platform.parameters.has("/apps/loan-tracker/prod/PROD_ONLY")).toBe(false);
    expect((await b.request("/apps/loan-tracker/secrets/prod")).text).toContain("Removed PROD_ONLY from prod.");
  });
});
