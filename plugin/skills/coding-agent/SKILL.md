---
name: coding-agent
description: Gives every feature, bug fix or enhancement in a slipway app its own git worktree and branch, and runs several at once as background agents when one request asks for more than one thing. Use whenever the user asks you to build, add, change or fix something in a repo with an app.yaml that has a template key, before editing any file.
---

# One worktree per task

The main checkout stays on `main` as a clean starting point. Every task gets its own worktree, branch and PR, so a feature, a bug fix and a tweak can be in flight at once, each in its own Claude Code session.

## Steps

1. **Check where you are.** Run `git rev-parse --show-toplevel` and `git branch --show-current`.
   - Already in a worktree on a task branch for this same task (for example the user started this session there, or you're fixing a failed check)? Keep working there and skip to step 4.
   - In the main checkout, or in a worktree for a different task? Continue with step 2. Never edit files in the main checkout.
2. **Pick a short branch name** from the request: `feat/loan-reminders`, `fix/date-filter`, `chore/upgrade-vite`. Lowercase, hyphens, a `feat/`, `fix/` or `chore/` prefix.
3. **Create the worktree** from anywhere in the app's repo:

   ```sh
   "${CLAUDE_SKILL_DIR}/scripts/new-worktree.sh" <branch>
   ```

   It fetches `origin/main`, runs `git worktree add ../<app>-worktrees/<branch> -b <branch> origin/main`, then `npm ci` so tests, typecheck and lint can run. It takes a minute or so.

   If the user already has uncommitted changes in the main checkout that belong to this task, move them: `git stash` in the main checkout, create the worktree, then `git stash pop` inside it.
4. **Work only inside the worktree.** `cd` into the path the script printed and stay there: every edit, test and generated migration happens in that folder. Use absolute paths under the worktree when editing files.
5. **Build it properly.** Follow the `slipway-stack` conventions and the app's `CLAUDE.md`. Add tests. Run `npm run typecheck`, `npm run lint` and `npm test` before shipping, plus `npm run db:check -w api` if you changed the schema. Don't try to run the app or a database locally; there isn't one.
6. **Ship it** with `/ship` from inside the worktree. It commits, rebases onto `main`, opens the PR and waits until staging is live. Then give the user the staging link and tell them what to try there.

## Several tasks in one request

When one message asks for several things ("add reminders, fix the date filter and export to CSV"), you can run them in parallel, one background agent per task, each in its own worktree with its own PR. A single task always stays in this session, where the user can watch and steer.

1. **Decide how to split.** Make something its own task only if it can be shipped and previewed on staging without the others. Keep pieces together when one needs the other (a feature and the schema it relies on) or when they'd rework the same screen or route; that's one task, done here or by one agent. When in doubt, fewer tasks.
2. **Ask first, then start.** If anything about a task is unclear, ask about all of them in one message before starting any agent; background agents can't ask the user. Then say the plan in one line ("I'll do these as 3 PRs: loan reminders, the date filter fix, CSV export") and start without waiting for approval.
3. **Start one background agent per task** with the Agent tool (the general-purpose agent, in the background), at most 4 at a time; start the rest as earlier ones finish. Give each a distinct branch name (step 2 above) and this brief, filled in:

   > Build one task in the slipway app whose main checkout is `<path>`: <the task, with everything the user said about it>. Use branch `<branch>`. Follow the `coding-agent` skill from step 3: create the worktree with `"${CLAUDE_SKILL_DIR}/scripts/new-worktree.sh" <branch>`, work only inside it, follow the `slipway-stack` skill and the app's `CLAUDE.md`, add tests, and finish with `/ship` (the `slipway:ship` skill). You can't ask the user anything: make the simplest reasonable choice and mention it in your report, and if the task can't be done without their answer, stop before shipping and report the question. At `/ship`'s last step, don't offer to remove the worktree. Report the branch, the PR link, whether staging is live with the change, what to try on staging, and any choices or problems.

4. **Coordinate; don't build.** While agents run, don't edit their worktrees. As each finishes, tell the user in a line or two: the PR, what to try on staging, any choices it made. If one failed or stopped with a question, say so; the user can carry on with that task in this session (it's already in a worktree on its branch, so start at step 4).
5. **When all are done,** offer to remove the finished worktrees in one go (see below).

Parallel PRs often touch the same files (`web/src/api.ts`, the router list in `api/src/app.ts`). That's expected: each `/ship` rebases onto the latest `main` and resolves conflicts, including clashing migrations, so they merge one after another.

## Cleaning up

After a PR is merged or closed, its worktree and branch can go. From the main checkout:

```sh
"${CLAUDE_SKILL_DIR}/scripts/clean-worktrees.sh" --dry-run   # list them
"${CLAUDE_SKILL_DIR}/scripts/clean-worktrees.sh"             # remove them
```

It skips worktrees with uncommitted changes (pass `--force` to remove them anyway, only if the user agrees) and the one you're currently inside. `/status` reminds the user when there are worktrees to clean up.

## Rules

- Never commit to or push `main`. Branch protection rejects it anyway; the deployer merges PRs after their check passes.
- Never deploy or run anything against AWS. Deploys happen when PRs merge.
- One task per worktree. If the user asks for something unrelated mid-task, give it its own worktree: start a background agent for it (see above), or finish and ship this one first.
