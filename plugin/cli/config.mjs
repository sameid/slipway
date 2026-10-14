// Where the deployer is, and the caller's GitHub token. The deployer says which
// GitHub account owns app repos (GET /api/whoami), so nothing here names one.
//
// The deployer URL comes from, in order: SLIPWAY_DEPLOYER_URL; the user's config
// file (written by `slipway setup` and `slipway connect`); deployerUrl in the
// plugin's own slipway.config.json (for a team that forks the plugin with its URL
// built in).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, run } from "./util.mjs";

export const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
// The repo root, which is also the installed plugin's root: foundation/, deployer/,
// jobs/ and modules/ live there, for `slipway setup`. SLIPWAY_SOURCE points it at a checkout.
export const SOURCE_ROOT = process.env.SLIPWAY_SOURCE
  ? path.resolve(process.env.SLIPWAY_SOURCE)
  : path.resolve(PLUGIN_ROOT, "..");

let cached;

export function userConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "slipway", "config.json");
}

export function cacheDir() {
  const base = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(base, "slipway");
}

export function pluginVersion() {
  return readJson(path.join(SOURCE_ROOT, ".claude-plugin", "plugin.json")).version || "0.0.0";
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

export function userConfig() {
  return readJson(userConfigPath());
}

/** Merge fields into the user's config file, keeping anything else in it. */
export function saveUserConfig(fields) {
  const file = userConfigPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const next = { ...readJson(file), ...fields };
  writeFileSync(`${file}.tmp`, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  cached = undefined;
  return file;
}

/** Save the deployer URL in the user's config file. */
export function saveDeployerUrl(url) {
  return saveUserConfig({ deployerUrl: trimUrl(url) });
}

export function deployerUrl() {
  const url = config().deployerUrl;
  if (!url) {
    throw new CliError(
      "The slipway plugin doesn't know your deployer yet. Run /setup in Claude Code to put slipway " +
        "in your own AWS account, or /connect <url> to use one someone else runs " +
        "(or set SLIPWAY_DEPLOYER_URL).",
    );
  }
  return url;
}

let token;

// The user's GitHub token. The deployer checks it with GitHub and decides whether they may use it.
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
