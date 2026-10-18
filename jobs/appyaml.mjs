#!/usr/bin/env node
// Reads and validates an app's app.yaml (design 5.2), and renders the Terraform
// root config deploy-env applies for an app and environment (design 5.6).
//
//   node appyaml.mjs validate <app.yaml> [--app NAME]
//   node appyaml.mjs get <app.yaml> <key>          e.g. web.build_command, secrets
//   node appyaml.mjs render-shared --app NAME --out-dir DIR --modules-dir DIR --state-bucket B --region R
//   node appyaml.mjs render-env --app NAME --env ENV --out-dir DIR --modules-dir DIR --state-bucket B --region R
//                               (--app-yaml FILE | --inputs-json FILE)
//   node appyaml.mjs check-links DIR [--what TEXT]   fail if a symbolic link under DIR points outside it
//
// The root config is written as main.tf.json: generating JSON is safer than
// templating HCL, and Terraform reads both.

import { mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const APP_NAME = /^[a-z][a-z0-9-]{1,18}[a-z0-9]$/;
export const SIZES = ["small", "medium", "large"];
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MAX_SECRETS = 50;

// Set by the platform; an app secret with one of these names would shadow it.
const RESERVED_SECRETS = new Set([
  "PORT", "NODE_ENV", "APP_ENV", "RELEASE", "DEPLOY_ID",
  "DB_HOST", "DB_PORT", "DB_NAME", "DB_SECRET_ARN", "DB_SSL_CA", "DATABASE_URL",
]);
const RESERVED_SECRET_PREFIXES = ["AWS_", "ECS_"];

const TOP_LEVEL_KEYS = new Set([
  "name", "template", "description", "owner", "api", "web", "secrets", "auto_merge", "sizes",
]);

const DEFAULTS = {
  api: { port: 3000, health_check: "/api/health", migrate_command: ["node", "dist/migrate.js"] },
  web: { build_command: "npm run build --workspace web", output_dir: "web/dist" },
};

const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Parses app.yaml text. Returns { config, errors }; config is normalized with defaults. */
export function parseAppYaml(text, { app } = {}) {
  const errors = [];
  let doc;
  try {
    doc = YAML.parse(text, { prettyErrors: true, uniqueKeys: true });
  } catch (err) {
    return { config: null, errors: [`not valid YAML: ${err.message.split("\n")[0]}`] };
  }
  if (!isMap(doc)) return { config: null, errors: ["must be a YAML mapping"] };

  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`unknown key "${key}"`);
  }

  const config = {};

  // name
  if (typeof doc.name !== "string" || !APP_NAME.test(doc.name)) {
    errors.push("name must be 3-20 lowercase letters, digits or hyphens, start with a letter and not end with a hyphen");
  } else if (app && doc.name !== app) {
    errors.push(`name is "${doc.name}" but this app is registered as "${app}"`);
  }
  config.name = doc.name;

  for (const key of ["template", "description", "owner"]) {
    if (doc[key] !== undefined && typeof doc[key] !== "string") errors.push(`${key} must be a string`);
    config[key] = doc[key] ?? null;
  }

  // api
  const api = doc.api ?? {};
  if (!isMap(api)) errors.push("api must be a mapping");
  const port = api.port ?? DEFAULTS.api.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push("api.port must be an integer from 1 to 65535");
  const healthCheck = api.health_check ?? DEFAULTS.api.health_check;
  // CloudFront only routes /api/* to the service, and deploy-env checks health through CloudFront.
  if (typeof healthCheck !== "string" || !/^\/api\/[A-Za-z0-9._~\/-]*$/.test(healthCheck)) {
    errors.push("api.health_check must be a path under /api/ (e.g. /api/health)");
  }
  const migrate = api.migrate_command ?? DEFAULTS.api.migrate_command;
  if (!Array.isArray(migrate) || migrate.length === 0 || !migrate.every((s) => typeof s === "string" && s !== "")) {
    errors.push('api.migrate_command must be a non-empty list of strings, e.g. ["node", "dist/migrate.js"]');
  }
  for (const key of Object.keys(isMap(api) ? api : {})) {
    if (!["port", "health_check", "migrate_command"].includes(key)) errors.push(`unknown key "api.${key}"`);
  }
  config.api = { port, health_check: healthCheck, migrate_command: migrate };

  // web
  const web = doc.web ?? {};
  if (!isMap(web)) errors.push("web must be a mapping");
  const buildCommand = web.build_command ?? DEFAULTS.web.build_command;
  if (typeof buildCommand !== "string" || buildCommand.trim() === "") errors.push("web.build_command must be a string");
  let outputDir = web.output_dir ?? DEFAULTS.web.output_dir;
  if (typeof outputDir !== "string" || outputDir === "" || path.posix.isAbsolute(outputDir)) {
    errors.push("web.output_dir must be a relative path such as web/dist");
  } else {
    outputDir = path.posix.normalize(outputDir).replace(/\/+$/, "");
    if (outputDir === "." || outputDir.startsWith("..")) errors.push("web.output_dir must be inside the repo");
  }
  for (const key of Object.keys(isMap(web) ? web : {})) {
    if (!["build_command", "output_dir"].includes(key)) errors.push(`unknown key "web.${key}"`);
  }
  config.web = { build_command: buildCommand, output_dir: outputDir };

  // secrets: names only (design 5.8)
  const secrets = doc.secrets ?? [];
  if (!Array.isArray(secrets)) {
    errors.push("secrets must be a list of names");
  } else {
    const seen = new Set();
    for (const name of secrets) {
      if (typeof name !== "string" || !SECRET_NAME.test(name)) {
        errors.push(`secret name ${JSON.stringify(name)} must be UPPER_SNAKE_CASE`);
      } else if (RESERVED_SECRETS.has(name) || RESERVED_SECRET_PREFIXES.some((p) => name.startsWith(p))) {
        errors.push(`secret name ${name} is reserved by the platform`);
      } else if (seen.has(name)) {
        errors.push(`secret name ${name} is listed twice`);
      }
      seen.add(name);
    }
    if (secrets.length > MAX_SECRETS) errors.push(`at most ${MAX_SECRETS} secrets`);
  }
  config.secrets = Array.isArray(secrets) ? secrets : [];

  // Platform-owned fields
  if (doc.auto_merge !== undefined && typeof doc.auto_merge !== "boolean") errors.push("auto_merge must be true or false");
  config.auto_merge = doc.auto_merge ?? true;

  const sizes = doc.sizes ?? {};
  if (!isMap(sizes)) errors.push("sizes must be a mapping");
  config.sizes = {};
  for (const env of ["staging", "prod"]) {
    const size = (isMap(sizes) ? sizes[env] : undefined) ?? "small";
    if (!SIZES.includes(size)) errors.push(`sizes.${env} must be one of ${SIZES.join(", ")}`);
    config.sizes[env] = size;
  }
  for (const key of Object.keys(isMap(sizes) ? sizes : {})) {
    if (!["staging", "prod"].includes(key)) errors.push(`unknown key "sizes.${key}"`);
  }

  return { config: errors.length ? null : config, errors };
}

/** Reads KEY=VALUE lines from versions.env. */
export function readVersions(file = path.join(HERE, "versions.env")) {
  const versions = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) versions[m[1]] = m[2].trim();
  }
  return versions;
}

function terraformBlock({ app, stack, stateBucket, region, versions }) {
  return {
    required_version: ">= 1.11",
    required_providers: {
      aws: { source: "hashicorp/aws", version: versions.AWS_PROVIDER_VERSION },
      random: { source: "hashicorp/random", version: versions.RANDOM_PROVIDER_VERSION },
    },
    backend: {
      s3: {
        bucket: stateBucket,
        key: `apps/${app}/${stack}.tfstate`,
        region,
        encrypt: true,
        use_lockfile: true,
      },
    },
  };
}

function providerBlock({ app, env, region }) {
  return {
    aws: { region, default_tags: { tags: { platform: "slipway", app, env } } },
  };
}

function moduleSource(outDir, modulesDir, name) {
  let rel = path.relative(path.resolve(outDir), path.resolve(modulesDir, name)).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

/** Root config for apps/<app>/shared.tfstate. */
export function renderShared({ app, outDir, modulesDir, stateBucket, region, versions = readVersions() }) {
  if (!APP_NAME.test(app)) throw new Error(`invalid app name "${app}"`);
  if (!region) throw new Error("region is required");
  const outputs = ["ecr_repository_url", "ecr_repository_name", "log_group_name"];
  return {
    terraform: terraformBlock({ app, stack: "shared", stateBucket, region, versions }),
    provider: providerBlock({ app, env: "shared", region }),
    module: { shared: { source: moduleSource(outDir, modulesDir, "app-shared"), app } },
    output: Object.fromEntries(outputs.map((o) => [o, { value: `\${module.shared.${o}}` }])),
  };
}

export const ENV_OUTPUTS = [
  "app_url", "service_url", "service_name", "service_image", "migrate_image", "release", "deploy_id",
  "cluster_name", "migrate_task_definition_arn", "subnet_ids", "task_security_group_id", "web_bucket",
  "distribution_id", "log_group_name", "env", "custom_domain", "certificate_arn", "inputs",
];

/** Module inputs for an environment from a validated app.yaml config. */
export function inputsFromConfig(config, env) {
  return {
    size: config.sizes[env],
    api_port: config.api.port,
    health_check_path: config.api.health_check,
    migrate_command: config.api.migrate_command,
    secret_names: config.secrets,
  };
}

/** Root config for apps/<app>/<env>.tfstate. Per-phase values stay variables (-var on the command line). */
export function renderEnv({ app, env, inputs, outDir, modulesDir, stateBucket, region, versions = readVersions() }) {
  if (!region) throw new Error("region is required");
  if (!APP_NAME.test(app)) throw new Error(`invalid app name "${app}"`);
  if (!["staging", "prod"].includes(env)) throw new Error(`invalid env "${env}"`);
  for (const key of ["size", "api_port", "health_check_path", "migrate_command", "secret_names"]) {
    if (inputs[key] === undefined) throw new Error(`inputs.${key} is missing`);
  }
  const phaseVars = {
    service_image: { type: "string", default: "" },
    migrate_image: { type: "string", default: "" },
    release: { type: "string", default: "" },
    deploy_id: { type: "string", default: "" },
    // A custom domain added on the dashboard and its us-east-1 certificate.
    custom_domain: { type: "string", default: "" },
    certificate_arn: { type: "string", default: "" },
    destroying: { type: "bool", default: false },
  };
  return {
    terraform: terraformBlock({ app, stack: env, stateBucket, region, versions }),
    provider: providerBlock({ app, env, region }),
    variable: phaseVars,
    module: {
      env: {
        source: moduleSource(outDir, modulesDir, "app-env"),
        app,
        env,
        size: inputs.size,
        api_port: inputs.api_port,
        health_check_path: inputs.health_check_path,
        migrate_command: inputs.migrate_command,
        secret_names: inputs.secret_names,
        ...Object.fromEntries(Object.keys(phaseVars).map((v) => [v, `\${var.${v}}`])),
      },
    },
    output: Object.fromEntries(ENV_OUTPUTS.map((o) => [o, { value: `\${module.env.${o}}` }])),
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

class UsageError extends Error {
  constructor(message, summary = message.split("\n")[0]) {
    super(message);
    this.summary = summary; // one line, for the build log's ERROR: line
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      flags[arg.slice(2)] = value;
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function need(flags, ...names) {
  for (const name of names) if (!flags[name]) throw new UsageError(`--${name} is required`);
}

function loadConfig(file, app) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new UsageError(`${path.basename(file)} not found: every app repo needs an app.yaml at its root`);
  }
  const { config, errors } = parseAppYaml(text, { app });
  if (errors.length) {
    throw new UsageError(
      `app.yaml is invalid:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
      `app.yaml is invalid: ${errors.join("; ")}`,
    );
  }
  return config;
}

function get(config, key) {
  const value = key.split(".").reduce((v, k) => (v == null ? undefined : v[k]), config);
  if (value === undefined) throw new UsageError(`unknown key ${key}`);
  if (Array.isArray(value)) return key === "secrets" ? value.join("\n") : JSON.stringify(value);
  return String(value);
}

const inside = (root, p) => p === root || p.startsWith(root + path.sep);

/**
 * Symbolic links under `dir` that point outside it, relative to `dir`. App code
 * is untrusted: a link out of its folder could make the runner (which can read
 * other apps' runs) read or publish files that aren't the app's.
 */
export function linksOutside(dir) {
  const root = realpathSync(dir);
  const bad = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isSymbolicLink()) {
        const lexical = path.resolve(path.dirname(p), readlinkSync(p));
        let real = lexical;
        try {
          real = realpathSync(p);
        } catch {
          // dangling: judge it by where it says it points
        }
        if (!inside(root, lexical) || !inside(root, real)) bad.push(path.relative(root, p));
      } else if (entry.isDirectory()) {
        walk(p);
      }
    }
  };
  walk(root);
  return bad;
}

function writeRoot(outDir, root) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "main.tf.json"), `${JSON.stringify(root, null, 2)}\n`);
}

export function main(argv) {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  switch (command) {
    case "validate": {
      loadConfig(positional[0] ?? "app.yaml", flags.app);
      return "app.yaml OK";
    }
    case "get": {
      if (positional.length !== 2) throw new UsageError("usage: get <app.yaml> <key>");
      return get(loadConfig(positional[0]), positional[1]);
    }
    case "render-shared": {
      need(flags, "app", "out-dir", "modules-dir", "state-bucket");
      writeRoot(flags["out-dir"], renderShared({
        app: flags.app, outDir: flags["out-dir"], modulesDir: flags["modules-dir"],
        stateBucket: flags["state-bucket"], region: flags.region,
      }));
      return `rendered ${flags["out-dir"]}/main.tf.json`;
    }
    case "render-env": {
      need(flags, "app", "env", "out-dir", "modules-dir", "state-bucket");
      let inputs;
      if (flags["app-yaml"]) {
        inputs = inputsFromConfig(loadConfig(flags["app-yaml"], flags.app), flags.env);
      } else if (flags["inputs-json"]) {
        inputs = JSON.parse(readFileSync(flags["inputs-json"], "utf8"));
      } else {
        throw new UsageError("--app-yaml or --inputs-json is required");
      }
      writeRoot(flags["out-dir"], renderEnv({
        app: flags.app, env: flags.env, inputs, outDir: flags["out-dir"], modulesDir: flags["modules-dir"],
        stateBucket: flags["state-bucket"], region: flags.region,
      }));
      return `rendered ${flags["out-dir"]}/main.tf.json`;
    }
    case "check-links": {
      if (positional.length !== 1) throw new UsageError("usage: check-links <dir> [--what TEXT]");
      const bad = linksOutside(positional[0]);
      if (bad.length) {
        const what = flags.what ?? positional[0];
        const err = new UsageError(
          `${what} contains symbolic links that point outside it: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ` and ${bad.length - 5} more` : ""}`,
        );
        throw err;
      }
      return `no symbolic links out of ${flags.what ?? positional[0]}`;
    }
    default:
      throw new UsageError("usage: appyaml.mjs validate|get|render-shared|render-env|check-links ...");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof UsageError ? err.message : err.stack);
    // The build scripts set this so the deployer gets one readable ERROR: line (docs/contracts.md).
    if (process.env.SLIPWAY_LOG_ERRORS) console.error(`ERROR: ${err.summary ?? err.message.split("\n")[0]}`);
    process.exit(1);
  }
}
