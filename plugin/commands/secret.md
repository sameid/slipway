---
description: List this app's secrets, or get a one-time browser link to set one for staging or prod
argument-hint: "list | set <KEY> --env staging|prod"
allowed-tools: Bash(slipway secret *), Bash(${CLAUDE_PLUGIN_ROOT}/bin/slipway secret *)
---

Manage the app's third-party keys (Stripe, OpenAI, ...). The `slipway` CLI is on PATH while this plugin is enabled (if not, use `"${CLAUDE_PLUGIN_ROOT}/bin/slipway"`). Exit codes: 0 done, 1 error, 2 usage, 3 failed, 10 still waiting (run the same command again).

Arguments: $ARGUMENTS

**Secret values must never pass through this conversation.** Anything typed here is sent to the model and kept in the transcript. Never ask for a value, never accept one, never put one in a command, file or commit. If the user pastes a value anyway, don't use it: tell them it's now in the transcript and they should rotate that key, then continue with the link flow.

**`list`** (or no arguments): run `slipway secret list` and show, for each declared name, whether it's set for staging and prod, and who set it when. Point out anything not set: deploys of that environment fail until it is.

**`set <KEY> --env staging|prod`:**

1. The name must be declared under `secrets:` in `app.yaml` on `main`. If it isn't, explain: add the name (only the name) to `app.yaml` in a task worktree, use it as `process.env.<KEY>` in the API, and `/ship` that change first. Its staging deploy will fail until the value is set, which is expected.
2. If `--env` is missing, ask which environment: staging or prod. They're always set separately.
3. Run `slipway secret set <KEY> --env <env> --open`. It creates a link that works once and expires in 10 minutes, tries to open it in the browser, and prints it. Tell the user to paste the value into that page, not here.
4. The same command then waits for the value and the redeploy of that environment. Exit 10 means still waiting: run `slipway secret wait <link-id>` with the id it printed. Exit 0 means the value is saved and live. Exit 3: the link expired (offer a new one) or the redeploy failed (show the step and error).

Nobody can read a value back after it's set, including whoever runs the deployer. To rotate a key, set it again.
