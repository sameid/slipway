// The runner (docs/contracts.md, "Runner"): runs build-release and deploy-env
// jobs as child processes on the deployer instance, in place of CodeBuild.
//
// build-release runs jobs/build-release.sh once per phase:
//   prepare  as the runner      unpack the source, validate app.yaml, open work/ to the build user
//   verify   as the build user  (sudo, clean environment, no AWS credentials) npm ci, checks, tests
//   image    as the runner      docker build
//   publish  as the runner      with AWS credentials (release mode only)
// deploy-env runs jobs/deploy-env.sh as the runner with AWS credentials.
// On the instance those are the instance role's, unless RUNNER_PUBLISH_PROFILE /
// RUNNER_DEPLOY_PROFILE name a profile in the runner's ~/.aws/config.
//
// Sharing work/ with the build user, without group memberships (pm2 starts the
// runner with its primary group only, and the host has no shared group):
//   - The run dir stays the runner's (0750); while the build runs it gets an ACL
//     entry giving the build user "x" only, so it can reach work/ by path. The
//     host gives it the same on the runner's data dir and runs/.
//   - work/ itself is 0777. Only the runner and the build user can get to it, so
//     its "other" bits are in effect the build user's permissions.
//   - prepare (SLIPWAY_SHARE_WORK=1) makes what it unpacked a+rwX so the build
//     user can install into it and delete it; verify ends by making everything
//     it created a+rX so the runner can read it for the image and publish phases.
//   - Cleanup deletes work/'s contents as the build user (sudo), since the
//     runner can't remove what the build user owns, then work/ and the ACL.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import type { RunKind } from "../runs.js";
import type { RunnerConfig } from "./config.js";
import { RunStore, type RunRecord } from "./store.js";

/** Inputs each kind accepts (contracts: build-release and deploy-env). Anything else is refused. */
export const INPUTS: Record<RunKind, string[]> = {
  "build-release": ["APP", "COMMIT_SHA", "MODE", "PR_NUMBER", "VERIFIED_BY_CHECK"],
  "deploy-env": [
    "APP", "ENV", "ACTION", "COMMIT_SHA", "IMAGE_DIGEST", "WEB_ARTIFACT", "DEPLOY_ID",
    "CUSTOM_DOMAIN", "CERTIFICATE_ARN", // only when the env has a custom domain
  ],
};

/** Exports each kind may return; other keys in exports.env are ignored. */
export const EXPORTS: Record<RunKind, string[]> = {
  "build-release": ["IMAGE_DIGEST", "IMAGE_URI", "WEB_ARTIFACT"],
  "deploy-env": ["APP_URL", "SERVICE_URL"],
};

const INPUT_VALUE = /^[A-Za-z0-9:/._@+-]{0,512}$/;
const APP_NAME = /^[a-z][a-z0-9-]{1,18}[a-z0-9]$/;

/** `aws`: the phase gets AWS credentials (and which optional profile applies). */
type Phase = { name: string; asBuildUser: boolean; aws?: "publish" | "deploy" };

type Active = { kind: RunKind; child?: ChildProcess; cancelled?: string; timer?: NodeJS.Timeout };

export class RunnerError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Runner {
  readonly store: RunStore;
  private queue: RunRecord[] = [];
  private active = new Map<string, Active>();
  private draining = false;
  private idle: (() => void)[] = [];

  constructor(
    private config: RunnerConfig,
    private opts: { now?: () => Date; log?: (message: string, extra?: Record<string, unknown>) => void } = {},
  ) {
    this.store = new RunStore(config.dataDir);
  }

  private now = () => (this.opts.now ?? (() => new Date()))();
  private log = (message: string, extra?: Record<string, unknown>) => this.opts.log?.(message, extra);

  /** On start: runs that were running can't be resumed and fail; queued ones still run. */
  recover(): void {
    for (const run of this.store.all()) {
      if (run.status === "running") {
        this.store.appendLog(run.id, "ERROR: runner restarted during this run");
        this.finish(run, "failed", null);
      } else if (run.status === "queued") {
        this.queue.push(run);
      } else if (existsSync(this.store.workPath(run.id)) || existsSync(this.store.sourcePath(run.id))) {
        void this.cleanWork(run);
      }
    }
  }

  submit(kind: unknown, env: unknown, sourceZip: unknown): RunRecord {
    if (this.draining) throw new RunnerError(503, "the runner is shutting down");
    if (kind !== "build-release" && kind !== "deploy-env") throw new RunnerError(400, "kind must be build-release or deploy-env");
    if (!env || typeof env !== "object" || Array.isArray(env)) throw new RunnerError(400, "env must be an object");
    const inputs: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (!INPUTS[kind].includes(key)) throw new RunnerError(400, `${kind} doesn't take ${key}`);
      if (typeof value !== "string" || !INPUT_VALUE.test(value)) throw new RunnerError(400, `invalid value for ${key}`);
      inputs[key] = value;
    }
    if (!APP_NAME.test(inputs.APP ?? "")) throw new RunnerError(400, "APP must be a valid app name");
    let zip: Buffer | undefined;
    if (kind === "build-release") {
      if (typeof sourceZip !== "string" || !sourceZip) throw new RunnerError(400, "build-release needs sourceZip");
      zip = Buffer.from(sourceZip, "base64");
      if (zip.length < 22 || zip.readUInt32LE(0) !== 0x04034b50) throw new RunnerError(400, "sourceZip isn't a zip file");
    } else if (sourceZip !== undefined) {
      throw new RunnerError(400, "deploy-env takes no source");
    }
    const run = this.store.create(kind, inputs, zip, this.now());
    this.store.appendLog(run.id, `[runner] queued ${kind}: ${describe(inputs)}`);
    this.queue.push(run);
    this.log("run queued", { run: run.id, kind, app: inputs.APP });
    setImmediate(() => this.pump());
    return run;
  }

  /** false if there's no such run. A queued run is dropped; a running one is stopped. */
  cancel(id: string): boolean {
    const run = this.store.get(id);
    if (!run) return false;
    const queued = this.queue.findIndex((r) => r.id === id);
    if (queued >= 0) {
      this.queue.splice(queued, 1);
      this.store.appendLog(id, "ERROR: cancelled before it started");
      this.finish(run, "failed", null);
    } else if (this.active.has(id)) {
      this.stop(id, "ERROR: cancelled");
    }
    return true;
  }

  /** Start queued runs, oldest first, while their kind is under its cap. */
  pump(): void {
    if (this.draining) return;
    const running = { "build-release": 0, "deploy-env": 0 };
    for (const a of this.active.values()) running[a.kind]++;
    const cap = { "build-release": this.config.maxBuilds, "deploy-env": this.config.maxDeploys };
    for (const run of [...this.queue]) {
      if (running[run.kind] >= cap[run.kind]) continue;
      running[run.kind]++;
      this.queue.splice(this.queue.indexOf(run), 1);
      this.active.set(run.id, { kind: run.kind });
      void this.execute(run).catch((err) => this.log("run crashed", { run: run.id, error: String(err) }));
    }
  }

  /** Stop taking runs, wait up to the grace period for active ones, then stop them. */
  async drain(): Promise<void> {
    this.draining = true;
    if (!this.active.size) return;
    this.log("waiting for active runs", { runs: [...this.active.keys()] });
    const done = new Promise<void>((resolve) => this.idle.push(resolve));
    const timer = setTimeout(() => {
      for (const id of this.active.keys()) this.stop(id, "ERROR: the runner was stopped during this run");
    }, this.config.shutdownGraceMs);
    await done;
    clearTimeout(timer);
  }

  stats(): { running: number; queued: number } {
    return { running: this.active.size, queued: this.queue.length };
  }

  // --- Running ----------------------------------------------------------------

  private phases(run: RunRecord): Phase[] {
    if (run.kind === "deploy-env") return [{ name: "deploy", asBuildUser: false, aws: "deploy" }];
    const phases: Phase[] = [
      { name: "prepare", asBuildUser: false },
      { name: "verify", asBuildUser: true },
      { name: "image", asBuildUser: false },
    ];
    if (run.env.MODE === "release") phases.push({ name: "publish", asBuildUser: false, aws: "publish" });
    return phases;
  }

  private async execute(queued: RunRecord): Promise<void> {
    const run: RunRecord = { ...queued, status: "running", startedAt: this.now().toISOString() };
    this.store.save(run);
    const active = this.active.get(run.id)!;
    const timeout = run.kind === "build-release" ? this.config.buildTimeoutMs : this.config.deployTimeoutMs;
    active.timer = setTimeout(
      () => this.stop(run.id, `ERROR: ${run.kind} took longer than ${Math.round(timeout / 60_000)} minutes and was stopped`),
      timeout,
    );
    this.log("run started", { run: run.id, kind: run.kind, app: run.env.APP });

    let exitCode: number | null = 0;
    try {
      // Resolve the release once, so switching releases during a run doesn't mix versions.
      const home = realpathSync(this.config.home);
      this.prepareWork(run);
      for (const phase of this.phases(run)) {
        if (active.cancelled) break;
        exitCode = await this.runPhase(run, phase, home, active);
        if (exitCode !== 0) break;
      }
    } catch (err) {
      this.store.appendLog(run.id, `ERROR: the runner couldn't run this job: ${err instanceof Error ? err.message : String(err)}`);
      exitCode = null;
    }
    clearTimeout(active.timer);
    if (active.cancelled) this.store.appendLog(run.id, active.cancelled);
    const ok = exitCode === 0 && !active.cancelled;
    const finished = this.finish({ ...run, exported: ok ? this.readExports(run) : {} }, ok ? "succeeded" : "failed", exitCode);
    this.log("run finished", { run: run.id, status: finished.status, exitCode });
    this.active.delete(run.id);
    if (this.draining && !this.active.size) for (const resolve of this.idle.splice(0)) resolve();
    this.pump();
  }

  private finish(run: RunRecord, status: "succeeded" | "failed", exitCode: number | null): RunRecord {
    const done: RunRecord = { ...run, status, exitCode, finishedAt: this.now().toISOString() };
    this.store.save(done);
    void this.cleanWork(done);
    return done;
  }

  private prepareWork(run: RunRecord): void {
    const work = this.store.workPath(run.id);
    mkdirSync(work, { recursive: true });
    if (this.config.buildUser && run.kind === "build-release") {
      execFileSync("setfacl", ["-m", `u:${this.config.buildUser}:x`, this.store.dir(run.id)], { stdio: "pipe" });
      chmodSync(work, 0o777);
    }
  }

  private runPhase(run: RunRecord, phase: Phase, home: string, active: Active): Promise<number | null> {
    const script = join(home, "jobs", run.kind === "deploy-env" ? "deploy-env.sh" : "build-release.sh");
    const args = run.kind === "deploy-env" ? [script] : [script, phase.name];
    const asBuildUser = phase.asBuildUser && !!this.config.buildUser;
    const env = this.phaseEnv(run, phase, home);
    const who = asBuildUser ? this.config.buildUser : userInfo().username;
    this.store.appendLog(run.id, `[runner] ${phase.name}: as ${who}${env.AWS_PROFILE ? ` with AWS profile ${env.AWS_PROFILE}` : ""}`);

    const [command, argv, childEnv]: [string, string[], Record<string, string>] = asBuildUser
      ? [
          "sudo",
          // env -i: the build user gets exactly these variables and nothing from the runner.
          ["-n", "-H", "-u", this.config.buildUser, "--", "/usr/bin/env", "-i", ...Object.entries(env).map(([k, v]) => `${k}=${v}`), "/bin/bash", ...args],
          { PATH: "/usr/bin:/bin" },
        ]
      : ["/bin/bash", args, env];

    const fd = openSync(this.store.logPath(run.id), "a");
    return new Promise((resolve) => {
      let settled = false;
      const done = (code: number | null) => {
        if (settled) return;
        settled = true;
        closeSync(fd);
        active.child = undefined;
        resolve(code);
      };
      const child = spawn(command, argv, {
        cwd: this.store.workPath(run.id),
        env: childEnv,
        stdio: ["ignore", fd, fd],
        detached: true, // its own process group, so stop() reaches everything it starts
      });
      active.child = child;
      child.on("error", (err) => {
        this.store.appendLog(run.id, `ERROR: couldn't start the ${phase.name} phase: ${err.message}`);
        done(null);
      });
      child.on("close", (code, signal) => {
        if (signal) this.store.appendLog(run.id, `[runner] ${phase.name} ended by ${signal}`);
        done(code);
      });
    });
  }

  /** The environment of one phase: the run's inputs plus the contract's variables, nothing inherited. */
  phaseEnv(run: RunRecord, phase: Phase, home: string): Record<string, string> {
    const nodeBin = dirname(process.execPath);
    const env: Record<string, string> = {
      ...run.env,
      LANG: "C.UTF-8",
      SLIPWAY_HOME: home,
      SLIPWAY_WORK: this.store.workPath(run.id),
      SLIPWAY_RUN_ID: run.id,
      SLIPWAY_IMAGE: localImage(run),
    };
    if (this.config.dev) env.SLIPWAY_DEV = "1";
    if (this.config.buildUser) env.SLIPWAY_SHARE_WORK = "1";

    if (phase.asBuildUser) {
      // Untrusted code: no AWS settings, no exports, no access to the runner's files.
      const buildHome = this.config.buildUser ? (this.config.buildUserHome ?? `/home/${this.config.buildUser}`) : userInfo().homedir;
      const path = this.config.dev ? `${nodeBin}:${process.env.PATH ?? "/usr/bin:/bin"}` : `${nodeBin}:/usr/local/bin:/usr/bin:/bin`;
      return { ...env, HOME: buildHome, PATH: path, SLIPWAY_EXPORTS: "/dev/null" };
    }

    const runnerHome = userInfo().homedir;
    Object.assign(env, {
      HOME: runnerHome,
      AWS_REGION: this.config.region,
      PATH: this.config.dev ? `${nodeBin}:${process.env.PATH ?? "/usr/bin:/bin"}` : `${nodeBin}:/usr/local/bin:/usr/bin:/bin`,
      AWS_ACCOUNT_ID: this.config.accountId,
      RELEASES_BUCKET: this.config.releasesBucket,
      STATE_BUCKET: this.config.stateBucket,
      SLIPWAY_EXPORTS: this.store.exportsPath(run.id),
    });
    if (phase.name === "prepare") env.SLIPWAY_SOURCE_ZIP = this.store.sourcePath(run.id);
    if (phase.aws) {
      const profile = phase.aws === "publish" ? this.config.publishProfile : this.config.deployProfile;
      if (this.config.dev) {
        // On a laptop, publish and deploy use whatever credentials the developer has.
        for (const key of ["AWS_PROFILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE"]) {
          const value = process.env[key];
          if (value) env[key] = value;
        }
      } else if (profile) {
        env.AWS_PROFILE = profile;
        env.AWS_CONFIG_FILE = join(runnerHome, ".aws", "config");
        env.AWS_SDK_LOAD_CONFIG = "1";
      }
      // No profile: the AWS CLI, SDK and Terraform find the instance role through
      // the metadata service, which only the build user is blocked from.
    }
    return env;
  }

  /** SIGTERM the run's process group, then SIGKILL it if it's still there 30 seconds later. */
  private stop(id: string, reason: string): void {
    const active = this.active.get(id);
    if (!active) return;
    active.cancelled ??= reason;
    const pid = active.child?.pid;
    if (!pid) return;
    const signal = (sig: NodeJS.Signals) => {
      try {
        process.kill(-pid, sig);
      } catch {
        // already gone
      }
    };
    signal("SIGTERM");
    setTimeout(() => {
      if (active.child?.pid === pid) signal("SIGKILL");
    }, 30_000).unref();
  }

  private readExports(run: RunRecord): Record<string, string> {
    const path = this.store.exportsPath(run.id);
    if (!existsSync(path)) return {};
    const allowed = EXPORTS[run.kind];
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1]!;
      if (allowed.includes(key)) out[key] = m[2]!;
      else this.store.appendLog(run.id, `[runner] ignored export ${key}: ${run.kind} doesn't export it`);
    }
    return out;
  }

  /** Delete a finished run's source zip, work/ and local image. */
  private async cleanWork(run: RunRecord): Promise<void> {
    rmSync(this.store.sourcePath(run.id), { force: true });
    const work = this.store.workPath(run.id);
    const shared = !!this.config.buildUser && run.kind === "build-release";
    if (existsSync(work)) {
      // What the build user created, only it can delete (the runner owns nothing inside its dirs).
      if (shared) await quietly("sudo", ["-n", "-H", "-u", this.config.buildUser, "--", "/usr/bin/find", work, "-mindepth", "1", "-delete"]);
      try {
        rmSync(work, { recursive: true, force: true });
      } catch (err) {
        this.log("couldn't delete a work dir", { run: run.id, error: String(err) });
      }
    }
    if (shared) await quietly("setfacl", ["-x", `u:${this.config.buildUser}`, this.store.dir(run.id)]);
    if (run.kind === "build-release") await quietly("docker", ["image", "rm", "-f", localImage(run)]);
  }

  /** Delete runs that finished more than retentionDays ago. */
  prune(): void {
    const cutoff = this.now().getTime() - this.config.retentionDays * 86400_000;
    for (const run of this.store.all()) {
      if (run.finishedAt && Date.parse(run.finishedAt) < cutoff && !this.active.has(run.id)) this.store.remove(run.id);
    }
  }
}

/** The tag the image phase builds; publish pushes it, and cleanup removes it. */
export const localImage = (run: Pick<RunRecord, "id" | "env">) => `slipway-local/app-${run.env.APP}:${run.id}`;

function describe(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

/** Run a command for its side effect; ignore its output and whether it worked. */
function quietly(command: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}
