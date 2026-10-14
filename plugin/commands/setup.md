---
description: Set up slipway in your own AWS account, with apps under your GitHub org or account (once; run again to update)
argument-hint: "[region]"
allowed-tools: Bash(aws configure list-profiles), Bash(aws sts get-caller-identity*), Bash(gh auth status), Bash(gh api user), Bash(gh api user --jq *), Bash(gh api user/orgs --jq *), Bash(git config --get user.email), Bash(terraform version*)
---

Set slipway up in the user's own AWS account, with app repos under their own GitHub org or personal account. The `slipway` CLI is on PATH while this plugin is enabled (if not, use `"${CLAUDE_PLUGIN_ROOT}/bin/slipway"`). `slipway setup` does the work. It creates a state bucket, applies the foundation with Terraform, creates a GitHub App, releases the deployer and creates a dashboard account. Without `--yes` it only checks things and prints what it would do.

Region from the user, if any: $ARGUMENTS

If `slipway whoami` already works and the user wants to update (after a plugin update, say), skip to step 5. `slipway setup --yes` with no other flags reuses everything it used last time.

If someone else already runs slipway for them, they don't need any of this: use `/connect <deployer url>`.

1. **Say what's about to happen**, in a few lines:
   - It takes 20–30 minutes.
   - It costs about $20–25 a month before any apps. Each app adds a small database, a service and a CDN distribution per environment.
   - It needs an AWS account with admin access in the AWS CLI. Ideally that's an account used only for slipway: the region they pick is slipway's alone.
   - It needs the GitHub CLI signed in, Terraform 1.11 or later, and Node.js 24.
2. **Gather the inputs.** Find what you can, then ask the rest in one message:
   - **AWS profile:** `aws configure list-profiles`. If there's more than one, ask which. Then check it with `aws sts get-caller-identity --profile <name>`. If the sign-in has expired, ask them to run `! aws sso login --profile <name>`.
   - **Region:** where slipway runs, for example `us-east-1` or `eu-west-1`. Suggest one near them, and remind them nothing else should run there.
   - **GitHub owner:** their personal account (`gh api user --jq .login`) or an org they own (`gh api user/orgs --jq '.[].login'`). slipway's GitHub App can write to every repo of that owner, so an org or account that holds only slipway apps is best. In an org, its members can use the deployer too. On a personal account, only they can, unless they pass `--allowed-users`.
   - **Email:** for AWS alerts and their dashboard account. Offer `git config --get user.email`.
3. **Check:** `slipway setup --region <region> --owner <owner> --email <email> [--profile <profile>]`. Then:
   - If it lists problems, help fix them and run it again. For a missing tool, give the install command. For a region that won't work, suggest another.
   - Otherwise, show the user its summary: account, region, GitHub owner, email, budget and any notes. A "Free plan" note means `main` can't be protected on private repos. Mention that.
4. **Confirm.** Ask whether to go ahead in this AWS account and region. Stop unless they clearly say yes.
5. **Run** the same command with `--yes`, in the background (Bash `run_in_background`), because it takes longer than a foreground command may run. While it runs, read its output every minute or two and keep the user posted in a short line (state bucket, foundation, first boot, and so on). **When a line starts with `ACTION:`, tell the user immediately.** The GitHub App step needs them in the browser. It opens a page that sends them to GitHub, where they choose **Create GitHub App** and then install it on **All repositories**. If the page didn't open, give them the `http://127.0.0.1:...` link from the output.
6. **When it finishes**, tell them:
   - the deployer URL;
   - their dashboard sign-in, with the temporary password if one was printed. They choose their own at first sign-in. The dashboard is where a person promotes staging to prod;
   - to confirm the "AWS Notification - Subscription Confirmation" email, so alerts reach them.

   Then suggest `/new-app`.

To let someone else use a deployer on a personal account, run `slipway setup --yes --allowed-users <login,login>`. To set the `CODEOWNERS` entry new apps get, add `--codeowners @org/team`. Either one restarts the deployer.

If it fails:
- **"would replace or delete existing resources":** explain what it lists. Replacing `aws_instance.deployer` loses the deployer's database: dashboard accounts, the app registry and job history. The apps keep running. Run again with `--allow-replace` only if the user explicitly agrees.
- **Anything else:** show the error and what it suggests. Running `slipway setup --yes` again carries on from where it stopped; finished steps are skipped.
- **Nobody acted on the GitHub step in time:** run it again; the step starts over.
