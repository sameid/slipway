// Configuration from the environment. On the instance these come from
// /etc/slipway/deployer.env (written by the foundation's user data); locally,
// from deployer/.env. See docs/contracts.md, "Deployer host".
import { join } from "node:path";
import type { OwnerType } from "./github.js";

export type Config = {
  production: boolean;
  fake: boolean;
  host: string;
  port: number;
  region: string;
  dataDir: string;
  dbFile: string;
  /** The GitHub org or personal account that owns every app repo. */
  owner: string;
  /** Extra logins allowed to use the plugin API when the owner is a personal account (lowercase). */
  allowedUsers: string[];
  /** CODEOWNERS entry for platform-owned files in new apps; unset uses a default (see /api/whoami). */
  codeowners?: string;
  /** SSM parameter holding allowedUsers and codeowners as JSON; read at startup in place of the env vars. */
  githubAccessParam?: string;
  /** The runner's Unix socket (docs/contracts.md, "Runner"). */
  runnerSocket: string;
  githubAppSecretId: string;
  githubApp?: { appId: string; privateKey: string; webhookSecret: string };
  /** KMS key for app secrets. Unset: SSM's AWS-managed key (aws/ssm), which is what production uses. */
  secretsKmsKeyId?: string;
  /** The deployer's public URL (https://dxxxx.cloudfront.net). Production sets it in deployer.env. */
  publicUrl?: string;
  /** Alternative to PUBLIC_URL: an SSM parameter holding it. */
  publicUrlParam?: string;
  /** SNS topic told about failed prod deploys. */
  alertsTopicArn?: string;
  /** Delay between tries when a just-created repo isn't visible yet (POST /api/apps). */
  registerRetryMs: number;
  workerIntervalMs: number;
  fakeBuildSeconds: number;
  /** Fake mode only: simulate an org or a personal account (FAKE_OWNER_TYPE=User). */
  fakeOwnerType: OwnerType;
};

const logins = (list: string[]) => list.map((login) => login.trim().replace(/^@/, "").toLowerCase()).filter(Boolean);

/** Apply GITHUB_ACCESS_PARAM's value: {"allowedUsers": ["login"], "codeowners": "@org/team"}. */
export function withGithubAccess(config: Config, json: string): Config {
  const value = JSON.parse(json) as { allowedUsers?: unknown; codeowners?: unknown };
  const allowed = Array.isArray(value.allowedUsers) ? value.allowedUsers.filter((u): u is string => typeof u === "string") : [];
  const codeowners = typeof value.codeowners === "string" ? value.codeowners.trim() : "";
  return { ...config, allowedUsers: logins(allowed), codeowners: codeowners || undefined };
}

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing environment variable ${name}`);
}

export function loadConfig(): Config {
  const fake = process.env.DEPLOYER_FAKE === "1";
  const production = process.env.NODE_ENV === "production";
  if (fake && production) throw new Error("DEPLOYER_FAKE=1 can't be used with NODE_ENV=production");
  const dataDir = env("DATA_DIR", production ? undefined : "./data");

  // Local development against a real GitHub App can skip Secrets Manager.
  const appId = process.env.GITHUB_APP_ID;
  const githubApp = appId
    ? {
        appId,
        privateKey: env("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n"),
        webhookSecret: env("GITHUB_WEBHOOK_SECRET"),
      }
    : undefined;

  return {
    production,
    fake,
    // On the instance Caddy listens for CloudFront and proxies to 127.0.0.1:3000.
    host: env("HOST", "127.0.0.1"),
    port: Number(env("PORT", "8080")),
    region: env("AWS_REGION", fake ? "us-east-1" : undefined),
    dataDir,
    dbFile: join(dataDir, "deployer.db"),
    owner: env("GITHUB_OWNER", fake ? "acme" : undefined),
    allowedUsers: logins((process.env.GITHUB_ALLOWED_USERS ?? "").split(/[\s,]+/)),
    codeowners: process.env.GITHUB_CODEOWNERS || undefined,
    githubAccessParam: process.env.GITHUB_ACCESS_PARAM || undefined,
    runnerSocket: env("RUNNER_SOCKET", fake || !production ? "./data/runner/runner.sock" : undefined),
    githubAppSecretId: env("GITHUB_APP_SECRET_ID", "slipway/github-app"),
    githubApp,
    secretsKmsKeyId: process.env.SECRETS_KMS_KEY_ID || undefined,
    publicUrl: process.env.PUBLIC_URL || (fake ? `http://localhost:${env("PORT", "8080")}` : undefined),
    publicUrlParam: process.env.PUBLIC_URL_PARAM || undefined,
    alertsTopicArn: process.env.ALERTS_TOPIC_ARN || undefined,
    registerRetryMs: Number(env("REGISTER_RETRY_MS", "2000")),
    workerIntervalMs: Number(env("WORKER_INTERVAL_SECONDS", fake ? "2" : "15")) * 1000,
    fakeBuildSeconds: Number(env("FAKE_BUILD_SECONDS", "5")),
    fakeOwnerType: process.env.FAKE_OWNER_TYPE === "User" ? "User" : "Organization",
  };
}
