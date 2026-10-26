---
description: Show what's on staging and prod for this slipway app, running and failed jobs, and worktrees to clean up
argument-hint: "[app-name]"
allowed-tools: Bash(slipway *), Bash(${CLAUDE_PLUGIN_ROOT}/bin/slipway *)
---

Show the app's status. The `slipway` CLI is on PATH while this plugin is enabled (if not, use `"${CLAUDE_PLUGIN_ROOT}/bin/slipway"`).

App name from the user, if any: $ARGUMENTS

1. Run `slipway status` from inside the app's repo, or `slipway status --app <name>` if a name was given.
2. Summarize in a few lines:
   - staging and prod: link, release (short commit SHA) and when, whether it's verified (type check, lint and tests passed; prod needs it), last deploy result;
   - anything running now;
   - the last failure, if any, with its step and error. If the user wants details, `slipway log <job-id>` prints the log. If it's a PR's check, offer to fix it in that PR's worktree and `/ship` again;
   - the dashboard link (where a person promotes staging to prod or rolls back).
3. If the output lists worktrees whose PRs are merged or closed, say so and offer to remove them with `"${CLAUDE_PLUGIN_ROOT}/plugin/skills/coding-agent/scripts/clean-worktrees.sh"`, run from the main checkout.

If the user asks about a PR that isn't on staging yet, `slipway wait-pr <number> --max-seconds 0` shows where it is (checking, blocked and why, merged, deploying) without waiting.

If the app isn't registered or the deployer can't be reached, say so plainly and suggest `/new-app`, or `/setup` if this laptop has no deployer yet.
