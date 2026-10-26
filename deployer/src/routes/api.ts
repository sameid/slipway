// Plugin API (design 5.5 "API"; shapes in docs/contracts.md). Authenticated with
// the colleague's GitHub token; it can register and read apps, fetch local dev
// config, create secret links and request teardown, but never promote.
import { and, desc, eq } from "drizzle-orm";
import express, { type NextFunction, type Request, type Response } from "express";
import { PluginAuth } from "../auth/plugin-auth.js";
import { iso, type Deps } from "../deps.js";
import { apps, jobs, secretLinks, type AppRow } from "../db/schema.js";
import { ApiError } from "../errors.js";
import { getApp, getJob } from "../jobs.js";
import { isAppEnv } from "../names.js";
import { registerApp } from "../registration.js";
import { canSetSecrets, createLink, linkState, secretStatuses } from "../secrets.js";
import { appJson, jobJson, pullJson } from "../serialize.js";

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;

/** Turn ApiErrors (and anything unexpected) into {"error": ...}. */
const route =
  (deps: Deps, fn: Handler) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ApiError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      deps.log("api error", { path: req.path, error: String(err) });
      next(err);
    }
  };

const param = (req: Request, name: string) => String(req.params[name] ?? "");

export function apiRoutes(deps: Deps): express.Router {
  const router = express.Router();
  const auth = new PluginAuth(deps);
  router.use(express.json({ limit: "64kb" }));
  router.use(auth.middleware);

  const findApp = (req: Request): AppRow => {
    const app = getApp(deps, param(req, "name"));
    if (!app) throw new ApiError(404, `${param(req, "name")} isn't registered`);
    return app;
  };

  // Who the caller is, and what the plugin needs to create apps: the account
  // that owns app repos and the CODEOWNERS entry for platform-owned files.
  router.get(
    "/whoami",
    route(deps, async (req, res) => {
      const { owner, codeowners } = deps.config;
      const ownerType = await deps.github.ownerType();
      res.json({
        login: req.login,
        owner,
        ownerType,
        codeowners: codeowners ?? `@${ownerType === "User" ? owner : req.login}`,
      });
    }),
  );

  router.post(
    "/apps",
    route(deps, async (req, res) => {
      const name = typeof req.body?.name === "string" ? req.body.name : "";
      const { app, warning } = await registerApp(deps, name, req.login!);
      res.status(201).json({ ...appJson(deps, app), warning });
    }),
  );

  router.get(
    "/apps/:name",
    route(deps, (req, res) => res.json(appJson(deps, findApp(req)))),
  );

  router.get(
    "/apps/:name/pulls/:number",
    route(deps, (req, res) => {
      const number = Number(param(req, "number"));
      if (!Number.isInteger(number) || number < 1) throw new ApiError(400, "Bad PR number");
      res.json(pullJson(deps, findApp(req), number));
    }),
  );

  router.get(
    "/apps/:name/jobs",
    route(deps, (req, res) => {
      const app = findApp(req);
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
      const rows = deps.db.select().from(jobs).where(eq(jobs.app, app.name)).orderBy(desc(jobs.id)).limit(limit).all();
      res.json({ jobs: rows.map((j) => jobJson(deps, j)) });
    }),
  );

  router.get(
    "/apps/:name/jobs/:id/log",
    route(deps, async (req, res) => {
      const app = findApp(req);
      const job = getJob(deps, Number(param(req, "id")));
      if (!job || job.app !== app.name) throw new ApiError(404, "No such job");
      const tail = Math.min(Math.max(Number(req.query.tail) || 200, 1), 2000);
      res.type("text/plain").send((await jobLog(deps, job, tail)).join("\n") + "\n");
    }),
  );

  router.post(
    "/apps/:name/destroy",
    route(deps, (req, res) => {
      const app = findApp(req);
      if (app.owner !== req.login) throw new ApiError(403, `Only the app's owner (${app.owner}) can request teardown`);
      if (!["active", "failed", "destroy_requested"].includes(app.status)) {
        throw new ApiError(409, `${app.name} is ${app.status}`);
      }
      deps.db
        .update(apps)
        .set({ status: "destroy_requested", destroyRequestedBy: req.login, destroyRequestedAt: iso(deps) })
        .where(eq(apps.name, app.name))
        .run();
      deps.log("teardown requested", { app: app.name, by: req.login });
      res.status(202).json({ status: "destroy_requested", dashboardUrl: `${deps.publicUrl}/apps/${app.name}` });
    }),
  );

  router.get(
    "/apps/:name/secrets",
    route(deps, async (req, res) => {
      res.json({ secrets: await secretStatuses(deps, findApp(req)) });
    }),
  );

  router.post(
    "/apps/:name/secrets/:env/:key/link",
    route(deps, async (req, res) => {
      const app = findApp(req);
      const env = param(req, "env");
      const key = param(req, "key");
      if (!isAppEnv(env)) throw new ApiError(400, "env must be staging or prod");
      if (!canSetSecrets(app)) throw new ApiError(409, `${app.name} is ${app.status}`);
      res.status(201).json(await createLink(deps, app, env, key, req.login!));
    }),
  );

  router.get(
    "/apps/:name/secret-links/:linkId",
    route(deps, (req, res) => {
      const app = findApp(req);
      const link = deps.db
        .select()
        .from(secretLinks)
        .where(and(eq(secretLinks.id, param(req, "linkId")), eq(secretLinks.app, app.name)))
        .get();
      if (!link) throw new ApiError(404, "No such link");
      const redeploy = getJob(deps, link.redeployJobId);
      res.json({
        status: linkState(deps, link),
        usedAt: link.usedAt,
        // false: saved with "Save only", so nothing was deployed.
        deployRequested: link.deployRequested ?? true,
        redeploy: redeploy ? jobJson(deps, redeploy) : null,
      });
    }),
  );

  router.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });
  return router;
}

/** The tail of a job's runner log; colleagues have no access to the instance. */
export async function jobLog(deps: Deps, job: typeof jobs.$inferSelect, tail: number): Promise<string[]> {
  if (!job.runId) {
    return [job.status === "queued" ? "(queued; no log yet)" : `(no log for this job${job.error ? `: ${job.error}` : ""})`];
  }
  return deps.runs.logTail(job.runId, tail);
}
