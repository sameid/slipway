// App secrets (design 5.8). Values go straight from a browser form to Parameter
// Store; the deployer stores only who set which name and when.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { parseAppYaml, type AppYaml } from "./appyaml.js";
import { iso, type Deps } from "./deps.js";
import { secretLinks, secrets, type AppRow, type JobRow, type SecretLinkRow } from "./db/schema.js";
import { ApiError } from "./errors.js";
import { queueRedeploy } from "./jobs.js";
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

const tooLong = (value: string) => Buffer.byteLength(value) > MAX_VALUE_BYTES;

/** Write one parameter and record who set it. The caller queues the redeploy. */
async function writeSecret(deps: Deps, app: string, env: AppEnv, key: string, value: string, by: string): Promise<void> {
  await deps.platform.putAppSecret(secretParameter(app, env, key), value);
  const now = iso(deps);
  deps.db
    .insert(secrets)
    .values({ app, env, key, lastSetBy: by, lastSetAt: now })
    .onConflictDoUpdate({ target: [secrets.app, secrets.env, secrets.key], set: { lastSetBy: by, lastSetAt: now } })
    .run();
}

/** Use a one-time link: write the parameter, record it, and redeploy that environment. */
export async function setSecret(deps: Deps, token: string, value: string): Promise<{ link: SecretLinkRow; redeploy: JobRow | null }> {
  const link = findLink(deps, token);
  if (!link) throw new ApiError(404, "This link isn't valid.");
  const state = linkState(deps, link);
  if (state !== "pending") throw new ApiError(410, state === "used" ? "This link has already been used." : "This link has expired.");
  if (!value) throw new ApiError(400, "Enter a value.");
  if (tooLong(value)) throw new ApiError(400, `Values can be at most ${MAX_VALUE_BYTES} bytes.`);

  // Claim the link first so two submissions can't both write.
  const now = iso(deps);
  const claimed = deps.db
    .update(secretLinks)
    .set({ usedAt: now })
    .where(and(eq(secretLinks.tokenHash, link.tokenHash), isNull(secretLinks.usedAt)))
    .run();
  if (claimed.changes !== 1) throw new ApiError(410, "This link has already been used.");

  const env = link.env as AppEnv;
  try {
    await writeSecret(deps, link.app, env, link.key, value, link.createdBy);
  } catch (err) {
    deps.db.update(secretLinks).set({ usedAt: null }).where(eq(secretLinks.tokenHash, link.tokenHash)).run();
    deps.log("writing secret failed", { app: link.app, env, key: link.key, error: String(err) });
    throw new ApiError(502, "Couldn't save the value. Try again; if it keeps failing, the deployer's log has the reason.");
  }

  const redeploy = queueRedeploy(deps, link.app, env, link.createdBy);
  deps.db
    .update(secretLinks)
    .set({ redeployJobId: redeploy?.id ?? null })
    .where(eq(secretLinks.tokenHash, link.tokenHash))
    .run();
  deps.log("secret set", { app: link.app, env, key: link.key, by: link.createdBy, redeploy: redeploy?.id });
  return { link: { ...link, usedAt: now, redeployJobId: redeploy?.id ?? null }, redeploy };
}

/** Whether values can be set for an app: not while it's being torn down. */
export const canSetSecrets = (app: AppRow) => ["registering", "active", "failed"].includes(app.status);

export type SetSecretsResult = { saved: string[]; failed: string[]; ignored: string[]; redeploy: JobRow | null };

/**
 * Set several values for one environment at once (the dashboard's secrets page),
 * then redeploy it once. Names that app.yaml on main doesn't declare are ignored
 * and reported back; nothing is written unless every value is valid.
 */
export async function setSecrets(
  deps: Deps,
  app: AppRow,
  env: AppEnv,
  values: Map<string, string>,
  by: string,
): Promise<SetSecretsResult> {
  if (!canSetSecrets(app)) throw new ApiError(409, `${app.name} is ${app.status.replace(/_/g, " ")}, so its secrets can't be changed.`);
  const { secrets: declared } = await mainAppYaml(deps, app);
  const ignored = [...values.keys()].filter((key) => !declared.includes(key));
  const keys = declared.filter((key) => values.has(key));
  if (!keys.length) {
    throw new ApiError(400, ignored.length ? `None of those names are declared in app.yaml on main.` : "Enter at least one value.");
  }
  const long = keys.filter((key) => tooLong(values.get(key)!));
  if (long.length) throw new ApiError(400, `Values can be at most ${MAX_VALUE_BYTES} bytes; ${long.join(", ")} ${long.length > 1 ? "are" : "is"} longer.`);

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
  if (!saved.length) throw new ApiError(502, "Couldn't save any of the values. Try again, or check the deployer's log.");
  const redeploy = queueRedeploy(deps, app.name, env, by);
  deps.log("secrets set", { app: app.name, env, keys: saved, failed, by, redeploy: redeploy?.id });
  return { saved, failed, ignored, redeploy };
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
