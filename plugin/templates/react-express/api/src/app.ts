import express, { type ErrorRequestHandler } from "express";
import { clerkMiddleware } from "@clerk/express";
import { sql } from "drizzle-orm";
import { db, forgetCredentials } from "./db/client.js";
import { me } from "./routes/me.js";

export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true); // CloudFront -> load balancer -> here
app.use(express.json());

// Public, and the platform's health check. 200 only when the database is
// reachable; also reports the running release and applied migrations.
app.get("/api/health", async (_req, res) => {
  try {
    await db.execute(sql`select 1`);
  } catch (err) {
    console.error("health: database unreachable", err);
    res.status(503).json({ ok: false, error: "database unreachable" });
    return;
  }
  const migrations = await db
    .execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)
    .then((r) => r.rows[0].n)
    .catch(() => 0);
  res.json({ ok: true, release: process.env.RELEASE ?? "dev", migrations });
});

// Verifies the session token (Authorization: Bearer ...) locally against
// Clerk's public keys. Reads CLERK_SECRET_KEY and CLERK_PUBLISHABLE_KEY.
app.use(clerkMiddleware());

// Every route below uses requireUser (see auth.ts).
app.use("/api", me);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "not found" });
});

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err?.code === "28P01") forgetCredentials(); // password rotated
  console.error(err);
  res.status(500).json({ error: "internal error" });
};
app.use(onError);
