// App secrets (design 5.8). Values go straight from a browser form to Parameter
// Store; the deployer stores only who set which name and when.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { parseAppYaml, type AppYaml } from "./appyaml.js";
import { iso, type Deps } from "./deps.js";
import { jobs, secretLinks, secrets, type AppRow, type JobRow, type SecretLinkRow } from "./db/schema.js";
import { ApiError } from "./errors.js";
import { getApp, getRelease, queueDeploy } from "./jobs.js";
import { secretParameter, type AppEnv } from "./names.js";

export const LINK_TTL_MS = 10 * 60_000;
const MAX_VALUE_BYTES = 4096; // Parameter Store standard tier

const manifests = new Map<string, AppYaml>();

/** app.yaml on main, cached per commit. */
export async function mainAppYaml(deps: Deps, app: AppRow): Promise<AppYaml> {
  const head = await deps.github.branchHead(app.repo, "main");
  const cacheKey = `${app.repo}@${head}`;
  const cached = manifests.get(cacheKey);
  if (cached) return cached;
  const text = await deps.github.readFile(app.repo, "app.yaml", head);
  if (text === null) throw new ApiError(409, "app.yaml is missing on main");
  const manifest = parseAppYaml(text);
  if (manifests.size > 500) manifests.clear();
  manifests.set(cacheKey, manifest);
  return manifest;
}

export type SecretStatus = { set: boolean; lastSetBy: string | null; lastSetAt: string | null };

export async function secretStatuses(
  deps: Deps,
  app: AppRow,
): Promise<{ key: string; staging: SecretStatus; prod: SecretStatus }[]> {
  const { secrets: declared } = await mainAppYaml(deps, app);
  const rows = deps.db.select().from(secrets).where(eq(secrets.app, app.name)).all();
  const status = (key: string, env: AppEnv): SecretStatus => {
    const row = rows.find((r) => r.key === key && r.env === env);
    return { set: !!row?.lastSetAt, lastSetBy: row?.lastSetBy ?? null, lastSetAt: row?.lastSetAt ?? null };
  };
  return declared.map((key) => ({ key, staging: status(key, "staging"), prod: status(key, "prod") }));
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
  if (!declared.includes(key)) {
    throw new ApiError(400, `${key} isn't declared under secrets: in app.yaml on main. Add it, ship that change, then set it.`);
  }
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

/** Use a one-time link: write the parameter, record it, and redeploy that environment. */
export async function setSecret(deps: Deps, token: string, value: string): Promise<{ link: SecretLinkRow; redeploy: JobRow | null }> {
  const link = findLink(deps, token);
  if (!link) throw new ApiError(404, "This link isn't valid.");
  const state = linkState(deps, link);
  if (state !== "pending") throw new ApiError(410, state === "used" ? "This link has already been used." : "This link has expired.");
  if (!value) throw new ApiError(400, "Enter a value.");
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) throw new ApiError(400, `Values can be at most ${MAX_VALUE_BYTES} bytes.`);

  // Claim the link first so two submissions can't both write.
  const claimed = deps.db
    .update(secretLinks)
    .set({ usedAt: iso(deps) })
    .where(and(eq(secretLinks.tokenHash, link.tokenHash), isNull(secretLinks.usedAt)))
    .run();
  if (claimed.changes !== 1) throw new ApiError(410, "This link has already been used.");

  const env = link.env as AppEnv;
  try {
    await deps.platform.putAppSecret(secretParameter(link.app, env, link.key), value);
  } catch (err) {
    deps.db.update(secretLinks).set({ usedAt: null }).where(eq(secretLinks.tokenHash, link.tokenHash)).run();
    deps.log("writing secret failed", { app: link.app, env, key: link.key, error: String(err) });
    throw new ApiError(502, "Couldn't save the value. Try again; if it keeps failing, the deployer's log has the reason.");
  }

  const now = iso(deps);
  deps.db
    .insert(secrets)
    .values({ app: link.app, env, key: link.key, lastSetBy: link.createdBy, lastSetAt: now })
    .onConflictDoUpdate({
      target: [secrets.app, secrets.env, secrets.key],
      set: { lastSetBy: link.createdBy, lastSetAt: now },
    })
    .run();
  const redeploy = queueSecretRedeploy(deps, link.app, env, link.createdBy);
  deps.db
    .update(secretLinks)
    .set({ redeployJobId: redeploy?.id ?? null })
    .where(eq(secretLinks.tokenHash, link.tokenHash))
    .run();
  deps.log("secret set", { app: link.app, env, key: link.key, by: link.createdBy, redeploy: redeploy?.id });
  return { link: { ...link, usedAt: now, redeployJobId: redeploy?.id ?? null }, redeploy };
}

/**
 * Containers read secrets at start, so a new value needs new tasks. A deploy that
 * hasn't started yet will start them anyway; otherwise redeploy what's running
 * (or about to be, if a deploy is in flight).
 */
export function queueSecretRedeploy(deps: Deps, app: string, env: AppEnv, requestedBy: string): JobRow | null {
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
  if (!release || release.status !== "ready") return null; // nothing deployed yet; the first deploy picks it up
  return queueDeploy(deps, app, env, release, requestedBy);
}
