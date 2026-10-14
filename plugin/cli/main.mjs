// slipway CLI: everything the plugin's commands and skills need from the deployer,
// plus the mechanical parts of /new-app. Zero dependencies; Node 24.
import { parseArgs } from "node:util";
import { appName } from "./app.mjs";
import { config } from "./config.mjs";
import { api } from "./deployer.mjs";
import { checkName, newApp, register, templates } from "./new-app.mjs";
import { secret } from "./secret.mjs";
import { CliError, EXIT, print, printJson } from "./util.mjs";
import { jobs, log, status, waitApp, waitPr } from "./watch.mjs";

const HELP = `slipway: the slipway plugin's CLI

Usage: slipway <command> [options]

Apps
  new-app --name <name> --description <text> [--template react-express] [--dir <parent>] [--local-only]
                          copy the template, create acme/<name>, register it
  check-name <name>       is the name valid and free?
  templates               list templates
  register                register an already-pushed repo with the deployer
  status                  staging and prod releases, running jobs, worktrees to clean up
  wait-app                wait until the app's first staging deploy is live
  destroy --yes           ask for the app to be torn down (confirmed on the dashboard)

Pull requests and jobs
  wait-pr <number> [--head <sha>]   wait for check, merge and staging deploy
  jobs [--limit 20]       recent builds and deploys
  log <job-id> [--tail 200]         a job's log

Secrets (values are only ever typed into a browser page)
  secret list
  secret set <KEY> --env staging|prod [--open]   one-time link, then wait for the redeploy
  secret link <KEY> --env staging|prod [--open]  one-time link only
  secret wait <link-id>

Other
  whoami                  your GitHub login as the deployer sees it

Options
  --app <name>            app to act on (default: name in app.yaml at the git root)
  --json                  machine-readable output
  --max-seconds <n>       for wait commands (default 540, under the Bash tool's 10-minute limit)
  --interval <seconds>    polling interval for wait commands

Exit codes: 0 done, 1 error, 2 usage, 3 failed, 4 blocked (PR won't auto-merge),
10 still waiting (run the same command again).

Config: SLIPWAY_DEPLOYER_URL or deployerUrl in slipway.config.json; SLIPWAY_GH_TOKEN or gh auth token.`;

const OPTIONS = {
  app: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  name: { type: "string" },
  description: { type: "string" },
  template: { type: "string" },
  dir: { type: "string" },
  "local-only": { type: "boolean" },
  "max-seconds": { type: "string" },
  interval: { type: "string" },
  head: { type: "string" },
  pr: { type: "string" },
  limit: { type: "string" },
  tail: { type: "string" },
  env: { type: "string" },
  open: { type: "boolean" },
  yes: { type: "boolean" },
};

const COMMANDS = {
  "new-app": newApp,
  "check-name": checkName,
  templates,
  register,
  status,
  "wait-app": waitApp,
  "wait-pr": waitPr,
  jobs,
  log,
  secret,
  destroy,
  whoami,
};

async function whoami(opts) {
  const me = await api.whoami();
  if (opts.json) return printJson({ ...me, deployerUrl: config().deployerUrl });
  print(`${me.login} on ${config().deployerUrl}`);
}

async function destroy(opts) {
  const name = appName(opts);
  if (!opts.yes) {
    throw new CliError(
      `This asks for ${name}'s staging and prod environments, databases and repo to be torn down. ` +
        "Confirm with the app's owner, then run again with --yes.",
      EXIT.USAGE,
    );
  }
  const result = await api.post(`/api/apps/${name}/destroy`);
  if (opts.json) return printJson(result);
  print(
    `Teardown of ${name} requested. Nothing is deleted until someone confirms it on the dashboard by typing the app name:`,
    `  ${result.dashboardUrl}`,
  );
}

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`slipway: ${err.message}\nRun: slipway --help\n`);
    process.exit(EXIT.USAGE);
  }
  const { values: opts, positionals } = parsed;
  const [command, ...rest] = positionals;
  if (!command || opts.help || command === "help") {
    print(HELP);
    process.exit(command || opts.help ? EXIT.OK : EXIT.USAGE);
  }
  const handler = COMMANDS[command];
  if (!handler) {
    process.stderr.write(`slipway: unknown command "${command}". Run: slipway --help\n`);
    process.exit(EXIT.USAGE);
  }
  try {
    await handler(opts, rest);
    process.exitCode = EXIT.OK;
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    if (err.message) process.stderr.write(`slipway: ${err.message}\n`);
    process.exitCode = err.code;
  }
}
