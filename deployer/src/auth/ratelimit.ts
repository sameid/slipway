// Login rate limiting (design 5.5): too many failures in 15 minutes locks that
// email, or that IP, until the window passes.
import { and, eq, gt, inArray, count } from "drizzle-orm";
import type { Request } from "express";
import { iso, type Deps } from "../deps.js";
import { loginFailures } from "../db/schema.js";

export const WINDOW_MS = 15 * 60_000;
export const EMAIL_LIMIT = 5;
// Higher than the email limit: colleagues in one office share a public IP.
export const IP_LIMIT = 20;

export const emailKey = (email: string) => `email:${email.trim().toLowerCase()}`;
export const ipKey = (ip: string) => `ip:${ip}`;

/** The viewer's IP. CloudFront sets CloudFront-Viewer-Address ("ip:port"); the client can't. */
export function clientIp(req: Request): string {
  const viewer = req.get("cloudfront-viewer-address");
  if (viewer) return viewer.replace(/:\d+$/, "");
  return req.ip ?? "unknown";
}

function failures(deps: Pick<Deps, "db" | "now">, key: string): number {
  const since = new Date(deps.now().getTime() - WINDOW_MS).toISOString();
  const row = deps.db
    .select({ n: count() })
    .from(loginFailures)
    .where(and(eq(loginFailures.key, key), gt(loginFailures.at, since)))
    .get();
  return row?.n ?? 0;
}

export function isLocked(deps: Pick<Deps, "db" | "now">, email: string, ip: string): boolean {
  return failures(deps, emailKey(email)) >= EMAIL_LIMIT || failures(deps, ipKey(ip)) >= IP_LIMIT;
}

export function recordFailure(deps: Pick<Deps, "db" | "now">, email: string, ip: string): void {
  const at = iso(deps);
  deps.db.insert(loginFailures).values([{ key: emailKey(email), at }, { key: ipKey(ip), at }]).run();
}

export function clearFailures(deps: Pick<Deps, "db">, email: string): void {
  deps.db.delete(loginFailures).where(inArray(loginFailures.key, [emailKey(email)])).run();
}
