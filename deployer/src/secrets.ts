// App secrets (design 5.8). Values go straight from a browser form to Parameter
// Store; the deployer stores only who set which name and when. Parameter Store
// decides what an environment gets: every deploy injects all of its parameters
// (jobs/deploy-env.sh), so a name needn't be in app.yaml first. Names under
// secrets: in app.yaml are the required ones, which a deploy checks are set.
// Saving can leave the deploy for later ("Save only"); removing always waits
// for a deploy that leaves the secret out, and deletes it once that succeeds.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { parseAppYaml, type AppYaml } from "./appyaml.js";
import { iso, type Deps } from "./deps.js";
import { jobs, secretLinks, secrets, type AppRow, type JobRow, type SecretLinkRow } from "./db/schema.js";
import { ApiError } from "./errors.js";
import { getRelease, queueRedeploy } from "./jobs.js";
import { MAX_SECRETS, secretNameProblem, secretParameter, type AppEnv } from "./names.js";

export const LINK_TTL_MS = 10 * 60_000;
const MAX_VALUE_BYTES = 4096; // Parameter Store standard tier
// The runner takes inputs of at most 512 characters; removals past that wait for the next deploy.
const MAX_REMOVED_INPUT = 512;

export const listing = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? ""));

const manifests = new Map<string, AppYaml>();

/** app.yaml at a commit, cached. */
async function appYamlAt(deps: Deps, app: AppRow, sha: string): Promise<AppYaml> {
  const cacheKey = `${app.repo}@${sha}`;
  const cached = manifests.get(cacheKey);
  if (cached) return cached;
  const text = await deps.github.readFile(app.repo, "app.yaml", sha);
  if (text === null) throw new ApiError(409, `app.yaml is missing at ${sha.slice(0, 7)}`);
  const manifest = parseAppYaml(text);
  if (manifests.size > 500) manifests.clear();
  manifests.set(cacheKey, manifest);
  return manifest;
}

/** app.yaml on main, cached per commit. */
export async function mainAppYaml(deps: Deps, app: AppRow): Promise<AppYaml> {
  return appYamlAt(deps, app, await deps.github.branchHead(app.repo, "main"));
}

/**
 * Names a deploy of `env` requires: app.yaml's on main, and the ones of the
 * release the environment runs, since redeploying it checks them too.
 */
async function requiredNames(deps: Deps, app: AppRow, env: AppEnv): Promise<Set<string>> {
  const names = new Set((await mainAppYaml(deps, app)).secrets);
  const running = getRelease(deps, env === "staging" ? app.stagingReleaseId : app.prodReleaseId);
  if (running) for (const key of (await appYamlAt(deps, app, running.commitSha)).secrets) names.add(key);
  return names;
}

export type SecretStatus = {
  /** A value exists in Parameter Store. */
  set: boolean;
  lastSetBy: string | null;
  lastSetAt: string | null;
  /** Saved after the environment's last deploy started, so the app doesn't have this value yet. */
  notDeployed: boolean;
  /** Marked for removal: the next deploy leaves it out, then it's deleted. */
  removing: boolean;
};

export type SecretRow = {
  key: string;
  /** Listed under secrets: in app.yaml on main, so deploys fail without it. */
  required: boolean;
  staging: SecretStatus;
  prod: SecretStatus;
};

const deployedRelease = (app: AppRow, env: AppEnv) => (env === "staging" ? app.stagingReleaseId : app.prodReleaseId);

/** When the environment's last successful deploy started; anything saved later isn't in use yet. */
function lastDeployStart(deps: Deps, app: AppRow, env: AppEnv): string | null {
  if (!deployedRelease(app, env)) return null;
  const job = deps.db
    .select({ startedAt: jobs.startedAt })
    .from(jobs)
    .where(and(eq(jobs.app, app.name), eq(jobs.env, env), eq(jobs.kind, "deploy"), eq(jobs.status, "succeeded")))
    .orderBy(desc(jobs.id))
    .get();
  return job?.startedAt ?? null;
}

/** Every secret either environment has, plus the required ones: app.yaml's order first, then by name. */
export async function secretStatuses(deps: Deps, app: AppRow): Promise<SecretRow[]> {
  const { secrets: declared } = await mainAppYaml(deps, app);
  const [staging, prod] = await Promise.all([
    deps.platform.listAppSecrets(app.name, "staging"),
    deps.platform.listAppSecrets(app.name, "prod"),
  ]);
  const existing = { staging: new Set(staging), prod: new Set(prod) };
  const since = { staging: lastDeployStart(deps, app, "staging"), prod: lastDeployStart(deps, app, "prod") };
  const rows = deps.db.select().from(secrets).where(eq(secrets.app, app.name)).all();
  const others = new Set([...staging, ...prod, ...rows.filter((r) => r.removeRequestedAt).map((r) => r.key)]);
  const keys = [...declared, ...[...others].filter((k) => !declared.includes(k)).sort()];
  const status = (key: string, env: AppEnv): SecretStatus => {
    const row = rows.find((r) => r.key === key && r.env === env);
    const set = existing[env].has(key);
    const removing = !!row?.removeRequestedAt;
    const setAt = set ? (row?.lastSetAt ?? null) : null;
    return {
      set,
      lastSetBy: set ? (row?.lastSetBy ?? null) : null,
      lastSetAt: setAt,
      notDeployed: !removing && !!setAt && !!since[env] && setAt > since[env]!,
      removing,
    };
  };
  return keys.map((key) => ({ key, required: declared.includes(key), staging: status(key, "staging"), prod: status(key, "prod") }));
}

/** Throws if `names` would give the environment more secrets than a deploy takes. */
async function checkRoom(deps: Deps, app: AppRow, env: AppEnv, adding: string[], removing: string[] = []): Promise<void> {
  const { secrets: declared } = await mainAppYaml(deps, app);
  const existing = await deps.platform.listAppSecrets(app.name, env);
  const after = new Set([...declared, ...existing.filter((k) => !removing.includes(k)), ...adding]);
  if (after.size > MAX_SECRETS) throw new ApiError(400, `An environment can have at most ${MAX_SECRETS} secrets; ${env} would have ${after.size}.`);
}

/** Throws if a deploy that leaves `key` out is running: it's deleted once that finishes. */
function checkNotBeingRemoved(deps: Deps, app: string, env: AppEnv, keys: string[]): void {
  if (!keys.length) return;
  const busy = deps.db
    .select()
    .from(secrets)
    .where(and(eq(secrets.app, app), eq(secrets.env, env), inArray(secrets.key, keys), isNotNull(secrets.removeJobId)))
    .all();
  if (busy.length) {
    const names = busy.map((r) => r.key);
    throw new ApiError(
      409,
      `Deploy job #${busy[0]!.removeJobId} is removing ${listing(names)} from ${env}. Set ${names.length > 1 ? "them" : "it"} again once it has finished.`,
    );
  }
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createLink(
  deps: Deps,
  app: AppRow,
  env: AppEnv,
  key: string,
  createdBy: string,
): Promise<{ url: string; linkId: string; expiresAt: string }> {
  const { secrets: declared } = await mainAppYaml(deps, app);
  const problem = secretNameProblem(key, declared.includes(key));
  if (problem) throw new ApiError(400, `${problem}.`);
  await checkRoom(deps, app, env, [key]);
  const token = randomBytes(32).toString("base64url");
  const linkId = randomBytes(9).toString("base64url");
  const expiresAt = new Date(deps.now().getTime() + LINK_TTL_MS).toISOString();
  deps.db
    .insert(secretLinks)
    .values({ tokenHash: hashToken(token), id: linkId, app: app.name, env, key, createdBy, expiresAt })
    .run();
  deps.log("secret link created", { app: app.name, env, key, by: createdBy, link: linkId });
  return { url: `${deps.publicUrl}/secrets/set/${token}`, linkId, expiresAt };
}

export type LinkState = "pending" | "used" | "expired";

export function linkState(deps: Deps, link: SecretLinkRow): LinkState {
  if (link.usedAt) return "used";
  return link.expiresAt <= iso(deps) ? "expired" : "pending";
}

/** The link a token belongs to, compared in constant time. */
export function findLink(deps: Deps, token: string): SecretLinkRow | undefined {
  if (!/^[\w-]{20,100}$/.test(token)) return undefined;
  const hash = hashToken(token);
  const link = deps.db.select().from(secretLinks).where(eq(secretLinks.tokenHash, hash)).get();
  if (!link || !timingSafeEqual(Buffer.from(link.tokenHash), Buffer.from(hash))) return undefined;
  return link;
}

const tooLong = (value: string) => Buffer.byteLength(value) > MAX_VALUE_BYTES;

/** Write one parameter and record who set it; setting a value also cancels its removal. The caller deploys. */
async function writeSecret(deps: Deps, app: string, env: AppEnv, key: string, value: string, by: string): Promise<void> {
  await deps.platform.putAppSecret(secretParameter(app, env, key), value);
  const now = iso(deps);
  const set = { lastSetBy: by, lastSetAt: now, removeRequestedBy: null, removeRequestedAt: null, removeJobId: null };
  deps.db
    .insert(secrets)
    .values({ app, env, key, ...set })
    .onConflictDoUpdate({ target: [secrets.app, secrets.env, secrets.key], set })
    .run();
}

/**
 * Use a one-time link: write the parameter, record it, and with `deploy`
 * redeploy that environment. Without it, the next deploy picks the value up.
 */
export async function setSecret(
  deps: Deps,
  token: string,
  value: string,
  deploy = true,
): Promise<{ link: SecretLinkRow; redeploy: JobRow | null }> {
  const link = findLink(deps, token);
  if (!link) throw new ApiError(404, "This link isn't valid.");
  const state = linkState(deps, link);
  if (state !== "pending") throw new ApiError(410, state === "used" ? "This link has already been used." : "This link has expired.");
  if (!value) throw new ApiError(400, "Enter a value.");
  if (tooLong(value)) throw new ApiError(400, `Values can be at most ${MAX_VALUE_BYTES} bytes.`);
  const env = link.env as AppEnv;
  checkNotBeingRemoved(deps, link.app, env, [link.key]);

  // Claim the link first so two submissions can't both write.
  const now = iso(deps);
  const claimed = deps.db
    .update(secretLinks)
    .set({ usedAt: now })
    .where(and(eq(secretLinks.tokenHash, link.tokenHash), isNull(secretLinks.usedAt)))
    .run();
  if (claimed.changes !== 1) throw new ApiError(410, "This link has already been used.");

  try {
    await writeSecret(deps, link.app, env, link.key, value, link.createdBy);
  } catch (err) {
    deps.db.update(secretLinks).set({ usedAt: null }).where(eq(secretLinks.tokenHash, link.tokenHash)).run();
    deps.log("writing secret failed", { app: link.app, env, key: link.key, error: String(err) });
    throw new ApiError(502, "Couldn't save the value. Try again; if it keeps failing, the deployer's log has the reason.");
  }

  const redeploy = deploy ? queueRedeploy(deps, link.app, env, link.createdBy) : null;
  deps.db
    .update(secretLinks)
    .set({ redeployJobId: redeploy?.id ?? null, deployRequested: deploy })
    .where(eq(secretLinks.tokenHash, link.tokenHash))
    .run();
  deps.log("secret set", { app: link.app, env, key: link.key, by: link.createdBy, deploy, redeploy: redeploy?.id });
  return { link: { ...link, usedAt: now, redeployJobId: redeploy?.id ?? null, deployRequested: deploy }, redeploy };
}

/** Whether values can be set for an app: not while it's being torn down. */
export const canSetSecrets = (app: AppRow) => ["registering", "active", "failed"].includes(app.status);

export type SecretsChange = {
  /** New values by name; names the environment doesn't have yet are added. */
  values: Map<string, string>;
  /** Names to remove. */
  remove: string[];
  /** Redeploy the environment now ("Save and deploy"), or leave it to the next deploy ("Save only"). */
  deploy: boolean;
};

export type SetSecretsResult = {
  saved: string[];
  failed: string[];
  /** Marked for removal, or, if the environment was never deployed, deleted already. */
  removed: string[];
  redeploy: JobRow | null;
  /** Whether the environment has been deployed; if not, its first deploy uses what was saved. */
  deployed: boolean;
};

/**
 * Change several of one environment's secrets at once (the dashboard's secrets
 * page), then redeploy it once if `deploy`. Nothing is written unless every
 * name and value is valid.
 */
export async function setSecrets(deps: Deps, app: AppRow, env: AppEnv, change: SecretsChange, by: string): Promise<SetSecretsResult> {
  if (!canSetSecrets(app)) throw new ApiError(409, `${app.name} is ${app.status.replace(/_/g, " ")}, so its secrets can't be changed.`);
  const { values, remove, deploy } = change;
  const keys = [...values.keys()];
  if (!keys.length && !remove.length) throw new ApiError(400, "Enter at least one value.");
  const { secrets: declared } = await mainAppYaml(deps, app);
  const problems = keys.map((key) => secretNameProblem(key, declared.includes(key))).filter((p): p is string => !!p);
  if (problems.length) throw new ApiError(400, `${problems.join(". ")}. Nothing was saved.`);
  const both = remove.filter((key) => values.has(key));
  if (both.length) throw new ApiError(400, `${listing(both)} has a new value and is marked for removal; pick one. Nothing was saved.`);
  const required = await requiredNames(deps, app, env);
  const needed = remove.filter((key) => required.has(key));
  if (needed.length) {
    throw new ApiError(400, `${listing(needed)} ${needed.length > 1 ? "are" : "is"} required by app.yaml, so ${needed.length > 1 ? "they" : "it"} can't be removed. Nothing was saved.`);
  }
  const long = keys.filter((key) => tooLong(values.get(key)!));
  if (long.length) throw new ApiError(400, `Values can be at most ${MAX_VALUE_BYTES} bytes; ${long.join(", ")} ${long.length > 1 ? "are" : "is"} longer.`);
  checkNotBeingRemoved(deps, app.name, env, [...keys, ...remove]);
  await checkRoom(deps, app, env, keys, remove);

  const saved: string[] = [];
  const failed: string[] = [];
  for (const key of keys) {
    try {
      await writeSecret(deps, app.name, env, key, values.get(key)!, by);
      saved.push(key);
    } catch (err) {
      failed.push(key);
      deps.log("writing secret failed", { app: app.name, env, key, error: String(err) });
    }
  }

  const deployed = !!deployedRelease(app, env);
  const removed: string[] = [];
  for (const key of remove) {
    try {
      if (deployed) {
        // The running tasks' definition still names it: it goes once a deploy has left it out.
        const mark = { removeRequestedBy: by, removeRequestedAt: iso(deps), removeJobId: null };
        deps.db
          .insert(secrets)
          .values({ app: app.name, env, key, ...mark })
          .onConflictDoUpdate({ target: [secrets.app, secrets.env, secrets.key], set: mark })
          .run();
      } else {
        await deps.platform.deleteAppSecret(secretParameter(app.name, env, key));
        deps.db.delete(secrets).where(and(eq(secrets.app, app.name), eq(secrets.env, env), eq(secrets.key, key))).run();
      }
      removed.push(key);
    } catch (err) {
      failed.push(key);
      deps.log("removing secret failed", { app: app.name, env, key, error: String(err) });
    }
  }
  if (!saved.length && !removed.length) throw new ApiError(502, "Couldn't save any of the changes. Try again, or check the deployer's log.");
  const redeploy = deploy && deployed ? queueRedeploy(deps, app.name, env, by) : null;
  deps.log("secrets set", { app: app.name, env, keys: saved, removed, failed, by, deploy, redeploy: redeploy?.id });
  return { saved, failed, removed, redeploy, deployed };
}

/** Changes saved but not deployed: redeploy what the environment runs. */
export function deploySecrets(deps: Deps, app: AppRow, env: AppEnv, by: string): JobRow {
  if (!["active", "failed"].includes(app.status)) throw new ApiError(409, `${app.name} is ${app.status.replace(/_/g, " ")}; it can't be deployed.`);
  const job = queueRedeploy(deps, app.name, env, by);
  if (!job) throw new ApiError(409, `${env} hasn't been deployed yet; its first deploy will use the saved values.`);
  deps.log("secrets deploy", { app: app.name, env, by, job: job.id });
  return job;
}

/** Take back a removal that no deploy has started on yet. */
export function keepSecret(deps: Deps, app: AppRow, env: AppEnv, key: string): void {
  const row = deps.db.select().from(secrets).where(and(eq(secrets.app, app.name), eq(secrets.env, env), eq(secrets.key, key))).get();
  if (!row?.removeRequestedAt) throw new ApiError(400, `${key} isn't being removed from ${env}.`);
  checkNotBeingRemoved(deps, app.name, env, [key]);
  if (row.lastSetAt) {
    deps.db
      .update(secrets)
      .set({ removeRequestedBy: null, removeRequestedAt: null, removeJobId: null })
      .where(and(eq(secrets.app, app.name), eq(secrets.env, env), eq(secrets.key, key)))
      .run();
  } else {
    deps.db.delete(secrets).where(and(eq(secrets.app, app.name), eq(secrets.env, env), eq(secrets.key, key))).run();
  }
}

// --- Removals, through deploys (worker.ts) ---

/** SECRETS_REMOVED for a deploy of `env`: the names it should leave out. */
export function secretInputs(deps: Deps, app: string, env: AppEnv): { inputs: Record<string, string>; names: string[] } {
  const rows = deps.db
    .select({ key: secrets.key })
    .from(secrets)
    .where(and(eq(secrets.app, app), eq(secrets.env, env), isNotNull(secrets.removeRequestedAt)))
    .orderBy(secrets.key)
    .all();
  const names: string[] = [];
  for (const { key } of rows) {
    if ([...names, key].join(":").length > MAX_REMOVED_INPUT) break;
    names.push(key);
  }
  return { inputs: names.length ? { SECRETS_REMOVED: names.join(":") } : {}, names };
}

/** The deploy has started with `names` left out: it's the one that removes them. */
export function secretsDeployStarted(deps: Deps, job: JobRow, env: AppEnv, names: string[]): void {
  if (!names.length) return;
  deps.db
    .update(secrets)
    .set({ removeJobId: job.id })
    .where(and(eq(secrets.app, job.app), eq(secrets.env, env), inArray(secrets.key, names), isNotNull(secrets.removeRequestedAt)))
    .run();
}

/**
 * After a deploy: if it succeeded, the service no longer names the secrets it
 * left out, so their parameters can go. If it failed, the next deploy tries again.
 */
export async function secretsDeployFinished(deps: Deps, job: JobRow, env: AppEnv, succeeded: boolean): Promise<void> {
  const rows = deps.db
    .select()
    .from(secrets)
    .where(and(eq(secrets.app, job.app), eq(secrets.env, env), eq(secrets.removeJobId, job.id)))
    .all();
  for (const row of rows) {
    const where = and(eq(secrets.app, row.app), eq(secrets.env, row.env), eq(secrets.key, row.key), eq(secrets.removeJobId, job.id));
    if (succeeded) {
      try {
        await deps.platform.deleteAppSecret(secretParameter(row.app, env, row.key));
        deps.db.delete(secrets).where(where).run();
        deps.log("secret removed", { app: row.app, env, key: row.key, job: job.id });
        continue;
      } catch (err) {
        deps.log("deleting removed secret failed", { app: row.app, env, key: row.key, error: String(err) });
      }
    }
    deps.db.update(secrets).set({ removeJobId: null }).where(where).run();
  }
}

/**
 * KEY=value lines from a pasted .env file: blank lines, # comments and `export`
 * are skipped; values may be single- or double-quoted, and quoted values may span
 * lines. In double quotes \n is a newline and \" a quote. An unquoted value ends
 * at " #". Lines that can't be read are returned by number only, since their text
 * may hold a value.
 */
export function parseEnvFile(text: string): { values: Map<string, string>; badLines: number[] } {
  const lines = text.split(/\r?\n/);
  const values = new Map<string, string>();
  const badLines: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) {
      badLines.push(i + 1);
      continue;
    }
    const key = m[1]!;
    const rest = m[2]!;
    const quote = rest[0];
    if (quote !== '"' && quote !== "'") {
      values.set(key, rest.replace(/\s+#.*$/, ""));
      continue;
    }
    // Read up to the closing quote, across lines if need be.
    const start = i;
    let source = rest.slice(1);
    let value = "";
    let closed = false;
    for (let at = 0; ; at++) {
      if (at === source.length) {
        if (i + 1 === lines.length) break;
        source += "\n" + lines[++i];
      }
      const c = source[at];
      if (c === quote) {
        closed = /^\s*(#.*)?$/.test(source.slice(at + 1));
        break;
      }
      if (quote === '"' && c === "\\" && (source[at + 1] === "n" || source[at + 1] === '"' || source[at + 1] === "\\")) {
        at++;
        value += source[at] === "n" ? "\n" : source[at];
      } else {
        value += c;
      }
    }
    if (closed) values.set(key, value);
    else badLines.push(start + 1);
  }
  return { values, badLines };
}
