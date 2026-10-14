// Where the deployer is, which org we're in, and the caller's GitHub token.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, run } from "./util.mjs";

export const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

let cached;

export function config() {
  if (cached) return cached;
  let file = {};
  try {
    file = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, "slipway.config.json"), "utf8"));
  } catch {
    // Missing or unreadable config: fall back to env vars and defaults.
  }
  const deployerUrl = (process.env.SLIPWAY_DEPLOYER_URL || file.deployerUrl || "").replace(/\/+$/, "");
  const org = process.env.SLIPWAY_ORG || file.org || "acme";
  cached = { deployerUrl, org };
  return cached;
}

export function deployerUrl() {
  const url = config().deployerUrl;
  if (!url) {
    throw new CliError(
      "The slipway plugin doesn't know the deployer's URL yet. Ask the dev team to set deployerUrl " +
        "in the plugin's slipway.config.json, or set SLIPWAY_DEPLOYER_URL.",
    );
  }
  return url;
}

let token;

// The colleague's GitHub token. The deployer checks it with GitHub and confirms org membership.
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
