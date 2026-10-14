// Runner configuration from the environment. On the instance these come from
// /etc/slipway/runner.env (pm2's ecosystem file loads it); see
// docs/contracts.md, "Deployer host".
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RunnerConfig = {
  socket: string;
  /**
   * Group to give the socket. Usually unset: on the instance the socket's
   * directory (/run/slipway) is setgid to the deployer's group.
   */
  socketGroup?: string;
  dataDir: string;
  /** User for the untrusted verify phase; empty only in dev mode. */
  buildUser: string;
  buildUserHome?: string;
  /** Laptop mode: verify runs as the current user and jobs may fall back to local tools. */
  dev: boolean;
  maxBuilds: number;
  maxDeploys: number;
  /** Release directory holding jobs/ and modules/ (resolved per run, so a release switch mid-run is harmless). */
  home: string;
  region: string;
  accountId: string;
  releasesBucket: string;
  stateBucket: string;
  /** Optional AWS profiles for publish and deploy; empty means the instance role, used directly. */
  publishProfile: string;
  deployProfile: string;
  buildTimeoutMs: number;
  deployTimeoutMs: number;
  retentionDays: number;
  /** How long a SIGTERM waits for active runs before stopping them. */
  shutdownGraceMs: number;
};

function env(name: string, fallback?: string): string {
  const value = process.env[name];
  if (value !== undefined && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing environment variable ${name}`);
}

/** The repo root when running from a checkout (deployer/src/runner or deployer/dist/runner). */
const checkoutRoot = () => resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export function loadRunnerConfig(): RunnerConfig {
  const production = process.env.NODE_ENV === "production";
  const dev = process.env.RUNNER_DEV === "1";
  if (dev && production) throw new Error("RUNNER_DEV=1 can't be used with NODE_ENV=production");
  const buildUser = process.env.RUNNER_BUILD_USER ?? "";
  if (!buildUser && !dev) {
    throw new Error("RUNNER_BUILD_USER is required: untrusted build steps never run as the runner's own user (RUNNER_DEV=1 on a laptop)");
  }
  const dataDir = resolve(env("RUNNER_DATA_DIR", dev ? "./data/runner" : undefined));
  // Outside AWS (dev mode, check builds only) the AWS names are placeholders.
  const aws = (name: string, fallback: string) => env(name, dev ? fallback : undefined);
  return {
    socket: resolve(env("RUNNER_SOCKET", dev ? join(dataDir, "runner.sock") : undefined)),
    socketGroup: process.env.RUNNER_SOCKET_GROUP || undefined,
    dataDir,
    buildUser,
    buildUserHome: buildUser ? (passwdEntry(buildUser)?.home ?? `/home/${buildUser}`) : undefined,
    dev,
    maxBuilds: Number(env("RUNNER_MAX_BUILDS", "1")),
    maxDeploys: Number(env("RUNNER_MAX_DEPLOYS", "2")),
    home: resolve(env("SLIPWAY_HOME", dev ? checkoutRoot() : undefined)),
    region: aws("AWS_REGION", "us-east-1"),
    accountId: aws("AWS_ACCOUNT_ID", "000000000000"),
    releasesBucket: aws("RELEASES_BUCKET", "slipway-artifacts-dev"),
    stateBucket: aws("STATE_BUCKET", "slipway-tfstate-dev"),
    publishProfile: process.env.RUNNER_PUBLISH_PROFILE ?? "",
    deployProfile: process.env.RUNNER_DEPLOY_PROFILE ?? "",
    buildTimeoutMs: Number(env("RUNNER_BUILD_TIMEOUT_MINUTES", "45")) * 60_000,
    deployTimeoutMs: Number(env("RUNNER_DEPLOY_TIMEOUT_MINUTES", "120")) * 60_000,
    retentionDays: Number(env("RUNNER_RETENTION_DAYS", "30")),
    shutdownGraceMs: Number(env("RUNNER_SHUTDOWN_GRACE_SECONDS", "840")) * 1000,
  };
}

/** A user's home directory and primary group from the passwd database (getent on Linux). */
export function passwdEntry(user: string): { home: string; gid: number } | undefined {
  try {
    const fields = execFileSync("getent", ["passwd", user], { encoding: "utf8" }).trim().split(":");
    if (fields[3] && fields[5]) return { gid: Number(fields[3]), home: fields[5] };
  } catch {
    // no getent (macOS) or no such user
  }
  return undefined;
}

/** A group's numeric id from /etc/group, for chgrp on the socket. */
export function gidOf(group: string): number | undefined {
  try {
    for (const line of readFileSync("/etc/group", "utf8").split("\n")) {
      const [name, , gid] = line.split(":");
      if (name === group && gid) return Number(gid);
    }
  } catch {
    // no /etc/group
  }
  return undefined;
}
