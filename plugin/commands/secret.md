---
description: List this app's secrets, or get a one-time browser link to set one for staging or prod
argument-hint: "list | set <KEY> --env staging|prod"
allowed-tools: Bash(slipway secret *), Bash(${CLAUDE_PLUGIN_ROOT}/bin/slipway secret *), Bash(slipway whoami), Bash(${CLAUDE_PLUGIN_ROOT}/bin/slipway whoami)
---

Manage the app's third-party keys (Stripe, OpenAI, ...). The `slipway` CLI is on PATH while this plugin is enabled (if not, use `"${CLAUDE_PLUGIN_ROOT}/bin/slipway"`). Exit codes: 0 done, 1 error, 2 usage, 3 failed, 10 still waiting (run the same command again).

Arguments: $ARGUMENTS

**Secret values must never pass through this conversation.** Anything typed here is sent to the model and kept in the transcript. Never ask for a value, never accept one, never put one in a command, file or commit. If the user pastes a value anyway, don't use it: tell them it's now in the transcript and they should rotate that key, then continue with the link flow.

**`list`** (or no arguments): run `slipway secret list` and show, for each name, whether it's set for staging and prod and who set it when. Point out a required name (listed under `secrets:` in `app.yaml`) that isn't set: deploys of that environment fail until it is. A value that's "not deployed yet" was saved with Save only and reaches the app on that environment's next deploy.

**`set <KEY> --env staging|prod`:**

1. Any UPPER_SNAKE_CASE name works; it doesn't have to be in `app.yaml` first, and nothing needs shipping. Every deploy gives the app all of an environment's secrets as `process.env.<KEY>`. The deployer refuses names the platform sets (`PORT`, `DB_*`, `AWS_*`, ...) and ones that change how the app runs (`NODE_OPTIONS` and other `NODE_*`, `PATH`, proxies), which only `app.yaml` may declare.
2. If `--env` is missing, ask which environment: staging or prod. They're always set separately.
3. Run `slipway secret set <KEY> --env <env> --open`. It creates a link that works once and expires in 10 minutes, tries to open it in the browser, and prints it. Tell the user to paste the value into that page, not here, and to pick **Save and deploy** (the app gets it in a few minutes) or **Save only** (it waits for the next deploy, for example the merge of the change that uses it).
4. The same command then waits for the value and, with Save and deploy, the redeploy of that environment. Exit 10 means still waiting: run `slipway secret wait <link-id>` with the id it printed. Exit 0 means the value is saved, and either live or waiting for the next deploy (say which). Exit 3: the link expired (offer a new one) or the redeploy failed (show the step and error).

When a change that reads a new key is about to be shipped, set the value first (Save only is fine): that change's deploy then has it. If the code needs the key to work, the change should also list it under `secrets:` in `app.yaml`, so a deploy without it fails early instead of the app failing later.

**Several keys at once, or removing one:** `/secret set` takes one key per link. If the user has several to set and a deployer dashboard account, point them to the app's secrets page instead: `<deployer URL>/apps/<app>/secrets/<env>`, where `slipway whoami` prints the deployer URL. It has a field for every name, a row for a new one, takes a pasted `.env` file, and saves with one deploy (Save and deploy) or none (Save only). It's also where a secret is removed: the next deploy leaves it out, then it's deleted. Without a dashboard account, they set each key with `/secret set`, choosing Save only for all but the last one so the environment deploys once.

Nobody can read a value back after it's set, including whoever runs the deployer. To rotate a key, set it again.
