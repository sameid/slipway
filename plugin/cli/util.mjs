// Shared helpers: exit codes, errors, output, subprocesses, time formatting.
import { spawnSync } from "node:child_process";

// Exit codes. Commands and skills rely on these; keep them in sync with README.md.
export const EXIT = {
  OK: 0,
  ERROR: 1, // unexpected error: network, auth, bad state
  USAGE: 2,
  FAILED: 3, // the thing we waited on failed: check, build, deploy, registration
  BLOCKED: 4, // a PR passed its check but can't auto-merge; see the note
  WAITING: 10, // still in progress when --max-seconds ran out: run the same command again
};

export class CliError extends Error {
  constructor(message, code = EXIT.ERROR) {
    super(message);
    this.code = code;
  }
}

export function print(...lines) {
  for (const line of lines) process.stdout.write(`${line}\n`);
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function warn(message) {
  process.stderr.write(`${message}\n`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Run a command and capture its output. Never throws on a non-zero exit; check .status.
export function run(cmd, args, { cwd, env, input, inherit = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    env: env ?? process.env,
    input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
  });
  if (result.error && result.error.code === "ENOENT") {
    return { status: 127, stdout: "", stderr: `${cmd}: command not found`, missing: true };
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// Run a command and throw a CliError with the tail of its output if it fails.
export function runOrThrow(cmd, args, opts = {}, what = `${cmd} ${args.join(" ")}`) {
  const result = run(cmd, args, opts);
  if (result.status !== 0) {
    const output = tail(`${result.stdout}\n${result.stderr}`.trim(), 30);
    throw new CliError(`${what} failed${output ? `:\n${output}` : ""}`);
  }
  return result.stdout;
}

export function tail(text, lines) {
  const all = text.split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n");
}

export function shortSha(sha) {
  return sha ? sha.slice(0, 7) : "-";
}

export function ago(iso) {
  if (!iso) return "";
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${Math.max(seconds, 0)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function clock() {
  return new Date().toTimeString().slice(0, 8);
}
