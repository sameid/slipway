// Plugin API auth (design 5.5): the colleague's `gh auth token`, checked with
// GitHub and against org membership, cached for 10 minutes by the token's hash.
import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Deps } from "../deps.js";

export const CACHE_MS = 10 * 60_000;
type Entry = { login: string; member: boolean; until: number };

export class PluginAuth {
  private cache = new Map<string, Entry>();

  constructor(private deps: Deps) {}

  /** The caller's login if they're an org member; otherwise an HTTP error. */
  async check(token: string): Promise<{ login: string } | { status: number; error: string }> {
    const key = createHash("sha256").update(token).digest("hex");
    const now = this.deps.now().getTime();
    let entry = this.cache.get(key);
    if (!entry || entry.until <= now) {
      const login = await this.deps.github.loginForToken(token);
      if (!login) {
        this.cache.delete(key);
        return { status: 401, error: "invalid GitHub token" };
      }
      entry = { login, member: await this.deps.github.isOrgMember(login), until: now + CACHE_MS };
      if (this.cache.size > 5000) this.cache.clear();
      this.cache.set(key, entry);
    }
    if (!entry.member) return { status: 403, error: `${entry.login} is not a member of ${this.deps.config.org}` };
    return { login: entry.login };
  }

  middleware = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const match = req.get("authorization")?.match(/^Bearer\s+(\S+)$/i);
    if (!match?.[1]) {
      res.status(401).json({ error: "Send your GitHub token: Authorization: Bearer $(gh auth token)" });
      return;
    }
    try {
      const result = await this.check(match[1]);
      if ("error" in result) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      req.login = result.login;
      next();
    } catch (err) {
      this.deps.log("plugin auth failed", { error: String(err) });
      res.status(502).json({ error: "Couldn't check your GitHub token with GitHub; try again" });
    }
  };
}
