// The webhook log behind the dashboard's Webhooks page: every delivery GitHub
// sends, with what the deployer did about it or why it did nothing. A rejected
// delivery is logged from its headers only, because its body isn't trusted.
import { lte } from "drizzle-orm";
import { iso, type Deps } from "./deps.js";
import { webhookDeliveries } from "./db/schema.js";
import { handleGithubEvent, type EventResult } from "./events.js";
import { getAppByRepo } from "./jobs.js";
import { shortSha } from "./names.js";

/** Deliveries kept; each new one deletes the oldest beyond this. */
export const KEEP_DELIVERIES = 2000;

export type Delivery = { event: string; deliveryId?: string | null };

type Row = Omit<typeof webhookDeliveries.$inferInsert, "id" | "receivedAt">;

/** Handle a verified delivery and log the outcome. Rethrows a handling error once it's logged. */
export async function receiveGithubEvent(deps: Deps, delivery: Delivery, payload: unknown): Promise<EventResult> {
  const about = describe(delivery.event, payload);
  const app = about.repo ? (getAppByRepo(deps, about.repo)?.name ?? null) : null;
  let result: EventResult;
  try {
    result = await handleGithubEvent(deps, delivery.event, payload);
  } catch (err) {
    record(deps, { ...delivery, ...about, app, outcome: "failed", detail: String(err) });
    throw err;
  }
  record(deps, { ...delivery, ...about, app, outcome: result.outcome, detail: result.detail, jobId: result.jobId ?? null });
  return result;
}

/** Log a delivery that failed verification or couldn't be read. */
export function recordRejected(deps: Deps, delivery: Delivery, reason: string): void {
  record(deps, { ...delivery, outcome: "rejected", detail: reason });
}

function record(deps: Deps, row: Row): void {
  const clip = (s: string | null | undefined, n: number) => (s == null ? null : s.slice(0, n));
  const values = {
    ...row,
    event: clip(row.event, 100) || "(none)",
    deliveryId: clip(row.deliveryId, 100),
    action: clip(row.action, 100),
    repo: clip(row.repo, 200),
    summary: clip(row.summary, 300),
    detail: clip(row.detail, 1000),
  };
  deps.log("webhook", {
    event: values.event,
    delivery: values.deliveryId,
    repo: values.repo,
    outcome: values.outcome,
    detail: values.detail,
  });
  const { id } = deps.db
    .insert(webhookDeliveries)
    .values({ ...values, receivedAt: iso(deps) })
    .returning({ id: webhookDeliveries.id })
    .get();
  deps.db.delete(webhookDeliveries).where(lte(webhookDeliveries.id, id - KEEP_DELIVERIES)).run();
}

type Payload = {
  action?: unknown;
  ref?: unknown;
  after?: unknown;
  number?: unknown;
  repository?: { full_name?: unknown };
  pull_request?: { head?: { sha?: unknown } };
};

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** One line for the log: "Push to main at abc1234", "PR #3 synchronize at def5678". */
function describe(event: string, payload: unknown): { action: string | null; repo: string | null; summary: string } {
  const p = (payload && typeof payload === "object" ? payload : {}) as Payload;
  const action = str(p.action);
  const repo = str(p.repository?.full_name);
  let summary = action ? `${event} ${action}` : event;
  if (event === "push") {
    summary = `Push to ${str(p.ref)?.replace(/^refs\/heads\//, "") ?? "?"} at ${shortSha(str(p.after) ?? "?")}`;
  } else if (event === "pull_request") {
    summary = `PR #${Number(p.number)} ${action ?? "?"} at ${shortSha(str(p.pull_request?.head?.sha) ?? "?")}`;
  }
  return { action, repo, summary };
}
