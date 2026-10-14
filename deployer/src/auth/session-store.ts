// express-session store backed by the sessions table (design 5.5).
import { eq } from "drizzle-orm";
import session from "express-session";
import type { Db } from "../db/client.js";
import { sessions } from "../db/schema.js";

const DEFAULT_TTL_MS = 12 * 3600_000;

export class SqliteSessionStore extends session.Store {
  constructor(private db: Db) {
    super();
  }

  private expiry(sess: session.SessionData): string {
    const expires = sess.cookie?.expires;
    return (expires ? new Date(expires) : new Date(Date.now() + DEFAULT_TTL_MS)).toISOString();
  }

  override get(sid: string, cb: (err: unknown, session?: session.SessionData | null) => void): void {
    try {
      const row = this.db.select().from(sessions).where(eq(sessions.sid, sid)).get();
      if (!row || row.expire <= new Date().toISOString()) return cb(null, null);
      cb(null, JSON.parse(row.sess) as session.SessionData);
    } catch (err) {
      cb(err);
    }
  }

  override set(sid: string, sess: session.SessionData, cb?: (err?: unknown) => void): void {
    try {
      const values = { sess: JSON.stringify(sess), expire: this.expiry(sess) };
      this.db
        .insert(sessions)
        .values({ sid, ...values })
        .onConflictDoUpdate({ target: sessions.sid, set: values })
        .run();
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  override destroy(sid: string, cb?: (err?: unknown) => void): void {
    try {
      this.db.delete(sessions).where(eq(sessions.sid, sid)).run();
      cb?.();
    } catch (err) {
      cb?.(err);
    }
  }

  override touch(sid: string, sess: session.SessionData, cb?: () => void): void {
    try {
      this.db.update(sessions).set({ expire: this.expiry(sess) }).where(eq(sessions.sid, sid)).run();
    } finally {
      cb?.();
    }
  }
}
