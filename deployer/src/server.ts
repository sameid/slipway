// Entry point: one process serves the dashboard, plugin API and webhooks, and
// runs the job worker (design 5.5). Builds and deploys run in the runner, a
// separate process on the same instance (src/runner, docs/contracts.md).
import { randomUUID } from "node:crypto";
import { AwsPlatform, loadGithubAppSecret, loadParameter } from "./aws.js";
import { createApp } from "./app.js";
import { loadConfig, withGithubAccess } from "./config.js";
import { openDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { consoleLog, type Deps } from "./deps.js";
import { receiveGithubEvent } from "./deliveries.js";
import { catchUp } from "./events.js";
import { FakeGitHub, FakePlatform, FakeRuns, fakeRoutes } from "./fake.js";
import { OctokitGitHub } from "./github.js";
import { SocketRuns } from "./runs.js";
import { pruneOld, Worker } from "./worker.js";

const base = loadConfig();
// On the instance, who else may use the deployer and the CODEOWNERS entry are an SSM
// parameter rather than user data, so changing them restarts the deployer instead of
// replacing the instance (foundation/deployer.tf).
const config =
  base.githubAccessParam && !base.fake
    ? withGithubAccess(base, await loadParameter(base.region, base.githubAccessParam))
    : base;
const db = openDb(config.dbFile);
runMigrations(db);

let deps: Deps;
let fakeGithub: FakeGitHub | undefined;
if (config.fake) {
  const publicUrl = config.publicUrl!;
  fakeGithub = new FakeGitHub(config.owner, config.fakeOwnerType);
  deps = {
    db,
    config,
    github: fakeGithub,
    runs: new FakeRuns({
      github: fakeGithub,
      autoFinishMs: config.fakeBuildSeconds * 1000,
      siteUrl: (app, env) => `${publicUrl}/fake/sites/${app}/${env}`,
    }),
    platform: new FakePlatform(),
    publicUrl,
    now: () => new Date(),
    log: consoleLog,
    kick: () => {},
  };
  fakeGithub.onEvent = (event, payload) => receiveGithubEvent(deps, { event, deliveryId: randomUUID() }, payload);
} else {
  const app = config.githubApp ?? (await loadGithubAppSecret(config.region, config.githubAppSecretId));
  deps = {
    db,
    config,
    github: new OctokitGitHub({ ...app, owner: config.owner }),
    runs: new SocketRuns(config.runnerSocket),
    platform: new AwsPlatform({
      region: config.region,
      kmsKeyId: config.secretsKmsKeyId,
      alertsTopicArn: config.alertsTopicArn,
    }),
    publicUrl: (await resolvePublicUrl(config)).replace(/\/$/, ""),
    now: () => new Date(),
    log: consoleLog,
    kick: () => {},
  };
}

const worker = new Worker(deps);
deps.kick = () => worker.kick();
const app = createApp(deps, fakeGithub ? (a) => a.use("/fake", fakeRoutes(fakeGithub)) : undefined);
const server = app.listen(config.port, config.host, () => {
  deps.log("deployer listening", { host: config.host, port: config.port, publicUrl: deps.publicUrl, fake: config.fake });
});

// GitHub doesn't retry failed webhook deliveries, so look for anything missed.
await catchUp(deps).catch((err) => deps.log("catch-up failed", { error: String(err) }));
worker.start();
pruneOld(deps);
const housekeeping = setInterval(() => pruneOld(deps), 3600_000);

async function shutdown(signal: string): Promise<void> {
  deps.log("shutting down", { signal });
  clearInterval(housekeeping);
  server.close();
  await worker.stop();
  db.$client.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function resolvePublicUrl(c: typeof config): Promise<string> {
  if (c.publicUrl) return c.publicUrl;
  if (c.publicUrlParam) return loadParameter(c.region, c.publicUrlParam);
  throw new Error("Set PUBLIC_URL (or PUBLIC_URL_PARAM) to the deployer's public URL");
}
