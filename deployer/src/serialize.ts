// JSON shapes of the plugin API (docs/contracts.md, "Deployer HTTP API").
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Deps } from "./deps.js";
import { jobs, pullRequests, releases, type AppRow, type JobRow, type ReleaseRow } from "./db/schema.js";
import { getDomain } from "./domains.js";
import { ACTIVE, getJob, getRelease } from "./jobs.js";
import { shortSha, type AppEnv } from "./names.js";

export type JobJson = ReturnType<typeof jobJson>;

export function jobJson(deps: Deps, j: JobRow) {
  return {
    id: j.id,
    app: j.app,
    env: j.env,
    kind: j.kind,
    status: j.status,
    releaseId: j.releaseId,
    commitSha: j.commitSha,
    prNumber: j.prNumber,
    requestedBy: j.requestedBy,
    failedStep: j.failedStep,
    error: j.error,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    logPath: `/api/apps/${j.app}/jobs/${j.id}/log`,
    dashboardUrl: `${deps.publicUrl}/apps/${j.app}/jobs/${j.id}`,
  };
}

export function releaseJson(r: ReleaseRow | undefined) {
  if (!r) return null;
  return {
    id: r.id,
    commitSha: r.commitSha,
    shortSha: shortSha(r.commitSha),
    status: r.status,
    imageDigest: r.imageDigest,
    // Type check, lint and tests passed on its commit; prod only takes verified releases.
    verified: !!r.verifiedAt,
    createdAt: r.createdAt,
  };
}

function lastDeploy(deps: Deps, app: string, env: AppEnv): JobRow | undefined {
  return deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.app, app), eq(jobs.env, env), eq(jobs.kind, "deploy")))
    .orderBy(desc(jobs.id))
    .get();
}

/** Where a new app is on its way to a staging URL, for /new-app's progress output. */
export function phase(deps: Deps, app: AppRow, active: JobRow[]): string {
  switch (app.status) {
    case "destroyed":
      return "destroyed";
    case "destroying":
      return "destroying";
    case "failed":
      return "failed";
    case "registering": {
      const running = active.find((j) => j.status === "running") ?? active[0];
      if (!running) return "registering";
      if (running.env === "shared") return "deploying_shared";
      if (running.kind === "build") return "building";
      if (running.env === "staging") return "deploying_staging";
      return "registering";
    }
    default:
      return "live";
  }
}

export function appJson(deps: Deps, app: AppRow) {
  const active = deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.app, app.name), inArray(jobs.status, ACTIVE)))
    .orderBy(jobs.id)
    .all();
  const recent = deps.db.select().from(jobs).where(eq(jobs.app, app.name)).orderBy(desc(jobs.id)).limit(10).all();
  // The job that failed the first deploy, so /new-app can show its step and log.
  const failedJob = app.status === "failed" ? getJob(deps, app.failedJobId) : undefined;
  if (failedJob && !recent.some((j) => j.id === failedJob.id)) recent.push(failedJob);
  const env = (e: AppEnv) => {
    const deploy = lastDeploy(deps, app.name, e);
    const domain = getDomain(deps, app.name, e);
    return {
      url: e === "staging" ? app.stagingUrl : app.prodUrl,
      // Added on the dashboard; serves the app once active and its DNS points at url's host.
      customDomain: domain ? { hostname: domain.hostname, status: domain.status } : null,
      release: releaseJson(getRelease(deps, e === "staging" ? app.stagingReleaseId : app.prodReleaseId)),
      lastDeploy: deploy ? jobJson(deps, deploy) : null,
    };
  };
  return {
    name: app.name,
    repo: app.repo,
    repoUrl: `https://github.com/${app.repo}`,
    owner: app.owner,
    status: app.status,
    autoMerge: app.autoMerge,
    dashboardUrl: `${deps.publicUrl}/apps/${app.name}`,
    phase: phase(deps, app, active),
    error: app.status === "failed" || app.status === "destroying" ? app.error : null,
    failedJob: failedJob ? jobJson(deps, failedJob) : null,
    staging: env("staging"),
    prod: env("prod"),
    activeJobs: active.map((j) => jobJson(deps, j)),
    recentJobs: recent.map((j) => jobJson(deps, j)),
  };
}

export function pullJson(deps: Deps, app: AppRow, number: number) {
  const pr = deps.db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.app, app.name), eq(pullRequests.number, number)))
    .get();
  if (!pr) {
    return {
      app: app.name,
      number,
      headSha: "",
      status: "unknown",
      check: null,
      mergedSha: null,
      deploy: null,
      live: false,
      stagingUrl: app.stagingUrl,
      failure: null,
      note: null,
    };
  }
  const check = deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.app, app.name), eq(jobs.kind, "check"), eq(jobs.prNumber, number), eq(jobs.commitSha, pr.headSha)))
    .orderBy(desc(jobs.id))
    .get();

  let build: JobRow | undefined;
  let deploy: JobRow | undefined;
  let live = false;
  if (pr.mergedSha) {
    const release = deps.db
      .select()
      .from(releases)
      .where(and(eq(releases.app, app.name), eq(releases.commitSha, pr.mergedSha)))
      .orderBy(desc(releases.id))
      .get();
    if (release) {
      build = deps.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.kind, "build"), eq(jobs.releaseId, release.id)))
        .orderBy(desc(jobs.id))
        .get();
      deploy = deps.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.app, app.name), eq(jobs.env, "staging"), eq(jobs.kind, "deploy"), eq(jobs.releaseId, release.id)))
        .orderBy(desc(jobs.id))
        .get();
      // Live if this release went out, or a newer one did (main only moves forward).
      live =
        deploy?.status === "succeeded" ||
        (deploy?.status === "superseded" && (app.stagingReleaseId ?? 0) > release.id);
    }
  }

  const failed =
    pr.status === "check_failed" ? check : build?.status === "failed" ? build : deploy?.status === "failed" ? deploy : undefined;
  return {
    app: app.name,
    number,
    headSha: pr.headSha,
    status: pr.status,
    check: check ? jobJson(deps, check) : null,
    mergedSha: pr.mergedSha,
    deploy: deploy ? jobJson(deps, deploy) : null,
    live,
    stagingUrl: app.stagingUrl,
    failure: failed
      ? { step: failed.failedStep, message: failed.error, logPath: `/api/apps/${app.name}/jobs/${failed.id}/log` }
      : null,
    note: pr.note,
  };
}
