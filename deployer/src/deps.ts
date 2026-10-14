import type { Platform } from "./aws.js";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import type { GitHub } from "./github.js";
import type { Runs } from "./runs.js";

/** Everything the routes and the worker need; tests and fake mode swap in fakes. */
export type Deps = {
  db: Db;
  config: Config;
  github: GitHub;
  /** The runner on the same instance (a fake in fake mode and tests). */
  runs: Runs;
  platform: Platform;
  /** The deployer's own https URL, used in links it hands out. */
  publicUrl: string;
  now: () => Date;
  log: (message: string, extra?: Record<string, unknown>) => void;
  /** Wake the worker after queueing a job, instead of waiting for the next tick. */
  kick: () => void;
};

export const iso = (deps: Pick<Deps, "now">) => deps.now().toISOString();

export function consoleLog(message: string, extra?: Record<string, unknown>): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), message, ...extra }));
}
