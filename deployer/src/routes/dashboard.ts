// Dashboard pages (design 5.5 "Dashboard pages"). Every signed-in user can
// promote, roll back and confirm teardown; admins also manage accounts.
import { and, desc, eq, inArray } from "drizzle-orm";
import express, { type Request, type Response } from "express";
import { hashPassword, temporaryPassword } from "../auth/passwords.js";
import { iso, type Deps } from "../deps.js";
import { apps, jobs, pullRequests, releases, users, webhookDeliveries, type AppRow } from "../db/schema.js";
import { KEEP_DELIVERIES } from "../deliveries.js";
import { catchUpApp } from "../events.js";
import { ACTIVE, enqueue, getApp, getJob, getRelease, queueDeploy, supersedeQueued } from "../jobs.js";
import { isAppEnv, shortSha } from "../names.js";
import { secretStatuses } from "../secrets.js";
import { jobLog } from "./api.js";
import { requireAdmin, requireUser } from "./auth.js";

const param = (req: Request, name: string) => String(req.params[name] ?? "");

function notFound(res: Response, what: string): void {
  res.status(404).render("message", { title: "Not found", message: `${what} doesn't exist.` });
}

function flash(req: Request, message: string): void {
  req.session.flash = message;
}

/** Queue prod, then staging, then shared teardown (design 6, "Teardown"). */
function queueTeardown(deps: Deps, app: AppRow, by: string): void {
  const prod = enqueue(deps, { app: app.name, env: "prod", kind: "destroy", requestedBy: by });
  const staging = enqueue(deps, { app: app.name, env: "staging", kind: "destroy", requestedBy: by, afterJobId: prod.id });
  enqueue(deps, { app: app.name, env: "shared", kind: "destroy", requestedBy: by, afterJobId: staging.id });
}

export function dashboardRoutes(deps: Deps): express.Router {
  const router = express.Router();
  router.use(requireUser);

  router.get("/", (_req, res) => {
    const active = deps.db.select().from(jobs).where(inArray(jobs.status, ACTIVE)).orderBy(desc(jobs.id)).all();
    const lastDelivery = deps.db.select().from(webhookDeliveries).orderBy(desc(webhookDeliveries.id)).get();
    const rows = deps.db.select().from(apps).orderBy(apps.name).all();
    const list = rows.map((app) => {
      const lastDeploy = deps.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.app, app.name), inArray(jobs.kind, ["deploy", "destroy"])))
        .orderBy(desc(jobs.id))
        .get();
      return {
        app,
        staging: getRelease(deps, app.stagingReleaseId),
        prod: getRelease(deps, app.prodReleaseId),
        lastDeploy,
      };
    });
    res.render("index", { title: "Apps", list, active, lastDelivery, shortSha });
  });

  router.get("/deliveries", (req, res) => {
    const app = typeof req.query.app === "string" && req.query.app ? req.query.app : null;
    const outcome = typeof req.query.outcome === "string" && req.query.outcome ? req.query.outcome : null;
    const where = and(
      app ? eq(webhookDeliveries.app, app) : undefined,
      outcome ? eq(webhookDeliveries.outcome, outcome) : undefined,
    );
    const rows = deps.db.select().from(webhookDeliveries).where(where).orderBy(desc(webhookDeliveries.id)).limit(200).all();
    const appNames = deps.db.select({ name: apps.name }).from(apps).orderBy(apps.name).all().map((a) => a.name);
    res.render("deliveries", { title: "Webhooks", deliveries: rows, appNames, filter: { app, outcome }, keep: KEEP_DELIVERIES });
  });

  router.get("/apps/:name", async (req, res) => {
    const app = getApp(deps, param(req, "name"));
    if (!app) return notFound(res, "That app");
    const releaseRows = deps.db
      .select()
      .from(releases)
      .where(eq(releases.app, app.name))
      .orderBy(desc(releases.id))
      .limit(30)
      .all();
    const jobRows = deps.db.select().from(jobs).where(eq(jobs.app, app.name)).orderBy(desc(jobs.id)).limit(50).all();
    let secretRows: Awaited<ReturnType<typeof secretStatuses>> = [];
    let secretError: string | null = null;
    if (app.status !== "destroyed") {
      try {
        secretRows = await secretStatuses(deps, app);
      } catch (err) {
        secretError = `Couldn't read app.yaml from GitHub: ${(err as Error).message}`;
      }
    }
    const pulls = deps.db
      .select()
      .from(pullRequests)
      .where(eq(pullRequests.app, app.name))
      .orderBy(desc(pullRequests.updatedAt))
      .limit(20)
      .all()
      .map((pull) => ({ pull, check: getJob(deps, pull.checkJobId) }));
    const deliveries = deps.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.app, app.name))
      .orderBy(desc(webhookDeliveries.id))
      .limit(15)
      .all();
    const staging = getRelease(deps, app.stagingReleaseId);
    const activeJobs = jobRows.filter((j) => ACTIVE.includes(j.status));
    res.render("app", {
      title: app.name,
      app,
      staging,
      prod: getRelease(deps, app.prodReleaseId),
      releases: releaseRows,
      jobs: jobRows,
      pulls,
      deliveries,
      secrets: secretRows,
      secretError,
      canPromote: !!staging && staging.status === "ready" && ["active", "failed"].includes(app.status),
      canRetryTeardown: app.status === "destroying" && activeJobs.length === 0,
      shortSha,
    });
  });

  router.get("/apps/:name/jobs/:id", async (req, res) => {
    const app = getApp(deps, param(req, "name"));
    const job = getJob(deps, Number(param(req, "id")));
    if (!app || !job || job.app !== app.name) return notFound(res, "That job");
    let log: string[];
    try {
      log = await jobLog(deps, job, 500);
    } catch (err) {
      log = [`(couldn't read the log: ${(err as Error).message})`];
    }
    res.render("job", {
      title: `Job #${job.id}`,
      app,
      job,
      release: getRelease(deps, job.releaseId),
      log,
      shortSha,
      refresh: ACTIVE.includes(job.status) ? 10 : null, // follow the log while it runs
    });
  });

  router.post("/apps/:name/promote", (req, res) => {
    const app = getApp(deps, param(req, "name"));
    if (!app) return notFound(res, "That app");
    const release = getRelease(deps, app.stagingReleaseId);
    if (!release || release.status !== "ready" || !["active", "failed"].includes(app.status)) {
      flash(req, "Nothing on staging to promote.");
      return res.redirect(`/apps/${app.name}`);
    }
    const job = queueDeploy(deps, app.name, "prod", release, req.user!.email);
    deps.log("promote", { app: app.name, release: release.id, by: req.user!.email, job: job.id });
    flash(req, `Promoting ${shortSha(release.commitSha)} to prod (job #${job.id}).`);
    res.redirect(`/apps/${app.name}`);
  });

  // Webhooks GitHub never retried leave PRs without checks and main unbuilt;
  // this does what the startup catch-up does, for one app.
  router.post("/apps/:name/sync", async (req, res) => {
    const app = getApp(deps, param(req, "name"));
    if (!app) return notFound(res, "That app");
    if (!["active", "failed", "destroy_requested"].includes(app.status)) {
      flash(req, `${app.name} is ${app.status.replace(/_/g, " ")}; there's nothing to sync.`);
      return res.redirect(`/apps/${app.name}`);
    }
    try {
      const done = await catchUpApp(deps, app);
      deps.log("synced with GitHub", { app: app.name, by: req.user!.email, done });
      flash(req, done.length ? `Synced with GitHub. ${done.join(". ")}.` : "Synced with GitHub: nothing was missed.");
    } catch (err) {
      flash(req, `Couldn't sync with GitHub: ${(err as Error).message}`);
    }
    res.redirect(`/apps/${app.name}`);
  });

  router.post("/apps/:name/rollback", (req, res) => {
    const app = getApp(deps, param(req, "name"));
    if (!app) return notFound(res, "That app");
    const env = String(req.body.env ?? "");
    const release = getRelease(deps, Number(req.body.release_id));
    if (!isAppEnv(env) || !release || release.app !== app.name || release.status !== "ready") {
      flash(req, "Pick an environment and a release that built successfully.");
      return res.redirect(`/apps/${app.name}`);
    }
    if (!["active", "failed"].includes(app.status)) {
      flash(req, `${app.name} is ${app.status}; it can't be deployed.`);
      return res.redirect(`/apps/${app.name}`);
    }
    const job = queueDeploy(deps, app.name, env, release, req.user!.email);
    deps.log("rollback", { app: app.name, env, release: release.id, by: req.user!.email, job: job.id });
    flash(req, `Deploying ${shortSha(release.commitSha)} to ${env} (job #${job.id}).`);
    res.redirect(`/apps/${app.name}`);
  });

  router.post("/apps/:name/destroy", (req, res) => {
    const app = getApp(deps, param(req, "name"));
    if (!app) return notFound(res, "That app");
    if (app.status !== "destroy_requested") {
      flash(req, "Teardown starts with /destroy-app from the app's owner.");
      return res.redirect(`/apps/${app.name}`);
    }
    if (String(req.body.confirm ?? "").trim() !== app.name) {
      flash(req, `Type ${app.name} exactly to confirm the teardown.`);
      return res.redirect(`/apps/${app.name}`);
    }
    deps.db.update(apps).set({ status: "destroying", error: null }).where(eq(apps.name, app.name)).run();
    supersedeQueued(deps, app.name, "The app is being torn down");
    queueTeardown(deps, app, req.user!.email);
    deps.log("teardown confirmed", { app: app.name, by: req.user!.email });
    flash(req, `Tearing down ${app.name}: prod, then staging, then shared.`);
    res.redirect(`/apps/${app.name}`);
  });

  router.post("/apps/:name/destroy/cancel", (req, res) => {
    const app = getApp(deps, param(req, "name"));
    if (!app) return notFound(res, "That app");
    if (app.status === "destroy_requested") {
      deps.db
        .update(apps)
        .set({ status: app.stagingReleaseId ? "active" : "failed", destroyRequestedBy: null, destroyRequestedAt: null })
        .where(eq(apps.name, app.name))
        .run();
      deps.log("teardown request cancelled", { app: app.name, by: req.user!.email });
      flash(req, "Teardown request cancelled.");
    }
    res.redirect(`/apps/${app.name}`);
  });

  router.post("/apps/:name/destroy/retry", (req, res) => {
    const app = getApp(deps, param(req, "name"));
    if (!app) return notFound(res, "That app");
    const active = deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.app, app.name), inArray(jobs.status, ACTIVE)))
      .get();
    if (app.status === "destroying" && !active) {
      queueTeardown(deps, app, req.user!.email);
      flash(req, "Teardown queued again.");
    }
    res.redirect(`/apps/${app.name}`);
  });

  // --- Users (admins) ---------------------------------------------------------

  router.get("/users", requireAdmin, (_req, res) => {
    const rows = deps.db.select().from(users).orderBy(users.email).all();
    res.render("users", { title: "Users", users: rows, created: null, error: null });
  });

  router.post("/users", requireAdmin, async (req, res) => {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const name = String(req.body.name ?? "").trim();
    const isAdmin = req.body.is_admin === "on";
    const rows = () => deps.db.select().from(users).orderBy(users.email).all();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) {
      return res.status(400).render("users", { title: "Users", users: rows(), created: null, error: "Enter a name and a valid email." });
    }
    if (deps.db.select().from(users).where(eq(users.email, email)).get()) {
      return res.status(409).render("users", { title: "Users", users: rows(), created: null, error: `${email} already has an account.` });
    }
    const password = temporaryPassword();
    deps.db
      .insert(users)
      .values({
        email,
        name,
        isAdmin,
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
        createdBy: req.user!.id,
        createdAt: iso(deps),
      })
      .run();
    deps.log("user created", { user: email, admin: isAdmin, by: req.user!.email });
    res.render("users", { title: "Users", users: rows(), created: { email, password }, error: null });
  });

  router.post("/users/:id/reset", requireAdmin, async (req, res) => {
    const user = deps.db.select().from(users).where(eq(users.id, Number(param(req, "id")))).get();
    if (!user) return notFound(res, "That user");
    const password = temporaryPassword();
    deps.db
      .update(users)
      .set({ passwordHash: await hashPassword(password), mustChangePassword: true })
      .where(eq(users.id, user.id))
      .run();
    deps.log("password reset", { user: user.email, by: req.user!.email });
    const rows = deps.db.select().from(users).orderBy(users.email).all();
    res.render("users", { title: "Users", users: rows, created: { email: user.email, password }, error: null });
  });

  for (const action of ["disable", "enable"] as const) {
    router.post(`/users/:id/${action}`, requireAdmin, (req, res) => {
      const id = Number(param(req, "id"));
      if (id === req.user!.id) {
        flash(req, "You can't disable your own account.");
        return res.redirect("/users");
      }
      const disabled = action === "disable";
      deps.db.update(users).set({ disabled }).where(eq(users.id, id)).run();
      deps.log(disabled ? "user disabled" : "user enabled", { user: id, by: req.user!.email });
      res.redirect("/users");
    });
  }

  return router;
}
