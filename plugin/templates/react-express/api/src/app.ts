import express, { type ErrorRequestHandler } from "express";
import { sql } from "drizzle-orm";
import { db, forgetCredentials } from "./db/client.js";
import { notesRouter } from "./routes/notes.js";

export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", true); // CloudFront -> load balancer -> here
app.use(express.json());

// There's no sign-in: every route is public. Add authentication before the
// app stores anything that shouldn't be.

// The platform's health check. 200 only when the database is reachable; also
// reports the running release and applied migrations.
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

app.use("/api", notesRouter);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "not found" });
});

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err?.code === "28P01") forgetCredentials(); // password rotated
  console.error(err);
  res.status(500).json({ error: "internal error" });
};
app.use(onError);
