---
description: Commit this worktree's task, rebase onto main, open or update its PR, and wait until it's merged and live on staging
argument-hint: "[short description of the change]"
allowed-tools: Bash(slipway *), Bash(${CLAUDE_PLUGIN_ROOT}/bin/slipway *), Bash(git *), Bash(gh pr *), Bash(npm run *), Bash(npm test *)
---

Ship the current task to staging. Run this from inside the task's worktree. The `slipway` CLI is on PATH while this plugin is enabled (if not, use `"${CLAUDE_PLUGIN_ROOT}/bin/slipway"`). Its exit codes: 0 done, 1 error, 3 failed, 4 blocked, 10 still waiting (run the same command again).

What the user said about the change, if anything: $ARGUMENTS

1. **Check where you are.** `git rev-parse --show-toplevel` must have an `app.yaml`, and `git branch --show-current` must be a task branch, not `main`.
   - On `main` in the main checkout with uncommitted work: don't commit it to `main`. Use the `coding-agent` skill to create a worktree for the task, move the changes with `git stash` / `git stash pop`, and continue there.
   - On `main` with nothing to ship: say so and stop.
2. **Check locally first.** Run `npm run typecheck`, `npm run lint` and `npm test`, plus `npm run db:check -w api` if anything under `api/drizzle/` changed. Fix failures before going on; the PR check runs the same commands.
3. **Commit.** `git status` to review. Make sure no `.env*` file or secret value is staged. `git add -A` and commit with a clear message (imperative mood, what and why). If there's nothing new to commit but the branch has commits that aren't on GitHub yet, continue.
4. **Rebase onto the latest main.** `git fetch origin main`, then `git rebase origin/main`.
   - **Drizzle migration conflicts** (anything under `api/drizzle/`, usually `meta/_journal.json` or a snapshot): this branch's migration was numbered against an older `main`. Run `git rebase --abort`, then:
     1. List the migration files this branch added: `git diff --name-only --diff-filter=A origin/main...HEAD -- api/drizzle`.
     2. Remove them with `git rm`, restore the journal and snapshots from the fork point with `git checkout $(git merge-base origin/main HEAD) -- api/drizzle/meta`, and commit ("Drop migration to regenerate after rebase").
     3. `git rebase origin/main` again and resolve any other conflicts.
     4. `npm run db:generate -w api` to regenerate the migration on top of `main`'s schema, check the new SQL is still additive, run `npm run db:check -w api`, and commit it.
   - **Other conflicts:** resolve them by keeping both sides' intent, then `git add` and `git rebase --continue`. Rerun the tests afterwards.
5. **Push** the task branch: `git push --force-with-lease -u origin HEAD`. Never push to `main`.
6. **Open or update the PR.** `gh pr view --json number,url,state` for this branch.
   - No PR yet: `gh pr create --base main --title "<title>" --body "<what changed, why, how it was tested>"`.
   - An open PR: the push updated it. Update the title or body if the scope changed.
   - A merged or closed PR for this branch: the earlier work is done. Create a new branch name for this change (`git branch -m <new-name>`), push it and open a new PR.
7. **Wait for check, merge and deploy:** `slipway wait-pr <number> --head $(git rev-parse HEAD)`. It prints the check, then the merge, then the staging deploy. Exit 10 means still going: run it again. Keep the user posted with one short line per stage.
   - **Exit 0:** staging is live with this change. Go to step 8.
   - **Exit 3, check failed:** the output shows the failed step and the end of its log. Fix the cause in this worktree, run the matching local check, commit, push (step 5), and wait again. If the same check fails three times, stop and explain what's wrong.
   - **Exit 3 after the merge** (release build or staging deploy failed): show the step and error. The change is on `main`, so the fix is a new PR; for platform errors (Terraform, AWS, timeouts) suggest the user check the job on the dashboard, or share its link with whoever runs their slipway if that's someone else.
   - **Exit 4, blocked:** read the note. "Conflicts with main": go back to step 4. "Changes platform-owned files": stop; the PR needs a review from the app's code owners (CODEOWNERS). Auto-merge turned off for this app: the PR waits for a person to merge it.
8. **Done.** Print the staging link and the PR link. If you're a background agent running one of several tasks, stop here and report; the main session offers cleanup once all are done. Otherwise ask whether to remove this worktree. If yes, `cd` to the main checkout (`dirname "$(git rev-parse --path-format=absolute --git-common-dir)"`) and run `"${CLAUDE_PLUGIN_ROOT}/plugin/skills/coding-agent/scripts/clean-worktrees.sh"`.
