// SQLite schema (design 5.5). Timestamps are ISO 8601 strings in UTC.
import { index, integer, primaryKey, sqliteTable, text, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer().primaryKey({ autoIncrement: true }),
  email: text().notNull().unique(),
  name: text().notNull(),
  passwordHash: text("password_hash").notNull(), // argon2id
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(true),
  disabled: integer({ mode: "boolean" }).notNull().default(false),
  createdBy: integer("created_by").references((): AnySQLiteColumn => users.id),
  createdAt: text("created_at").notNull(),
  lastLoginAt: text("last_login_at"),
});

// Managed by SqliteSessionStore.
export const sessions = sqliteTable("sessions", {
  sid: text().primaryKey(),
  sess: text().notNull(),
  expire: text().notNull(),
});

export const apps = sqliteTable("apps", {
  name: text().primaryKey(),
  repo: text().notNull(), // acme/my-app
  owner: text().notNull(), // GitHub login
  // registering | active | failed | destroy_requested | destroying | destroyed
  status: text().notNull(),
  autoMerge: integer("auto_merge", { mode: "boolean" }).notNull().default(true),
  stagingReleaseId: integer("staging_release_id"),
  prodReleaseId: integer("prod_release_id"),
  stagingUrl: text("staging_url"),
  prodUrl: text("prod_url"),
  error: text(),
  // The job whose failure failed the app's first deploy (status "failed").
  failedJobId: integer("failed_job_id"),
  destroyRequestedBy: text("destroy_requested_by"),
  destroyRequestedAt: text("destroy_requested_at"),
  createdAt: text("created_at").notNull(),
});

export const releases = sqliteTable(
  "releases",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    app: text()
      .notNull()
      .references(() => apps.name),
    commitSha: text("commit_sha").notNull(),
    imageDigest: text("image_digest"), // sha256:...
    webArtifact: text("web_artifact"), // s3://.../web.tgz
    status: text().notNull(), // building | ready | failed
    runId: text("run_id"), // the runner's build-release run
    // When type check, lint and tests passed on this commit (a verify job, which
    // someone starts on the dashboard). Prod only takes verified releases.
    verifiedAt: text("verified_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("releases_app_commit").on(t.app, t.commitSha)],
);

export const pullRequests = sqliteTable(
  "pull_requests",
  {
    app: text()
      .notNull()
      .references(() => apps.name),
    number: integer().notNull(),
    headSha: text("head_sha").notNull(),
    // checking | check_failed | blocked | merged | closed
    status: text().notNull(),
    checkJobId: integer("check_job_id"),
    mergedSha: text("merged_sha"),
    note: text(),
    // Last "<head sha>:<reason>" we commented about, so a blocked PR gets one comment per head.
    lastCommentKey: text("last_comment_key"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.app, t.number] })],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    app: text().notNull(),
    env: text().notNull(), // shared | staging | prod | build | check | verify
    kind: text().notNull(), // check | build | verify | deploy | destroy
    releaseId: integer("release_id"),
    prNumber: integer("pr_number"),
    commitSha: text("commit_sha"),
    // queued | running | succeeded | failed | superseded
    status: text().notNull(),
    // Starts only after this job succeeds; fails (or is superseded) with it.
    afterJobId: integer("after_job_id"),
    runId: text("run_id"), // the runner's run (docs/contracts.md, "Runner")
    requestedBy: text("requested_by").notNull(),
    failedStep: text("failed_step"),
    error: text(),
    exported: text(), // JSON of the run's exported variables
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (t) => [index("jobs_status").on(t.status), index("jobs_app").on(t.app, t.id)],
);

// Metadata only; values live in Parameter Store.
export const secrets = sqliteTable(
  "secrets",
  {
    app: text()
      .notNull()
      .references(() => apps.name),
    env: text().notNull(), // staging | prod
    key: text().notNull(),
    lastSetBy: text("last_set_by"),
    lastSetAt: text("last_set_at"),
    // Removing: the next deploy leaves it out, and once that deploy succeeds the
    // parameter and this row go (secrets.ts). removeJobId is that deploy.
    removeRequestedBy: text("remove_requested_by"),
    removeRequestedAt: text("remove_requested_at"),
    removeJobId: integer("remove_job_id"),
  },
  (t) => [primaryKey({ columns: [t.app, t.env, t.key] })],
);

// One-time links for setting a value. Only the token's SHA-256 is stored.
export const secretLinks = sqliteTable("secret_links", {
  tokenHash: text("token_hash").primaryKey(),
  id: text().notNull().unique(), // linkId handed to the plugin; not usable to set a value
  app: text().notNull(),
  env: text().notNull(),
  key: text().notNull(),
  createdBy: text("created_by").notNull(),
  expiresAt: text("expires_at").notNull(),
  usedAt: text("used_at"),
  redeployJobId: integer("redeploy_job_id"),
  // Whether the value was saved with "Save and deploy"; null on links used before there was a choice.
  deployRequested: integer("deploy_requested", { mode: "boolean" }),
});

// GitHub webhook deliveries and what the deployer did with each, for the
// dashboard. Only a summary is kept, never the payload; deliveries.ts keeps the newest few thousand.
export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    deliveryId: text("delivery_id"), // X-GitHub-Delivery
    event: text().notNull(), // X-GitHub-Event
    action: text(),
    repo: text(), // as GitHub spells it: Acme/my-app
    app: text(), // the registered app the repo belongs to, if any
    summary: text(), // "PR #3 opened at abc1234"
    // handled | ignored | rejected | failed
    outcome: text().notNull(),
    detail: text(), // what the deployer did, or why it did nothing
    jobId: integer("job_id"), // the job it queued (a check, or a build)
    receivedAt: text("received_at").notNull(),
  },
  (t) => [index("webhook_deliveries_app").on(t.app, t.id)],
);

// Custom domains people add on the dashboard: at most one per app env (domains.ts
// enforces it). The certificate is ACM's, in us-east-1, where CloudFront looks.
export const domains = sqliteTable(
  "domains",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    app: text()
      .notNull()
      .references(() => apps.name),
    env: text().notNull(), // staging | prod
    hostname: text().notNull().unique(), // lowercase, no trailing dot
    // requesting | validating | attaching | active | failed | removing (domains.ts)
    status: text().notNull(),
    certificateArn: text("certificate_arn"),
    // The CNAME that proves control of the name to ACM; filled in once ACM has it.
    validationName: text("validation_name"),
    validationValue: text("validation_value"),
    error: text(),
    jobId: integer("job_id"), // the deploy attaching or detaching it
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    checkedAt: text("checked_at"), // last look at the certificate
  },
  (t) => [index("domains_app_env").on(t.app, t.env)],
);

// Failed dashboard logins, for rate limiting. key is "email:<email>" or "ip:<address>".
export const loginFailures = sqliteTable(
  "login_failures",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    key: text().notNull(),
    at: text().notNull(),
  },
  (t) => [index("login_failures_key").on(t.key, t.at)],
);

export const settings = sqliteTable("settings", {
  key: text().primaryKey(),
  value: text().notNull(),
});

export type User = typeof users.$inferSelect;
export type AppRow = typeof apps.$inferSelect;
export type ReleaseRow = typeof releases.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;
export type SecretLinkRow = typeof secretLinks.$inferSelect;
export type WebhookDeliveryRow = typeof webhookDeliveries.$inferSelect;
export type DomainRow = typeof domains.$inferSelect;
