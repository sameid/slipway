// Dashboard sign-in with local accounts (design 5.5 "Dashboard: local accounts").
import { eq } from "drizzle-orm";
import express, { type NextFunction, type Request, type Response } from "express";
import { hashPassword, passwordProblem, verifyPassword } from "../auth/passwords.js";
import { clearFailures, clientIp, isLocked, recordFailure } from "../auth/ratelimit.js";
import { iso, type Deps } from "../deps.js";
import { users } from "../db/schema.js";

/** Load the signed-in user, if any, onto req.user and res.locals.user. */
export function loadUser(deps: Deps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const id = req.session.userId;
    if (id !== undefined) {
      const user = deps.db.select().from(users).where(eq(users.id, id)).get();
      if (user && !user.disabled) {
        req.user = user;
        res.locals.user = user;
      } else {
        delete req.session.userId;
      }
    }
    res.locals.flash = req.session.flash;
    delete req.session.flash;
    next();
  };
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  if (req.user.mustChangePassword) return res.redirect("/password");
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.isAdmin) {
    res.status(403).render("message", { title: "Admins only", message: "Only admins can manage accounts." });
    return;
  }
  next();
}

/** Only follow local paths after login. */
const safeNext = (next: unknown) =>
  typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/";

export function authRoutes(deps: Deps): express.Router {
  const router = express.Router();

  router.get("/login", (req, res) => {
    if (req.user) return res.redirect("/");
    res.render("login", { title: "Sign in", error: null, email: "", next: safeNext(req.query.next) });
  });

  router.post("/login", async (req, res) => {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const password = String(req.body.password ?? "");
    const next = safeNext(req.body.next);
    const ip = clientIp(req);
    const fail = (status: number, error: string) =>
      res.status(status).render("login", { title: "Sign in", error, email, next });

    if (isLocked(deps, email, ip)) {
      deps.log("login locked", { email, ip });
      return fail(429, "Too many failed sign-ins. Wait 15 minutes and try again.");
    }
    const user = deps.db.select().from(users).where(eq(users.email, email)).get();
    const ok = await verifyPassword(user?.passwordHash, password);
    if (!user || !ok || user.disabled) {
      recordFailure(deps, email, ip);
      deps.log("login failed", { email, ip });
      return fail(401, "Wrong email or password.");
    }
    clearFailures(deps, email);
    deps.db.update(users).set({ lastLoginAt: iso(deps) }).where(eq(users.id, user.id)).run();
    // A fresh session id on sign-in prevents session fixation.
    req.session.regenerate((err) => {
      if (err) return res.status(500).render("message", { title: "Error", message: "Couldn't start a session." });
      req.session.userId = user.id;
      deps.log("login", { user: user.email, ip });
      res.redirect(user.mustChangePassword ? "/password" : next);
    });
  });

  router.post("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
  });

  router.get("/password", (req, res) => {
    if (!req.user) return res.redirect("/login");
    res.render("password", { title: "Change password", error: null, forced: req.user.mustChangePassword });
  });

  router.post("/password", async (req, res) => {
    const user = req.user;
    if (!user) return res.redirect("/login");
    const current = String(req.body.current ?? "");
    const next = String(req.body.password ?? "");
    const confirm = String(req.body.confirm ?? "");
    const fail = (error: string) =>
      res.status(400).render("password", { title: "Change password", error, forced: user.mustChangePassword });

    if (!(await verifyPassword(user.passwordHash, current))) return fail("Your current password is wrong.");
    const problem = passwordProblem(next);
    if (problem) return fail(problem);
    if (next !== confirm) return fail("The new passwords don't match.");
    if (next === current) return fail("Choose a password different from the current one.");
    deps.db
      .update(users)
      .set({ passwordHash: await hashPassword(next), mustChangePassword: false })
      .where(eq(users.id, user.id))
      .run();
    deps.log("password changed", { user: user.email });
    req.session.flash = "Password changed.";
    res.redirect("/");
  });

  return router;
}
