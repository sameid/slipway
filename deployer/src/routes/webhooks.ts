// POST /webhooks/github. Every delivery is verified against the webhook secret
// before anything reads it (design 5.5 "GitHub App"), and every delivery,
// rejected or not, goes in the webhook log (deliveries.ts).
import express from "express";
import type { Deps } from "../deps.js";
import { receiveGithubEvent, recordRejected } from "../deliveries.js";

export function webhookRoutes(deps: Deps): express.Router {
  const router = express.Router();
  router.post("/github", express.raw({ type: "*/*", limit: "5mb" }), async (req, res) => {
    const delivery = { event: req.get("x-github-event") ?? "", deliveryId: req.get("x-github-delivery") ?? null };
    const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    const signature = req.get("x-hub-signature-256") ?? "";
    if (!signature || !(await deps.github.verifyWebhook(body, signature))) {
      // No header means the GitHub App has no webhook secret set; a mismatch
      // means it differs from webhookSecret in slipway/github-app.
      recordRejected(deps, delivery, signature ? "The signature doesn't match webhookSecret" : "No X-Hub-Signature-256 header");
      res.status(401).json({ error: "bad signature" });
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      recordRejected(deps, delivery, "The body isn't JSON");
      res.status(400).json({ error: "body isn't JSON" });
      return;
    }
    try {
      await receiveGithubEvent(deps, delivery, payload);
      res.status(202).json({ ok: true });
    } catch {
      // Logged by receiveGithubEvent. GitHub doesn't retry; catch-up on the
      // next restart, or "Sync with GitHub" on the app's page, picks up what we missed.
      res.status(500).json({ error: "handling failed" });
    }
  });
  return router;
}
