// Reading and waiting on deployer state: status, wait-app, wait-pr, jobs, log.
import path from "node:path";
import { appName, currentApp } from "./app.mjs";
import { PLUGIN_ROOT } from "./config.mjs";
import { api, isTransient } from "./deployer.mjs";
import { ago, CliError, clock, EXIT, print, printJson, run, shortSha, sleep } from "./util.mjs";

const PHASES = {
  registering: "Registering the app and protecting its main branch",
  deploying_shared: "Creating the app's container registry and logs",
  building: "Building the first release: install, type check, lint, tests, Docker image, frontend",
  deploying_staging: "Creating staging: database, API service, CDN (the first deploy takes 10-15 minutes, mostly the database)",
  live: "Staging is live",
  failed: "Setup failed",
  destroying: "Being torn down",
  destroyed: "Torn down",
};

// Poll fn() until it returns { done: true, code } or the time budget runs out.
// fn gets the previous state's key so it can print only changes.
async function poll(opts, defaultInterval, fn, waitingHint) {
  const maxSeconds = Number(opts["max-seconds"] ?? 540);
  const interval = Number(opts.interval ?? defaultInterval) * 1000;
  const deadline = Date.now() + maxSeconds * 1000;
  let failures = 0;
  for (;;) {
    let outcome;
    try {
      outcome = await fn();
      failures = 0;
    } catch (err) {
      if (!isTransient(err) || ++failures > 4) throw err;
      if (!opts.json) print(`[${clock()}] ${err.message} Retrying.`);
    }
    if (outcome?.done) return outcome.code;
    if (Date.now() + interval > deadline) {
      if (!opts.json) print(`[${clock()}] Still in progress. ${waitingHint}`);
      return EXIT.WAITING;
    }
    await sleep(interval);
  }
}

function onChange() {
  let last;
  return (key, ...lines) => {
    if (key === last) return;
    last = key;
    print(...lines.map((line, i) => (i === 0 ? `[${clock()}] ${line}` : line)));
  };
}

async function logTail(job, lines = 60) {
  try {
    const text = await api.text(`${job.logPath}?tail=${lines}`);
    return text.trimEnd();
  } catch (err) {
    return `(couldn't fetch the log: ${err.message})`;
  }
}

function describeJob(job) {
  const target = job.kind === "check" ? `check of PR #${job.prNumber}` : job.kind === "build" ? "build" : `${job.kind} ${job.env}`;
  return `${target} ${shortSha(job.commitSha)} ${job.status}`;
}

async function printFailure({ step, message, logPath }, lines = 60) {
  print(`Failed step: ${step ?? "unknown"}`);
  if (message) print(`Error: ${message}`);
  if (logPath) {
    const id = /\/jobs\/(\d+)\//.exec(logPath)?.[1];
    print(`Last ${lines} log lines${id ? ` (more: slipway log ${id} --tail 500)` : ""}:`, "---");
    print(await logTail({ logPath }, lines), "---");
  }
}

export async function waitApp(opts) {
  const name = appName(opts);
  const show = onChange();
  let app;
  const code = await poll(opts, 15, async () => {
    app = await api.app(name);
    if (!app) throw new CliError(`${name} isn't registered with the deployer. Run: slipway register --app ${name}`);
    const running = app.activeJobs.map(describeJob).join(", ");
    if (!opts.json) show(`${app.phase}|${running}`, `${PHASES[app.phase] ?? app.phase}${running ? ` (${running})` : ""}`);
    if (app.phase === "live") return { done: true, code: EXIT.OK };
    if (app.phase === "failed" || app.status === "failed") return { done: true, code: EXIT.FAILED };
    return null;
  }, `Run again: slipway wait-app --app ${name}`);

  if (opts.json) printJson(app ?? null);
  else if (code === EXIT.OK) {
    print("", `Staging: ${app.staging.url}`, `Repo:    ${app.repoUrl}`);
  } else if (code === EXIT.FAILED) {
    if (app.error) print(`Error: ${app.error}`);
    const failed = app.recentJobs.find((job) => job.status === "failed");
    if (failed) await printFailure({ step: failed.failedStep, message: failed.error, logPath: failed.logPath });
    print(`Dashboard: ${app.dashboardUrl}`);
  }
  if (code !== EXIT.OK) throw new CliError("", code);
}

export async function waitPr(opts, [number = opts.pr] = []) {
  const name = appName(opts);
  if (!/^\d+$/.test(String(number ?? ""))) throw new CliError("Usage: slipway wait-pr <pr-number> [--head <sha>]", EXIT.USAGE);
  const head = opts.head;
  const show = onChange();
  let pr;
  let code = await poll(opts, 10, async () => {
    pr = await api.get(`/api/apps/${name}/pulls/${number}`);
    const stale = head && pr.headSha && !head.startsWith(pr.headSha) && !pr.headSha.startsWith(head);
    const status = stale || !pr.headSha ? "unknown" : pr.status;
    if (opts.json) return terminal(status, pr);
    const note = pr.note ? ` (${pr.note})` : "";
    switch (status) {
      case "unknown":
        show("unknown", `Waiting for the deployer to pick up PR #${number}${head ? ` at ${shortSha(head)}` : ""}`);
        break;
      case "checking":
        show(`checking|${pr.check?.status}|${pr.note}`, `Check ${pr.check?.status ?? "queued"} for ${shortSha(pr.headSha)}: install, type check, lint, tests, Docker and frontend builds${note}`);
        break;
      case "merged": {
        const deploy = pr.deploy ? `staging deploy ${pr.deploy.status}` : "building the release";
        show(`merged|${deploy}|${pr.live}`, `Merged as ${shortSha(pr.mergedSha)}; ${pr.live ? "staging is live" : deploy}`);
        break;
      }
      default:
        show(`${status}|${pr.note}`, `PR #${number}: ${status}${note}`);
    }
    return terminal(status, pr);
  }, `Run again: slipway wait-pr ${number}${head ? ` --head ${head}` : ""}`);

  if (opts.json) printJson(pr ?? null);
  else if (code === EXIT.OK) print("", `Staging: ${pr.stagingUrl}`);
  else if (code === EXIT.BLOCKED) print("", `PR #${number} passed its check but won't be merged automatically: ${pr.note ?? "see the PR comments"}`);
  else if (code === EXIT.FAILED) {
    if (pr.status === "closed") print("", `PR #${number} was closed without merging.`);
    else if (pr.failure) await printFailure(pr.failure, 80);
    else if (pr.deploy?.status === "failed") {
      await printFailure({ step: pr.deploy.failedStep, message: pr.deploy.error, logPath: pr.deploy.logPath }, 80);
    } else print("", `PR #${number} failed. ${pr.note ?? ""}`);
  }
  if (code !== EXIT.OK) throw new CliError("", code);
}

function terminal(status, pr) {
  if (status === "check_failed" || status === "closed") return { done: true, code: EXIT.FAILED };
  if (status === "blocked") return { done: true, code: EXIT.BLOCKED };
  if (status === "merged" && pr.live) return { done: true, code: EXIT.OK };
  if (status === "merged" && (pr.deploy?.status === "failed" || pr.failure)) return { done: true, code: EXIT.FAILED };
  return null;
}

function envLine(label, env, dashboardUrl) {
  if (!env.release) {
    return `${label} not deployed yet${label.startsWith("Prod") ? ` (promote from the dashboard: ${dashboardUrl})` : ""}`;
  }
  const last = env.lastDeploy ? `, last deploy ${env.lastDeploy.status} ${ago(env.lastDeploy.finishedAt ?? env.lastDeploy.createdAt)}` : "";
  return `${label} ${env.url ?? "(no URL yet)"}  release ${env.release.shortSha}${last}`;
}

export async function status(opts) {
  const name = appName(opts);
  const app = await api.app(name);
  if (!app) throw new CliError(`${name} isn't registered with the deployer.`, EXIT.FAILED);
  const worktrees = opts.app ? [] : finishedWorktrees();
  if (opts.json) return printJson({ ...app, finishedWorktrees: worktrees });

  print(
    `${app.name}: ${app.status}${app.phase !== "live" ? ` (${PHASES[app.phase] ?? app.phase})` : ""}, owner ${app.owner}`,
    envLine("Staging:", app.staging, app.dashboardUrl),
    envLine("Prod:   ", app.prod, app.dashboardUrl),
  );
  for (const job of app.activeJobs) print(`Running: ${describeJob(job)} (requested by ${job.requestedBy}, ${ago(job.startedAt ?? job.createdAt)})`);
  const lastFailure = app.recentJobs.find((job) => job.status === "failed");
  if (lastFailure) {
    print(`Last failure: ${describeJob(lastFailure)} at step ${lastFailure.failedStep ?? "?"}${lastFailure.error ? `: ${lastFailure.error}` : ""} (slipway log ${lastFailure.id})`);
  }
  if (app.error) print(`Error: ${app.error}`);
  print(`Repo: ${app.repoUrl}`, `Dashboard: ${app.dashboardUrl}`);
  if (worktrees.length) {
    print("", "Worktrees whose PRs are merged or closed (remove them with clean-worktrees.sh from the coding-agent skill):");
    for (const line of worktrees) print(`  ${line}`);
  }
}

// Lines from clean-worktrees.sh --dry-run, or [] if there's nothing to clean or it can't tell.
function finishedWorktrees() {
  try {
    const { root } = currentApp();
    const script = path.join(PLUGIN_ROOT, "skills", "coding-agent", "scripts", "clean-worktrees.sh");
    const result = run("bash", [script, "--dry-run", "--quiet"], { cwd: root });
    return result.status === 0 ? result.stdout.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

export async function jobs(opts) {
  const name = appName(opts);
  const limit = Number(opts.limit ?? 20);
  const { jobs: list } = await api.get(`/api/apps/${name}/jobs?limit=${limit}`);
  if (opts.json) return printJson({ jobs: list });
  if (!list.length) return print("No jobs yet.");
  for (const job of list) {
    const failure = job.status === "failed" ? `  failed at ${job.failedStep ?? "?"}${job.error ? `: ${job.error}` : ""}` : "";
    print(`#${job.id}  ${describeJob(job)}  by ${job.requestedBy}  ${ago(job.createdAt)}${failure}`);
  }
}

export async function log(opts, [id] = []) {
  const name = appName(opts);
  if (!/^\d+$/.test(String(id ?? ""))) throw new CliError("Usage: slipway log <job-id> [--tail 200]", EXIT.USAGE);
  const lines = Number(opts.tail ?? 200);
  process.stdout.write(await api.text(`/api/apps/${name}/jobs/${id}/log?tail=${lines}`));
}
