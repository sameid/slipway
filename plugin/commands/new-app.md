---
description: Create a new slipway app (GitHub repo and a staging environment with sign-in) from a template
argument-hint: "[app-name] [one-line description]"
allowed-tools: Bash(slipway *), Bash(${CLAUDE_PLUGIN_ROOT}/bin/slipway *), Bash(cd *), Bash(git rev-parse *)
---

Create a new slipway app. The `slipway` CLI does the mechanical work; it's on PATH while this plugin is enabled (if not, use `"${CLAUDE_PLUGIN_ROOT}/bin/slipway"`). Run it with the Bash tool and read its output and exit code: 0 done, 1 error, 2 usage, 3 failed, 10 still waiting (run the same command again).

Arguments from the colleague, if any: $ARGUMENTS

1. **Interview.** You need three answers. Use what's in the arguments and ask only for what's missing, all in one message:
   - **App name:** 3-20 lowercase letters, digits and hyphens, starting with a letter (it becomes `<owner>/<name>` on GitHub, under the account `slipway whoami` names, and part of every AWS resource name). Suggest one if they described the app.
   - **Template:** run `slipway templates`. If `react-express` is the only one, say that's what you'll use instead of asking.
   - **One-line description** of what the app does and for whom.
2. **Check the name:** `slipway check-name <name>`. If it's taken or invalid, explain why and ask for another.
3. **Pick the folder.** The app is created in a new `<name>/` folder inside the current directory. If the current directory is itself inside a git repo (`git rev-parse --show-toplevel` succeeds), create it next to that repo instead (pass `--dir <parent of that repo>`) and say where.
4. **Create it:** `slipway new-app --name <name> --description "<description>" [--dir <folder>]`. This copies the template, commits, creates the private repo `<owner>/<name>`, pushes `main` and registers the app with the deployer, which starts building staging. If it fails after the repo was created, follow the printed recovery step (`slipway register --app <name>`). If it prints a warning that main isn't protected (GitHub Free can't protect private repos), pass it on.
5. **Wait for staging:** `slipway wait-app --app <name>`. It prints each phase (registering, building, creating staging). The first deploy takes 10-15 minutes, mostly creating the database. Exit code 10 means it's still going: run it again until it exits 0 or 3. Keep the colleague posted with one short line per phase, not the raw output.
   - On exit 3, show the failed step and error, and the relevant log lines. Setup failures are platform problems, not the colleague's: suggest sharing the dashboard link with the dev team.
6. **Finish** with:
   - the staging link (opening it shows a Clerk sign-in; who can sign in is set in the Clerk dashboard),
   - the repo link and the local folder,
   - what's next: describe a feature to build; each one gets its own worktree, and `/ship` opens a PR that merges and deploys to staging automatically once its check passes. Every change is previewed on staging; nothing runs on the laptop. `/status` shows what's live. Promoting to prod is done by a person on the deployer dashboard.
