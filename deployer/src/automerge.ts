// Design 5.7: merge a PR once its check passes, unless something needs a person.
import { and, eq } from "drizzle-orm";
import { changedPlatformFields } from "./appyaml.js";
import { iso, type Deps } from "./deps.js";
import { pullRequests, type AppRow } from "./db/schema.js";
import type { PullInfo } from "./github.js";
import { queueBuildAndDeploy } from "./jobs.js";
import { isProtectedPath, sameRepo } from "./names.js";

export type MergeDecision =
  | { action: "merge" }
  | { action: "update" }
  | { action: "block"; note: string }
  | { action: "skip"; reason: string };

export async function decideMerge(deps: Deps, app: AppRow, pull: PullInfo, checkedSha: string): Promise<MergeDecision> {
  if (pull.state !== "open") return { action: "skip", reason: "PR is no longer open" };
  if (pull.headSha !== checkedSha) return { action: "skip", reason: "PR has newer commits" };
  if (!app.autoMerge) {
    return { action: "block", note: "Auto-merge is off for this app; the dev team merges its PRs" };
  }
  if (pull.draft) return { action: "block", note: "Draft PR: mark it ready for review to merge it" };

  const files = await deps.github.listPullFiles(app.repo, pull.number);
  const protectedFiles = files.filter(isProtectedPath);
  if (protectedFiles.length) {
    return {
      action: "block",
      note: `Changes platform-owned files (${protectedFiles.join(", ")}); needs dev team review`,
    };
  }
  if (files.includes("app.yaml")) {
    const [before, after] = await Promise.all([
      deps.github.readFile(app.repo, "app.yaml", "main"),
      deps.github.readFile(app.repo, "app.yaml", pull.headSha),
    ]);
    const changed = changedPlatformFields(before, after);
    if (changed.length) {
      return {
        action: "block",
        note: `Changes platform-owned app.yaml fields (${changed.join(", ")}); needs dev team review`,
      };
    }
  }
  if ((await deps.github.behindBy(app.repo, "main", pull.headSha)) > 0) return { action: "update" };
  return { action: "merge" };
}

function setPull(deps: Deps, app: string, number: number, fields: Partial<typeof pullRequests.$inferInsert>): void {
  deps.db
    .update(pullRequests)
    .set({ ...fields, updatedAt: iso(deps) })
    .where(and(eq(pullRequests.app, app), eq(pullRequests.number, number)))
    .run();
}

/** Comment once per head commit and reason, so re-checks don't spam the PR. */
async function commentOnce(deps: Deps, app: AppRow, pull: PullInfo, reason: string, body: string): Promise<void> {
  const key = `${pull.headSha}:${reason}`;
  const row = deps.db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.app, app.name), eq(pullRequests.number, pull.number)))
    .get();
  if (row?.lastCommentKey === key) return;
  setPull(deps, app.name, pull.number, { lastCommentKey: key });
  await safely(deps, "comment", () => deps.github.comment(app.repo, pull.number, body));
}

export async function safely(deps: Deps, what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    deps.log(`GitHub ${what} failed`, { error: String(err) });
  }
}

/** Called when a check for `checkedSha` passed. */
export async function autoMerge(deps: Deps, app: AppRow, prNumber: number, checkedSha: string): Promise<void> {
  const pull = await deps.github.getPull(app.repo, prNumber);
  const decision = await decideMerge(deps, app, pull, checkedSha);
  deps.log("merge decision", { app: app.name, pr: prNumber, ...decision });

  switch (decision.action) {
    case "skip":
      return;
    case "block":
      setPull(deps, app.name, prNumber, { status: "blocked", note: decision.note });
      await commentOnce(deps, app, pull, decision.note, `The check passed, but this PR wasn't merged automatically: ${decision.note}.`);
      return;
    case "update": {
      const result = await deps.github.updateBranch(app.repo, prNumber, pull.headSha);
      if (result === "updated") {
        // GitHub pushes a merge commit to the branch; its synchronize event starts a fresh check.
        setPull(deps, app.name, prNumber, { status: "checking", note: "Branch is behind main; updating it" });
      } else {
        const note = "Conflicts with main: rebase onto main and push (run /ship again)";
        setPull(deps, app.name, prNumber, { status: "blocked", note });
        await commentOnce(deps, app, pull, "conflict", `This branch conflicts with \`main\`. ${note}.`);
      }
      return;
    }
    case "merge": {
      const result = await deps.github.squashMerge(app.repo, prNumber, pull.headSha, pull.title);
      if (!result.merged) {
        const note = `GitHub refused the merge: ${result.reason}`;
        setPull(deps, app.name, prNumber, { status: "blocked", note });
        await commentOnce(deps, app, pull, "merge-refused", note);
        return;
      }
      setPull(deps, app.name, prNumber, { status: "merged", mergedSha: result.sha, note: null });
      if (sameRepo(pull.headRepo, app.repo)) {
        await safely(deps, "delete branch", () => deps.github.deleteBranch(app.repo, pull.headRef));
      }
      // The push webhook queues the same work; queueBuildAndDeploy de-duplicates.
      queueBuildAndDeploy(deps, app.name, result.sha, "system");
      return;
    }
  }
}
