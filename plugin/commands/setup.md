---
description: Point the slipway plugin at your deployer (once per laptop)
argument-hint: "[deployer-url]"
allowed-tools: Bash(slipway *), Bash(${CLAUDE_PLUGIN_ROOT}/bin/slipway *), Bash(gh auth status)
---

Connect the plugin to the colleague's slipway deployer. The `slipway` CLI is on PATH while this plugin is enabled (if not, use `"${CLAUDE_PLUGIN_ROOT}/bin/slipway"`).

Deployer URL from the colleague, if any: $ARGUMENTS

1. If no URL was given, ask for it in one short message: it's the `deployer_url` output of the slipway foundation (it looks like `https://dxxxx.cloudfront.net`), from whoever runs their slipway. If they run it themselves, it's `terraform -chdir=foundation output -raw deployer_url` in their slipway checkout.
2. Run `gh auth status`. If they aren't signed in, ask them to run `! gh auth login` and continue once they have.
3. Run `slipway setup --deployer-url <url>`. It saves the URL in `~/.config/slipway/config.json` and then checks it with the deployer.
4. Tell them what it printed: who they're signed in as, and the GitHub account new apps are created under. Then suggest `/new-app`.

If the check fails:
- **Can't reach the deployer:** the URL is wrong, or the deployer isn't released yet. The URL is saved anyway; run `/setup` again with the right one.
- **403:** their GitHub account isn't allowed. In an org, they must be a member of it. On a personal account, whoever runs their slipway adds their login to the deployer's allowed users (the runbook, docs/foundation.md, covers how).
- **401:** run `! gh auth login` and try again.
