import { afterEach, describe, expect, it } from "vitest";
import { secretLinks, secrets } from "../src/db/schema.js";
import { getApp, getRelease, queueDeploy } from "../src/jobs.js";
import { createLink, LINK_TTL_MS, setSecret } from "../src/secrets.js";
import { Browser, jobsOf, liveApp, serve, setup } from "./helpers.js";

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
