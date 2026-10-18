// Queueing jobs. The worker (worker.ts) decides when they start; this file only
// records what should happen, de-duplicating requests for the same work.
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { iso, type Deps } from "./deps.js";
import { apps, jobs, pullRequests, releases, type AppRow, type JobRow, type ReleaseRow } from "./db/schema.js";
import type { AppEnv } from "./names.js";

export type JobEnv = "shared" | "staging" | "prod" | "build" | "check";
export type JobKind = "check" | "build" | "deploy" | "destroy";
export const ACTIVE = ["queued", "running"];

type NewJob = {
  app: string;
  env: JobEnv;
  kind: JobKind;
  requestedBy: string;
  releaseId?: number | null;
  prNumber?: number | null;
  commitSha?: string | null;
  afterJobId?: number | null;
};

export function enqueue(deps: Deps, job: NewJob): JobRow {
  const row = deps.db
    .insert(jobs)
    .values({
      app: job.app,
      env: job.env,
      kind: job.kind,
      requestedBy: job.requestedBy,
      releaseId: job.releaseId ?? null,
      prNumber: job.prNumber ?? null,
      commitSha: job.commitSha ?? null,
      afterJobId: job.afterJobId ?? null,
      status: "queued",
      createdAt: iso(deps),
    })
    .returning()
    .get();
  deps.log("job queued", { job: row.id, app: row.app, env: row.env, kind: row.kind, by: row.requestedBy });
  deps.kick();
  return row;
}

export function getApp(deps: Deps, name: string): AppRow | undefined {
  return deps.db.select().from(apps).where(eq(apps.name, name)).get();
}

/** Case-insensitive, like GitHub: webhooks may spell the owner "Acme", apps.repo "acme". */
export function getAppByRepo(deps: Deps, repo: string): AppRow | undefined {
  return deps.db
    .select()
    .from(apps)
    .where(sql`lower(${apps.repo}) = ${repo.toLowerCase()}`)
    .get();
}

export function getRelease(deps: Deps, id: number | null | undefined): ReleaseRow | undefined {
  if (id == null) return undefined;
  return deps.db.select().from(releases).where(eq(releases.id, id)).get();
}

export function getJob(deps: Deps, id: number | null | undefined): JobRow | undefined {
  if (id == null) return undefined;
  return deps.db.select().from(jobs).where(eq(jobs.id, id)).get();
}

function activeJob(deps: Deps, where: ReturnType<typeof and>): JobRow | undefined {
  return deps.db
    .select()
    .from(jobs)
    .where(and(where, inArray(jobs.status, ACTIVE)))
    .orderBy(desc(jobs.id))
    .get();
}

/**
 * Build `sha` (unless a release for it already exists or is being built) and
 * deploy it to staging once it's ready.
 */
export function queueBuildAndDeploy(
  deps: Deps,
  app: string,
  sha: string,
  requestedBy: string,
  afterJobId?: number,
): { build: JobRow | null; deploy: JobRow } {
  let release = deps.db
    .select()
    .from(releases)
    .where(and(eq(releases.app, app), eq(releases.commitSha, sha), ne(releases.status, "failed")))
    .orderBy(desc(releases.id))
    .get();
  let build: JobRow | null = null;

  if (release?.status === "building") {
    build = activeJob(deps, and(eq(jobs.kind, "build"), eq(jobs.releaseId, release.id))) ?? null;
    if (!build) release = undefined; // left over from a crash; build it again
  }
  if (!release) {
    release = deps.db
      .insert(releases)
      .values({ app, commitSha: sha, status: "building", createdAt: iso(deps) })
      .returning()
      .get();
    build = enqueue(deps, {
      app,
      env: "build",
      kind: "build",
      releaseId: release.id,
      commitSha: sha,
      requestedBy,
      afterJobId,
    });
  }

  const existing = activeJob(
    deps,
    and(eq(jobs.app, app), eq(jobs.env, "staging"), eq(jobs.kind, "deploy"), eq(jobs.releaseId, release.id)),
  );
  const deploy =
    existing ??
    enqueue(deps, {
      app,
      env: "staging",
      kind: "deploy",
      releaseId: release.id,
      commitSha: sha,
      requestedBy,
      afterJobId: build?.id ?? afterJobId,
    });
  return { build, deploy };
}

/** Deploy an existing, ready release (promote, rollback, secret change). */
export function queueDeploy(deps: Deps, app: string, env: AppEnv, release: ReleaseRow, requestedBy: string): JobRow {
  return enqueue(deps, {
    app,
    env,
    kind: "deploy",
    releaseId: release.id,
    commitSha: release.commitSha,
    requestedBy,
  });
}

/**
 * Apply a change that only takes effect on a deploy (a secret's new value, a
 * custom domain) without changing what runs. A deploy that hasn't started yet
 * will pick it up anyway; otherwise redeploy what's running (or about to be, if
 * a deploy is in flight), so this never rolls an env back or supersedes a newer
 * release. Null when the env has nothing deployed: its first deploy picks it up.
 */
export function queueRedeploy(deps: Deps, app: string, env: AppEnv, requestedBy: string): JobRow | null {
  const pending = deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.app, app), eq(jobs.env, env), eq(jobs.kind, "deploy"), inArray(jobs.status, ["queued"])))
    .orderBy(desc(jobs.id))
    .get();
  if (pending) return pending;
  const running = deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.app, app), eq(jobs.env, env), eq(jobs.kind, "deploy"), eq(jobs.status, "running")))
    .get();
  const appRow = getApp(deps, app);
  const releaseId = running?.releaseId ?? (env === "staging" ? appRow?.stagingReleaseId : appRow?.prodReleaseId);
  const release = getRelease(deps, releaseId);
  if (!release || release.status !== "ready") return null;
  return queueDeploy(deps, app, env, release, requestedBy);
}

/** Queue a check for a PR's head commit, superseding queued checks for older heads. */
export function queueCheck(deps: Deps, app: string, prNumber: number, headSha: string, requestedBy: string): JobRow {
  const queued = deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.app, app), eq(jobs.kind, "check"), eq(jobs.prNumber, prNumber), inArray(jobs.status, ACTIVE)))
    .all();
  const same = queued.find((j) => j.commitSha === headSha);
  if (same) return same;
  for (const j of queued.filter((j) => j.status === "queued")) {
    finishJob(deps, j, "superseded", { error: "The PR received new commits" });
  }
  const job = enqueue(deps, { app, env: "check", kind: "check", prNumber, commitSha: headSha, requestedBy });
  deps.db
    .update(pullRequests)
    .set({ checkJobId: job.id })
    .where(and(eq(pullRequests.app, app), eq(pullRequests.number, prNumber)))
    .run();
  return job;
}

export function finishJob(
  deps: Deps,
  job: JobRow,
  status: "succeeded" | "failed" | "superseded",
  fields: { error?: string | null; failedStep?: string | null; exported?: Record<string, string> } = {},
): JobRow {
  return deps.db
    .update(jobs)
    .set({
      status,
      error: fields.error ?? null,
      failedStep: fields.failedStep ?? null,
      exported: fields.exported ? JSON.stringify(fields.exported) : job.exported,
      finishedAt: iso(deps),
    })
    .where(eq(jobs.id, job.id))
    .returning()
    .get();
}

/** Mark every queued job of an app superseded (used when a teardown is confirmed). */
export function supersedeQueued(deps: Deps, app: string, reason: string): void {
  for (const j of deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.app, app), eq(jobs.status, "queued")))
    .all()) {
    finishJob(deps, j, "superseded", { error: reason });
  }
}
