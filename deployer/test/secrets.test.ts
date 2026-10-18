import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { apps, secretLinks, secrets } from "../src/db/schema.js";
import { defaultAppYaml } from "../src/fake.js";
import { getApp, getRelease, queueDeploy } from "../src/jobs.js";
import { createLink, LINK_TTL_MS, parseEnvFile, setSecret } from "../src/secrets.js";
import { addUser, Browser, jobsOf, liveApp, serve, setup, type TestEnv } from "./helpers.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const tokenOf = (url: string) => url.split("/").at(-1)!;

describe("secret links", () => {
  it("only hands out links for names declared in app.yaml on main", async () => {
    const t = setup();
    await liveApp(t);
    const app = getApp(t.deps, "loan-tracker")!;
    await expect(createLink(t.deps, app, "staging", "NOT_DECLARED", "alice")).rejects.toMatchObject({ status: 400 });
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
    const _csrf = await b.csrf(path);
    const saved = await b.request(path, { form: { _csrf, value: "sk_live_abc" } });
    expect(saved.text).toContain("Redeploying staging");
    expect(saved.text).not.toContain("sk_live_abc");
    expect((await b.request(path)).res.status).toBe(410);

    const after = await api(`/api/apps/loan-tracker/secret-links/${body.linkId}`);
    expect(after.body).toMatchObject({ status: "used", redeploy: { env: "staging", status: "queued" } });
    const list = await api("/api/apps/loan-tracker/secrets");
    expect(list.body).toEqual({
      secrets: [
        {
          key: "EXAMPLE_API_KEY",
          staging: { set: true, lastSetBy: "alice", lastSetAt: expect.any(String) },
          prod: { set: false, lastSetBy: null, lastSetAt: null },
        },
      ],
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
    t.platform.putAppSecret = async (name, value) => {
      put[name] = value;
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

    const res = await submit("staging", {
      "value:EXAMPLE_API_KEY": "example-value",
      "value:OPENAI_KEY": "",
      env_file: 'export STRIPE_KEY="sk_live_123"\n# not this one\nOPENAI_KEY=\nDATABASE_URL=postgres://x\n',
    });
    expect(res.res.status).toBe(302);
    expect(res.res.headers.get("location")).toBe("/apps/loan-tracker?tab=settings");
    expect(put).toEqual({
      "/apps/loan-tracker/staging/EXAMPLE_API_KEY": "example-value",
      "/apps/loan-tracker/staging/STRIPE_KEY": "sk_live_123",
    });
    const added = jobsOf(t).slice(jobsBefore);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: "deploy", env: "staging", requestedBy: "ada@example.com" });

    const after = await b.request("/apps/loan-tracker");
    expect(after.text).toContain(`Saved EXAMPLE_API_KEY and STRIPE_KEY for staging. Redeploying staging so the app picks them up (job #${added[0]!.id}).`);
    expect(after.text).toContain("Ignored DATABASE_URL: not declared in app.yaml on main.");
    expect(after.text).not.toContain("sk_live_123");
    const rows = t.deps.db.select().from(secrets).all();
    expect(rows.map((r) => [r.env, r.key, r.lastSetBy])).toEqual([
      ["staging", "EXAMPLE_API_KEY", "ada@example.com"],
      ["staging", "STRIPE_KEY", "ada@example.com"],
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
    expect((await submit("staging", { env_file: "NOPE=1" })).text).toContain("None of those names are declared");
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
    const after = await b.request("/apps/loan-tracker");
    expect(after.text).toContain("Saved EXAMPLE_API_KEY and OPENAI_KEY for staging.");
    expect(after.text).toContain("Couldn&#39;t save STRIPE_KEY: try it again.");
    expect(jobsOf(t).at(-1)).toMatchObject({ kind: "deploy", env: "staging", status: "queued" });
  });

  it("leaves prod's first deploy to pick values up, and refuses changes during a teardown", async () => {
    const { t, b, put, submit } = await page();
    expect((await b.request("/apps/loan-tracker/secrets/prod")).text).toContain("its first deploy will use these values");
    const jobsBefore = jobsOf(t).length;
    await submit("prod", { "value:STRIPE_KEY": "sk_live_prod" });
    expect(put).toEqual({ "/apps/loan-tracker/prod/STRIPE_KEY": "sk_live_prod" });
    expect(jobsOf(t)).toHaveLength(jobsBefore);
    expect((await b.request("/apps/loan-tracker")).text).toContain("prod hasn&#39;t been deployed yet, so its first deploy will use it.");

    t.deps.db.update(apps).set({ status: "destroying" }).where(eq(apps.name, "loan-tracker")).run();
    expect((await b.request("/apps/loan-tracker/secrets/staging")).text).toContain("loan-tracker is destroying, so its secrets can't be changed.");
    const refused = await submit("staging", { "value:STRIPE_KEY": "late" });
    expect(refused.res.status).toBe(409);
    expect(put).not.toHaveProperty("/apps/loan-tracker/staging/STRIPE_KEY");
    expect((await b.request("/apps/loan-tracker/secrets/qa")).res.status).toBe(404);
  });
});
