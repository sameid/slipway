// Naming rules shared by the API, the worker and the dashboard (docs/contracts.md, "Names").

export const APP_NAME = /^[a-z][a-z0-9-]{1,18}[a-z0-9]$/;
const RESERVED = new Set(["slipway", "deployer", "platform", "api", "www"]);

export const ENVS = ["staging", "prod"] as const;
export type AppEnv = (typeof ENVS)[number];
export const isAppEnv = (env: string): env is AppEnv => (ENVS as readonly string[]).includes(env);

export const SECRET_KEY = /^[A-Z][A-Z0-9_]{0,127}$/;

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
