// GitHub events (design 5.5 "Worker loop", 5.7) and the startup catch-up, which
// covers webhook deliveries GitHub never retried.
import { and, eq, inArray } from "drizzle-orm";
import { parseAppYaml } from "./appyaml.js";
import { iso, type Deps } from "./deps.js";
import { apps, jobs, pullRequests, releases, type AppRow } from "./db/schema.js";
import { ACTIVE, finishJob, getAppByRepo, queueBuildAndDeploy, queueCheck } from "./jobs.js";
import { shortSha } from "./names.js";

const ZERO_SHA = /^0+$/;
/** Apps whose repos the deployer reacts to. */
const LISTENING = ["registering", "active", "failed", "destroy_requested"];

type Repo = { full_name: string };
export type PushEvent = { ref: string; after: string; deleted?: boolean; repository: Repo; sender?: { login: string } };
export type PullRequestEvent = {
  action: string;
  number: number;
  repository: Repo;
  sender?: { login: string };
  pull_request: {
    number: number;
    state: string;
    draft?: boolean;
    merged?: boolean;
    merge_commit_sha: string | null;
    head: { sha: string; ref: string };
    base: { ref: string };
  };
};

/** What the deployer did with an event, for the webhook log on the dashboard. */
export type EventResult = { outcome: "handled" | "ignored"; detail: string; jobId?: number };

const ignored = (detail: string): EventResult => ({ outcome: "ignored", detail });

/** The app listening to `repo`, or why there isn't one. */
function appFor(deps: Deps, repo: string): AppRow | EventResult {
  const app = getAppByRepo(deps, repo);
  if (!app) return ignored(`No app is registered for ${repo}`);
  if (!LISTENING.includes(app.status)) return ignored(`${app.name} is ${app.status.replace(/_/g, " ")}`);
  return app;
}

export async function handleGithubEvent(deps: Deps, name: string, payload: unknown): Promise<EventResult> {
  if (name === "push") return onPush(deps, payload as PushEvent);
  if (name === "pull_request") return onPullRequest(deps, payload as PullRequestEvent);
  if (name === "ping") return ignored("GitHub's test delivery");
  return ignored(`The deployer doesn't act on ${name} events`);
}

async function onPush(deps: Deps, event: PushEvent): Promise<EventResult> {
  if (event.ref !== "refs/heads/main") return ignored(`Only pushes to main deploy (this was ${event.ref})`);
  if (event.deleted || ZERO_SHA.test(event.after)) return ignored("main was deleted");
  const app = appFor(deps, event.repository.full_name);
  if ("outcome" in app) return app;
  await refreshAutoMerge(deps, app, event.after);
  const { build, deploy } = queueBuildAndDeploy(deps, app.name, event.after, event.sender?.login ?? "github");
  return {
    outcome: "handled",
    detail: build
      ? `Build job #${build.id}, then staging deploy job #${deploy.id}`
      : `${shortSha(event.after)} is already built; staging deploy job #${deploy.id}`,
    jobId: build?.id ?? deploy.id,
  };
}

/** auto_merge is platform-owned, so main's app.yaml is the source of truth. */
async function refreshAutoMerge(deps: Deps, app: AppRow, ref: string): Promise<void> {
  try {
    const text = await deps.github.readFile(app.repo, "app.yaml", ref);
    if (text === null) return;
    const { autoMerge } = parseAppYaml(text);
    if (autoMerge !== app.autoMerge) deps.db.update(apps).set({ autoMerge }).where(eq(apps.name, app.name)).run();
  } catch (err) {
    deps.log("reading app.yaml failed", { app: app.name, error: String(err) });
  }
}

async function onPullRequest(deps: Deps, event: PullRequestEvent): Promise<EventResult> {
  const pr = event.pull_request;
  if (pr.base.ref !== "main") return ignored(`The PR targets ${pr.base.ref}, not main`);
  const app = appFor(deps, event.repository.full_name);
  if ("outcome" in app) return app;

  if (["opened", "reopened", "synchronize", "ready_for_review"].includes(event.action) && pr.state === "open") {
    upsertPull(deps, app.name, pr.number, { headSha: pr.head.sha, status: "checking", note: null, mergedSha: null });
    const check = queueCheck(deps, app.name, pr.number, pr.head.sha, event.sender?.login ?? "github");
    return { outcome: "handled", detail: `Check job #${check.id} for ${shortSha(pr.head.sha)}`, jobId: check.id };
  }
  if (event.action === "closed") {
    upsertPull(deps, app.name, pr.number, {
      headSha: pr.head.sha,
      status: pr.merged ? "merged" : "closed",
      mergedSha: pr.merged ? pr.merge_commit_sha : null,
      note: null,
    });
    for (const job of deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.app, app.name), eq(jobs.kind, "check"), eq(jobs.prNumber, pr.number), eq(jobs.status, "queued")))
      .all()) {
      finishJob(deps, job, "superseded", { error: "The PR was closed" });
    }
    return { outcome: "handled", detail: pr.merged ? "Marked the PR merged" : "Marked the PR closed" };
  }
  return ignored(`Nothing to do for "${event.action}"`);
}

export function upsertPull(
  deps: Deps,
  app: string,
  number: number,
  fields: { headSha: string; status: string; note?: string | null; mergedSha?: string | null },
): void {
  const values = { ...fields, updatedAt: iso(deps) };
  deps.db
    .insert(pullRequests)
    .values({ app, number, ...values })
    .onConflictDoUpdate({ target: [pullRequests.app, pullRequests.number], set: values })
    .run();
}

/** On startup: queue anything a missed webhook would have queued. */
export async function catchUp(deps: Deps): Promise<void> {
  const active = deps.db
    .select()
    .from(apps)
    .where(inArray(apps.status, ["active", "failed", "destroy_requested"]))
    .all();
  for (const app of active) {
    try {
      await catchUpApp(deps, app);
    } catch (err) {
      deps.log("catch-up failed", { app: app.name, error: String(err) });
    }
  }
}

/**
 * Compare an app with GitHub and queue what missed webhooks would have queued.
 * Returns what it did, for the dashboard's "Sync with GitHub".
 */
export async function catchUpApp(deps: Deps, app: AppRow): Promise<string[]> {
  const done: string[] = [];
  const head = await deps.github.branchHead(app.repo, "main");
  const release = deps.db
    .select()
    .from(releases)
    .where(and(eq(releases.app, app.name), eq(releases.commitSha, head)))
    .get();
  if (!release) {
    deps.log("catch-up: main has an unbuilt commit", { app: app.name, sha: head });
    await refreshAutoMerge(deps, app, head);
    const { build } = queueBuildAndDeploy(deps, app.name, head, "system");
    if (build) done.push(`Building main's head ${shortSha(head)} (job #${build.id})`);
  }

  const open = await deps.github.listOpenPulls(app.repo);
  for (const pull of open) {
    const checked = deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.app, app.name), eq(jobs.kind, "check"), eq(jobs.prNumber, pull.number), eq(jobs.commitSha, pull.headSha)))
      .get();
    if (checked) continue;
    deps.log("catch-up: PR head has no check", { app: app.name, pr: pull.number, sha: pull.headSha });
    upsertPull(deps, app.name, pull.number, { headSha: pull.headSha, status: "checking", note: null });
    const check = queueCheck(deps, app.name, pull.number, pull.headSha, "system");
    done.push(`Checking PR #${pull.number} at ${shortSha(pull.headSha)} (job #${check.id})`);
  }

  // PRs we think are open but GitHub doesn't list: they merged or closed while we weren't listening.
  const openNumbers = new Set(open.map((p) => p.number));
  const stale = deps.db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.app, app.name), inArray(pullRequests.status, ["checking", "check_failed", "blocked"])))
    .all()
    .filter((p) => !openNumbers.has(p.number));
  for (const row of stale) {
    const pull = await deps.github.getPull(app.repo, row.number);
    upsertPull(deps, app.name, row.number, {
      headSha: pull.headSha,
      status: pull.merged ? "merged" : "closed",
      mergedSha: pull.merged ? pull.mergeCommitSha : null,
    });
    done.push(`PR #${row.number} was ${pull.merged ? "merged" : "closed"}`);
  }

  // Jobs left "queued" for a closed PR can go.
  for (const job of deps.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.app, app.name), eq(jobs.kind, "check"), inArray(jobs.status, ACTIVE)))
    .all()) {
    if (job.status === "queued" && job.prNumber != null && !openNumbers.has(job.prNumber)) {
      finishJob(deps, job, "superseded", { error: "The PR is no longer open" });
      done.push(`Dropped job #${job.id}: PR #${job.prNumber} is no longer open`);
    }
  }
  return done;
}
