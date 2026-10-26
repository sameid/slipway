// Naming rules shared by the API, the worker and the dashboard (docs/contracts.md, "Names").

export const APP_NAME = /^[a-z][a-z0-9-]{1,18}[a-z0-9]$/;
const RESERVED = new Set(["slipway", "deployer", "platform", "api", "www"]);

export const ENVS = ["staging", "prod"] as const;
export type AppEnv = (typeof ENVS)[number];
export const isAppEnv = (env: string): env is AppEnv => (ENVS as readonly string[]).includes(env);

export const SECRET_KEY = /^[A-Z][A-Z0-9_]{0,127}$/;

// The rules for a secret's name, as jobs/appyaml.mjs has them for app.yaml.
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_SECRETS = 50;
// Set by the platform; a secret with one of these names would shadow it.
const PLATFORM_SECRETS = new Set([
  "PORT", "NODE_ENV", "APP_ENV", "RELEASE", "DEPLOY_ID",
  "DB_HOST", "DB_PORT", "DB_NAME", "DB_SECRET_ARN", "DB_SSL_CA", "DATABASE_URL",
]);
const PLATFORM_PREFIXES = ["AWS_", "ECS_"];
// Names that change how Node or the OS runs the app (NODE_OPTIONS can load any
// code, a proxy sees its traffic). Only app.yaml, through a pull request, can
// declare these; the dashboard can't add them (jobs/appyaml.mjs skips them too).
const RUNTIME_SECRETS = new Set([
  "PATH", "HOME", "SHELL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR",
]);
const RUNTIME_PREFIXES = ["NODE_", "LD_"];

/** Why `key` can't be a secret's name, or null if it can. `declared`: app.yaml on main lists it. */
export function secretNameProblem(key: string, declared: boolean): string | null {
  if (!SECRET_NAME.test(key)) return `${key || "That"} isn't a secret name: use up to 64 capital letters, digits and underscores, like STRIPE_KEY`;
  if (PLATFORM_SECRETS.has(key) || PLATFORM_PREFIXES.some((p) => key.startsWith(p))) return `${key} is set by the platform`;
  if (!declared && (RUNTIME_SECRETS.has(key) || RUNTIME_PREFIXES.some((p) => key.startsWith(p)))) {
    return `${key} changes how the app runs, so it can only be added under secrets: in app.yaml`;
  }
  return null;
}

/** Why `name` can't be an app name, or null if it can. */
export function invalidAppName(name: string): string | null {
  if (!APP_NAME.test(name)) {
    return "App names are 3-20 characters: lowercase letters, digits and hyphens, starting with a letter and not ending with a hyphen";
  }
  if (RESERVED.has(name)) return `"${name}" is reserved`;
  return null;
}

export const repoFor = (owner: string, app: string) => `${owner}/${app}`;
/** GitHub owner and repo names are case-insensitive: webhooks may spell the owner "Acme", apps.repo "acme". */
export const sameRepo = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
// Commit status contexts carry the product's name, not the owner's.
export const CHECK_CONTEXT = "slipway/check";
export const deployContext = (env: AppEnv) => `slipway/deploy-${env}`;
export const shortSha = (sha: string) => sha.slice(0, 7);
export const secretParameter = (app: string, env: AppEnv, key: string) => `/apps/${app}/${env}/${key}`;

/** Files an agent may not change without dev team review (design 5.1 guardrails). */
export function isProtectedPath(path: string): boolean {
  return path.startsWith(".github/") || path === "CODEOWNERS" || path === "docs/CODEOWNERS";
}
