import type { RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { eq } from "drizzle-orm";
import { db } from "./db/client.js";
import { users, type User } from "./db/schema.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- how Express types req.user
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

// Every /api route except /api/health uses this. 401 JSON when signed out
// (Clerk's requireAuth() redirects, which is wrong for a JSON API). On a user's
// first request, creates their local row from the session claims; app data
// references users.id, never the Clerk id. Being signed in only proves the
// user is a colleague: what they may do is this app's own authorization.
export const requireUser: RequestHandler = async (req, res, next) => {
  const { userId, sessionClaims } = getAuth(req);
  if (!userId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  let [user] = await db.select().from(users).where(eq(users.clerkId, userId));
  if (!user) {
    const claim = (key: string) => (typeof sessionClaims?.[key] === "string" ? (sessionClaims[key] as string) : null);
    const values = { clerkId: userId, email: claim("email"), name: claim("name") };
    [user] = await db
      .insert(users)
      .values(values)
      .onConflictDoUpdate({ target: users.clerkId, set: { email: values.email, name: values.name } })
      .returning();
  }

  req.user = user;
  next();
};
