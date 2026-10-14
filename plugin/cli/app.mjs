// The app repo on disk: where it is, what app.yaml says, and app name rules.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CliError, EXIT, run } from "./util.mjs";

export const NAME_PATTERN = /^[a-z][a-z0-9-]{1,18}[a-z0-9]$/;
const RESERVED = new Set(["slipway", "deployer", "platform", "api", "www"]);

// Why a name can't be used, or null if it's fine.
export function nameProblem(name) {
  if (!name) return "An app name is required.";
  if (!NAME_PATTERN.test(name)) {
    return (
      `"${name}" isn't a valid app name: use 3-20 lowercase letters, digits and hyphens, ` +
      "starting with a letter and not ending with a hyphen."
    );
  }
  if (RESERVED.has(name)) return `"${name}" is reserved by the platform.`;
  return null;
}

export function gitToplevel(cwd = process.cwd()) {
  const result = run("git", ["rev-parse", "--show-toplevel"], { cwd });
  return result.status === 0 ? result.stdout.trim() : null;
}

// Just the parts of app.yaml the CLI needs. Not a general YAML parser: app.yaml's
// top-level keys are simple scalars and the secrets list is a block or flow sequence.
export function parseAppYaml(text) {
  const result = { name: null, template: null, owner: null, secrets: [] };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const match = /^([a-z_]+):(.*)$/.exec(lines[i]);
    if (!match) continue;
    const [, key, rest] = match;
    const value = scalar(rest);
    if (key === "name" || key === "template" || key === "owner") result[key] = value || null;
    if (key === "secrets") {
      if (value.startsWith("[")) {
        result.secrets = value
          .replace(/^\[|\]$/g, "")
          .split(",")
          .map((item) => scalar(item))
          .filter(Boolean);
      } else {
        for (let j = i + 1; j < lines.length; j++) {
          const item = /^\s+-\s*(.*)$/.exec(lines[j]);
          if (item) result.secrets.push(scalar(item[1]));
          else if (/^\S/.test(lines[j])) break;
        }
      }
    }
  }
  return result;
}

function scalar(raw) {
  let value = raw.trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    const end = value.indexOf(quote, 1);
    return end > 0 ? value.slice(1, end) : value.slice(1);
  }
  const comment = value.search(/\s#/);
  if (comment >= 0) value = value.slice(0, comment);
  return value.startsWith("#") ? "" : value.trim();
}

export function readAppYaml(dir) {
  const file = path.join(dir, "app.yaml");
  if (!existsSync(file)) return null;
  return parseAppYaml(readFileSync(file, "utf8"));
}

// The app repo we're in: { root, manifest }. Throws if we're not in one.
export function currentApp(cwd = process.cwd()) {
  const root = gitToplevel(cwd);
  const manifest = root && readAppYaml(root);
  if (!manifest || !manifest.template) {
    throw new CliError(
      "This isn't a slipway app repo (no app.yaml with a template at the git root). " +
        "cd into the app, or pass --app <name>.",
      EXIT.USAGE,
    );
  }
  return { root, manifest };
}

export function appName(opts) {
  if (opts.app) {
    const problem = nameProblem(opts.app);
    if (problem) throw new CliError(problem, EXIT.USAGE);
    return opts.app;
  }
  const { manifest } = currentApp();
  if (!manifest.name) throw new CliError("app.yaml has no name.", EXIT.USAGE);
  return manifest.name;
}
