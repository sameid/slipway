---
description: Use a slipway deployer someone else set up (once per laptop)
argument-hint: "[deployer-url]"
allowed-tools: Bash(slipway connect *), Bash(${CLAUDE_PLUGIN_ROOT}/bin/slipway connect *), Bash(gh auth status)
---

Point the plugin at a slipway deployer that someone else runs, for example a teammate who ran `/setup` for an org. The `slipway` CLI is on PATH while this plugin is enabled (if not, use `"${CLAUDE_PLUGIN_ROOT}/bin/slipway"`).

Deployer URL, if given: $ARGUMENTS

1. If no URL was given, ask for it in one short message. It looks like `https://dxxxx.cloudfront.net`, and whoever ran `/setup` has it (`slipway whoami` on their laptop prints it). If nobody runs slipway for them yet, they want `/setup` instead.
2. Run `gh auth status`. If they aren't signed in, ask them to run `! gh auth login` and continue once they have.
3. Run `slipway connect <url>`. It saves the URL in `~/.config/slipway/config.json`, then checks it with the deployer.
4. Tell them what it printed: who they're signed in as, and the GitHub account new apps are created under. Then suggest `/new-app`.

If the check fails:
- **Can't reach the deployer:** the URL is wrong, or the deployer isn't running. The URL is saved anyway; run `/connect` again with the right one.
- **403:** their GitHub account isn't allowed. In an org, they must be a member of it. On a personal account, its owner adds them with `slipway setup --yes --allowed-users <logins>`, which restarts the deployer.
- **401:** run `! gh auth login` and try again.
