import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import { hashPassword } from "../src/auth/passwords.js";
import type { Config } from "../src/config.js";
import { openDb } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { jobs, users, type JobRow } from "../src/db/schema.js";
import type { Deps } from "../src/deps.js";
import { handleGithubEvent } from "../src/events.js";
import { FAKE_WEBHOOK_SECRET, FakeGitHub, FakePlatform, FakeRuns } from "../src/fake.js";
import type { OwnerType } from "../src/github.js";
import { registerApp } from "../src/registration.js";
import { Worker } from "../src/worker.js";

export const testConfig = (over: Partial<Config> = {}): Config => ({
  production: false,
  fake: true,
  host: "127.0.0.1",
  port: 0,
  region: "us-east-1",
  dataDir: ":memory:",
  dbFile: ":memory:",
  owner: "acme",
  allowedUsers: [],
  runnerSocket: "/nonexistent/runner.sock",
  githubAppSecretId: "slipway/github-app",
  publicUrl: "https://deployer.test",
  registerRetryMs: 0,
  workerIntervalMs: 60_000,
  fakeBuildSeconds: 0,
  fakeOwnerType: "Organization",
  ...over,
});

export type TestEnv = {
  deps: Deps;
  github: FakeGitHub;
  runs: FakeRuns;
  platform: FakePlatform;
  worker: Worker;
  clock: { now: number; advance(ms: number): void };
  logs: string[];
};

export function setup(config: Partial<Config> = {}, ownerType: OwnerType = "Organization"): TestEnv {
  const db = openDb(":memory:");
  runMigrations(db);
  const clock = {
    now: Date.parse("2026-10-12T12:00:00Z"),
    advance(ms: number) {
      this.now += ms;
    },
  };
  const github = new FakeGitHub(testConfig(config).owner, ownerType);
  const runs = new FakeRuns({ github, now: () => clock.now });
  const platform = new FakePlatform();
  const logs: string[] = [];
  const deps: Deps = {
    db,
    config: testConfig(config),
    github,
    runs,
    platform,
    publicUrl: "https://deployer.test",
    now: () => new Date(clock.now),
    log: (message) => logs.push(message),
    kick: () => {},
  };
  return { deps, github, runs, platform, worker: new Worker(deps), clock, logs };
}

export const jobsOf = (t: TestEnv, app?: string): JobRow[] =>
  (app ? t.deps.db.select().from(jobs).where(eq(jobs.app, app)) : t.deps.db.select().from(jobs)).orderBy(jobs.id).all();

export const running = (t: TestEnv): JobRow[] => jobsOf(t).filter((j) => j.status === "running");

/** Finish every running run (or those matching `which`) and run a worker tick. */
export async function finishRunning(
  t: TestEnv,
  status: "succeeded" | "failed" = "succeeded",
  which: (j: JobRow) => boolean = () => true,
  opts: { failStep?: string; error?: string } = {},
): Promise<void> {
  for (const job of running(t).filter(which)) t.runs.finish(job.runId!, status, opts);
  await t.worker.tick();
}

/** Register an app and drive its first deploy to staging. */
export async function liveApp(t: TestEnv, name = "loan-tracker", owner = "alice"): Promise<void> {
  await registerApp(t.deps, name, owner);
  await t.worker.tick();
  for (let i = 0; i < 3; i++) await finishRunning(t);
}

/** Deliver a fake GitHub event straight to the handler (no HTTP). */
export async function drainEvents(t: TestEnv): Promise<void> {
  // FakeGitHub emits on setImmediate; give them a turn to run.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

export function routeEvents(t: TestEnv): void {
  t.github.onEvent = (name, payload) => handleGithubEvent(t.deps, name, payload);
}

export async function serve(t: TestEnv): Promise<{ url: string; close: () => Promise<void> }> {
  const app = createApp(t.deps);
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export const sign = (body: string, secret = FAKE_WEBHOOK_SECRET) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

export async function addUser(
  t: TestEnv,
  email: string,
  password: string,
  opts: { isAdmin?: boolean; mustChangePassword?: boolean } = {},
): Promise<void> {
  t.deps.db
    .insert(users)
    .values({
      email,
      name: email.split("@")[0]!,
      passwordHash: await hashPassword(password),
      isAdmin: opts.isAdmin ?? false,
      mustChangePassword: opts.mustChangePassword ?? false,
      createdAt: new Date(t.clock.now).toISOString(),
    })
    .run();
}

/** A tiny cookie-keeping client for dashboard tests. */
export class Browser {
  cookies = new Map<string, string>();
  constructor(
    private base: string,
    private headers: Record<string, string> = {},
  ) {}

  async request(path: string, init: { method?: string; form?: Record<string, string> } = {}) {
    const res = await fetch(this.base + path, {
      method: init.method ?? (init.form ? "POST" : "GET"),
      redirect: "manual",
      headers: {
        ...this.headers,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(init.form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: init.form ? new URLSearchParams(init.form).toString() : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const [k, v] = pair!.split("=");
      this.cookies.set(k!, v!);
    }
    return { res, text: await res.text() };
  }

  async csrf(path: string): Promise<string> {
    const { text } = await this.request(path);
    const m = text.match(/name="_csrf" value="([^"]+)"/);
    if (!m) throw new Error(`no CSRF token on ${path}`);
    return m[1]!;
  }

  async login(email: string, password: string) {
    const _csrf = await this.csrf("/login");
    return this.request("/login", { form: { _csrf, email, password, next: "/" } });
  }
}
