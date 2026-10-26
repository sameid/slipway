// /secrets/set/:token: the one-time form behind `/secret set` (design 5.8). No
// dashboard account is needed; the unguessable, single-use token is the
// authorization, and it can only set (never read) one named key.
import express, { type Request } from "express";
import type { Deps } from "../deps.js";
import { ApiError } from "../errors.js";
import { getApp } from "../jobs.js";
import { findLink, linkState, setSecret } from "../secrets.js";

const token = (req: Request) => String(req.params.token ?? "");

export function secretRoutes(deps: Deps): express.Router {
  const router = express.Router();
  // Whether there's anything running to redeploy, which decides the buttons.
  const deployed = (name: string, env: string) => {
    const app = getApp(deps, name);
    return !!(env === "staging" ? app?.stagingReleaseId : app?.prodReleaseId);
  };

  router.get("/set/:token", (req, res) => {
    const link = findLink(deps, token(req));
    const state = link ? linkState(deps, link) : null;
    if (!link || state !== "pending") {
      return res.status(link ? 410 : 404).render("message", {
        title: "Link not usable",
        message:
          state === "used"
            ? "This link has already been used. Run /secret set again for a new one."
            : "This link has expired or isn't valid. Run /secret set again for a new one.",
      });
    }
    res.render("secret-set", { title: `Set ${link.key}`, link, error: null, deployed: deployed(link.app, link.env) });
  });

  router.post("/set/:token", async (req, res) => {
    const value = typeof req.body?.value === "string" ? req.body.value.replace(/\r?\n$/, "") : "";
    // "Save and deploy" or "Save only"; a form from before there was a choice deploys.
    const deploy = req.body?.deploy !== "0";
    try {
      const { link, redeploy } = await setSecret(deps, token(req), value, deploy);
      res.render("message", {
        title: "Saved",
        message: redeploy
          ? `${link.key} is set for ${link.app} (${link.env}). Deploying ${link.env} so the app picks it up; /secret set in Claude Code reports when it's done. You can close this tab.`
          : !deploy && deployed(link.app, link.env)
            ? `${link.key} is saved for ${link.app} (${link.env}) without deploying. ${link.env} picks it up on its next deploy, which you can start from the app's secrets page on the dashboard. You can close this tab.`
            : `${link.key} is set for ${link.app} (${link.env}). ${link.env} hasn't been deployed yet, so its first deploy will use it. You can close this tab.`,
      });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      const link = findLink(deps, token(req));
      if (err.status === 400 && link) {
        return res.status(400).render("secret-set", { title: `Set ${link.key}`, link, error: err.message, deployed: deployed(link.app, link.env) });
      }
      res.status(err.status).render("message", { title: "Couldn't save", message: err.message });
    }
  });

  return router;
}
