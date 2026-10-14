// Entry point of the runner process (dist/runner/main.js). pm2 starts it as
// slipway-runner next to the deployer; see docs/contracts.md, "Runner".
import { consoleLog } from "../deps.js";
import { createRunnerServer, listenOnSocket } from "./api.js";
import { loadRunnerConfig } from "./config.js";
import { Runner } from "./runner.js";

// Files 0640, dirs 0750: nothing the runner writes is readable by other users
// unless it opens it up on purpose (store.ts, runner.ts).
process.umask(0o027);

const config = loadRunnerConfig();
const runner = new Runner(config, { log: (message, extra) => consoleLog(message, { component: "runner", ...extra }) });
runner.recover();

const server = createRunnerServer(runner);
await listenOnSocket(server, config.socket, config.socketGroup);
consoleLog("runner listening", {
  component: "runner",
  socket: config.socket,
  dev: config.dev,
  buildUser: config.buildUser || null,
  maxBuilds: config.maxBuilds,
  maxDeploys: config.maxDeploys,
  ...runner.stats(),
});
runner.pump();
runner.prune();
const housekeeping = setInterval(() => runner.prune(), 3600_000);

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  consoleLog("runner shutting down", { component: "runner", signal, ...runner.stats() });
  clearInterval(housekeeping);
  server.close();
  // Deploys can't be resumed, so give active runs a chance to finish (pm2's kill_timeout is longer).
  await runner.drain();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
