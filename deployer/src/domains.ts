// Custom domains. Someone adds a hostname they own to an app's staging or prod
// on the dashboard, points its DNS at the env's CloudFront distribution, and it
// works. The deployer gets a certificate for it (ACM in us-east-1, where
// CloudFront looks; DNS-validated, so validating also proves control of the
// name), and every deploy of the env passes the domain to deploy-env, which
// attaches it to the distribution. This table decides: a deploy without the
// domain detaches it.
//
//   requesting  saved; the certificate is being requested
//   validating  waiting for the validation CNAME (the worker polls ACM)
//   attaching   the certificate is issued; the next deploy of the env attaches it
//   active      a deploy attached it
//   failed      the certificate wasn't issued, or the deploy attaching it failed
//   removing    the next deploy detaches it; then the certificate and the row go
//
// Every status change is conditional on the status it saw, because the worker's
// poll awaits ACM while a dashboard request can change the same row.
import { domainToASCII } from "node:url";
import { and, eq, inArray } from "drizzle-orm";
import { iso, type Deps } from "./deps.js";
import { domains, jobs, type AppRow, type DomainRow, type JobRow } from "./db/schema.js";
import { ApiError } from "./errors.js";
import { ACTIVE, getApp, queueRedeploy } from "./jobs.js";
import type { AppEnv } from "./names.js";

/** How often the worker asks ACM about a certificate (more often while its validation record is still being made). */
export const DOMAIN_POLL_MS = 60_000;
const RECORD_POLL_MS = 10_000;
/** A request that hasn't finished by now was interrupted (e.g. a restart). */
const REQUEST_TIMEOUT_MS = 5 * 60_000;

/** Names that belong to AWS, not to anyone adding a domain. */
const AWS_SUFFIXES = ["cloudfront.net", "amazonaws.com", "on.aws", "acm-validations.aws"];

/** Steps after which a deploy has applied the domain change (terraform-phase1 ran). */
const AFTER_PHASE1 = ["migrate", "rollout-settings", "terraform-phase2", "web-sync", "health-check"];

/** Apps can take a domain while they're running, like rollbacks. */
const canChangeDomains = (app: AppRow) => ["active", "failed"].includes(app.status);

export function getDomain(deps: Deps, app: string, env: AppEnv): DomainRow | undefined {
  return deps.db
    .select()
    .from(domains)
    .where(and(eq(domains.app, app), eq(domains.env, env)))
    .get();
}

/** Lowercase, ASCII (punycode for international names), no trailing dot; "" if it can't be a hostname. */
export function normalizeHostname(input: string): string {
  const trimmed = input.trim().replace(/\.$/, "");
  if (!trimmed || /[/:@\s]/.test(trimmed)) return trimmed.toLowerCase();
  return domainToASCII(trimmed) || trimmed.toLowerCase();
}

/** Why a normalized hostname can't be added, or null. Doesn't check whether it's taken. */
export function hostnameProblem(deps: Deps, hostname: string): string | null {
  if (!hostname) return "Enter a hostname, like app.example.com.";
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(hostname) || /[/:@\s]/.test(hostname)) {
    return "Enter just the hostname, like app.example.com: no https://, port or path.";
  }
  if (hostname.includes("*")) return "Wildcards aren't supported; enter one hostname.";
  // ACM's limit for a certificate's domain name.
  if (hostname.length > 64) return "That's too long: certificates take hostnames up to 64 characters.";
  const labels = hostname.split(".");
  if (labels.length < 2) return "Enter a full hostname with its domain, like app.example.com.";
  if (!labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    return "That isn't a valid hostname: use letters, digits, hyphens and dots.";
  }
  if (/^[0-9]+$/.test(labels.at(-1)!)) return "Enter a hostname, not an IP address.";
  if (hostname === new URL(deps.publicUrl).hostname) return "That's the deployer's own address.";
  const aws = AWS_SUFFIXES.find((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
  if (aws) return `Names under ${aws} belong to AWS; use a domain you own.`;
  return null;
}

/** The env's CloudFront hostname: what the custom domain's CNAME points at. Null until the env is deployed. */
export function cloudfrontHost(app: AppRow, env: AppEnv): string | null {
  const url = env === "staging" ? app.stagingUrl : app.prodUrl;
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function setStatus(deps: Deps, d: DomainRow, values: Partial<DomainRow>): boolean {
  const result = deps.db
    .update(domains)
    .set({ ...values, updatedAt: iso(deps) })
    .where(and(eq(domains.id, d.id), eq(domains.status, d.status)))
    .run();
  return result.changes > 0;
}

function deployInFlight(deps: Deps, app: string, env: AppEnv): boolean {
  return !!deps.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.app, app), eq(jobs.env, env), eq(jobs.kind, "deploy"), inArray(jobs.status, ACTIVE)))
    .get();
}

/** Queue the deploy that attaches or detaches the domain, if the app can deploy. */
function redeploy(deps: Deps, app: AppRow, env: AppEnv, by: string): JobRow | null {
  return canChangeDomains(app) ? queueRedeploy(deps, app.name, env, by) : null;
}

async function requestCertificate(deps: Deps, d: DomainRow, token: string): Promise<string> {
  try {
    return await deps.platform.requestCertificate({
      hostname: d.hostname,
      idempotencyToken: token,
      tags: { platform: "slipway", app: d.app, env: d.env },
    });
  } catch (err) {
    deps.log("certificate request failed", { app: d.app, env: d.env, hostname: d.hostname, error: String(err) });
    if ((err as { name?: string }).name === "AccessDeniedException") {
      throw new ApiError(502, "The deployer isn't allowed to request certificates yet: whoever set slipway up needs to run slipway setup --yes again, which updates its IAM role.");
    }
    throw new ApiError(502, `Couldn't request a certificate for ${d.hostname}: ${(err as Error).message}`);
  }
}

async function deleteCertificateQuietly(deps: Deps, d: DomainRow): Promise<void> {
  if (!d.certificateArn) return;
  try {
    await deps.platform.deleteCertificate(d.certificateArn);
  } catch (err) {
    deps.log("deleting a certificate failed", { hostname: d.hostname, arn: d.certificateArn, error: String(err) });
  }
}

// --- Dashboard actions --------------------------------------------------------

export async function addDomain(deps: Deps, app: AppRow, env: AppEnv, input: string, by: string): Promise<DomainRow> {
  if (!canChangeDomains(app)) throw new ApiError(409, `${app.name} is ${app.status.replace(/_/g, " ")}; domains can be added while it's running.`);
  if (!cloudfrontHost(app, env)) throw new ApiError(409, `${env} isn't deployed yet. Add a domain once it is.`);
  const hostname = normalizeHostname(input);
  const problem = hostnameProblem(deps, hostname);
  if (problem) throw new ApiError(400, problem);
  const current = getDomain(deps, app.name, env);
  if (current) throw new ApiError(409, `${env} already has ${current.hostname}. Remove it first.`);
  const taken = deps.db.select().from(domains).where(eq(domains.hostname, hostname)).get();
  if (taken) throw new ApiError(409, `${hostname} is already added to ${taken.app} ${taken.env}.`);

  const now = iso(deps);
  let row: DomainRow;
  try {
    row = deps.db
      .insert(domains)
      .values({ app: app.name, env, hostname, status: "requesting", createdBy: by, createdAt: now, updatedAt: now })
      .returning()
      .get();
  } catch {
    throw new ApiError(409, `${hostname} was just added. Reload the page.`); // the unique hostname, on a double submit
  }
  let arn: string;
  try {
    // Repeating the token within an hour gets the same certificate back.
    arn = await requestCertificate(deps, row, `d${row.id}`);
  } catch (err) {
    deps.db.delete(domains).where(eq(domains.id, row.id)).run();
    throw err;
  }
  setStatus(deps, row, { status: "validating", certificateArn: arn, checkedAt: null });
  deps.log("domain added", { app: app.name, env, hostname, by, certificate: arn });
  deps.kick(); // the validation record shows up on the next polls
  return getDomain(deps, app.name, env) ?? row;
}

export type DomainChange = {
  hostname: string;
  /** The deploy that attaches or detaches it, if one was queued (or reused). */
  job: JobRow | null;
  /** remove: the domain is gone already. retry: a new certificate was requested. */
  done: boolean;
};

/** Detach and forget the env's domain. */
export async function removeDomain(deps: Deps, app: AppRow, env: AppEnv, by: string): Promise<DomainChange> {
  const d = getDomain(deps, app.name, env);
  if (!d) throw new ApiError(404, `${env} has no custom domain.`);
  if (d.status === "removing") throw new ApiError(409, `${d.hostname} is already being removed.`);
  if (d.status === "requesting") throw new ApiError(409, `The certificate for ${d.hostname} is still being requested. Try again in a moment.`);

  // Attached, or about to be: a deploy has to detach it before the certificate can go.
  let attached = d.status === "attaching" || d.status === "active";
  if (!attached && d.certificateArn) {
    const result = await deps.platform.deleteCertificate(d.certificateArn).catch((err) => {
      deps.log("deleting a certificate failed", { hostname: d.hostname, error: String(err) });
      return "in_use" as const; // leave it to the poller
    });
    attached = result === "in_use";
  }
  if (!attached) {
    deps.db.delete(domains).where(and(eq(domains.id, d.id), eq(domains.status, d.status))).run();
    deps.log("domain removed", { app: app.name, env, hostname: d.hostname, by });
    return { hostname: d.hostname, job: null, done: true };
  }
  if (!setStatus(deps, d, { status: "removing", error: null, jobId: null, checkedAt: null })) {
    throw new ApiError(409, `${d.hostname} changed while you were looking. Reload the page.`);
  }
  const job = redeploy(deps, app, env, by);
  deps.log("domain removing", { app: app.name, env, hostname: d.hostname, by, job: job?.id });
  return { hostname: d.hostname, job, done: false };
}

/** After a failure: request a new certificate, or attach again, or detach again. */
export async function retryDomain(deps: Deps, app: AppRow, env: AppEnv, by: string): Promise<DomainChange> {
  const d = getDomain(deps, app.name, env);
  if (!d) throw new ApiError(404, `${env} has no custom domain.`);
  if (d.status === "removing") {
    if (!setStatus(deps, d, { error: null, checkedAt: null })) throw new ApiError(409, "That changed meanwhile. Reload the page.");
    const job = redeploy(deps, app, env, by);
    return { hostname: d.hostname, job, done: false };
  }
  if (d.status !== "failed") throw new ApiError(409, `${d.hostname} hasn't failed; nothing to retry.`);
  const certificate = d.certificateArn ? await deps.platform.describeCertificate(d.certificateArn).catch(() => null) : null;
  if (certificate?.status === "ISSUED") {
    // The certificate is fine; the deploy attaching it failed.
    if (!setStatus(deps, d, { status: "attaching", error: null, jobId: null })) throw new ApiError(409, "That changed meanwhile. Reload the page.");
    const job = redeploy(deps, app, env, by);
    deps.log("domain attach retried", { app: app.name, env, hostname: d.hostname, by, job: job?.id });
    return { hostname: d.hostname, job, done: false };
  }
  const arn = await requestCertificate(deps, d, `d${d.id}r${deps.now().getTime()}`);
  if (!setStatus(deps, d, { status: "validating", certificateArn: arn, validationName: null, validationValue: null, error: null, checkedAt: null })) {
    throw new ApiError(409, "That changed meanwhile. Reload the page.");
  }
  await deleteCertificateQuietly(deps, d);
  deps.log("domain certificate re-requested", { app: app.name, env, hostname: d.hostname, by, certificate: arn });
  deps.kick();
  return { hostname: d.hostname, job: null, done: true };
}

// --- Deploys -------------------------------------------------------------------

/** deploy-env inputs for a deploy of the env: the domain while it's attaching or attached. */
export function domainInputs(deps: Deps, app: string, env: AppEnv): Record<string, string> {
  const d = getDomain(deps, app, env);
  if (!d || !d.certificateArn || !["attaching", "active"].includes(d.status)) return {};
  return { CUSTOM_DOMAIN: d.hostname, CERTIFICATE_ARN: d.certificateArn };
}

/** A deploy of the env started: it's the one that attaches or detaches a pending domain. */
export function domainDeployStarted(deps: Deps, job: JobRow, env: AppEnv): void {
  const d = getDomain(deps, job.app, env);
  if (d && (d.status === "attaching" || d.status === "removing")) setStatus(deps, d, { jobId: job.id });
}

/** A deploy of the env finished (job.status says how). */
export function domainDeployFinished(deps: Deps, job: JobRow, env: AppEnv): void {
  const d = getDomain(deps, job.app, env);
  if (!d || d.jobId !== job.id) return;
  // Phase 1 applies the whole stack, distribution included: past it, the change is in.
  const applied = job.status === "succeeded" || AFTER_PHASE1.includes(job.failedStep ?? "");
  const why = `${job.failedStep ? ` in step ${job.failedStep}` : ""}: ${job.error ?? "see the job's log"}`;
  if (d.status === "attaching") {
    setStatus(deps, d, applied ? { status: "active", error: null } : { status: "failed", error: `The deploy attaching it failed${why}` });
  } else if (d.status === "removing") {
    setStatus(deps, d, applied ? { error: null, checkedAt: null } : { error: `The deploy detaching it failed${why}` });
    if (applied) deps.kick();
  }
}

/** The env (or, for "shared", the whole app) was torn down: its distribution is gone, so the certificates can go. */
export function domainsTornDown(deps: Deps, app: string, env: AppEnv | "shared"): void {
  const rows = deps.db.select().from(domains).where(eq(domains.app, app)).all();
  for (const d of rows) {
    if (env !== "shared" && d.env !== env) continue;
    if (d.status !== "removing") setStatus(deps, d, { status: "removing", error: null, jobId: null, checkedAt: null });
  }
}

// --- Polling (the worker's tick) --------------------------------------------------

export async function pollDomains(deps: Deps): Promise<void> {
  const rows = deps.db
    .select()
    .from(domains)
    .where(inArray(domains.status, ["requesting", "validating", "removing"]))
    .all();
  const now = deps.now().getTime();
  for (const d of rows) {
    const every = d.status === "validating" && !d.validationName ? RECORD_POLL_MS : DOMAIN_POLL_MS;
    if (d.checkedAt && now - Date.parse(d.checkedAt) < every) continue;
    try {
      await pollDomain(deps, d);
    } catch (err) {
      deps.log("checking a domain failed", { app: d.app, env: d.env, hostname: d.hostname, error: String(err) });
      deps.db.update(domains).set({ checkedAt: iso(deps) }).where(eq(domains.id, d.id)).run();
    }
  }
}

async function pollDomain(deps: Deps, d: DomainRow): Promise<void> {
  const checked = { checkedAt: iso(deps) };
  if (d.status === "requesting") {
    if (deps.now().getTime() - Date.parse(d.updatedAt) > REQUEST_TIMEOUT_MS) {
      setStatus(deps, d, { status: "failed", error: "Requesting the certificate was interrupted. Retry, or remove the domain.", ...checked });
    }
    return;
  }
  if (d.status === "removing") {
    // Wait for the deploy detaching it: until it's done, CloudFront may still use the certificate.
    if (deployInFlight(deps, d.app, d.env as AppEnv)) return;
    const result = d.certificateArn ? await deps.platform.deleteCertificate(d.certificateArn) : "not_found";
    if (result === "in_use") {
      deps.db.update(domains).set(checked).where(eq(domains.id, d.id)).run();
      return;
    }
    deps.db.delete(domains).where(and(eq(domains.id, d.id), eq(domains.status, "removing"))).run();
    deps.log("domain removed", { app: d.app, env: d.env, hostname: d.hostname });
    return;
  }

  // validating
  if (!d.certificateArn) return;
  const certificate = await deps.platform.describeCertificate(d.certificateArn);
  const record = certificate.record ? { validationName: certificate.record.name, validationValue: certificate.record.value } : {};
  if (certificate.status === "ISSUED") {
    if (!setStatus(deps, d, { status: "attaching", error: null, jobId: null, ...record, ...checked })) return;
    const app = getApp(deps, d.app);
    const job = app ? redeploy(deps, app, d.env as AppEnv, d.createdBy) : null;
    deps.log("domain certificate issued", { app: d.app, env: d.env, hostname: d.hostname, job: job?.id });
    return;
  }
  if (certificate.status !== "PENDING_VALIDATION") {
    setStatus(deps, d, { status: "failed", error: certificateFailure(certificate.status, certificate.failureReason), ...record, ...checked });
    return;
  }
  setStatus(deps, d, { ...record, ...checked });
}

/** ACM's reasons, in words someone fixing their DNS can act on. */
export function certificateFailure(status: string, reason: string | undefined): string {
  if (status === "VALIDATION_TIMED_OUT") return "ACM didn't find the validation record within 72 hours. Check the record, then retry.";
  switch (reason) {
    case "CAA_ERROR":
      return "The domain's CAA records don't allow Amazon to issue certificates. Add a CAA record for amazon.com, then retry.";
    case "DOMAIN_NOT_ALLOWED":
    case "ADDITIONAL_VERIFICATION_REQUIRED":
      return `ACM won't issue a certificate for this name (${reason}). Ask the dev team.`;
    case "INVALID_PUBLIC_DOMAIN":
      return "ACM says that isn't a public domain name. Check the spelling.";
    default:
      return `ACM couldn't issue the certificate (${reason ?? status}). Retry, or ask the dev team.`;
  }
}
