// POST /api/apps: register a repo that /new-app just created (design 6, "New app").
import { eq } from "drizzle-orm";
import { parseAppYaml, type AppYaml } from "./appyaml.js";
import { iso, type Deps } from "./deps.js";
import { apps, type AppRow } from "./db/schema.js";
import { ApiError } from "./errors.js";
import { enqueue, getApp, queueBuildAndDeploy } from "./jobs.js";
import { invalidAppName, repoFor } from "./names.js";

const TRIES = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The repo, its main branch and app.yaml, retrying briefly: /new-app registers
 * right after `gh repo create --push`, and GitHub can take a moment to show them.
 */
async function readRepo(deps: Deps, repo: string, name: string): Promise<{ head: string; manifest: AppYaml }> {
  let problem = "";
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    if (attempt > 1) await sleep(deps.config.registerRetryMs);
    if (!(await deps.github.repoExists(repo))) {
      problem = `${repo} doesn't exist, or the deployer's GitHub App can't see it`;
      continue;
    }
    const head = await deps.github.branchHead(repo, "main").catch(() => null);
    if (!head) {
      problem = `${repo} has no main branch`;
      continue;
    }
    const text = await deps.github.readFile(repo, "app.yaml", head);
    if (text === null) {
      problem = `${repo} has no app.yaml on main`;
      continue;
    }
    let manifest: AppYaml;
    try {
      manifest = parseAppYaml(text);
    } catch (err) {
      throw new ApiError(400, `app.yaml on main is invalid: ${(err as Error).message}`);
    }
    if (manifest.name !== name) {
      throw new ApiError(400, `app.yaml on main has name "${manifest.name ?? ""}", expected "${name}"`);
    }
    return { head, manifest };
  }
  throw new ApiError(400, problem);
}

/**
 * Register a new app, or retry the first deploy of one whose registration failed
 * (its owner runs /new-app's register step again).
 */
export async function registerApp(deps: Deps, name: string, owner: string): Promise<AppRow> {
  const invalid = invalidAppName(name);
  if (invalid) throw new ApiError(400, invalid);
  const existing = getApp(deps, name);
  if (existing && existing.status !== "failed") throw new ApiError(409, `${name} is already registered`);
  if (existing && existing.owner !== owner) {
    throw new ApiError(403, `${name} belongs to ${existing.owner}; only they can retry its registration`);
  }

  const repo = repoFor(deps.config.org, name);
  const { head, manifest } = await readRepo(deps, repo, name);

  // Before recording anything, so a failure leaves nothing half-registered.
  try {
    await deps.github.protectMain(repo);
  } catch (err) {
    throw new ApiError(502, `Couldn't set branch protection on ${repo}: ${String(err)}`);
  }

  const fields = { status: "registering", autoMerge: manifest.autoMerge, error: null, failedJobId: null };
  const app = existing
    ? deps.db.update(apps).set(fields).where(eq(apps.name, name)).returning().get()
    : deps.db
        .insert(apps)
        .values({ name, repo, owner, createdAt: iso(deps), ...fields })
        .returning()
        .get();
  deps.log(existing ? "registration retried" : "app registered", { app: name, owner });

  // shared stack → build main → staging, each after the previous succeeds.
  const shared = enqueue(deps, { app: name, env: "shared", kind: "deploy", requestedBy: owner });
  queueBuildAndDeploy(deps, name, head, owner, shared.id);
  return app;
}
