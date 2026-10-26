// The job loop (design 5.5 "Worker loop"), started inside the server process so
// SQLite only ever has one writer. Each tick: poll running runs, skip builds and
// staging deploys a newer merge replaces, fail (or skip) jobs whose dependency
// failed (or was skipped), then start what's free.
// Jobs run in the runner (src/runner), which takes the place of CodeBuild.
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, or } from "drizzle-orm";
import { autoMerge, safely } from "./automerge.js";
import { iso, type Deps } from "./deps.js";
import {
  apps,
  jobs,
  loginFailures,
  pullRequests,
  releases,
  secrets,
  sessions,
  type AppRow,
  type JobRow,
} from "./db/schema.js";
import { domainDeployFinished, domainDeployStarted, domainInputs, domainsTornDown, pollDomains } from "./domains.js";
import { secretInputs, secretsDeployFinished, secretsDeployStarted } from "./secrets.js";
import { ACTIVE, finishJob, getApp, getJob, getRelease, markVerified, queueDeploy } from "./jobs.js";
import { CHECK_CONTEXT, deployContext, isAppEnv, shortSha, type AppEnv } from "./names.js";
import { parseFailure, type RunInfo } from "./runs.js";

/** Jobs that must not run at the same time share a key (contract: concurrency key). */
export function concurrencyKey(job: Pick<JobRow, "app" | "env" | "kind" | "prNumber">): string {
  return job.kind === "check" ? `${job.app}:check:${job.prNumber}` : `${job.app}:${job.env}`;
}

export const jobUrl = (deps: Deps, job: Pick<JobRow, "app" | "id">) =>
  `${deps.publicUrl}/apps/${job.app}/jobs/${job.id}`;

export class Worker {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private again = false;

  constructor(private deps: Deps) {}

  start(): void {
    this.timer = setInterval(() => this.kick(), this.deps.config.workerIntervalMs);
    this.kick();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Run a tick now, or right after the current one finishes. */
  kick(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.tick()
      .catch((err) => this.deps.log("worker tick failed", { error: String(err) }))
      .finally(() => {
        this.running = undefined;
        if (this.again && this.timer) {
          this.again = false;
          setImmediate(() => this.kick());
        }
      });
  }

  async tick(): Promise<void> {
    await this.poll();
    // Failures first, so a deploy whose build just failed fails rather than
    // being superseded; then the skipped builds' deploys go with them.
    this.propagateFailures();
    this.supersede();
    this.propagateFailures();
    await this.startReady();
    // Custom domains' certificates (throttled per domain; see domains.ts).
    try {
      await pollDomains(this.deps);
    } catch (err) {
      this.deps.log("polling domains failed", { error: String(err) });
    }
  }

  // --- 1. Poll running runs --------------------------------------------------

  private async poll(): Promise<void> {
    const running = this.deps.db.select().from(jobs).where(eq(jobs.status, "running")).all();
    for (const job of running) {
      if (!job.runId) continue;
      let run: RunInfo | null;
      try {
        run = await this.deps.runs.get(job.runId);
      } catch (err) {
        // The runner is restarting or down; try again next tick.
        this.deps.log("polling the runner failed", { job: job.id, error: String(err) });
        return;
      }
      try {
        if (!run) {
          const done = finishJob(this.deps, job, "failed", { error: `The runner has no record of run ${job.runId}` });
          await this.onFailed(done);
        } else if (run.status === "succeeded" || run.status === "failed") {
          await this.finished(job, run);
        }
      } catch (err) {
        this.deps.log("handling a finished job failed", { job: job.id, error: String(err) });
      }
    }
  }

  private async finished(job: JobRow, run: RunInfo): Promise<void> {
    if (run.status === "succeeded") {
      const done = finishJob(this.deps, job, "succeeded", { exported: run.exported });
      await this.onSucceeded(done, run.exported);
      return;
    }
    let step: string | null = null;
    let error: string | null = null;
    try {
      // Step markers can be thousands of lines back (Terraform is verbose), so read plenty.
      ({ step, error } = parseFailure(await this.deps.runs.logTail(run.id, 20_000)));
    } catch (err) {
      this.deps.log("reading the run log failed", { job: job.id, error: String(err) });
    }
    error ??= step ? `Failed in step ${step}` : `Run failed${run.exitCode != null ? ` (exit ${run.exitCode})` : ""}`;
    const done = finishJob(this.deps, job, "failed", { failedStep: step, error, exported: run.exported });
    await this.onFailed(done);
  }

  private async onSucceeded(job: JobRow, exported: Record<string, string>): Promise<void> {
    const app = getApp(this.deps, job.app);
    if (!app) return;
    this.deps.log("job succeeded", { job: job.id, app: job.app, env: job.env, kind: job.kind });

    if (job.kind === "check") return this.onCheckFinished(app, job);
    if (job.kind === "verify") return markVerified(this.deps, job);
    if (job.kind === "build") {
      const digest = exported.IMAGE_DIGEST;
      const artifact = exported.WEB_ARTIFACT;
      this.deps.db
        .update(releases)
        .set(
          digest && artifact
            ? { status: "ready", imageDigest: digest, webArtifact: artifact }
            : { status: "failed" },
        )
        .where(eq(releases.id, job.releaseId ?? -1))
        .run();
      return;
    }
    if (job.kind === "deploy" && isAppEnv(job.env)) {
      domainDeployFinished(this.deps, job, job.env);
      await secretsDeployFinished(this.deps, job, job.env, true);
      return this.onDeployed(app, job, job.env, exported.APP_URL);
    }
    // The env's distribution is gone, so its custom domain's certificate can go too.
    if (job.kind === "destroy") domainsTornDown(this.deps, app.name, job.env === "shared" ? "shared" : (job.env as AppEnv));
    if (job.kind === "destroy" && job.env === "shared") {
      // The last step of a teardown: prod and staging went first.
      this.deps.db.delete(secrets).where(eq(secrets.app, app.name)).run();
      this.deps.db
        .update(apps)
        .set({ status: "destroyed", error: null, stagingUrl: null, prodUrl: null, stagingReleaseId: null, prodReleaseId: null })
        .where(eq(apps.name, app.name))
        .run();
      await safely(this.deps, "archive repo", () => this.deps.github.archiveRepo(app.repo));
    }
  }

  private async onDeployed(app: AppRow, job: JobRow, env: AppEnv, url: string | undefined): Promise<void> {
    const release = getRelease(this.deps, job.releaseId);
    const set =
      env === "staging"
        ? { stagingReleaseId: job.releaseId, ...(url ? { stagingUrl: url } : {}) }
        : { prodReleaseId: job.releaseId, ...(url ? { prodUrl: url } : {}) };
    const becomesActive = env === "staging" && (app.status === "registering" || app.status === "failed");
    this.deps.db
      .update(apps)
      .set({ ...set, ...(becomesActive ? { status: "active", error: null } : {}) })
      .where(eq(apps.name, app.name))
      .run();
    if (!release) return;
    const link = url ?? (env === "staging" ? app.stagingUrl : app.prodUrl) ?? undefined;
    await safely(this.deps, "status", () =>
      this.deps.github.setStatus(app.repo, release.commitSha, {
        context: deployContext(env),
        state: "success",
        description: `Live on ${env}`,
        targetUrl: link,
      }),
    );
    // Comment once per release: redeploys (rollbacks, secret changes) don't re-announce merged PRs.
    const earlier = this.deps.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.app, app.name),
          eq(jobs.env, env),
          eq(jobs.kind, "deploy"),
          eq(jobs.releaseId, release.id),
          eq(jobs.status, "succeeded"),
          lt(jobs.id, job.id),
        ),
      )
      .get();
    if (env === "staging" && !earlier) {
      for (const pr of this.mergedPullsFor(app.name, release.commitSha)) {
        await safely(this.deps, "comment", () =>
          this.deps.github.comment(app.repo, pr, `Live on staging: ${link} (release \`${shortSha(release.commitSha)}\`)`),
        );
      }
      // Merges whose own deploys this one superseded (latest merge wins).
      for (const pr of this.skippedPulls(app.name, app.stagingReleaseId, release.id)) {
        await safely(this.deps, "comment", () =>
          this.deps.github.comment(
            app.repo,
            pr,
            `Live on staging: ${link} (release \`${shortSha(release.commitSha)}\`, a later merge that includes this PR)`,
          ),
        );
      }
    }
  }

  /** PRs merged as releases between staging's previous release and this one, which never deployed by themselves. */
  private skippedPulls(app: string, previousId: number | null, releaseId: number): number[] {
    if (previousId === null || previousId >= releaseId) return [];
    const shas = this.deps.db
      .select({ sha: releases.commitSha })
      .from(releases)
      .where(and(eq(releases.app, app), gt(releases.id, previousId), lt(releases.id, releaseId)))
      .all()
      .map((r) => r.sha);
    if (!shas.length) return [];
    return this.deps.db
      .select({ number: pullRequests.number })
      .from(pullRequests)
      .where(and(eq(pullRequests.app, app), inArray(pullRequests.mergedSha, shas)))
      .all()
      .map((r) => r.number);
  }

  private mergedPullsFor(app: string, sha: string): number[] {
    return this.deps.db
      .select({ number: pullRequests.number })
      .from(pullRequests)
      .where(and(eq(pullRequests.app, app), eq(pullRequests.mergedSha, sha)))
      .all()
      .map((r) => r.number);
  }

  private async onFailed(job: JobRow): Promise<void> {
    const app = getApp(this.deps, job.app);
    if (!app) return;
    this.deps.log("job failed", { job: job.id, app: job.app, env: job.env, kind: job.kind, error: job.error });
    this.failRegistration(app, job);

    if (job.kind === "check") return this.onCheckFinished(app, job);
    // Shown on the dashboard, where it was started; nothing on GitHub waits for it.
    if (job.kind === "verify") return;
    const release = getRelease(this.deps, job.releaseId);
    const where = job.kind === "build" ? "Building" : job.kind === "destroy" ? `Tearing down ${job.env}` : `Deploying to ${job.env}`;
    const message = `${where} \`${release ? shortSha(release.commitSha) : job.env}\` failed${
      job.failedStep ? ` in step \`${job.failedStep}\`` : ""
    }: ${job.error}\n\nLog: ${jobUrl(this.deps, job)}`;

    if (job.kind === "build") {
      this.deps.db.update(releases).set({ status: "failed" }).where(eq(releases.id, job.releaseId ?? -1)).run();
      this.deployNewestBuilt(app, job);
    }
    if (job.kind === "destroy") {
      this.deps.db.update(apps).set({ error: `${where} failed: ${job.error}` }).where(eq(apps.name, app.name)).run();
    }
    if (job.kind === "deploy" && isAppEnv(job.env)) {
      const env = job.env;
      domainDeployFinished(this.deps, job, env);
      await secretsDeployFinished(this.deps, job, env, false);
      try {
        await this.deps.platform.deployFailed({ app: app.name, env, summary: message, link: jobUrl(this.deps, job) });
      } catch (err) {
        this.deps.log("reporting the failed deploy failed", { job: job.id, error: String(err) });
      }
    }
    if (job.kind === "deploy" && isAppEnv(job.env) && release) {
      const env = job.env;
      await safely(this.deps, "status", () =>
        this.deps.github.setStatus(app.repo, release.commitSha, {
          context: deployContext(env),
          state: "failure",
          description: `Deploy to ${env} failed`,
          targetUrl: jobUrl(this.deps, job),
        }),
      );
    }
    if (release && (job.kind === "build" || job.env === "staging")) {
      for (const pr of this.mergedPullsFor(app.name, release.commitSha)) {
        await safely(this.deps, "comment", () => this.deps.github.comment(app.repo, pr, message));
      }
    }
  }

  /**
   * A build failed, and newer merges had skipped the deploys of the ones before
   * it (latest merge wins): deploy the newest release that did build, if it's
   * newer than what staging runs and no other deploy is on its way.
   */
  private deployNewestBuilt(app: AppRow, failed: JobRow): void {
    if (app.status !== "active" || failed.releaseId == null) return;
    const pending = this.deps.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.app, app.name),
          eq(jobs.env, "staging"),
          eq(jobs.kind, "deploy"),
          inArray(jobs.status, ACTIVE),
          or(isNull(jobs.afterJobId), ne(jobs.afterJobId, failed.id)),
        ),
      )
      .get();
    if (pending) return;
    const release = this.deps.db
      .select()
      .from(releases)
      .where(
        and(
          eq(releases.app, app.name),
          eq(releases.status, "ready"),
          gt(releases.id, app.stagingReleaseId ?? 0),
          lt(releases.id, failed.releaseId),
        ),
      )
      .orderBy(desc(releases.id))
      .get();
    if (!release) return;
    const job = queueDeploy(this.deps, app.name, "staging", release, "system");
    this.deps.log("deploying the newest release that built", { app: app.name, release: release.id, job: job.id, failedBuild: failed.id });
  }

  /**
   * A failure anywhere in a new app's first deploy marks the app failed. The
   * first failure is the cause; jobs that fail because it did don't overwrite it.
   */
  private failRegistration(app: AppRow, job: JobRow): void {
    const current = getApp(this.deps, app.name);
    if (current?.status !== "registering" || job.kind === "check" || job.kind === "verify") return;
    this.deps.db
      .update(apps)
      .set({ status: "failed", error: job.error, failedJobId: job.id })
      .where(eq(apps.name, app.name))
      .run();
  }

  private async onCheckFinished(app: AppRow, job: JobRow): Promise<void> {
    const sha = job.commitSha;
    if (!sha || job.prNumber == null) return;
    const passed = job.status === "succeeded";
    await safely(this.deps, "status", () =>
      this.deps.github.setStatus(app.repo, sha, {
        context: CHECK_CONTEXT,
        state: passed ? "success" : "failure",
        description: passed ? "Check passed" : `Failed${job.failedStep ? ` in ${job.failedStep}` : ""}`,
        targetUrl: jobUrl(this.deps, job),
      }),
    );
    const pr = this.deps.db
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.app, app.name), eq(pullRequests.number, job.prNumber)))
      .get();
    // A newer commit has its own check; this result only matters for the commit status.
    if (!pr || pr.headSha !== sha || pr.status === "merged" || pr.status === "closed") return;

    if (!passed) {
      this.deps.db
        .update(pullRequests)
        .set({ status: "check_failed", note: null, updatedAt: iso(this.deps) })
        .where(and(eq(pullRequests.app, app.name), eq(pullRequests.number, job.prNumber)))
        .run();
      const key = `${sha}:check-failed`;
      if (pr.lastCommentKey !== key) {
        this.deps.db
          .update(pullRequests)
          .set({ lastCommentKey: key })
          .where(and(eq(pullRequests.app, app.name), eq(pullRequests.number, job.prNumber)))
          .run();
        const prNumber = job.prNumber;
        await safely(this.deps, "comment", () =>
          this.deps.github.comment(
            app.repo,
            prNumber,
            `The check failed${job.failedStep ? ` in step \`${job.failedStep}\`` : ""}: ${job.error}\n\nLog: ${jobUrl(this.deps, job)} (or run \`/ship\` to see it in Claude Code).`,
          ),
        );
      }
      return;
    }
    await autoMerge(this.deps, app, job.prNumber, sha);
  }

  // --- 2. Dependencies -------------------------------------------------------

  private propagateFailures(): void {
    for (;;) {
      const queued = this.deps.db.select().from(jobs).where(eq(jobs.status, "queued")).orderBy(asc(jobs.id)).all();
      let changed = false;
      for (const job of queued) {
        const parent = getJob(this.deps, job.afterJobId);
        if (!parent || (parent.status !== "failed" && parent.status !== "superseded")) continue;
        const done = finishJob(this.deps, job, parent.status === "failed" ? "failed" : "superseded", {
          error: `Job #${parent.id} (${parent.kind} ${parent.env}) ${parent.status}`,
        });
        if (done.status === "failed") {
          const app = getApp(this.deps, job.app);
          if (app) this.failRegistration(app, done);
        }
        changed = true;
      }
      if (!changed) return;
    }
  }

  // --- 3. Superseding --------------------------------------------------------

  /**
   * Latest merge wins. Main only moves forward, so the newest queued build of an
   * app has every older one's changes: the others are skipped, with their
   * releases, and their staging deploys go with them (propagateFailures). Of
   * several queued staging deploys, only the newest runs too. A build that has
   * already started finishes; if the newer one then fails, staging gets it
   * (deployNewestBuilt).
   */
  private supersede(): void {
    const queued = this.deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "queued"), or(eq(jobs.kind, "build"), and(eq(jobs.kind, "deploy"), eq(jobs.env, "staging")))))
      .orderBy(desc(jobs.id))
      .all();
    const newest = new Map<string, number>();
    for (const job of queued) {
      const key = `${job.app}:${job.kind}`;
      const keep = newest.get(key);
      if (keep === undefined) {
        newest.set(key, job.id);
        continue;
      }
      finishJob(this.deps, job, "superseded", { error: `Superseded by job #${keep}` });
      if (job.kind === "build") {
        this.deps.db
          .update(releases)
          .set({ status: "superseded" })
          .where(and(eq(releases.id, job.releaseId ?? -1), eq(releases.status, "building")))
          .run();
      }
    }
  }

  // --- 4. Starting -------------------------------------------------------------

  private async startReady(): Promise<void> {
    const busy = new Set(
      this.deps.db
        .select()
        .from(jobs)
        .where(eq(jobs.status, "running"))
        .all()
        .map((j) => concurrencyKey(j)),
    );
    const queued = this.deps.db.select().from(jobs).where(eq(jobs.status, "queued")).orderBy(asc(jobs.id)).all();
    const toStart: JobRow[] = [];
    for (const job of queued) {
      const key = concurrencyKey(job);
      if (busy.has(key)) continue;
      busy.add(key); // the oldest queued job holds its key even while it waits
      if (this.ready(job)) toStart.push(job);
    }
    await Promise.all(toStart.map((job) => this.startJob(job)));
  }

  /** Whether a queued job can start now. Fails it if it never will. */
  private ready(job: JobRow): boolean {
    const parent = getJob(this.deps, job.afterJobId);
    if (parent && parent.status !== "succeeded") return false;

    const app = getApp(this.deps, job.app);
    if (!app) {
      finishJob(this.deps, job, "failed", { error: "App not found" });
      return false;
    }
    // Neither touches AWS.
    if (job.kind === "check" || job.kind === "verify") return true;

    // Builds push to the app's ECR repo and deploys use its log group, both from the shared stack.
    if ((job.kind === "build" || job.kind === "deploy") && job.env !== "shared" && !this.sharedReady(app.name)) {
      const pending = this.deps.db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.app, app.name),
            eq(jobs.env, "shared"),
            eq(jobs.kind, "deploy"),
            inArray(jobs.status, ["queued", "running"]),
          ),
        )
        .get();
      if (pending) return false;
      this.failRegistration(app, finishJob(this.deps, job, "failed", { error: "The app's shared infrastructure isn't deployed" }));
      return false;
    }
    if (job.kind === "deploy" && isAppEnv(job.env)) {
      const release = getRelease(this.deps, job.releaseId);
      if (release?.status === "superseded") {
        finishJob(this.deps, job, "superseded", { error: `Release #${release.id} was skipped for a newer one` });
        return false;
      }
      if (!release || release.status === "failed") {
        this.failRegistration(app, finishJob(this.deps, job, "failed", { error: `Release #${job.releaseId} didn't build` }));
        return false;
      }
      if (release.status === "building") {
        const building = this.deps.db
          .select()
          .from(jobs)
          .where(and(eq(jobs.kind, "build"), eq(jobs.releaseId, release.id), inArray(jobs.status, ["queued", "running"])))
          .get();
        if (building) return false;
        finishJob(this.deps, job, "failed", { error: `Release #${release.id} has no build` });
        return false;
      }
    }
    return true;
  }

  private sharedReady(app: string): boolean {
    return !!this.deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.app, app), eq(jobs.env, "shared"), eq(jobs.kind, "deploy"), eq(jobs.status, "succeeded")))
      .get();
  }

  private async startJob(job: JobRow): Promise<void> {
    const app = getApp(this.deps, job.app);
    if (!app) return;
    try {
      const runId = await this.startRun(app, job);
      this.deps.db
        .update(jobs)
        .set({ status: "running", runId, startedAt: iso(this.deps) })
        .where(and(eq(jobs.id, job.id), eq(jobs.status, "queued")))
        .run();
      if (job.kind === "build") {
        this.deps.db.update(releases).set({ runId }).where(eq(releases.id, job.releaseId ?? -1)).run();
      }
      this.deps.log("job started", { job: job.id, app: job.app, env: job.env, kind: job.kind, run: runId });
      if (job.kind === "check" && job.commitSha) {
        const sha = job.commitSha;
        await safely(this.deps, "status", () =>
          this.deps.github.setStatus(app.repo, sha, {
            context: CHECK_CONTEXT,
            state: "pending",
            description: "Check running",
            targetUrl: jobUrl(this.deps, job),
          }),
        );
      }
    } catch (err) {
      const done = finishJob(this.deps, job, "failed", { failedStep: "start", error: `Couldn't start: ${String(err)}` });
      await this.onFailed(done);
    }
  }

  private async startRun(app: AppRow, job: JobRow): Promise<string> {
    const { runs, github } = this.deps;
    if (job.kind === "check" || job.kind === "build" || job.kind === "verify") {
      const sha = job.commitSha;
      if (!sha) throw new Error("job has no commit");
      // The deployer holds the GitHub App; the runner never sees a GitHub credential.
      return runs.start({
        kind: "build-release",
        sourceZip: await github.downloadZipball(app.repo, sha),
        env: {
          APP: app.name,
          COMMIT_SHA: sha,
          MODE: job.kind === "build" ? "release" : job.kind,
          ...(job.kind === "check" ? { PR_NUMBER: String(job.prNumber) } : {}),
        },
      });
    }
    const env: Record<string, string> = {
      APP: app.name,
      ENV: job.env,
      ACTION: job.kind === "destroy" ? "destroy" : "apply",
      DEPLOY_ID: String(job.id),
    };
    if (job.kind === "deploy" && isAppEnv(job.env)) {
      const release = getRelease(this.deps, job.releaseId);
      if (!release?.imageDigest || !release.webArtifact) throw new Error(`release #${job.releaseId} isn't ready`);
      const removing = secretInputs(this.deps, app.name, job.env);
      Object.assign(env, {
        COMMIT_SHA: release.commitSha,
        IMAGE_DIGEST: release.imageDigest,
        WEB_ARTIFACT: release.webArtifact,
        ...domainInputs(this.deps, app.name, job.env),
        ...removing.inputs,
      });
      const runId = await runs.start({ kind: "deploy-env", env });
      // Only once it has started: a deploy that couldn't start doesn't count against the domain.
      domainDeployStarted(this.deps, job, job.env);
      secretsDeployStarted(this.deps, job, job.env, removing.names);
      return runId;
    }
    return runs.start({ kind: "deploy-env", env });
  }
}

/** Housekeeping the worker doesn't need every tick. */
export function pruneOld(deps: Deps): void {
  const dayAgo = new Date(deps.now().getTime() - 24 * 3600_000).toISOString();
  deps.db.delete(loginFailures).where(lt(loginFailures.at, dayAgo)).run();
  deps.db.delete(sessions).where(lt(sessions.expire, iso(deps))).run();
}
