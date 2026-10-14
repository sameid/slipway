# slipway

The slipway Claude Code plugin, for building internal apps. `/new-app` gives you a GitHub repo and a live staging link with working sign-in a few minutes later. After that, you describe features to Claude Code. `/ship` opens a pull request, which merges and deploys to staging once its checks pass. A person promotes staging to prod from the deployer dashboard.

You don't need AWS credentials or any AWS knowledge. The plugin only uses the GitHub CLI and the deployer's API. Someone on your team runs the platform (the deployer and its AWS infrastructure) in your own AWS account; see the [repo README](../README.md) to set one up.

The plugin lives in `plugin/`, and the repo root is its marketplace. The platform side (infrastructure, the deployer, build and deploy scripts) is in the same repo, one level up.

## Install

You need Claude Code, Node.js 24, and the GitHub CLI signed in (`gh auth login`) as an account the deployer accepts: a member of the GitHub org it serves, or on a personal account, its owner or someone on its allowed list. There's no Docker or local database: apps aren't run on your laptop, and you preview every change on staging. Then, in Claude Code:

```
/plugin marketplace add sameid/slipway
/plugin install slipway@slipway
/setup https://dxxxx.cloudfront.net
```

`/setup` takes your deployer's URL (ask whoever runs your slipway) and saves it in `~/.config/slipway/config.json`. It's a one-time step per laptop.

To get updates, run `/plugin marketplace update slipway`.

## Commands

If another plugin uses the same command name, the commands are also available as `/slipway:<command>`.

| Command | What it does |
|---|---|
| `/setup` | Saves your deployer's URL and checks that it accepts your GitHub login. Shows the GitHub account new apps are created under. |
| `/new-app` | Asks for a name, template and one-line description. Then creates `<owner>/<name>` from the template (the owner is the org or account your deployer serves), registers the app with the deployer, and waits for the staging link (10–15 minutes the first time). |
| `/ship` | Run it from a task's worktree. Commits the work, rebases onto `main` (regenerating a Drizzle migration if it conflicts), pushes the branch, and opens or updates the PR. Then it waits for the check, the auto-merge and the staging deploy. If the check fails, it shows the failing step and log so Claude can fix it and push again. |
| `/status` | Shows the staging and prod releases with their links, running and failed jobs, and any worktrees ready to clean up. |
| `/secret list`, `/secret set KEY --env staging\|prod` | Lists declared secrets, or gives you a one-time browser link for setting a value. Values never pass through Claude Code. |
| `/destroy-app` | Asks for the app to be torn down. Nothing is deleted until someone confirms it on the dashboard. |

The plugin also includes:

- **`slipway-stack` skill**: house conventions for the default stack (React, TanStack Query, HeroUI, Tailwind, Express, Drizzle, Clerk), migrations and secrets.
- **`coding-agent` skill**: gives every feature, fix or enhancement its own git worktree and branch. When one request asks for several things, it runs them in parallel as background agents, one worktree and PR each. `scripts/new-worktree.sh` creates one; `scripts/clean-worktrees.sh` removes those whose PRs are merged or closed.
- **Hooks**: in slipway app repos, these block edits to `.github/`, `CODEOWNERS`, and the platform-owned `app.yaml` fields (`name`, `auth`, `auto_merge`, `sizes`). They do nothing in other repos.
- **`slipway` CLI** (`bin/slipway`): Claude Code puts it on the Bash tool's PATH while the plugin is enabled. The commands use it to talk to the deployer, and you can run it yourself (`slipway --help`).
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
2. `~/.config/slipway/config.json` (or `$XDG_CONFIG_HOME/slipway/config.json`), written by `/setup` or `slipway setup --deployer-url <url>`;
3. `deployerUrl` in the plugin's own `slipway.config.json`. It's empty here. A team that would rather skip `/setup` can fork this repo, set it, and install the plugin from their fork.

The GitHub owner and the CODEOWNERS entry for new apps come from the deployer (`slipway whoami`), so there's nothing else to configure.

## Development

- **Releasing:** bump `version` in `.claude-plugin/plugin.json`. Colleagues get the change when they update the marketplace. Because the version is set, a commit without a version bump doesn't reach them.
- **Local deployer:** run the deployer in fake mode (`DEPLOYER_FAKE=1`, see `../deployer`) and point the CLI at it:
  ```sh
  SLIPWAY_DEPLOYER_URL=http://localhost:8080 SLIPWAY_GH_TOKEN=fake:<your-login> bin/slipway whoami
  ```
- **Checks before releasing:**
  ```sh
  npm test                                              # CLI and hook tests (node:test, no dependencies)
  claude plugin validate .. --strict                    # marketplace (repo root)
  claude plugin validate .claude-plugin/plugin.json --strict
  ```
- **Contracts:** the deployer API the CLI calls and the template's scripts are pinned in `../docs/contracts.md`. If you change one side, change the other side in the same release.
