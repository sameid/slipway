// The Express app: GitHub webhooks, the plugin API, the one-time secret form and
// the dashboard. server.ts wires in real clients; tests and fake mode pass fakes.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import { csrf } from "./auth/csrf.js";
import { SqliteSessionStore } from "./auth/session-store.js";
import type { Deps } from "./deps.js";
import { settings } from "./db/schema.js";
import { apiRoutes } from "./routes/api.js";
import { authRoutes, loadUser } from "./routes/auth.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { secretRoutes } from "./routes/secrets.js";
import { webhookRoutes } from "./routes/webhooks.js";

// views/ sits at the package root, one level above both src/ and dist/.
const viewsDir = fileURLToPath(new URL("../views", import.meta.url));

export const SESSION_TTL_MS = 12 * 3600_000;

/** /static URLs carry a hash of the file, so a release's CSS isn't hidden by a cached copy. */
function assetUrl(file: string): string {
  let version = "dev"; // views/static/app.css only exists after `npm run build:css`
  try {
    version = createHash("sha256").update(readFileSync(`${viewsDir}/static/${file}`)).digest("hex").slice(0, 12);
  } catch {}
  return `/static/${file}?v=${version}`;
}

/** "5 min ago", for times the dashboard also shows in full. */
export function ago(t: string | null, now = Date.now()): string {
  if (!t) return "";
  const s = Math.max(0, Math.round((now - Date.parse(t)) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}

/** "3m 05s", how long a job has been running or took. views/static/elapsed.js formats the same way. */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
}

/** The HeroUI colour a status chip gets. */
export function tone(status: string): "success" | "danger" | "warning" | "accent" | "default" {
  if (["succeeded", "active", "ready", "merged", "handled"].includes(status)) return "success";
  if (["failed", "check_failed", "rejected"].includes(status)) return "danger";
  if (["blocked", "destroy_requested", "destroying"].includes(status)) return "warning";
  if (["running", "checking", "building", "registering"].includes(status)) return "accent";
  return "default"; // queued, superseded, ignored, closed, destroyed
}

/** A random session-signing secret, generated once and kept in SQLite with the rest of the deployer's state. */
function sessionSecret(deps: Deps): string {
  const row = deps.db.select().from(settings).where(eq(settings.key, "session_secret")).get();
  if (row) return row.value;
  const value = randomBytes(32).toString("hex");
  deps.db.insert(settings).values({ key: "session_secret", value }).onConflictDoNothing().run();
  return deps.db.select().from(settings).where(eq(settings.key, "session_secret")).get()!.value;
}

export function createApp(deps: Deps, extraRoutes?: (app: express.Express) => void): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true); // only CloudFront can reach the instance
  app.set("views", viewsDir);
  app.set("view engine", "ejs");
  app.locals.owner = deps.config.owner;
  app.locals.fake = deps.config.fake;
  app.locals.fmt = (t: string | null) => (t ? `${t.replace("T", " ").slice(0, 16)} UTC` : "");
  app.locals.ago = (t: string | null) => ago(t, deps.now().getTime());
  app.locals.tone = tone;
  app.locals.jobName = (j: { kind: string; env: string }) => (j.kind === j.env ? j.kind : `${j.kind} ${j.env}`);
  app.locals.duration = duration;
  // Seconds from a job's start to its finish, or to now while it runs; null before it starts.
  app.locals.jobSeconds = (j: { startedAt: string | null; finishedAt: string | null }) =>
    j.startedAt ? ((j.finishedAt ? Date.parse(j.finishedAt) : deps.now().getTime()) - Date.parse(j.startedAt)) / 1000 : null;
  app.locals.assets = { css: assetUrl("app.css"), themeJs: assetUrl("theme.js"), elapsedJs: assetUrl("elapsed.js") };

  app.use((req, res, next) => {
    // CloudFront talks to the origin over HTTP inside the VPC and says what the viewer used.
    const proto = req.get("cloudfront-forwarded-proto");
    if (proto) req.headers["x-forwarded-proto"] = proto;
    res.locals.path = req.path; // for the nav's current page
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer", // secret links carry their token in the URL
      "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
      "Cache-Control": "no-store",
    });
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.type("text/plain").send("ok\n");
  });
  app.use("/webhooks", webhookRoutes(deps));
  app.use("/api", apiRoutes(deps));
  app.use("/static", express.static(`${viewsDir}/static`, { maxAge: deps.config.production ? "1h" : 0 }));
  extraRoutes?.(app);

  // The secrets page can carry many values of up to 4 KB each, or a pasted .env file.
  app.use("/apps/:name/secrets", express.urlencoded({ extended: false, limit: "256kb" }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));
  app.use(
    session({
      name: "slipway.sid",
      secret: sessionSecret(deps),
      store: new SqliteSessionStore(deps.db),
      resave: false,
      saveUninitialized: false,
      proxy: true,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: deps.config.production ? true : "auto",
        maxAge: SESSION_TTL_MS,
      },
    }),
  );
  app.use(loadUser(deps));
  app.use(csrf);
  app.use(authRoutes(deps));
  app.use("/secrets", secretRoutes(deps));
  app.use(dashboardRoutes(deps));

  app.use((_req, res) => {
    res.status(404).render("message", { title: "Not found", message: "There's nothing here." });
  });
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    deps.log("request failed", { path: req.path, error: err instanceof Error ? err.stack : String(err) });
    if (req.path.startsWith("/api/")) {
      res.status(500).json({ error: "internal error" });
      return;
    }
    res.status(500).render("message", { title: "Something went wrong", message: "The error has been logged." });
  });
  return app;
}
