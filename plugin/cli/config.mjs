// Where the deployer is, and the caller's GitHub token. The deployer says which
// GitHub account owns app repos (GET /api/whoami), so nothing here names one.
//
// The deployer URL comes from, in order: SLIPWAY_DEPLOYER_URL; the user's config
// file (written by `slipway setup`); deployerUrl in the plugin's own
// slipway.config.json (for a team that forks the plugin with its URL built in).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, run } from "./util.mjs";

export const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

let cached;

export function userConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "slipway", "config.json");
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // Missing or unreadable config: fall through to the next source.
    return {};
  }
}

const trimUrl = (url) => (url || "").replace(/\/+$/, "");

export function config() {
  if (cached) return cached;
  const user = readJson(userConfigPath());
  const plugin = readJson(path.join(PLUGIN_ROOT, "slipway.config.json"));
  cached = { deployerUrl: trimUrl(process.env.SLIPWAY_DEPLOYER_URL || user.deployerUrl || plugin.deployerUrl) };
  return cached;
}

/** Save the deployer URL in the user's config file, keeping anything else in it. */
export function saveDeployerUrl(url) {
  const file = userConfigPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...readJson(file), deployerUrl: trimUrl(url) };
  writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
  cached = undefined;
  return file;
}

export function deployerUrl() {
  const url = config().deployerUrl;
  if (!url) {
    throw new CliError(
      "The slipway plugin doesn't know your deployer's URL yet. Run /setup in Claude Code " +
        "(or: slipway setup --deployer-url <url>) with the deployerUrl from whoever runs your slipway, " +
        "or set SLIPWAY_DEPLOYER_URL.",
    );
  }
  return url;
}

let token;

// The colleague's GitHub token. The deployer checks it with GitHub and decides whether they may use it.
export function githubToken() {
  if (token) return token;
  if (process.env.SLIPWAY_GH_TOKEN) return (token = process.env.SLIPWAY_GH_TOKEN);
  const result = run("gh", ["auth", "token"]);
  if (result.missing) {
    throw new CliError("The GitHub CLI isn't installed. Install it (brew install gh), then run: gh auth login");
  }
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new CliError("You're not signed in to the GitHub CLI. Run: gh auth login");
  }
  return (token = result.stdout.trim());
}
