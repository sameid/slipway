// The runner's socket API (docs/contracts.md, "Runner"): JSON over HTTP on a
// Unix socket only the deployer's user can open (group slipway-ipc, 0660).
import { chmodSync, chownSync, existsSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gidOf } from "./config.js";
import { RunnerError, type Runner } from "./runner.js";
import { RUN_ID, type RunRecord } from "./store.js";

// GitHub zipballs of app repos are a few MB; base64 adds a third.
const MAX_BODY = 200 * 1024 * 1024;

export function runJson(run: RunRecord) {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    exitCode: run.exitCode,
    exported: run.exported,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

export function createRunnerServer(runner: Runner): Server {
  return createServer((req, res) => {
    handle(runner, req, res).catch((err: unknown) => {
      const status = err instanceof RunnerError ? err.status : 500;
      send(res, status, { error: err instanceof Error ? err.message : String(err) });
    });
  });
}

/** Listen on the socket, replacing a stale one, and open it to the deployer's group only. */
export function listenOnSocket(server: Server, socket: string, group?: string): Promise<void> {
  if (existsSync(socket)) rmSync(socket);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, () => {
      chmodSync(socket, 0o660);
      if (group) {
        const gid = gidOf(group);
        if (gid === undefined) return reject(new Error(`no group ${group} for ${socket}`));
        chownSync(socket, -1, gid);
      }
      resolve();
    });
  });
}

async function handle(runner: Runner, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://runner");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, ...runner.stats() });

  if (req.method === "POST" && url.pathname === "/runs") {
    const body = await readJson(req);
    const run = runner.submit(body.kind, body.env, body.sourceZip);
    return send(res, 201, { id: run.id });
  }

  if (parts[0] === "runs" && parts[1] && RUN_ID.test(parts[1])) {
    const id = parts[1];
    const run = runner.store.get(id);
    if (!run) return send(res, 404, { error: `no run ${id}` });
    if (req.method === "GET" && parts.length === 2) return send(res, 200, runJson(run));
    if (req.method === "GET" && parts[2] === "log" && parts.length === 3) {
      const tail = url.searchParams.get("tail");
      const lines = tail === null ? undefined : Math.max(1, Math.min(100_000, Number(tail) || 200));
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return void res.end(runner.store.logTail(id, lines));
    }
    if (req.method === "POST" && parts[2] === "cancel" && parts.length === 3) {
      runner.cancel(id);
      return send(res, 202, { id });
    }
  }
  if (parts[0] === "runs" && parts[1]) return send(res, 404, { error: "no such run" });
  send(res, 404, { error: "not found" });
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new RunnerError(413, "request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
        resolve(body as Record<string, unknown>);
      } catch {
        reject(new RunnerError(400, "body must be a JSON object"));
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return void res.end();
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
