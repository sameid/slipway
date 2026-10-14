// The deployer's side of the runner (docs/contracts.md, "Runner"): start
// build-release and deploy-env runs over the runner's Unix socket, poll them,
// and read their logs. The runner is a separate process on the same instance,
// running as its own user; this module never touches its files.
import { request } from "node:http";

export type RunKind = "build-release" | "deploy-env";
export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export type StartRunInput = {
  kind: RunKind;
  env: Record<string, string>;
  /** GitHub's zipball of the commit; build-release only. */
  sourceZip?: Uint8Array;
};

export type RunInfo = {
  id: string;
  kind: RunKind;
  status: RunStatus;
  exitCode: number | null;
  exported: Record<string, string>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export interface Runs {
  start(input: StartRunInput): Promise<string>;
  /** null when the runner has no record of the run. */
  get(id: string): Promise<RunInfo | null>;
  /** The last `lines` lines of a run's log. */
  logTail(id: string, lines: number): Promise<string[]>;
  cancel(id: string): Promise<void>;
}

/** Talks to the runner over its Unix socket (JSON over HTTP). */
export class SocketRuns implements Runs {
  constructor(
    private socketPath: string,
    private timeoutMs = 60_000,
  ) {}

  async start(input: StartRunInput): Promise<string> {
    const body = JSON.stringify({
      kind: input.kind,
      env: input.env,
      ...(input.sourceZip ? { sourceZip: Buffer.from(input.sourceZip).toString("base64") } : {}),
    });
    const res = await this.call("POST", "/runs", body);
    if (res.status !== 201) throw new Error(`runner refused the run: ${errorText(res)}`);
    const id = (JSON.parse(res.body) as { id?: unknown }).id;
    if (typeof id !== "string") throw new Error("runner returned no run id");
    return id;
  }

  async get(id: string): Promise<RunInfo | null> {
    const res = await this.call("GET", `/runs/${encodeURIComponent(id)}`);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`runner: ${errorText(res)}`);
    return JSON.parse(res.body) as RunInfo;
  }

  async logTail(id: string, lines: number): Promise<string[]> {
    const res = await this.call("GET", `/runs/${encodeURIComponent(id)}/log?tail=${lines}`);
    if (res.status === 404) return [`(the runner has no log for run ${id})`];
    if (res.status !== 200) throw new Error(`runner: ${errorText(res)}`);
    return res.body.replace(/\n$/, "").split("\n");
  }

  async cancel(id: string): Promise<void> {
    const res = await this.call("POST", `/runs/${encodeURIComponent(id)}/cancel`);
    if (res.status !== 202 && res.status !== 404) throw new Error(`runner: ${errorText(res)}`);
  }

  private call(method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {},
          timeout: this.timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error(`runner didn't answer ${method} ${path} within ${this.timeoutMs}ms`)));
      req.on("error", (err) => reject(new Error(`can't reach the runner at ${this.socketPath}: ${err.message}`)));
      req.end(body);
    });
  }
}

function errorText(res: { status: number; body: string }): string {
  try {
    const error = (JSON.parse(res.body) as { error?: unknown }).error;
    if (typeof error === "string") return `${res.status} ${error}`;
  } catch {
    // not JSON
  }
  return `${res.status} ${res.body.slice(0, 200)}`;
}

/** Find the failing step and error message in a log, per the log conventions in docs/contracts.md. */
export function parseFailure(lines: string[]): { step: string | null; error: string | null } {
  let step: string | null = null;
  let error: string | null = null;
  for (const line of lines) {
    const s = line.match(/^==> step: ([\w.-]+)/);
    if (s) step = s[1] ?? null;
    const e = line.match(/^ERROR: (.+)$/);
    if (e) error = e[1]?.trim() ?? null;
  }
  return { step, error };
}
