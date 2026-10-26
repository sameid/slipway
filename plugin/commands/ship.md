---
description: Commit this worktree's task, rebase onto main, and open or update its PR; the deployer merges it and updates staging on its own
argument-hint: "[short description of the change]"
allowed-tools: Bash(slipway *), Bash(${CLAUDE_PLUGIN_ROOT}/bin/slipway *), Bash(git *), Bash(gh pr *), Bash(npm run *), Bash(npm test *)
---

Ship the current task to staging. Run this from inside the task's worktree. The `slipway` CLI is on PATH while this plugin is enabled (if not, use `"${CLAUDE_PLUGIN_ROOT}/bin/slipway"`).

What the user said about the change, if anything: $ARGUMENTS

1. **Check where you are.** `git rev-parse --show-toplevel` must have an `app.yaml`, and `git branch --show-current` must be a task branch, not `main`.
   - On `main` in the main checkout with uncommitted work: don't commit it to `main`. Use the `coding-agent` skill to create a worktree for the task, move the changes with `git stash` / `git stash pop`, and continue there.
   - On `main` with nothing to ship: say so and stop.
2. **Type check first.** Run `npm run typecheck`, plus `npm run db:check -w api` if anything under `api/drizzle/` changed, and fix failures before going on. The PR check only validates `app.yaml` and scans for secrets, so this is what keeps type errors off staging. Lint and the full test suite run when someone verifies the release on the dashboard before promoting it to prod, so don't wait on them here.
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
7. **Tell the user it's submitted, and stop.** Run `slipway status` once for the staging link (it doesn't wait). Then tell them in a few short lines:
   - "Submitted PR #<number>: <url>", and what it changes in a sentence.
   - The deployer merges it by itself once a quick check passes (app.yaml and a secret scan), and staging updates a few minutes later at <staging link>. Nothing is running in this session any more: they can close it or ask for something else.
   - `/status` shows when it's live. If the check or the deploy fails, it shows that too, and they can ask Claude to fix it.

   Don't wait for the check, the merge or the deploy: no `slipway wait-pr`, no `gh pr checks --watch`, no polling. If you're a background agent running one of several tasks, don't message the user: report the branch, the PR link and what to try on staging, and stop.

If the user comes back because the PR's check failed (`/status` lists it as `check of PR #<n> ... failed`), work in this PR's worktree: read the log with `slipway log <job-id>`, fix the cause, run the matching local check, and `/ship` again. If the PR passed its check but never merged, `slipway wait-pr <number> --max-seconds 0` says why in one look: "Conflicts with main" needs another `/ship` (step 4 rebases); "Changes platform-owned files" needs a review from the app's code owners (CODEOWNERS); or auto-merge is off for this app, so a person merges it. Once the PR is merged, `/status` offers to remove its worktree.
