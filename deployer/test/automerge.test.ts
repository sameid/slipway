import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { changedPlatformFields } from "../src/appyaml.js";
import { decideMerge } from "../src/automerge.js";
import { apps } from "../src/db/schema.js";
import { defaultAppYaml } from "../src/fake.js";
import { getApp } from "../src/jobs.js";
import { pullJson } from "../src/serialize.js";
import { drainEvents, finishRunning, jobsOf, liveApp, routeEvents, setup } from "./helpers.js";

const REPO = "acme/loan-tracker";

async function passingCheck(t: ReturnType<typeof setup>, number: number) {
  await drainEvents(t);
  await t.worker.tick();
  await finishRunning(t, "succeeded", (j) => j.kind === "check" && j.prNumber === number);
  await drainEvents(t);
}

describe("platform-owned fields", () => {
  it("spots changes to name, auto_merge and sizes only", () => {
    const base = defaultAppYaml("loan-tracker");
    expect(changedPlatformFields(base, base.replace("EXAMPLE_API_KEY", "STRIPE_KEY"))).toEqual([]);
    expect(changedPlatformFields(base, base.replace("description: Fake", "description: Real"))).toEqual([]);
    expect(changedPlatformFields(base, base.replace("prod: small", "prod: large"))).toEqual(["sizes"]);
    expect(changedPlatformFields(base, base.replace("auto_merge: true", "auto_merge: false"))).toEqual(["auto_merge"]);
    expect(changedPlatformFields(base, base.replace("name: loan-tracker", "name: loan-tracker-2"))).toEqual(["name"]);
    expect(changedPlatformFields(base, "name: [oops")).toEqual(["app.yaml (not valid YAML)"]);
  });
});

describe("auto-merge", () => {
  it("squash-merges a passing, up-to-date PR and deploys it", async () => {
    const t = setup();
    routeEvents(t);
    await liveApp(t);
    const pull = t.github.openPull(REPO, { title: "Add reminders" });
    await passingCheck(t, pull.number);
    const app = getApp(t.deps, "loan-tracker")!;
    const pr = pullJson(t.deps, app, pull.number);
    expect(pr.status).toBe("merged");
    expect(pr.mergedSha).toBe(t.github.repo(REPO)!.main);
    expect(pr.deploy?.status).toBe("queued");
    // The check status was posted for the head commit.
    expect(t.github.repo(REPO)!.statuses.filter((s) => s.sha === pull.headSha).map((s) => s.status.state)).toEqual([
      "pending",
      "success",
    ]);
    await t.worker.tick();
    await finishRunning(t); // build
    await finishRunning(t); // deploy
    expect(pullJson(t.deps, app, pull.number).live).toBe(true);
    expect(t.github.repo(REPO)!.comments.at(-1)!.body).toMatch(/^Live on staging: https:/);
  });

  it("blocks PRs that touch .github/ or CODEOWNERS", async () => {
    const t = setup();
    routeEvents(t);
    await liveApp(t);
    const pull = t.github.openPull(REPO, { files: { ".github/workflows/x.yml": "on: push" } });
    await passingCheck(t, pull.number);
    const pr = pullJson(t.deps, getApp(t.deps, "loan-tracker")!, pull.number);
    expect(pr.status).toBe("blocked");
    expect(pr.note).toMatch(/platform-owned files \(\.github\/workflows\/x\.yml\)/);
    expect(t.github.repo(REPO)!.pulls.get(pull.number)!.state).toBe("open");
    expect(t.github.repo(REPO)!.comments.filter((c) => c.number === pull.number)).toHaveLength(1);
  });

  it("blocks platform-owned app.yaml changes but merges other app.yaml changes", async () => {
    const t = setup();
    routeEvents(t);
    await liveApp(t);
    const yaml = defaultAppYaml("loan-tracker");
    const sizes = t.github.openPull(REPO, { files: { "app.yaml": yaml.replace("prod: small", "prod: large") } });
    await passingCheck(t, sizes.number);
    expect(pullJson(t.deps, getApp(t.deps, "loan-tracker")!, sizes.number)).toMatchObject({
      status: "blocked",
      note: expect.stringContaining("(sizes)"),
    });

    const secret = t.github.openPull(REPO, { files: { "app.yaml": `${yaml}  - STRIPE_KEY\n`.replace("auto_merge: true\n", "") } });
    // (that one also drops auto_merge, so it's blocked too)
    await passingCheck(t, secret.number);
    expect(pullJson(t.deps, getApp(t.deps, "loan-tracker")!, secret.number).status).toBe("blocked");

    const ok = t.github.openPull(REPO, { files: { "app.yaml": yaml.replace("  - EXAMPLE_API_KEY", "  - EXAMPLE_API_KEY\n  - STRIPE_KEY") } });
    await passingCheck(t, ok.number);
    expect(pullJson(t.deps, getApp(t.deps, "loan-tracker")!, ok.number).status).toBe("merged");
  });

  it("respects auto_merge: false and drafts", async () => {
    const t = setup();
    await liveApp(t);
    const app = getApp(t.deps, "loan-tracker")!;
    const draft = t.github.openPull(REPO, { draft: true });
    expect(await decideMerge(t.deps, app, await t.github.getPull(REPO, draft.number), draft.headSha)).toMatchObject({
      action: "block",
      note: expect.stringMatching(/^Draft PR/),
    });
    t.deps.db.update(apps).set({ autoMerge: false }).where(eq(apps.name, "loan-tracker")).run();
    const pull = t.github.openPull(REPO);
    expect(
      await decideMerge(t.deps, getApp(t.deps, "loan-tracker")!, await t.github.getPull(REPO, pull.number), pull.headSha),
    ).toMatchObject({ action: "block", note: expect.stringMatching(/^Auto-merge is off/) });
  });

  it("skips results for an old head or a closed PR", async () => {
    const t = setup();
    await liveApp(t);
    const app = getApp(t.deps, "loan-tracker")!;
    const pull = t.github.openPull(REPO);
    const info = await t.github.getPull(REPO, pull.number);
    expect(await decideMerge(t.deps, app, info, "0".repeat(40))).toEqual({ action: "skip", reason: "PR has newer commits" });
    expect(await decideMerge(t.deps, app, { ...info, state: "closed" }, info.headSha)).toMatchObject({ action: "skip" });
  });

  it("updates a branch that's behind main, and re-checks it", async () => {
    const t = setup();
    routeEvents(t);
    await liveApp(t);
    const pull = t.github.openPull(REPO, { files: { "src/a.ts": "a" } });
    const firstHead = pull.headSha;
    t.github.pushToMain(REPO, { "src/b.ts": "b" });
    await passingCheck(t, pull.number);
    const pr = pullJson(t.deps, getApp(t.deps, "loan-tracker")!, pull.number);
    expect(pr.status).toBe("checking");
    expect(pr.headSha).not.toBe(firstHead); // GitHub added a merge commit
    expect(jobsOf(t).filter((j) => j.kind === "check" && j.prNumber === pull.number)).toHaveLength(2);
    await passingCheck(t, pull.number);
    expect(pullJson(t.deps, getApp(t.deps, "loan-tracker")!, pull.number).status).toBe("merged");
  });

  it("blocks and comments once when the branch conflicts with main", async () => {
    const t = setup();
    routeEvents(t);
    await liveApp(t);
    const pull = t.github.openPull(REPO, { files: { "src/a.ts": "mine" } });
    t.github.pushToMain(REPO, { "src/a.ts": "theirs" });
    await passingCheck(t, pull.number);
    const pr = pullJson(t.deps, getApp(t.deps, "loan-tracker")!, pull.number);
    expect(pr).toMatchObject({ status: "blocked", note: expect.stringMatching(/^Conflicts with main/) });
    const { autoMerge } = await import("../src/automerge.js");
    await autoMerge(t.deps, getApp(t.deps, "loan-tracker")!, pull.number, pull.headSha);
    expect(t.github.repo(REPO)!.comments.filter((c) => c.number === pull.number)).toHaveLength(1);
  });

  it("comments the failing step when a check fails", async () => {
    const t = setup();
    routeEvents(t);
    await liveApp(t);
    const pull = t.github.openPull(REPO);
    await drainEvents(t);
    await t.worker.tick();
    await finishRunning(t, "failed", (j) => j.kind === "check", { failStep: "secret-scan", error: "gitleaks found a key" });
    const pr = pullJson(t.deps, getApp(t.deps, "loan-tracker")!, pull.number);
    expect(pr.status).toBe("check_failed");
    expect(pr.failure).toMatchObject({ step: "secret-scan", message: "gitleaks found a key" });
    expect(t.github.repo(REPO)!.comments.at(-1)!.body).toMatch(/The check failed in step `secret-scan`: gitleaks found a key/);
  });
});
