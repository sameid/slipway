// /secret: list declared secrets, and hand out one-time browser links to set values.
// Values never pass through this CLI or the Claude Code conversation.
import { spawn } from "node:child_process";
import { appName } from "./app.mjs";
import { api, isTransient } from "./deployer.mjs";
import { ago, CliError, clock, EXIT, print, printJson, sleep } from "./util.mjs";

const KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const ENVS = ["staging", "prod"];

export async function secret(opts, [action, ...rest]) {
  switch (action) {
    case "list":
      return list(opts);
    case "link":
      return link(opts, rest, { wait: false });
    case "set":
      return link(opts, rest, { wait: true });
    case "wait":
      return waitLink(opts, appName(opts), rest[0]);
    default:
      throw new CliError(
        "Usage: slipway secret list | set <KEY> --env staging|prod | link <KEY> --env staging|prod | wait <link-id>",
        EXIT.USAGE,
      );
  }
}

async function list(opts) {
  const name = appName(opts);
  const { secrets } = await api.get(`/api/apps/${name}/secrets`);
  if (opts.json) return printJson({ secrets });
  if (!secrets.length) {
    return print("No secrets are declared. Add names under secrets: in app.yaml (names only, never values).");
  }
  const cell = (s) => (s.set ? `set by ${s.lastSetBy ?? "?"} ${ago(s.lastSetAt)}` : "NOT SET");
  for (const s of secrets) print(`${s.key}`, `  staging: ${cell(s.staging)}`, `  prod:    ${cell(s.prod)}`);
}

async function link(opts, [key], { wait }) {
  const name = appName(opts);
  const env = opts.env;
  if (!KEY_PATTERN.test(key ?? "")) throw new CliError(`Secret names are UPPER_SNAKE_CASE, like STRIPE_KEY.`, EXIT.USAGE);
  if (!ENVS.includes(env)) throw new CliError("Pass --env staging or --env prod.", EXIT.USAGE);

  // The deployer checks the name against app.yaml on main, which is what deploys read.
  // The local checkout may be behind main or ahead of it, so it isn't checked here.
  const created = await api.post(`/api/apps/${name}/secrets/${env}/${key}/link`);
  if (opts.open) openInBrowser(created.url);
  if (opts.json && !wait) return printJson(created);
  if (!opts.json) {
    print(
      `Open this one-time link to set ${key} for ${env} (valid until ${new Date(created.expiresAt).toLocaleTimeString()}, works once):`,
      `  ${created.url}`,
      "Paste the value into the page, not into Claude Code.",
    );
  }
  if (wait) return waitLink(opts, name, created.linkId);
  print(`Then wait for it with: slipway secret wait ${created.linkId}`);
}

async function waitLink(opts, name, linkId) {
  if (!linkId) throw new CliError("Usage: slipway secret wait <link-id>", EXIT.USAGE);
  const deadline = Date.now() + Number(opts["max-seconds"] ?? 540) * 1000;
  const interval = Number(opts.interval ?? 5) * 1000;
  let last;
  let failures = 0;
  for (;;) {
    let state;
    try {
      state = await api.get(`/api/apps/${name}/secret-links/${encodeURIComponent(linkId)}`);
      failures = 0;
    } catch (err) {
      if (!isTransient(err) || ++failures > 4) throw err;
    }
    if (state) {
      const job = state.redeploy;
      const key = `${state.status}|${job?.status}`;
      if (!opts.json && key !== last) {
        last = key;
        if (state.status === "pending") print(`[${clock()}] Waiting for the value to be entered in the browser`);
        if (state.status === "used" && job) print(`[${clock()}] Value saved. Redeploying ${job.env}: ${job.status}`);
      }
      const done = (code, ...lines) => {
        if (opts.json) printJson(state);
        else print(...lines);
        if (code !== EXIT.OK) throw new CliError("", code);
      };
      if (state.status === "expired") {
        return done(EXIT.FAILED, "The link expired before a value was entered. Create a new one with /secret set.");
      }
      if (state.status === "used" && !job) {
        return done(EXIT.OK, "Value saved. That environment has no release yet, so it takes effect on its first deploy.");
      }
      if (state.status === "used" && job.status === "succeeded") {
        return done(EXIT.OK, `Value saved and ${job.env} redeployed with it.`);
      }
      if (state.status === "used" && (job.status === "failed" || job.status === "superseded")) {
        return done(
          job.status === "failed" ? EXIT.FAILED : EXIT.OK,
          job.status === "failed"
            ? `Value saved, but the redeploy of ${job.env} failed at ${job.failedStep ?? "?"}: ${job.error ?? ""} (slipway log ${job.id})`
            : `Value saved. A newer deploy of ${job.env} replaced this redeploy and will pick it up.`,
        );
      }
    }
    if (Date.now() + interval > deadline) {
      if (!opts.json) print(`[${clock()}] Still waiting. Run again: slipway secret wait ${linkId}`);
      throw new CliError("", EXIT.WAITING);
    }
    await sleep(interval);
  }
}

function openInBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(opener, [url], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
  } catch {
    // Opening the browser is a convenience; the link is printed either way.
  }
}
