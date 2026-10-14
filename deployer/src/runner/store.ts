// Run directories (docs/contracts.md, "Runner"): one folder per run under
// <data>/runs/<id>/ with run.json, log, exports.env and work/. The folders are
// the queue, so runs survive a restart of the runner.
//
// Permissions: everything is the runner's (dirs 0750, files 0640 under its
// umask). The build user gets only "x" on the path to a run's work/ (an ACL the
// host sets on the data dir and runs/, and the runner on the run dir while a
// build runs), so it can't list runs or read run.json, log, exports.env or
// source.zip.
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RunKind, RunStatus } from "../runs.js";

export type RunRecord = {
  id: string;
  kind: RunKind;
  env: Record<string, string>;
  status: RunStatus;
  exitCode: number | null;
  exported: Record<string, string>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

// <ms since epoch>-<random>: sorts by creation time and is safe in a path.
export const RUN_ID = /^\d{13}-[0-9a-f]{8}$/;

export class RunStore {
  readonly runsDir: string;

  constructor(dataDir: string) {
    this.runsDir = join(dataDir, "runs");
    mkdirSync(this.runsDir, { recursive: true });
  }

  dir(id: string): string {
    if (!RUN_ID.test(id)) throw new Error(`invalid run id ${id}`);
    return join(this.runsDir, id);
  }
  logPath = (id: string) => join(this.dir(id), "log");
  exportsPath = (id: string) => join(this.dir(id), "exports.env");
  sourcePath = (id: string) => join(this.dir(id), "source.zip");
  workPath = (id: string) => join(this.dir(id), "work");

  create(kind: RunKind, env: Record<string, string>, sourceZip: Buffer | undefined, now: Date): RunRecord {
    const id = `${String(now.getTime()).padStart(13, "0")}-${randomBytes(4).toString("hex")}`;
    mkdirSync(this.dir(id));
    const run: RunRecord = {
      id,
      kind,
      env,
      status: "queued",
      exitCode: null,
      exported: {},
      createdAt: now.toISOString(),
      startedAt: null,
      finishedAt: null,
    };
    if (sourceZip) writeFileSync(this.sourcePath(id), sourceZip, { mode: 0o640 });
    writeFileSync(this.logPath(id), "", { mode: 0o640 });
    this.save(run);
    return run;
  }

  save(run: RunRecord): void {
    const file = join(this.dir(run.id), "run.json");
    writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 2), { mode: 0o640 });
    renameSync(`${file}.tmp`, file);
  }

  get(id: string): RunRecord | undefined {
    if (!RUN_ID.test(id)) return undefined;
    try {
      return JSON.parse(readFileSync(join(this.dir(id), "run.json"), "utf8")) as RunRecord;
    } catch {
      return undefined;
    }
  }

  /** Every run, oldest first. */
  all(): RunRecord[] {
    return readdirSync(this.runsDir)
      .filter((name) => RUN_ID.test(name))
      .sort()
      .flatMap((id) => {
        const run = this.get(id);
        return run ? [run] : [];
      });
  }

  appendLog(id: string, text: string): void {
    appendFileSync(this.logPath(id), text.endsWith("\n") ? text : `${text}\n`);
  }

  /** The last `lines` lines of a run's log (all of it when lines is undefined). */
  logTail(id: string, lines?: number): string {
    const path = this.logPath(id);
    if (!existsSync(path)) return "";
    const size = statSync(path).size;
    // Read only the end of big logs: 256 bytes a line is plenty.
    const want = lines === undefined ? size : Math.min(size, Math.max(64 * 1024, lines * 256));
    const buf = Buffer.alloc(want);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buf, 0, want, size - want);
    } finally {
      closeSync(fd);
    }
    let text = buf.toString("utf8");
    if (want < size) text = text.slice(text.indexOf("\n") + 1); // drop the partial first line
    if (lines === undefined) return text;
    const all = text.replace(/\n$/, "").split("\n");
    return all.slice(-lines).join("\n") + (all.length ? "\n" : "");
  }

  remove(id: string): void {
    rmSync(this.dir(id), { recursive: true, force: true });
  }
}
