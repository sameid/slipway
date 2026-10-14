import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "./app.js";

// No database in unit tests: the db module is replaced by a stub whose
// execute() each test controls. Clerk gets well-formed but fake keys; requests
// without a valid session token never reach Clerk's servers.
const { execute } = vi.hoisted(() => {
  process.env.CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from("example.clerk.accounts.dev$").toString("base64")}`;
  process.env.CLERK_SECRET_KEY = "sk_test_unit_tests";
  return { execute: vi.fn() };
});

vi.mock("./db/client.js", () => ({
  db: { execute },
  pool: {},
  forgetCredentials: vi.fn(),
}));

afterEach(() => {
  execute.mockReset();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/health", () => {
  it("reports the release and applied migrations when the database is up", async () => {
    vi.stubEnv("RELEASE", "a1b2c3d");
    execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ n: 2 }] });

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, release: "a1b2c3d", migrations: 2 });
  });

  it("returns 503 when the database is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    execute.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false });
  });
});

describe("GET /api/me", () => {
  it("returns 401 JSON without a session token", async () => {
    const res = await request(app).get("/api/me");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthenticated" });
  });

  it("returns 401 JSON with an invalid session token", async () => {
    const res = await request(app).get("/api/me").set("Authorization", "Bearer not-a-real-token");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthenticated" });
  });
});

describe("unknown /api routes", () => {
  it("return JSON 404, not the frontend's index.html", async () => {
    const res = await request(app).get("/api/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.type).toBe("application/json");
    expect(res.body).toEqual({ error: "not found" });
  });
});
