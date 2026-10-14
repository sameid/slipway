# slipway plugin

The slipway Claude Code plugin. `/setup` puts slipway in your own AWS account, with app repos under your GitHub org or personal account. Then `/new-app` gives you a GitHub repo and a live staging link a few minutes later. After that, you describe features to Claude Code. `/ship` opens a pull request, which merges and deploys to staging once its checks pass. You promote staging to prod from the deployer dashboard.

Only `/setup` uses AWS credentials. Everything else goes through the GitHub CLI and the deployer's API, so people who share your deployer (`/connect`) need no AWS access at all.

This directory holds the plugin's commands, skills, hooks, CLI and app template. The plugin's root is the repo root: Claude Code installs the whole repo, so `/setup` has the infrastructure code (`foundation/`, `deployer/`, `jobs/`, `modules/`) next to it.

## Install

You need Claude Code, Node.js 24 and the GitHub CLI signed in (`gh auth login`). For `/setup` you also need the AWS CLI v2 with admin credentials for the account, and Terraform 1.11 or later; the [repo README](../README.md) has the details. There's no Docker or local database: apps aren't run on your laptop, and you preview every change on staging. In Claude Code:

```
/plugin marketplace add sameid/slipway
/plugin install slipway@slipway
/setup                                  # or /connect <url> to use someone else's deployer
```

To get updates, run `/plugin marketplace update slipway`, then `/setup` to update your deployer.

## Commands

If another plugin uses the same command name, the commands are also available as `/slipway:<command>`.

| Command | What it does |
|---|---|
| `/setup` | Sets slipway up in your AWS account, with apps under your GitHub org or personal account: a state bucket, the foundation (Terraform), a GitHub App, the deployer and your dashboard account. Run it again after a plugin update to update the deployer. See `../docs/foundation.md`. |
| `/connect <url>` | Uses a deployer someone else set up. Saves its URL and checks that it accepts your GitHub login. |
| `/new-app` | Asks for a name, template and one-line description. Then creates `<owner>/<name>` from the template (the owner is the org or account your deployer serves), registers the app with the deployer, and waits for the staging link (10–15 minutes the first time). |
| `/ship` | Run it from a task's worktree. Commits the work, rebases onto `main` (regenerating a Drizzle migration if it conflicts), pushes the branch, and opens or updates the PR. Then it waits for the check, the auto-merge and the staging deploy. If the check fails, it shows the failing step and log so Claude can fix it and push again. |
| `/status` | Shows the staging and prod releases with their links, running and failed jobs, and any worktrees ready to clean up. |
| `/secret list`, `/secret set KEY --env staging\|prod` | Lists declared secrets, or gives you a one-time browser link for setting a value. Values never pass through Claude Code. |
| `/destroy-app` | Asks for the app to be torn down. Nothing is deleted until someone confirms it on the dashboard. |

The plugin also includes:

- **`slipway-stack` skill**: house conventions for the default stack (React, TanStack Query, HeroUI, Tailwind, Express, Drizzle), migrations and secrets. Apps have no sign-in until you add one.
- **`coding-agent` skill**: gives every feature, fix or enhancement its own git worktree and branch. When one request asks for several things, it runs them in parallel as background agents, one worktree and PR each. `scripts/new-worktree.sh` creates one; `scripts/clean-worktrees.sh` removes those whose PRs are merged or closed.
- **Hooks**: in slipway app repos, these block edits to `.github/`, `CODEOWNERS`, and the platform-owned `app.yaml` fields (`name`, `auto_merge`, `sizes`). They do nothing in other repos.
- **`slipway` CLI** (`../bin/slipway`, code in `cli/`): Claude Code puts it on the Bash tool's PATH while the plugin is enabled. The commands use it to set up slipway and talk to the deployer, and you can run it yourself (`slipway --help`).
- **Templates** (`templates/`): `react-express`, the default app.

## CLI exit codes

The command and skill instructions rely on these, so keep them stable:

| Code | Meaning |
|---|---|
| 0 | Done |
| 1 | Error (network, auth, unexpected state) |
| 2 | Usage error |
| 3 | The thing being waited on failed (check, build, deploy, registration, expired link) |
| 4 | The PR passed its check but won't auto-merge (see the note) |
| 10 | Still in progress when `--max-seconds` ran out (default 540, under the Bash tool's 10-minute limit). Run the same command again. |

## Configuration

The CLI finds the deployer's URL in this order:

1. `SLIPWAY_DEPLOYER_URL`, useful for testing against a local deployer;
2. `~/.config/slipway/config.json` (or `$XDG_CONFIG_HOME/slipway/config.json`), written by `/setup` and `/connect`. `/setup` also keeps its AWS account, region and profile there, so later runs need no flags;
3. `deployerUrl` in the plugin's own `slipway.config.json`. It's empty here. A team that would rather skip `/connect` can fork this repo, set it, and install the plugin from their fork.

The GitHub owner and the CODEOWNERS entry for new apps come from the deployer (`slipway whoami`), so there's nothing else to configure.

## Development

- **Releasing:** bump `version` in `../.claude-plugin/plugin.json`. Users get the change when they update the marketplace, and the next `/setup` releases the matching deployer (`<version>-<timestamp>`). Because the version is set, a commit without a version bump doesn't reach them.
- **Layout:** the repo root is the plugin root (the marketplace's source is `.`), because `/setup` needs `foundation/`, `deployer/`, `jobs/` and `modules/`, and an installed plugin only gets its own directory. `bin/` has to be at the plugin root; `../.claude-plugin/plugin.json` points `commands`, `skills` and `hooks` at this directory. In commands and hooks, `${CLAUDE_PLUGIN_ROOT}` is the repo root.
- **Trying it:** `claude --plugin-dir ..` loads the plugin from this checkout. `SLIPWAY_SOURCE=<checkout>` makes `slipway setup` use a different checkout's infrastructure code.
- **Local deployer:** run the deployer in fake mode (`DEPLOYER_FAKE=1`, see `../deployer`) and point the CLI at it:
  ```sh
  SLIPWAY_DEPLOYER_URL=http://localhost:8080 SLIPWAY_GH_TOKEN=fake:<your-login> bin/slipway whoami
  ```
- **Checks before releasing:**
  ```sh
  npm test                                              # CLI, setup and hook tests (node:test, no dependencies)
  npm run validate                                      # marketplace and plugin manifests
  ```
- **Contracts:** the deployer API the CLI calls and the template's scripts are pinned in `../docs/contracts.md`. If you change one side, change the other side in the same release.
