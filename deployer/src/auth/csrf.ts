// Synchronizer-token CSRF protection: every dashboard form carries the
// session's token in a hidden _csrf field (design 5.5).
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export function csrfToken(req: Request): string {
  req.session.csrf ??= randomBytes(24).toString("base64url");
  return req.session.csrf;
}

export function validCsrf(req: Request): boolean {
  const expected = req.session.csrf;
  const given = typeof req.body?._csrf === "string" ? req.body._csrf : "";
  if (!expected || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/** Expose the token to views and reject state-changing requests without it. */
export function csrf(req: Request, res: Response, next: NextFunction): void {
  res.locals.csrfToken = csrfToken(req);
  if (req.method === "GET" || req.method === "HEAD") return next();
  if (!validCsrf(req)) {
    res.status(403).render("message", { title: "Expired form", message: "That form expired. Go back, reload the page and try again." });
    return;
  }
  next();
}
