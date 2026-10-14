// new-app and the commands around it: templates, check-name, register.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { appName, nameProblem } from "./app.mjs";
import { config, PLUGIN_ROOT } from "./config.mjs";
import { api } from "./deployer.mjs";
import { CliError, EXIT, print, printJson, run, runOrThrow } from "./util.mjs";

const TEMPLATES_DIR = path.join(PLUGIN_ROOT, "templates");
const SKIP = new Set(["node_modules", "dist", ".git", ".DS_Store", ".turbo", "coverage"]);

export function listTemplates() {
  if (!existsSync(TEMPLATES_DIR)) return [];
  return readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export async function templates(opts) {
  const names = listTemplates();
  if (opts.json) return printJson({ templates: names });
  print(...names);
}

// Why the name can't be used (invalid, registered, or the repo exists), or null.
async function nameTaken(name) {
  const problem = nameProblem(name);
  if (problem) return problem;
  if (await api.app(name)) return `"${name}" is already registered with the deployer.`;
  const repo = `${config().org}/${name}`;
  const view = run("gh", ["repo", "view", repo, "--json", "name"]);
  if (view.status === 0) return `The GitHub repo ${repo} already exists.`;
  return null;
}

export async function checkName(opts, [name = opts.name] = []) {
  const problem = await nameTaken(name);
  if (opts.json) printJson({ name, available: !problem, reason: problem });
  else print(problem ?? `"${name}" is available.`);
  if (problem) throw new CliError("", EXIT.FAILED);
}

// Copy a template, skipping build output and local env files, and fill in placeholders.
export function copyTemplate(from, to, values) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const name = entry.name;
    if (SKIP.has(name) || name.endsWith(".tsbuildinfo")) continue;
    if (name.startsWith(".env") && name !== ".env.example") continue;
    const src = path.join(from, name);
    const dest = path.join(to, name);
    if (entry.isDirectory()) {
      copyTemplate(src, dest, values);
    } else if (entry.isFile()) {
      const buffer = readFileSync(src);
      const isText = !buffer.subarray(0, 8000).includes(0);
      const text = isText ? buffer.toString("utf8") : null;
      writeFileSync(dest, text !== null && text.includes("__APP_") ? fillPlaceholders(text, name, values) : buffer);
      chmodSync(dest, statSync(src).mode & 0o777);
    }
  }
}

// Replace __APP_NAME__, __APP_DESCRIPTION__ and __APP_OWNER__. Names and GitHub logins
// are safe anywhere; the description is free text, so it's escaped for its context.
export function fillPlaceholders(text, fileName, values) {
  const ext = path.extname(fileName).toLowerCase();
  return text.replace(/(["']?)__APP_(NAME|DESCRIPTION|OWNER)__(["']?)/g, (_, open, key, close) => {
    const value = values[key];
    if (key !== "DESCRIPTION") return `${open}${value}${close}`;
    if (open === '"' || close === '"') return `${open}${JSON.stringify(value).slice(1, -1)}${close}`;
    if (open === "'" || close === "'") {
      const escaped = ext === ".yaml" || ext === ".yml" ? value.replace(/'/g, "''") : value.replace(/[\\']/g, "\\$&");
      return `${open}${escaped}${close}`;
    }
    if (ext === ".yaml" || ext === ".yml") return `${open}${JSON.stringify(value)}${close}`;
    if (ext === ".html") return `${open}${escapeHtml(value)}${close}`;
    return `${open}${value}${close}`;
  });
}

const escapeHtml = (value) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function cleanDescription(raw) {
  const value = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) throw new CliError("A one-line description is required (--description).", EXIT.USAGE);
  if (value.length > 200) throw new CliError("Keep the description to one line, under 200 characters.", EXIT.USAGE);
  return value;
}

export async function newApp(opts) {
  const name = opts.name;
  const problem = nameProblem(name);
  if (problem) throw new CliError(problem, EXIT.USAGE);
  const description = cleanDescription(opts.description);
  const template = opts.template ?? "react-express";
  const templateDir = path.join(TEMPLATES_DIR, template);
  if (!existsSync(path.join(templateDir, "app.yaml"))) {
    throw new CliError(`No template "${template}". Available: ${listTemplates().join(", ") || "none"}`, EXIT.USAGE);
  }
  const target = path.resolve(opts.dir ?? process.cwd(), name);
  if (existsSync(target)) throw new CliError(`${target} already exists.`, EXIT.USAGE);
  const org = config().org;
  const localOnly = Boolean(opts["local-only"]);

  const { login } = await api.whoami();
  const taken = await nameTaken(name);
  if (taken) throw new CliError(taken, EXIT.FAILED);

  print(`Creating ${target} from the ${template} template`);
  copyTemplate(templateDir, target, { NAME: name, DESCRIPTION: description, OWNER: login });

  runOrThrow("git", ["init", "--quiet", "--initial-branch=main"], { cwd: target });
  runOrThrow("git", ["add", "--all"], { cwd: target });
  runOrThrow(
    "git",
    ["commit", "--quiet", "-m", `Create ${name} from the slipway ${template} template`],
    { cwd: target },
    "git commit (if git doesn't know who you are, run: git config --global user.name/user.email)",
  );

  const repo = `${org}/${name}`;
  const result = { name, path: target, repo, repoUrl: `https://github.com/${repo}`, app: null };
  if (localOnly) {
    print(`Created ${target} locally. Nothing was pushed or registered (--local-only).`);
    if (opts.json) printJson(result);
    return;
  }

  print(`Creating the private repo ${repo} and pushing main`);
  runOrThrow(
    "gh",
    ["repo", "create", repo, "--private", "--source", ".", "--remote", "origin", "--push", "--description", description],
    { cwd: target },
    "gh repo create",
  );

  print("Registering the app with the deployer");
  try {
    result.app = await api.post("/api/apps", { name });
  } catch (err) {
    throw new CliError(
      `The repo was created and pushed, but registering it failed: ${err.message}\n` +
        `Fix the problem, then run: slipway register --app ${name}`,
    );
  }
  if (opts.json) return printJson(result);
  print(
    "",
    `Created ${result.repoUrl}`,
    `Local folder: ${target}`,
    `Staging is being set up now (about 10-15 minutes on the first deploy). Follow it with: slipway wait-app --app ${name}`,
  );
}

export async function register(opts) {
  const name = appName(opts);
  const app = await api.post("/api/apps", { name });
  if (opts.json) return printJson(app);
  print(`Registered ${name}. Follow staging with: slipway wait-app --app ${name}`);
}
