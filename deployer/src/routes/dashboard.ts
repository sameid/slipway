// Dashboard pages (design 5.5 "Dashboard pages"). Every signed-in user can
// promote, roll back and confirm teardown; admins also manage accounts.
import { and, count, desc, eq, inArray, notInArray, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import express, { type Request, type Response } from "express";
import { hashPassword, temporaryPassword } from "../auth/passwords.js";
import { iso, type Deps } from "../deps.js";
import { apps, jobs, pullRequests, releases, users, webhookDeliveries, type AppRow } from "../db/schema.js";
import { KEEP_DELIVERIES } from "../deliveries.js";
import { catchUpApp } from "../events.js";
import { ACTIVE, enqueue, getApp, getJob, getRelease, queueDeploy, supersedeQueued } from "../jobs.js";
import { ApiError } from "../errors.js";
import { isAppEnv, shortSha, type AppEnv } from "../names.js";
import { canSetSecrets, parseEnvFile, secretStatuses, setSecrets, type SetSecretsResult } from "../secrets.js";
import { jobLog } from "./api.js";
import { requireAdmin, requireUser } from "./auth.js";

const param = (req: Request, name: string) => String(req.params[name] ?? "");

/** "A", "A and B", "A, B and C". */
const listing = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

function notFound(res: Response, what: string): void {
  res.status(404).render("message", { title: "Not found", message: `${what} doesn't exist.` });
}

function flash(req: Request, message: string): void {
  req.session.flash = message;
}

// The app page's tabs, ?tab=<key>; Jobs is the default.
const TABS = ["jobs", "releases", "code", "settings"] as const;
type Tab = (typeof TABS)[number];
const appTab = (value: unknown): Tab => TABS.find((t) => t === value) ?? "jobs";
const appUrl = (name: string, tab: Tab = "jobs") => (tab === "jobs" ? `/apps/${name}` : `/apps/${name}?tab=${tab}`);

// Long lists show the newest PAGE rows; each "Load more" shows PAGE more, up to MAX_ROWS.
const PAGE = 25;
const MAX_ROWS = 1000;
const ROLLBACK_CHOICES = 100;

/** How many rows a list shows: ?<list>=n from its "Load more" link, or PAGE. */
function listLimit(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n > PAGE ? Math.min(n, MAX_ROWS) : PAGE;
}

/** A list's rows, its length in the database, and the "Load more" link while there's more to show. */
function page<T>(rows: T[], total: number, limit: number, next: (last: T) => string) {
  const last = rows.at(-1);
  return { rows, total, more: last && total > rows.length && limit < MAX_ROWS ? next(last) : null };
}

function rowCount(deps: Deps, table: SQLiteTable, where: SQL | undefined): number {
  return deps.db.select({ n: count() }).from(table).where(where).get()?.n ?? 0;
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
    const tab = appTab(req.query.tab);
    const ofApp = (column: SQLiteColumn) => eq(column, app.name);
    const activeJobs = rowCount(deps, jobs, and(ofApp(jobs.app), inArray(jobs.status, ACTIVE)));
    const openPulls = rowCount(deps, pullRequests, and(ofApp(pullRequests.app), notInArray(pullRequests.status, ["merged", "closed"])));
    const staging = getRelease(deps, app.stagingReleaseId);
    const view: Record<string, unknown> = {
      title: app.name,
      app,
      tab,
      tabs: [
        { key: "jobs", label: "Jobs", count: activeJobs, countTitle: `${activeJobs} queued or running` },
        { key: "releases", label: "Releases" },
        { key: "code", label: "Code", count: openPulls, countTitle: `${openPulls} open pull request${openPulls === 1 ? "" : "s"}` },
        { key: "settings", label: "Settings", alert: app.status === "destroy_requested" ? "A teardown is waiting to be confirmed" : null },
      ],
      staging,
      prod: getRelease(deps, app.prodReleaseId),
      canPromote: !!staging && staging.status === "ready" && ["active", "failed"].includes(app.status),
      appUrl,
      shortSha,
    };
    // A "Load more" link: this tab with a longer list, scrolled to the list's last row so far.
    const url = (list: string, limit: number, anchor: string) =>
      `/apps/${app.name}?${new URLSearchParams({ tab, [list]: String(limit + PAGE) })}#${anchor}`;

    if (tab === "jobs") {
      const limit = listLimit(req.query.jobs);
      const rows = deps.db.select().from(jobs).where(ofApp(jobs.app)).orderBy(desc(jobs.id)).limit(limit).all();
      view.jobs = page(rows, rowCount(deps, jobs, ofApp(jobs.app)), limit, (last) => url("jobs", limit, `job-${last.id}`));
    } else if (tab === "releases") {
      const limit = listLimit(req.query.releases);
      const rows = deps.db.select().from(releases).where(ofApp(releases.app)).orderBy(desc(releases.id)).limit(limit).all();
      view.releases = page(rows, rowCount(deps, releases, ofApp(releases.app)), limit, (last) => url("releases", limit, `release-${last.id}`));
      // The rollback form offers releases that built, beyond the ones listed; a row's
      // "Deploy…" link picks its release in the form.
      const ready = deps.db
        .select()
        .from(releases)
        .where(and(ofApp(releases.app), eq(releases.status, "ready")))
        .orderBy(desc(releases.id))
        .limit(ROLLBACK_CHOICES)
        .all();
      const picked = getRelease(deps, Number(req.query.release) || null);
      if (picked && picked.app === app.name && picked.status === "ready" && !ready.some((r) => r.id === picked.id)) ready.push(picked);
      view.ready = ready;
      view.picked = picked?.id ?? null;
      view.canRollback = ["active", "failed"].includes(app.status);
    } else if (tab === "code") {
      const limit = listLimit(req.query.prs);
      const rows = deps.db
        .select()
        .from(pullRequests)
        .where(ofApp(pullRequests.app))
        .orderBy(desc(pullRequests.updatedAt))
        .limit(limit)
        .all()
        .map((pull) => ({ pull, check: getJob(deps, pull.checkJobId) }));
      view.pulls = page(rows, rowCount(deps, pullRequests, ofApp(pullRequests.app)), limit, (last) => url("prs", limit, `pr-${last.pull.number}`));
      view.deliveries = deps.db
        .select()
        .from(webhookDeliveries)
        .where(ofApp(webhookDeliveries.app))
        .orderBy(desc(webhookDeliveries.id))
        .limit(15)
        .all();
    } else {
      // Only this tab reads app.yaml from GitHub.
      let secretRows: Awaited<ReturnType<typeof secretStatuses>> = [];
      let secretError: string | null = null;
      if (app.status !== "destroyed") {
        try {
          secretRows = await secretStatuses(deps, app);
        } catch (err) {
          secretError = `Couldn't read app.yaml from GitHub: ${(err as Error).message}`;
        }
      }
      view.secrets = secretRows;
      view.secretError = secretError;
      view.canSetSecrets = canSetSecrets(app);
      view.canRetryTeardown = app.status === "destroying" && activeJobs === 0;
    }
    res.render("app", view);
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
      return res.redirect(appUrl(app.name, appTab(req.body.tab)));
    }
    try {
      const done = await catchUpApp(deps, app);
      deps.log("synced with GitHub", { app: app.name, by: req.user!.email, done });
      flash(req, done.length ? `Synced with GitHub. ${done.join(". ")}.` : "Synced with GitHub: nothing was missed.");
    } catch (err) {
      flash(req, `Couldn't sync with GitHub: ${(err as Error).message}`);
    }
    res.redirect(appUrl(app.name, appTab(req.body.tab)));
  });

  router.post("/apps/:name/rollback", (req, res) => {
    const app = getApp(deps, param(req, "name"));
    if (!app) return notFound(res, "That app");
    const env = String(req.body.env ?? "");
    const release = getRelease(deps, Number(req.body.release_id));
    if (!isAppEnv(env) || !release || release.app !== app.name || release.status !== "ready") {
      flash(req, "Pick an environment and a release that built successfully.");
      return res.redirect(appUrl(app.name, "releases"));
    }
    if (!["active", "failed"].includes(app.status)) {
      flash(req, `${app.name} is ${app.status}; it can't be deployed.`);
      return res.redirect(appUrl(app.name, "releases"));
    }
    const job = queueDeploy(deps, app.name, env, release, req.user!.email);
    deps.log("rollback", { app: app.name, env, release: release.id, by: req.user!.email, job: job.id });
    flash(req, `Deploying ${shortSha(release.commitSha)} to ${env} (job #${job.id}).`);
    res.redirect(`/apps/${app.name}`);
  });

  // --- Secrets: set several values for one environment, with one redeploy ------

  async function renderSecrets(res: Response, app: AppRow, env: AppEnv, error: string | null, status = 200): Promise<void> {
    const canSet = canSetSecrets(app);
    let rows: Awaited<ReturnType<typeof secretStatuses>> = [];
    let loadError: string | null = null;
    if (canSet) {
      try {
        rows = await secretStatuses(deps, app);
      } catch (err) {
        loadError = `Couldn't read app.yaml from GitHub: ${(err as Error).message}`;
      }
    }
    res.status(status).render("secrets", {
      title: `${app.name} secrets`,
      app,
      env,
      secrets: rows,
      error: error ?? loadError,
      canSet,
      loadFailed: !!loadError,
      deployed: !!(env === "staging" ? app.stagingReleaseId : app.prodReleaseId),
    });
  }

  router.get("/apps/:name/secrets/:env", async (req, res) => {
    const app = getApp(deps, param(req, "name"));
    const env = param(req, "env");
    if (!app || !isAppEnv(env)) return notFound(res, "That page");
    await renderSecrets(res, app, env, null);
  });

  router.post("/apps/:name/secrets/:env", async (req, res) => {
    const app = getApp(deps, param(req, "name"));
    const env = param(req, "env");
    if (!app || !isAppEnv(env)) return notFound(res, "That page");
    // Values are never echoed back: on an error the form comes back empty.
    const values = new Map<string, string>();
    for (const [field, value] of Object.entries(req.body ?? {})) {
      if (field.startsWith("value:") && typeof value === "string" && value.trim()) values.set(field.slice(6), value);
    }
    const pasted = parseEnvFile(typeof req.body?.env_file === "string" ? req.body.env_file : "");
    if (pasted.badLines.length) {
      const lines = pasted.badLines.length > 1 ? `Lines ${listing(pasted.badLines.map(String))} of the pasted text aren't` : `Line ${pasted.badLines[0]} of the pasted text isn't`;
      return renderSecrets(res, app, env, `${lines} KEY=value. Nothing was saved.`, 400);
    }
    for (const [key, value] of pasted.values) {
      if (!value.trim()) continue;
      if (values.has(key) && values.get(key) !== value) {
        return renderSecrets(res, app, env, `${key} has one value in its field and another in the pasted text. Nothing was saved.`, 400);
      }
      values.set(key, value);
    }
    let result: SetSecretsResult;
    try {
      result = await setSecrets(deps, app, env, values, req.user!.email);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      return renderSecrets(res, app, env, err.message, err.status);
    }
    const { saved, failed, ignored, redeploy } = result;
    const them = saved.length > 1 ? "them" : "it";
    flash(
      req,
      [
        `Saved ${listing(saved)} for ${env}.`,
        redeploy
          ? `Redeploying ${env} so the app picks ${them} up (job #${redeploy.id}).`
          : `${env} hasn't been deployed yet, so its first deploy will use ${them}.`,
        failed.length ? `Couldn't save ${listing(failed)}: try ${failed.length > 1 ? "them" : "it"} again.` : "",
        ignored.length ? `Ignored ${listing(ignored)}: not declared in app.yaml on main.` : "",
      ]
        .filter(Boolean)
        .join(" "),
    );
    res.redirect(appUrl(app.name, "settings"));
  });

  router.post("/apps/:name/destroy", (req, res) => {
    const app = getApp(deps, param(req, "name"));
    if (!app) return notFound(res, "That app");
    if (app.status !== "destroy_requested") {
      flash(req, "Teardown starts with /destroy-app from the app's owner.");
      return res.redirect(appUrl(app.name, "settings"));
    }
    if (String(req.body.confirm ?? "").trim() !== app.name) {
      flash(req, `Type ${app.name} exactly to confirm the teardown.`);
      return res.redirect(appUrl(app.name, "settings"));
    }
    deps.db.update(apps).set({ status: "destroying", error: null }).where(eq(apps.name, app.name)).run();
    supersedeQueued(deps, app.name, "The app is being torn down");
    queueTeardown(deps, app, req.user!.email);
    deps.log("teardown confirmed", { app: app.name, by: req.user!.email });
    flash(req, `Tearing down ${app.name}: prod, then staging, then shared.`);
    res.redirect(appUrl(app.name, "settings"));
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
    res.redirect(appUrl(app.name, "settings"));
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
    res.redirect(appUrl(app.name, "settings"));
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
