---
description: Ask for this slipway app to be torn down (a dashboard user confirms it before anything is deleted)
argument-hint: "[app-name]"
allowed-tools: Bash(${CLAUDE_PLUGIN_ROOT}/bin/slipway status *), Bash(slipway status *)
---

Request teardown of an app. The `slipway` CLI is on PATH while this plugin is enabled (if not, use `"${CLAUDE_PLUGIN_ROOT}/bin/slipway"`).

App name from the user, if any: $ARGUMENTS

1. Find the app: `slipway status` inside its repo, or `slipway status --app <name>`. Only the app's owner (shown as `owner`) can request teardown.
2. Explain what teardown does, then ask the user to confirm by typing the app's name:
   - staging and prod are deleted: API services, CDN, frontend files and **both databases** (prod keeps a final database snapshot that can be restored in the RDS console);
   - the app's secrets are deleted;
   - the GitHub repo is archived (read-only), not deleted;
   - nothing happens until someone confirms it on the deployer dashboard by typing the app name.
3. Only if they typed the exact name: `slipway destroy --yes` (add `--app <name>` if you're not in the repo). Running it without `--yes` just prints a reminder.
4. Print the dashboard link from the output and tell them to confirm it there, or ask a user with a dashboard account to.

Never run `slipway destroy --yes` without that confirmation in this conversation.
