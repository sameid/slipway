import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { parseAppYaml } from "../cli/app.mjs";
import { fillPlaceholders } from "../cli/new-app.mjs";
import { app, appRepo, job, mockDeployer, REPO, ROOT, runCli, stubGh, tempDir } from "./helpers/harness.mjs";

const FAST = ["--interval", "0.02"];

describe("argument handling", () => {
  test("--help exits 0", async () => {
    const r = await runCli(["--help"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Exit codes/);
  });

  test("unknown command and unknown flag are usage errors", async () => {
    assert.equal((await runCli(["frobnicate"])).code, 2);
    assert.equal((await runCli(["status", "--nope"])).code, 2);
  });

  test("a missing deployer URL is explained", async () => {
    const r = await runCli(["whoami"], { env: { SLIPWAY_DEPLOYER_URL: "" } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /\/setup/);
  });

  test("connect refuses a URL that isn't https (except localhost)", async () => {
    assert.equal((await runCli(["connect", "not a url"])).code, 2);
    const r = await runCli(["connect", "http://deployer.example.com"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /https:\/\//);
  });

  test("outside an app repo, app commands ask for --app", async () => {
    const t = tempDir();
    try {
      const r = await runCli(["status"], { cwd: t.dir, env: { SLIPWAY_DEPLOYER_URL: "http://127.0.0.1:9" } });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /--app/);
    } finally {
      t.cleanup();
    }
  });
});

describe("app.yaml and placeholders", () => {
  test("parses the fields the CLI uses", () => {
    const parsed = parseAppYaml(
      'name: my-app\ntemplate: react-express\ndescription: "x # y"\nowner: jane   # GitHub username\nsecrets:\n  - STRIPE_KEY\n  - "OPENAI_API_KEY"\n\nauto_merge: true\n',
    );
    assert.deepEqual(parsed, { name: "my-app", template: "react-express", owner: "jane", secrets: ["STRIPE_KEY", "OPENAI_API_KEY"] });
    assert.deepEqual(parseAppYaml("name: a\nsecrets: [A, 'B']\n").secrets, ["A", "B"]);
    assert.deepEqual(parseAppYaml("name: a\nsecrets: []\n").secrets, []);
  });

  test("escapes the description for its context", () => {
    const values = { NAME: "my-app", DESCRIPTION: 'Loans "for" ops: <b> & co\'s', OWNER: "jane" };
    assert.equal(fillPlaceholders('description: "__APP_DESCRIPTION__"', "app.yaml", values), 'description: "Loans \\"for\\" ops: <b> & co\'s"');
    assert.equal(fillPlaceholders("description: __APP_DESCRIPTION__", "app.yaml", values), 'description: "Loans \\"for\\" ops: <b> & co\'s"');
    assert.equal(fillPlaceholders("<p>__APP_DESCRIPTION__</p>", "index.html", values), "<p>Loans &quot;for&quot; ops: &lt;b&gt; &amp; co&#39;s</p>");
    assert.equal(fillPlaceholders("# __APP_NAME__\n\n__APP_DESCRIPTION__", "README.md", values), `# my-app\n\n${values.DESCRIPTION}`);
    assert.equal(fillPlaceholders("owner: __APP_OWNER__  # x", "app.yaml", values), "owner: jane  # x");
  });
});

describe("against a mock deployer", () => {
  let deployer;
  let state;
  const t = tempDir();
  const repo = appRepo(path.join(t.dir, "loan-tracker"), { secrets: ["STRIPE_KEY"] });
  const gh = stubGh(t.dir);
  const env = () => ({ SLIPWAY_DEPLOYER_URL: deployer.url, PATH: `${gh.bin}:${process.env.PATH}` });

  before(async () => {
    state = {};
    deployer = await mockDeployer([
      ["GET", /^\/api\/whoami$/, () => ({ json: { login: "alice", owner: "acme", ownerType: "Organization", codeowners: "@acme/platform" } })],
      ["POST", /^\/api\/apps$/, ({ body }) => ({ status: 201, json: app({ name: body.name, status: "registering", phase: "registering" }) })],
      ["GET", /^\/api\/apps\/([^/]+)$/, ({ match }) => {
        const next = state.apps?.[match[1]];
        if (typeof next === "function") return next();
        return next ? { json: next } : { status: 404, json: { error: "not found" } };
      }],
      ["GET", /^\/api\/apps\/[^/]+\/pulls\/(\d+)$/, () => state.pull()],
      ["GET", /^\/api\/apps\/[^/]+\/jobs\/(\d+)\/log$/, ({ match }) => ({ text: `line one of job ${match[1]}\nnpm test failed\n` })],
      ["GET", /^\/api\/apps\/[^/]+\/jobs$/, () => ({ json: { jobs: [job({ id: 9, status: "failed", failedStep: "test", error: "1 test failed" })] } })],
      ["GET", /^\/api\/apps\/[^/]+\/secrets$/, () => ({ json: { secrets: [{ key: "STRIPE_KEY", staging: { set: true, lastSetBy: "alice", lastSetAt: new Date().toISOString() }, prod: { set: false, lastSetBy: null, lastSetAt: null } }] } })],
      ["POST", /^\/api\/apps\/[^/]+\/secrets\/(\w+)\/(\w+)\/link$/, ({ match }) =>
        match[2] === "STRIPE_KEY"
          ? {
              status: 201,
              json: { url: `https://deployer.example/secrets/set/tok-${match[1]}-${match[2]}`, linkId: "lnk1", expiresAt: new Date(Date.now() + 600_000).toISOString() },
            }
          : { status: 400, json: { error: `${match[2]} isn't declared under secrets: in app.yaml on main.` } }],
      ["GET", /^\/api\/apps\/[^/]+\/secret-links\/(\w+)$/, () => state.link()],
      ["POST", /^\/api\/apps\/[^/]+\/destroy$/, () => ({ status: 202, json: { status: "destroy_requested", dashboardUrl: "https://deployer.example/apps/loan-tracker" } })],
    ]);
  });

  after(async () => {
    await deployer.close();
    t.cleanup();
  });

  // Serve a sequence of responses, repeating the last one.
  const sequence = (...responses) => {
    let i = 0;
    return () => responses[Math.min(i++, responses.length - 1)];
  };

  test("connect saves the URL in the user's config and checks it with the deployer", async () => {
    const home = tempDir();
    try {
      const own = { XDG_CONFIG_HOME: home.dir, SLIPWAY_DEPLOYER_URL: "" };
      const r = await runCli(["connect", `${deployer.url}/`], { env: own });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /New apps are created under acme/);
      const saved = JSON.parse(readFileSync(path.join(home.dir, "slipway", "config.json"), "utf8"));
      assert.equal(saved.deployerUrl, deployer.url);
      const again = await runCli(["whoami"], { env: own });
      assert.equal(again.code, 0, again.stderr);
      assert.match(again.stdout, /^alice on http:\/\/127\.0\.0\.1:\d+ \(apps are created under acme\)$/m);
    } finally {
      home.cleanup();
    }
  });

  test("whoami sends the GitHub token", async () => {
    const r = await runCli(["whoami"], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /alice/);
    assert.equal(deployer.requests.at(-1).auth, "Bearer fake:alice");
  });

  test("check-name: invalid, registered, repo exists, free", async () => {
    state.apps = { "taken-app": app({ name: "taken-app" }) };
    assert.equal((await runCli(["check-name", "Bad_Name"], { env: env() })).code, 3);
    const registered = await runCli(["check-name", "taken-app"], { env: env() });
    assert.equal(registered.code, 3);
    assert.match(registered.stdout, /already registered/);
    const free = await runCli(["check-name", "fresh-app"], { env: env() });
    assert.equal(free.code, 0, free.stderr);
    assert.match(free.stdout, /available/);
  });

  test("new-app --local-only copies the template, fills placeholders and commits", async () => {
    state.apps = {};
    const parent = path.join(t.dir, "apps");
    const description = 'Tracks "equipment" loans: ops team';
    const r = await runCli(["new-app", "--name", "gear-loans", "--description", description, "--dir", parent, "--local-only"], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    const dir = path.join(parent, "gear-loans");
    const yaml = readFileSync(path.join(dir, "app.yaml"), "utf8");
    assert.match(yaml, /^name: gear-loans$/m);
    assert.match(yaml, /^description: "Tracks \\"equipment\\" loans: ops team"$/m);
    assert.match(yaml, /^owner: alice /m);
    assert.match(readFileSync(path.join(dir, "CODEOWNERS"), "utf8"), /^\/app\.yaml +@acme\/platform$/m);
    assert.equal(parseAppYaml(yaml).name, "gear-loans");
    assert.ok(!existsSync(path.join(dir, "node_modules")));
    assert.ok(!existsSync(path.join(dir, ".env")), "apps aren't run locally, so new-app writes no .env");
    const tracked = execFileSync("git", ["ls-files"], { cwd: dir, encoding: "utf8" });
    assert.match(tracked, /^app\.yaml$/m);
    assert.doesNotMatch(tracked, /node_modules|\/dist\//);
    const leftovers = spawnSync("git", ["grep", "-l", "__APP_"], { cwd: dir, encoding: "utf8" });
    assert.equal(leftovers.status, 1, `placeholders left in: ${leftovers.stdout}`);
  });

  test("new-app pushes with gh and registers", async () => {
    state.apps = {};
    const parent = path.join(t.dir, "apps2");
    const r = await runCli(["new-app", "--name", "desk-booking", "--description", "Book desks", "--dir", parent], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    const ghLog = readFileSync(gh.log, "utf8");
    assert.match(ghLog, /repo create acme\/desk-booking --private --source \. --remote origin --push/);
    const post = deployer.requests.find((req) => req.method === "POST" && req.path === "/api/apps");
    assert.deepEqual(post.body, { name: "desk-booking" });
    assert.match(r.stdout, /wait-app --app desk-booking/);
  });

  test("new-app refuses a name that's taken", async () => {
    state.apps = { "taken-app": app({ name: "taken-app" }) };
    const r = await runCli(["new-app", "--name", "taken-app", "--description", "x", "--dir", path.join(t.dir, "apps3")], { env: env() });
    assert.equal(r.code, 3);
    assert.ok(!existsSync(path.join(t.dir, "apps3", "taken-app")));
  });

  test("wait-app follows phases until live", async () => {
    state.apps = {
      "loan-tracker": sequence(
        { json: app({ phase: "building", status: "registering", activeJobs: [job({ kind: "build", env: "build" })] }) },
        { json: app({ phase: "deploying_staging", status: "registering" }) },
        { json: app() },
      ),
    };
    const r = await runCli(["wait-app", ...FAST], { cwd: repo, env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Building the first release/);
    assert.match(r.stdout, /Staging: https:\/\/dstaging\.cloudfront\.net/);
  });

  test("wait-app exits 10 when time runs out", async () => {
    state.apps = { "loan-tracker": app({ phase: "deploying_staging", status: "registering" }) };
    const r = await runCli(["wait-app", "--max-seconds", "0.1", ...FAST], { cwd: repo, env: env() });
    assert.equal(r.code, 10);
    assert.match(r.stdout, /Run again/);
  });

  test("wait-app shows the failed step and log", async () => {
    state.apps = {
      "loan-tracker": app({
        phase: "failed",
        status: "failed",
        error: "staging deploy failed",
        recentJobs: [job({ id: 12, status: "failed", failedStep: "terraform-phase1", error: "AccessDenied" })],
      }),
    };
    const r = await runCli(["wait-app", ...FAST], { cwd: repo, env: env() });
    assert.equal(r.code, 3);
    assert.match(r.stdout, /Failed step: terraform-phase1/);
    assert.match(r.stdout, /line one of job 12/);
  });

  test("wait-app retries transient errors", async () => {
    state.apps = { "loan-tracker": sequence({ status: 503, json: { error: "busy" } }, { json: app() }) };
    const r = await runCli(["wait-app", ...FAST], { cwd: repo, env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Retrying/);
  });

  test("wait-pr: check, merge, live", async () => {
    const head = "abc1234def";
    state.pull = sequence(
      { json: { number: 5, headSha: "0000000", status: "check_failed", check: null, deploy: null, live: false, note: null, failure: null } },
      { json: { number: 5, headSha: head, status: "checking", check: job({ kind: "check", env: "check", status: "running" }), live: false, note: null } },
      { json: { number: 5, headSha: head, status: "merged", mergedSha: "fedcba9", deploy: job({ status: "running" }), live: false, note: null } },
      { json: { number: 5, headSha: head, status: "merged", mergedSha: "fedcba9", deploy: job({ status: "succeeded" }), live: true, stagingUrl: "https://dstaging.cloudfront.net", note: null } },
    );
    const r = await runCli(["wait-pr", "5", "--head", head, ...FAST], { cwd: repo, env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Waiting for the deployer to pick up/);
    assert.match(r.stdout, /Check running/);
    assert.match(r.stdout, /Staging: https:\/\/dstaging/);
  });

  test("wait-pr: failed check shows the step and log", async () => {
    state.pull = () => ({
      json: {
        number: 5, headSha: "abc", status: "check_failed", live: false, note: null,
        failure: { step: "test", message: "1 test failed", logPath: "/api/apps/loan-tracker/jobs/21/log" },
      },
    });
    const r = await runCli(["wait-pr", "5", ...FAST], { cwd: repo, env: env() });
    assert.equal(r.code, 3);
    assert.match(r.stdout, /Failed step: test/);
    assert.match(r.stdout, /npm test failed/);
  });

  test("wait-pr: blocked exits 4 with the note", async () => {
    state.pull = () => ({ json: { number: 5, headSha: "abc", status: "blocked", live: false, note: "changes platform-owned files; needs a review from CODEOWNERS" } });
    const r = await runCli(["wait-pr", "5", ...FAST], { cwd: repo, env: env() });
    assert.equal(r.code, 4);
    assert.match(r.stdout, /needs a review from CODEOWNERS/);
  });

  test("wait-pr --max-seconds 0 looks once without waiting", async () => {
    state.pull = () => ({ json: { number: 5, headSha: "abc", status: "checking", check: job({ kind: "check", env: "check", status: "running" }), live: false, note: null } });
    const r = await runCli(["wait-pr", "5", "--max-seconds", "0"], { cwd: repo, env: env() });
    assert.equal(r.code, 10);
    assert.match(r.stdout, /Check running/);
    assert.match(r.stdout, /Still in progress/);
  });

  test("status prints both environments", async () => {
    state.apps = { "loan-tracker": app() };
    const r = await runCli(["status", "--app", "loan-tracker"], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Staging: https:\/\/dstaging\.cloudfront\.net {2}release a1b2c3d/);
    assert.match(r.stdout, /Prod: +not deployed yet/);
  });

  test("jobs and log", async () => {
    const jobs = await runCli(["jobs"], { cwd: repo, env: env() });
    assert.equal(jobs.code, 0, jobs.stderr);
    assert.match(jobs.stdout, /#9 .*failed at test: 1 test failed/);
    const log = await runCli(["log", "9", "--tail", "50"], { cwd: repo, env: env() });
    assert.equal(log.code, 0);
    assert.match(log.stdout, /line one of job 9/);
    assert.equal(deployer.requests.at(-1).query, "?tail=50");
  });

  test("secret list", async () => {
    const r = await runCli(["secret", "list"], { cwd: repo, env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /STRIPE_KEY\n {2}staging: set by alice/);
    assert.match(r.stdout, /prod: {4}NOT SET/);
  });

  test("secret set: link, value entered, redeploy succeeds", async () => {
    state.link = sequence(
      { json: { status: "pending", usedAt: null, redeploy: null } },
      { json: { status: "used", usedAt: new Date().toISOString(), redeploy: job({ status: "running" }) } },
      { json: { status: "used", usedAt: new Date().toISOString(), redeploy: job({ status: "succeeded" }) } },
    );
    const r = await runCli(["secret", "set", "STRIPE_KEY", "--env", "staging", ...FAST], { cwd: repo, env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /https:\/\/deployer\.example\/secrets\/set\/tok-staging-STRIPE_KEY/);
    assert.match(r.stdout, /redeployed/);
  });

  test("secret set refuses undeclared keys and bad envs", async () => {
    // Declared names are checked by the deployer against app.yaml on main, not the local checkout.
    const undeclared = await runCli(["secret", "set", "OPENAI_KEY", "--env", "staging"], { cwd: repo, env: env() });
    assert.equal(undeclared.code, 1);
    assert.match(undeclared.stderr, /isn't declared/);
    assert.equal((await runCli(["secret", "set", "STRIPE_KEY", "--env", "dev"], { cwd: repo, env: env() })).code, 2);
    assert.equal((await runCli(["secret", "set", "stripe", "--env", "prod"], { cwd: repo, env: env() })).code, 2);
  });

  test("secret wait: expired link exits 3", async () => {
    state.link = () => ({ json: { status: "expired", usedAt: null, redeploy: null } });
    const r = await runCli(["secret", "wait", "lnk1", ...FAST], { cwd: repo, env: env() });
    assert.equal(r.code, 3);
    assert.match(r.stdout, /expired/);
  });

  test("destroy needs --yes", async () => {
    const without = await runCli(["destroy"], { cwd: repo, env: env() });
    assert.equal(without.code, 2);
    assert.ok(!deployer.requests.some((req) => req.path.endsWith("/destroy")));
    const r = await runCli(["destroy", "--yes"], { cwd: repo, env: env() });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /confirms it on the dashboard/);
  });
});

test("the plugin's own files exist where commands reference them", () => {
  // ${CLAUDE_PLUGIN_ROOT} is the repo root.
  for (const file of [
    "bin/slipway",
    "plugin/hooks/guard.mjs",
    "plugin/skills/coding-agent/scripts/new-worktree.sh",
    "plugin/skills/coding-agent/scripts/clean-worktrees.sh",
    "deployer/scripts/release.sh",
    "deployer/scripts/pack.sh",
  ]) {
    const mode = statSync(path.join(REPO, file)).mode;
    assert.ok(mode & 0o100, `${file} should be executable`);
  }
  const manifest = JSON.parse(readFileSync(path.join(REPO, ".claude-plugin", "plugin.json"), "utf8"));
  for (const key of ["commands", "skills", "hooks"]) assert.ok(existsSync(path.join(REPO, manifest[key])), `${key}: ${manifest[key]}`);
  const references = [];
  for (const dir of ["plugin/commands", "plugin/hooks"]) {
    for (const name of readdirSync(path.join(REPO, dir))) {
      const text = readFileSync(path.join(REPO, dir, name), "utf8");
      for (const [, ref] of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g)) references.push(`${dir}/${name}: ${ref}`);
    }
  }
  assert.ok(references.length > 5);
  for (const ref of references) assert.ok(existsSync(path.join(REPO, ref.split(": ")[1])), ref);
});
