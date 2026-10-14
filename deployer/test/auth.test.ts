import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginAuth, CACHE_MS } from "../src/auth/plugin-auth.js";
import { EMAIL_LIMIT, IP_LIMIT } from "../src/auth/ratelimit.js";
import { addUser, Browser, serve, setup } from "./helpers.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("plugin API auth", () => {
  it("rejects bad tokens and non-members, and caches members for 10 minutes", async () => {
    const t = setup();
    const auth = new PluginAuth(t.deps);
    const login = vi.spyOn(t.github, "loginForToken");
    const member = vi.spyOn(t.github, "isOrgMember");

    expect(await auth.check("ghp_bogus")).toEqual({ status: 401, error: "invalid GitHub token" });
    expect(await auth.check("fake:outsider9")).toEqual({ status: 403, error: "outsider9 is not a member of acme" });
    expect(await auth.check("fake:alice")).toEqual({ login: "alice" });
    expect(await auth.check("fake:alice")).toEqual({ login: "alice" });
    expect(login).toHaveBeenCalledTimes(3);
    expect(member).toHaveBeenCalledTimes(2);

    t.clock.advance(CACHE_MS + 1);
    await auth.check("fake:alice");
    expect(member).toHaveBeenCalledTimes(3);
  });

  it("needs a bearer token on every /api route", async () => {
    const t = setup();
    const s = await serve(t);
    close = s.close;
    const res = await fetch(`${s.url}/api/whoami`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("gh auth token") });
    const ok = await fetch(`${s.url}/api/whoami`, { headers: { authorization: "Bearer fake:alice" } });
    expect(await ok.json()).toEqual({ login: "alice" });
  });
});

describe("dashboard sign-in", () => {
  it("signs in, forces a password change, and sets a hardened session cookie", async () => {
    const t = setup({ production: true });
    await addUser(t, "ada@example.com", "temporary-pass", { isAdmin: true, mustChangePassword: true });
    const s = await serve(t);
    close = s.close;
    // CloudFront tells the origin the viewer used HTTPS.
    const b = new Browser(s.url, { "cloudfront-forwarded-proto": "https", "cloudfront-viewer-address": "203.0.113.9:5555" });
    const { res } = await b.login("ada@example.com", "temporary-pass");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/password");
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("slipway.sid="))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).toMatch(/Expires=/);

    expect((await b.request("/")).res.headers.get("location")).toBe("/password");
    const _csrf = await b.csrf("/password");
    const weak = await b.request("/password", { form: { _csrf, current: "temporary-pass", password: "short", confirm: "short" } });
    expect(weak.text).toContain("at least 12 characters");
    await b.request("/password", {
      form: { _csrf, current: "temporary-pass", password: "a much better one", confirm: "a much better one" },
    });
    expect((await b.request("/")).res.status).toBe(200);
  });

  it("refuses forms without the session's CSRF token", async () => {
    const t = setup();
    await addUser(t, "ada@example.com", "a-good-password");
    const s = await serve(t);
    close = s.close;
    const b = new Browser(s.url);
    expect((await b.request("/login", { form: { email: "ada@example.com", password: "a-good-password" } })).res.status).toBe(403);
    await b.login("ada@example.com", "a-good-password");
    expect((await b.request("/users", { form: { _csrf: "forged", email: "x@y.z", name: "X" } })).res.status).toBe(403);
    expect((await b.request("/apps/x/promote", { form: {} })).res.status).toBe(403);
  });

  it(`locks an email after ${EMAIL_LIMIT} failures in 15 minutes`, async () => {
    const t = setup();
    await addUser(t, "ada@example.com", "a-good-password");
    const s = await serve(t);
    close = s.close;
    const b = new Browser(s.url, { "cloudfront-viewer-address": "198.51.100.1:1000" });
    for (let i = 0; i < EMAIL_LIMIT; i++) expect((await b.login("ada@example.com", "wrong")).res.status).toBe(401);
    // Even the right password is refused while locked, from any IP.
    const other = new Browser(s.url, { "cloudfront-viewer-address": "198.51.100.2:1000" });
    expect((await other.login("ADA@example.com", "a-good-password")).res.status).toBe(429);
    t.clock.advance(15 * 60_000 + 1);
    expect((await other.login("ada@example.com", "a-good-password")).res.status).toBe(302);
  });

  it(`locks an IP after ${IP_LIMIT} failures, whatever the email`, async () => {
    const t = setup();
    await addUser(t, "ada@example.com", "a-good-password");
    const s = await serve(t);
    close = s.close;
    const b = new Browser(s.url, { "cloudfront-viewer-address": "198.51.100.7:1000" });
    for (let i = 0; i < IP_LIMIT; i++) await b.login(`nobody${i}@example.com`, "wrong");
    expect((await b.login("ada@example.com", "a-good-password")).res.status).toBe(429);
    const elsewhere = new Browser(s.url, { "cloudfront-viewer-address": "198.51.100.8:1000" });
    expect((await elsewhere.login("ada@example.com", "a-good-password")).res.status).toBe(302);
  });

  it("keeps disabled users out and admin pages to admins", async () => {
    const t = setup();
    await addUser(t, "ada@example.com", "a-good-password", { isAdmin: true });
    await addUser(t, "bob@example.com", "bobs-password-1");
    const s = await serve(t);
    close = s.close;
    const bob = new Browser(s.url);
    await bob.login("bob@example.com", "bobs-password-1");
    expect((await bob.request("/users")).res.status).toBe(403);

    const ada = new Browser(s.url);
    await ada.login("ada@example.com", "a-good-password");
    const created = await ada.request("/users", { form: { _csrf: await ada.csrf("/users"), email: "cy@example.com", name: "Cy" } });
    expect(created.text).toMatch(/secret-once"><code>[\w-]{16}</);
    await ada.request("/users/2/disable", { form: { _csrf: await ada.csrf("/users") } });
    expect((await bob.request("/")).res.headers.get("location")).toMatch(/^\/login/);
  });
});
