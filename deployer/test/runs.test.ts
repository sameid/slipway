import { describe, expect, it } from "vitest";
import { parseFailure } from "../src/runs.js";
import { catchUp, upsertPull } from "../src/events.js";
import { getApp } from "../src/jobs.js";
import { jobsOf, liveApp, setup } from "./helpers.js";

describe("run logs", () => {
  it("finds the last step and the last ERROR line", () => {
    const lines = [
      "==> step: npm-ci",
      "added 312 packages",
      "==> step: test",
      " FAIL  api/src/auth.test.ts",
      "ERROR: 2 tests failed",
      "[runner] verify ended by SIGTERM",
    ];
    expect(parseFailure(lines)).toEqual({ step: "test", error: "2 tests failed" });
    expect(parseFailure(["nothing useful"])).toEqual({ step: null, error: null });
    // Only lines that start with the markers count, not tools quoting them.
    expect(
      parseFailure(["==> step: npm-ci", 'npm error echo "ERROR: nope"', "  ==> step: fake"]),
    ).toEqual({ step: "npm-ci", error: null });
  });
});

describe("catch-up on startup", () => {
  it("queues missed builds and checks, and settles PRs that closed meanwhile", async () => {
    const t = setup();
    await liveApp(t);
    // Events the deployer never heard about:
    const sha = t.github.pushToMain("acme/loan-tracker", { "x.ts": "1" });
    const open = t.github.openPull("acme/loan-tracker");
    const closed = t.github.openPull("acme/loan-tracker");
    upsertPull(t.deps, "loan-tracker", closed.number, { headSha: closed.headSha, status: "checking" });
    t.github.repo("acme/loan-tracker")!.pulls.get(closed.number)!.state = "closed";

    const before = jobsOf(t).length;
    await catchUp(t.deps);
    const queued = jobsOf(t).slice(before).map((j) => `${j.kind}:${j.env}:${j.commitSha === sha || j.prNumber}`);
    expect(queued).toEqual(["build:build:true", "deploy:staging:true", `check:check:${open.number}`]);

    // Running it again queues nothing new.
    await catchUp(t.deps);
    expect(jobsOf(t)).toHaveLength(before + 3);
    expect(getApp(t.deps, "loan-tracker")!.status).toBe("active");
  });
});
