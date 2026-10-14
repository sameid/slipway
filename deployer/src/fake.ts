// Fake mode (DEPLOYER_FAKE=1, docs/contracts.md): an in-memory GitHub org and a
// simulated runner, so the dashboard and the plugin API can be exercised on a
// laptop with no AWS account, GitHub App or runner. The same fakes back the tests.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import express from "express";
import { parse } from "yaml";
import type { DevConfig, Platform } from "./aws.js";
import type { CommitStatus, GitHub, MergeResult, PullInfo } from "./github.js";
import type { RunInfo, Runs, StartRunInput } from "./runs.js";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

type Commit = { sha: string; files: Record<string, string>; failStep?: string };
type FakePull = PullInfo & { files: Record<string, string>; baseMain: string };
type FakeRepo = {
  name: string;
  commits: Map<string, Commit>;
  main: string;
  pulls: Map<number, FakePull>;
  statuses: { sha: string; status: CommitStatus }[];
  comments: { number: number; body: string }[];
  protected: boolean;
  archived: boolean;
};

export const FAKE_WEBHOOK_SECRET = "fake-webhook-secret";

export function defaultAppYaml(name: string): string {
  return [
    `name: ${name}`,
    "template: react-express",
    "description: Fake app for local deployer development",
    "owner: fake",
    "api:",
    "  port: 3000",
    "  health_check: /api/health",
    '  migrate_command: ["node", "dist/migrate.js"]',
    "web:",
    "  build_command: npm run build --workspace web",
    "  output_dir: web/dist",
    "secrets:",
    "  - EXAMPLE_API_KEY",
    "auth: clerk",
    "auto_merge: true",
    "sizes:",
    "  staging: small",
    "  prod: small",
    "",
  ].join("\n");
}

export type EventSink = (name: string, payload: unknown) => Promise<unknown>;

export class FakeGitHub implements GitHub {
  repos = new Map<string, FakeRepo>();
  private nextPull = 1;
  private counter = 0;
  /** Where simulated webhooks go (set by the app in fake mode; tests call the handler directly). */
  onEvent?: EventSink;

  constructor(readonly org = "acme") {}

  /** Repos appear on first use with an app.yaml, as if /new-app had created them. Names starting "missing" don't exist. */
  repo(fullName: string): FakeRepo | undefined {
    const name = fullName.split("/")[1] ?? fullName;
    if (name.startsWith("missing")) return undefined;
    let repo = this.repos.get(name);
    if (!repo) {
      const first = this.commit({ "app.yaml": defaultAppYaml(name), "README.md": `# ${name}\n` });
      repo = {
        name,
        commits: new Map([[first.sha, first]]),
        main: first.sha,
        pulls: new Map(),
        statuses: [],
        comments: [],
        protected: false,
        archived: false,
      };
      this.repos.set(name, repo);
    }
    return repo;
  }

  private must(fullName: string): FakeRepo {
    const repo = this.repo(fullName);
    if (!repo) throw Object.assign(new Error(`Not Found: ${fullName}`), { status: 404 });
    return repo;
  }

  private commit(files: Record<string, string>, failStep?: string): Commit {
    return { sha: sha1(`${++this.counter}:${JSON.stringify(files)}:${Date.now()}`), files, failStep };
  }

  private emit(name: string, payload: unknown): void {
    const sink = this.onEvent;
    if (sink) setImmediate(() => void sink(name, payload).catch((err) => console.error("fake event failed", err)));
  }

  private pullPayload(repo: FakeRepo, pull: FakePull, action: string) {
    return {
      action,
      number: pull.number,
      repository: { full_name: `${this.org}/${repo.name}` },
      sender: { login: "fake-dev" },
      pull_request: {
        number: pull.number,
        state: pull.state,
        draft: pull.draft,
        merged: pull.merged,
        merge_commit_sha: pull.mergeCommitSha,
        title: pull.title,
        head: { sha: pull.headSha, ref: pull.headRef },
        base: { ref: "main", sha: pull.baseSha },
      },
    };
  }

  // --- Simulations driven by tests or /fake routes ---------------------------

  pushToMain(fullName: string, files: Record<string, string> = {}, failStep?: string): string {
    const repo = this.must(fullName);
    const base = repo.commits.get(repo.main)!;
    const c = this.commit({ ...base.files, ...files }, failStep);
    repo.commits.set(c.sha, c);
    repo.main = c.sha;
    this.emit("push", {
      ref: "refs/heads/main",
      after: c.sha,
      repository: { full_name: `${this.org}/${repo.name}` },
      sender: { login: "fake-dev" },
    });
    return c.sha;
  }

  openPull(
    fullName: string,
    opts: { title?: string; branch?: string; files?: Record<string, string>; failStep?: string; draft?: boolean } = {},
  ): FakePull {
    const repo = this.must(fullName);
    const base = repo.commits.get(repo.main)!;
    const files = opts.files ?? { [`src/change-${this.nextPull}.ts`]: "export {};\n" };
    const c = this.commit({ ...base.files, ...files }, opts.failStep);
    repo.commits.set(c.sha, c);
    const number = this.nextPull++;
    const pull: FakePull = {
      number,
      title: opts.title ?? `Change ${number}`,
      state: "open",
      draft: opts.draft ?? false,
      merged: false,
      headSha: c.sha,
      headRef: opts.branch ?? `feat/change-${number}`,
      headRepo: `${this.org}/${repo.name}`,
      baseRef: "main",
      baseSha: repo.main,
      mergeCommitSha: null,
      files,
      baseMain: repo.main,
    };
    repo.pulls.set(number, pull);
    this.emit("pull_request", this.pullPayload(repo, pull, "opened"));
    return pull;
  }

  pushToPull(fullName: string, number: number, files: Record<string, string> = {}, failStep?: string): string {
    const repo = this.must(fullName);
    const pull = this.mustPull(repo, number);
    const head = repo.commits.get(pull.headSha)!;
    const c = this.commit({ ...head.files, ...files }, failStep);
    repo.commits.set(c.sha, c);
    pull.headSha = c.sha;
    Object.assign(pull.files, files);
    this.emit("pull_request", this.pullPayload(repo, pull, "synchronize"));
    return c.sha;
  }

  closePull(fullName: string, number: number): void {
    const repo = this.must(fullName);
    const pull = this.mustPull(repo, number);
    pull.state = "closed";
    this.emit("pull_request", this.pullPayload(repo, pull, "closed"));
  }

  private mustPull(repo: FakeRepo, number: number): FakePull {
    const pull = repo.pulls.get(number);
    if (!pull) throw Object.assign(new Error("Not Found"), { status: 404 });
    return pull;
  }

  // --- GitHub ------------------------------------------------------------------

  async loginForToken(token: string): Promise<string | null> {
    return token.startsWith("fake:") && token.length > 5 ? token.slice(5) : null;
  }

  async isOrgMember(login: string): Promise<boolean> {
    return !login.startsWith("outsider");
  }

  async repoExists(repo: string): Promise<boolean> {
    return !!this.repo(repo);
  }

  async branchHead(repo: string, branch: string): Promise<string> {
    if (branch !== "main") throw new Error("only main exists in fake mode");
    return this.must(repo).main;
  }

  async readFile(repo: string, path: string, ref: string): Promise<string | null> {
    const r = this.must(repo);
    const sha = ref === "main" ? r.main : ref;
    return r.commits.get(sha)?.files[path] ?? null;
  }

  async downloadZipball(repo: string, sha: string): Promise<Uint8Array> {
    const c = this.must(repo).commits.get(sha);
    if (!c) throw Object.assign(new Error("Not Found"), { status: 404 });
    return new TextEncoder().encode(JSON.stringify(c.files));
  }

  async setStatus(repo: string, sha: string, status: CommitStatus): Promise<void> {
    this.must(repo).statuses.push({ sha, status });
  }

  async comment(repo: string, number: number, body: string): Promise<void> {
    this.must(repo).comments.push({ number, body });
  }

  async getPull(repo: string, number: number): Promise<PullInfo> {
    const { files: _files, baseMain: _base, ...pull } = this.mustPull(this.must(repo), number);
    return { ...pull };
  }

  async listOpenPulls(repo: string): Promise<PullInfo[]> {
    const r = this.must(repo);
    return Promise.all([...r.pulls.values()].filter((p) => p.state === "open").map((p) => this.getPull(repo, p.number)));
  }

  async listPullFiles(repo: string, number: number): Promise<string[]> {
    return Object.keys(this.mustPull(this.must(repo), number).files);
  }

  async behindBy(repo: string, _base: string, headSha: string): Promise<number> {
    const r = this.must(repo);
    const pull = [...r.pulls.values()].find((p) => p.headSha === headSha);
    return pull && pull.baseMain !== r.main ? 1 : 0;
  }

  async updateBranch(repo: string, number: number, expectedHeadSha: string): Promise<"updated" | "conflict"> {
    const r = this.must(repo);
    const pull = this.mustPull(r, number);
    if (pull.headSha !== expectedHeadSha) return "conflict";
    const main = r.commits.get(r.main)!;
    // A conflict if main changed any file the PR also changed.
    const base = r.commits.get(pull.baseMain)!;
    if (Object.keys(pull.files).some((f) => main.files[f] !== base.files[f])) return "conflict";
    const c = this.commit({ ...main.files, ...pull.files }, r.commits.get(pull.headSha)?.failStep);
    r.commits.set(c.sha, c);
    pull.headSha = c.sha;
    pull.baseMain = r.main;
    this.emit("pull_request", this.pullPayload(r, pull, "synchronize"));
    return "updated";
  }

  async squashMerge(repo: string, number: number, headSha: string): Promise<MergeResult> {
    const r = this.must(repo);
    const pull = this.mustPull(r, number);
    if (pull.state !== "open") return { merged: false, reason: "Pull Request is not mergeable" };
    if (pull.headSha !== headSha) return { merged: false, reason: "Head branch was modified" };
    const main = r.commits.get(r.main)!;
    const c = this.commit({ ...main.files, ...pull.files });
    r.commits.set(c.sha, c);
    r.main = c.sha;
    Object.assign(pull, { state: "closed", merged: true, mergeCommitSha: c.sha });
    this.emit("pull_request", this.pullPayload(r, pull, "closed"));
    this.emit("push", {
      ref: "refs/heads/main",
      after: c.sha,
      repository: { full_name: `${this.org}/${r.name}` },
      sender: { login: "slipway-deployer[bot]" },
    });
    return { merged: true, sha: c.sha };
  }

  async deleteBranch(): Promise<void> {}

  async protectMain(repo: string): Promise<void> {
    this.must(repo).protected = true;
  }

  async archiveRepo(repo: string): Promise<void> {
    this.must(repo).archived = true;
  }

  async verifyWebhook(payload: string, signature: string): Promise<boolean> {
    const expected = `sha256=${createHmac("sha256", FAKE_WEBHOOK_SECRET).update(payload).digest("hex")}`;
    return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  /** Whether a commit should fail its build, and where. */
  failStepFor(app: string, sha: string): string | undefined {
    return this.repos.get(app)?.commits.get(sha)?.failStep;
  }
}

type FakeRun = {
  id: string;
  input: StartRunInput;
  createdAt: number;
  result?: { status: "succeeded" | "failed"; exported: Record<string, string>; log: string[] };
};

/**
 * Simulated runner. With `autoFinishMs` runs finish by themselves (fake mode);
 * otherwise tests finish them with `finish()`.
 */
export class FakeRuns implements Runs {
  runs = new Map<string, FakeRun>();
  cancelled: string[] = [];
  private counter = 0;

  constructor(
    private opts: {
      github?: FakeGitHub;
      autoFinishMs?: number;
      siteUrl?: (app: string, env: string) => string;
      now?: () => number;
    } = {},
  ) {}

  private now = () => (this.opts.now ?? Date.now)();

  async start(input: StartRunInput): Promise<string> {
    if (input.kind === "build-release" && !input.sourceZip?.length) throw new Error("build-release needs sourceZip");
    const id = `${String(this.now()).padStart(13, "0")}-${String(++this.counter).padStart(8, "0")}`;
    this.runs.set(id, { id, input, createdAt: this.now() });
    return id;
  }

  /** What a successful run would export, per docs/contracts.md. */
  successExports(input: StartRunInput): Record<string, string> {
    const e = input.env;
    if (input.kind === "build-release") {
      if (e.MODE !== "release") return {};
      const digest = `sha256:${createHash("sha256").update(`${e.APP}:${e.COMMIT_SHA}`).digest("hex")}`;
      return {
        IMAGE_DIGEST: digest,
        IMAGE_URI: `123456789012.dkr.ecr.ca-west-1.amazonaws.com/app-${e.APP}@${digest}`,
        WEB_ARTIFACT: `s3://slipway-artifacts-fake/releases/${e.APP}/${e.COMMIT_SHA}/web.tgz`,
      };
    }
    if (e.ACTION === "apply" && (e.ENV === "staging" || e.ENV === "prod")) {
      const site = this.opts.siteUrl?.(e.APP ?? "", e.ENV) ?? `https://d${sha1(`${e.APP}${e.ENV}`).slice(0, 13)}.cloudfront.net`;
      return { APP_URL: site, SERVICE_URL: `https://app-${e.APP}-${e.ENV}-api-f00d.ecs.ca-west-1.on.aws` };
    }
    return {};
  }

  private steps(input: StartRunInput): string[] {
    if (input.kind === "build-release") {
      const steps = ["app-yaml", "secret-scan", "npm-ci", "typecheck", "lint", "test", "migrations-check", "web-build", "docker-build"];
      return input.env.MODE === "release" ? [...steps, "publish"] : steps;
    }
    if (input.env.ACTION === "destroy") return ["terraform-destroy"];
    if (input.env.ENV === "shared") return ["terraform-apply"];
    return ["secrets-check", "terraform-phase1", "migrate", "rollout-settings", "terraform-phase2", "web-sync", "health-check"];
  }

  finish(id: string, status: "succeeded" | "failed" = "succeeded", opts: { failStep?: string; error?: string } = {}): void {
    const run = this.runs.get(id);
    if (!run) throw new Error(`no fake run ${id}`);
    const log: string[] = [`[fake] ${run.input.kind} ${JSON.stringify(run.input.env)}`];
    for (const step of this.steps(run.input)) {
      log.push(`==> step: ${step}`);
      if (status !== "succeeded" && (opts.failStep ?? step) === step) {
        log.push(`ERROR: ${opts.error ?? `${step} failed (simulated)`}`);
        break;
      }
      log.push(`[fake] ${step} ok`);
    }
    run.result = { status, exported: status === "succeeded" ? this.successExports(run.input) : {}, log };
  }

  async get(id: string): Promise<RunInfo | null> {
    const run = this.runs.get(id);
    if (!run) return null;
    if (!run.result && this.opts.autoFinishMs !== undefined && this.now() - run.createdAt >= this.opts.autoFinishMs) {
      const failStep =
        run.input.kind === "build-release" && run.input.env.APP && run.input.env.COMMIT_SHA
          ? this.opts.github?.failStepFor(run.input.env.APP, run.input.env.COMMIT_SHA)
          : undefined;
      this.finish(id, failStep ? "failed" : "succeeded", { failStep });
    }
    const iso = (ms: number) => new Date(ms).toISOString();
    return {
      id,
      kind: run.input.kind,
      status: run.result?.status ?? "running",
      exitCode: run.result ? (run.result.status === "succeeded" ? 0 : 1) : null,
      exported: run.result?.exported ?? {},
      createdAt: iso(run.createdAt),
      startedAt: iso(run.createdAt),
      finishedAt: run.result ? iso(this.now()) : null,
    };
  }

  async logTail(id: string, lines: number): Promise<string[]> {
    const run = this.runs.get(id);
    const log = run?.result?.log ?? [`[fake] ${run?.input.kind ?? "run"} running...`];
    return log.slice(-lines);
  }

  async cancel(id: string): Promise<void> {
    this.cancelled.push(id);
  }
}

export class FakePlatform implements Platform {
  /** Names written; values are dropped so even fake mode can't read them back. */
  written: string[] = [];
  failedDeploys: { app: string; env: string; summary: string }[] = [];

  async deployFailed(f: { app: string; env: "staging" | "prod"; summary: string; link: string }): Promise<void> {
    this.failedDeploys.push({ app: f.app, env: f.env, summary: f.summary });
  }

  async putAppSecret(name: string, _value: string): Promise<void> {
    this.written.push(name);
  }

  async devConfig(): Promise<DevConfig> {
    return {
      publishableKey: process.env.FAKE_CLERK_PUBLISHABLE_KEY ?? "pk_test_fake",
      secretKey: process.env.FAKE_CLERK_SECRET_KEY ?? "sk_test_fake",
    };
  }
}

/** Routes that drive the fake GitHub, mounted at /fake in fake mode only. */
export function fakeRoutes(github: FakeGitHub): express.Router {
  const router = express.Router();
  router.use(express.json());
  const repo = (req: express.Request) => `${github.org}/${String(req.params.app)}`;
  const files = (body: unknown): Record<string, string> =>
    body && typeof body === "object" && "files" in body && typeof body.files === "object" && body.files
      ? (body.files as Record<string, string>)
      : {};
  const failStep = (body: unknown) =>
    body && typeof body === "object" && "failStep" in body && typeof body.failStep === "string" ? body.failStep : undefined;

  router.get("/github/repos/:app", (req, res) => {
    const r = github.repo(repo(req));
    if (!r) return void res.status(404).json({ error: "no such repo" });
    res.json({
      main: r.main,
      protected: r.protected,
      archived: r.archived,
      pulls: [...r.pulls.values()],
      statuses: r.statuses,
      comments: r.comments,
      appYaml: parse(r.commits.get(r.main)?.files["app.yaml"] ?? "") as unknown,
    });
  });
  router.post("/github/repos/:app/commits", (req, res) => {
    res.status(201).json({ sha: github.pushToMain(repo(req), files(req.body), failStep(req.body)) });
  });
  router.post("/github/repos/:app/pulls", (req, res) => {
    const body = (req.body ?? {}) as { title?: string; branch?: string; draft?: boolean };
    const pull = github.openPull(repo(req), {
      title: body.title,
      branch: body.branch,
      draft: body.draft,
      files: Object.keys(files(req.body)).length ? files(req.body) : undefined,
      failStep: failStep(req.body),
    });
    res.status(201).json({ number: pull.number, headSha: pull.headSha });
  });
  router.post("/github/repos/:app/pulls/:number/commits", (req, res) => {
    res.status(201).json({
      headSha: github.pushToPull(repo(req), Number(req.params.number), files(req.body), failStep(req.body)),
    });
  });
  router.post("/github/repos/:app/pulls/:number/close", (req, res) => {
    github.closePull(repo(req), Number(req.params.number));
    res.json({ ok: true });
  });
  router.get("/sites/:app/:env", (req, res) => {
    const esc = (s: unknown) => String(s).replace(/[^\w-]/g, "");
    const [app, env] = [esc(req.params.app), esc(req.params.env)];
    res
      .type("text/html")
      .send(
        `<!doctype html><title>${app} (${env})</title><p>Fake ${env} site for <b>${app}</b>. In fake mode nothing is really deployed.</p>`,
      );
  });
  return router;
}
