// The AWS CLI, for `slipway setup` only: every other command talks to the deployer
// and needs no AWS credentials. Runs with the profile and region setup was given.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliError, run, sleep, tail } from "./util.mjs";

const INSTALL_AWS = "Install the AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html";

export class Aws {
  constructor({ profile, region }) {
    this.profile = profile || null;
    this.region = region;
  }

  env(extra = {}) {
    const env = { ...process.env, AWS_PAGER: "", AWS_REGION: this.region, AWS_DEFAULT_REGION: this.region, ...extra };
    if (this.profile) env.AWS_PROFILE = this.profile;
    return env;
  }

  // `aws <args> --output json`. Never throws on an AWS error: { ok, data } or { ok: false, error }.
  call(args, { region } = {}) {
    const result = run("aws", [...args, "--output", "json", ...(region ? ["--region", region] : [])], { env: this.env() });
    if (result.missing) throw new CliError(`The AWS CLI isn't installed. ${INSTALL_AWS}`);
    if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout).trim() };
    const out = result.stdout.trim();
    try {
      return { ok: true, data: out ? JSON.parse(out) : null };
    } catch {
      return { ok: true, data: out };
    }
  }

  // Like call(), but a failure is a CliError naming what was being done.
  must(args, what, opts) {
    const result = this.call(args, opts);
    if (!result.ok) throw new CliError(`${what} failed:\n${tail(result.error, 20)}`);
    return result.data;
  }

  // Run with a JSON document passed as a file, so values (keys, secrets) never appear in
  // the process list. `fill(fileUrl)` returns the CLI arguments.
  withFile(contents, fill, what) {
    const dir = mkdtempSync(path.join(tmpdir(), "slipway-"));
    try {
      const file = path.join(dir, "input.json");
      writeFileSync(file, contents, { mode: 0o600 });
      return this.must(fill(`file://${file}`), what);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Wait until the instance's SSM agent has checked in.
  async waitForSsm(instanceId, { maxMs = 15 * 60_000, intervalMs = 10_000 } = {}) {
    const until = Date.now() + maxMs;
    for (;;) {
      const info = this.call([
        "ssm", "describe-instance-information", "--filters", `Key=InstanceIds,Values=${instanceId}`,
      ]);
      if (info.ok && info.data?.InstanceInformationList?.[0]?.PingStatus === "Online") return;
      if (Date.now() > until) {
        throw new CliError(`The deployer instance ${instanceId} hasn't connected to Systems Manager after ${Math.round(maxMs / 60_000)} minutes.`);
      }
      await sleep(intervalMs);
    }
  }

  // Run shell commands on the instance as root through SSM Run Command and wait for them.
  // Returns { status, stdout, stderr }; status is SSM's (Success, Failed, TimedOut, ...).
  async runOnInstance(instanceId, commands, { comment = "slipway setup", timeoutSeconds = 1800, intervalMs = 5000 } = {}) {
    const parameters = JSON.stringify({ commands, executionTimeout: [String(timeoutSeconds)] });
    const commandId = this.withFile(
      parameters,
      (file) => [
        "ssm", "send-command", "--instance-ids", instanceId, "--document-name", "AWS-RunShellScript",
        "--comment", comment, "--parameters", file, "--query", "Command.CommandId",
      ],
      "Sending a command to the deployer instance",
    );
    const until = Date.now() + (timeoutSeconds + 120) * 1000;
    for (let polls = 0; ; polls++) {
      await sleep(polls === 0 ? 1000 : intervalMs);
      const result = this.call([
        "ssm", "get-command-invocation", "--command-id", commandId, "--instance-id", instanceId,
      ]);
      // Right after send-command the invocation may not exist yet.
      const status = result.ok ? result.data.Status : "Pending";
      if (!["Pending", "InProgress", "Delayed"].includes(status) || Date.now() > until) {
        return {
          status,
          stdout: result.ok ? result.data.StandardOutputContent ?? "" : "",
          stderr: result.ok ? result.data.StandardErrorContent ?? "" : result.error,
        };
      }
    }
  }
}

// Advice for the AWS CLI's usual credential errors.
export function credentialHint(error, profile) {
  const flag = profile ? ` --profile ${profile}` : "";
  if (/sso|token has expired|refresh failed/i.test(error)) return `Your AWS sign-in has expired. Run: ! aws sso login${flag}`;
  if (/could not be found|profile/i.test(error) && profile) return `There's no AWS profile called ${profile}. List them with: aws configure list-profiles`;
  if (/unable to locate credentials|no credentials/i.test(error)) {
    return "No AWS credentials. Sign in with aws configure or aws sso login, and pass --profile if you use a named profile.";
  }
  return "";
}
