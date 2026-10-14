import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "./app.js";

// No database in unit tests: the db module is replaced by a stub whose
// methods each test controls.
const db = vi.hoisted(() => {
  const returning = vi.fn();
  const values = vi.fn(() => ({ returning }));
  return {
    execute: vi.fn(),
    query: { notes: { findMany: vi.fn() } },
    insert: vi.fn(() => ({ values })),
    values,
    returning,
  };
});

vi.mock("./db/client.js", () => ({
  db,
  pool: {},
  forgetCredentials: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/health", () => {
  it("reports the release and applied migrations when the database is up", async () => {
    vi.stubEnv("RELEASE", "a1b2c3d");
    db.execute.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ n: 2 }] });

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, release: "a1b2c3d", migrations: 2 });
  });

  it("returns 503 when the database is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.execute.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const res = await request(app).get("/api/health");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ ok: false });
  });
});

describe("/api/notes", () => {
  it("lists notes, newest first", async () => {
    const rows = [{ id: 2, body: "Second", createdAt: "2026-01-02T00:00:00.000Z" }];
    db.query.notes.findMany.mockResolvedValueOnce(rows);

    const res = await request(app).get("/api/notes");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ notes: rows });
  });

  it("adds a note, trimmed", async () => {
    const note = { id: 3, body: "Hello", createdAt: "2026-01-03T00:00:00.000Z" };
    db.returning.mockResolvedValueOnce([note]);

    const res = await request(app).post("/api/notes").send({ body: "  Hello " });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ note });
    expect(db.values).toHaveBeenCalledWith({ body: "Hello" });
  });

  it("rejects an empty or overlong note without touching the database", async () => {
    for (const body of ["", "   ", "x".repeat(501), 42]) {
      const res = await request(app).post("/api/notes").send({ body });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/1 to 500 characters/);
    }
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("returns JSON 500 when the database fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.query.notes.findMany.mockRejectedValueOnce(new Error("boom"));

    const res = await request(app).get("/api/notes");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "internal error" });
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
