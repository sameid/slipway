// pm2 apps on the deployer instance (docs/contracts.md, "Deployer host"). pm2
// runs as root (pm2-root.service) and starts each app as its own user. It has
// no env-file option, so this file reads /etc/slipway/*.env itself.
//
//   pm2 startOrReload /opt/slipway/current/ecosystem.config.cjs --update-env && pm2 save
//
// pm2 starts an app with only its user's primary group (Node's spawn drops
// supplementary groups), so the host grants access through owners and primary
// groups: the runner socket's directory is setgid `slipway` (the deployer's
// group), and Docker's socket belongs to group `slipway-runner`.
//
// Paths go through /opt/slipway/current, so a reload after switching releases
// starts the new code.
const { readFileSync } = require("node:fs");

const ROOT = process.env.SLIPWAY_ROOT || "/opt/slipway/current";
const NODE = process.env.SLIPWAY_NODE || "/opt/slipway/node/bin/node";

/** KEY=value lines; # comments and blank lines are skipped; optional quotes are stripped. */
function envFile(path) {
  const env = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    let value = line.slice(eq + 1).trim();
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    env[line.slice(0, eq).trim()] = value;
  }
  return env;
}

const deployerEnv = envFile("/etc/slipway/deployer.env");
const runnerEnv = envFile("/etc/slipway/runner.env");

const common = { time: true, exp_backoff_restart_delay: 1000 };

module.exports = {
  apps: [
    {
      ...common,
      name: "deployer",
      script: `${ROOT}/deployer/dist/server.js`,
      interpreter: NODE,
      cwd: `${ROOT}/deployer`,
      uid: "slipway",
      gid: "slipway",
      env: { ...deployerEnv, HOME: "/var/lib/slipway" },
      kill_timeout: 15_000,
    },
    {
      ...common,
      name: "runner",
      script: `${ROOT}/deployer/dist/runner/main.js`,
      interpreter: NODE,
      cwd: `${ROOT}/deployer`,
      uid: "slipway-runner",
      gid: "slipway-runner",
      // pm2 doesn't set HOME for another user. Jobs use the instance role
      // directly; there's no ~/.aws/config unless RUNNER_PUBLISH_PROFILE or
      // RUNNER_DEPLOY_PROFILE in runner.env name a profile in it.
      env: { ...runnerEnv, HOME: "/var/lib/slipway-runner" },
      // A restart fails the runs in progress, and deploys can't be resumed: on
      // SIGINT/SIGTERM the runner stops taking runs and waits for active ones
      // (RUNNER_SHUTDOWN_GRACE_SECONDS, default 14 minutes) before stopping
      // them. So pm2 waits a little longer before it kills it, and signals only
      // the runner, not the jobs it's running.
      kill_timeout: 15 * 60_000,
      treekill: false,
    },
  ],
};
