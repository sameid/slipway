# Setup and operations

`/setup` in Claude Code (the `slipway setup` CLI) takes your own AWS account and your own GitHub org or personal account to a running slipway: the state bucket, the foundation (deployer host behind CloudFront, its IAM role, the permissions boundary for app roles, the artifacts bucket, alerts and a budget), a GitHub App, the deployer release and your dashboard account. This page says what it does at each step, how to change things later, how to operate the deployer host, and how to do it all by hand.

What gets created is in `foundation/*.tf` (about 20 resources); the names other components rely on are in [contracts.md](contracts.md).

**The region is dedicated to slipway.** The foundation uses the region's default VPC and subnets instead of building a network, and the deployer's role may do anything in the region. Don't run anything else there. A separate AWS account just for slipway is best. Outside the region (IAM, CloudFront), the role is scoped tightly. There's one slipway per AWS account: its state bucket is named after the account.

**There's no CodeBuild.** Builds and deploys run on the deployer instance itself, in a second process called the runner (contracts.md, "Runner"). That keeps the platform to one instance and works in every region. The instance runs the deployer and the runner under pm2 (pm2-logrotate rotates their logs), with Caddy in front and CloudFront in front of Caddy.

## Running setup

```
slipway setup --region <region> --email <email> [--owner <org-or-login>] [--profile <aws-profile>]   # checks only
slipway setup ... --yes                                                                               # does it
```

`/setup` runs these for you, and asks before the `--yes` run. Without `--yes`, setup only reads: it checks your tools, your AWS and GitHub accounts and the region, and prints what it would create. With `--yes` it creates, or updates, everything. Each step skips what's already done, so running it again after a failure, or after updating the plugin, carries on. A second run needs no flags: the region and AWS profile are in `~/.config/slipway/config.json`, and the foundation's inputs are stored next to its state in your account.

| Flag | |
|---|---|
| `--region` | required the first time; dedicated to slipway |
| `--email` | required the first time: AWS alerts, the budget's emails, and your dashboard account |
| `--owner` | the GitHub org or personal account for app repos. Default: your own account. It can't change later |
| `--profile` | AWS CLI profile; default `AWS_PROFILE` or the default credentials |
| `--budget` | monthly AWS Budgets limit in USD for the region (default 500) |
| `--allowed-users` | personal accounts only: other GitHub logins that may use the deployer, comma-separated |
| `--codeowners` | `CODEOWNERS` entry for platform-owned files in new apps, e.g. `@your-org/platform`. Default: you on a personal account, the app's creator in an org |
| `--allow-replace` | let an update replace or delete foundation resources (see step 2) |
| `--release` | release the deployer even if it already runs this plugin version |
| `--no-browser` | don't open the GitHub App page; the link is printed either way |

### Checks

- **Tools:** the AWS CLI v2, Terraform 1.11 or later, npm, tar and bash. Homebrew's own `terraform` formula is stuck at 1.5; use `brew tap hashicorp/tap && brew install hashicorp/tap/terraform`.
- **AWS:** your credentials work, and aren't the root user. Setup needs admin rights; nothing after setup uses your AWS credentials.
- **GitHub:** the GitHub CLI is signed in. A personal account must be yours, because only you can create its GitHub App and repos. In an org you should be an owner. On GitHub Free it warns that private repos' `main` can't be protected.
- **Region:** it's enabled for the account, AWS lists every service slipway uses there, it has a default VPC, and one of its zones has a default subnet and offers `t3.small` (setup picks that zone and keeps it). RDS offers `db.t3.micro`, `small` and `medium` for Postgres 17. ECS Express Mode isn't checked: the first app's deploy is the real test of it in a new region.

### What --yes does

1. **State bucket.** Creates `slipway-tfstate-<account>` in your region: versioned, encrypted, private, TLS-only, with old versions kept for 90 days. It holds every Terraform state file (the foundation's and each app environment's) and the foundation's inputs (`foundation/terraform.tfvars.json`).
2. **Foundation.** Copies `foundation/` to `~/.cache/slipway/foundation-<account>-<region>/`, writes the inputs there and to the state bucket, then runs `terraform init`, `plan` and `apply`. If the plan would replace or delete anything, setup stops and lists it unless you passed `--allow-replace`. Replacing `aws_instance.deployer` loses the deployer's database (see "Replacing the instance"). If the first apply fails because a new IAM role hasn't reached EC2 yet, it tries once more. The first apply takes 10–20 minutes, most of it the CloudFront distribution.
3. **First boot.** Waits for the instance to check in with Systems Manager, then for its first-boot setup (packages, swap, Docker, Node.js, pm2 and pm2-logrotate, Caddy), about five minutes. If that fails, it shows the end of `/var/log/cloud-init-output.log`.
4. **GitHub App.** Creates the deployer's GitHub App with GitHub's [manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). A page on `127.0.0.1` sends your browser to GitHub with the App's settings. You click **Create GitHub App** (renaming it if `slipway-<owner>` is taken), and GitHub sends the browser back with a one-time code. Setup exchanges the code for the App's ID, private key and webhook secret, which go straight into Secrets Manager as `slipway/github-app`. The browser then goes to the App's install page: install it on **All repositories**, so every new app repo is covered. Setup waits until it is. If the secret already holds a working App, this step only checks the installation.

   | App setting | Value |
   |---|---|
   | Webhook | `<deployer URL>/webhooks/github`; events: Push, Pull request |
   | Repository permissions | Administration: read and write · Commit statuses: read and write · Contents: read and write · Metadata: read-only · Pull requests: read and write |
   | Organization permissions | Members: read-only (orgs only) |
   | Installable | only on this account |

5. **Deployer release.** Runs `deployer/scripts/release.sh <plugin version>-<timestamp>` from the plugin's own copy of the repo. It builds the deployer in a scratch directory, uploads the release to the artifacts bucket, sets `/slipway/deployer/version`, and runs `/opt/slipway/bin/update-deployer.sh` on the instance through SSM (contracts.md, "Deployer host"). It's skipped when the deployer already runs this plugin version. Setup refuses to install an older plugin version over a newer deployer unless you pass `--release`. When only the GitHub App or the access settings changed, setup restarts the deployer instead.
6. **Dashboard account and plugin.** Creates a dashboard admin for `--email` on the instance (through SSM, so no SSH or Session Manager plugin is needed) and prints its temporary password once; you choose your own at first sign-in. Then it saves the deployer URL in `~/.config/slipway/config.json` and checks it with the deployer, like `slipway connect`.

Afterwards, confirm the "AWS Notification - Subscription Confirmation" email sent to `--email`, or alerts won't reach you. The budget (`slipway-<region>`) counts only spend billed to the region; CloudFront and other global services don't count towards it.

### Who can use it

Every app repo is created under one GitHub org or personal account. The deployer's GitHub App is installed on all of that owner's repositories and can write to every one of them, so use an owner that holds only slipway apps.

| | Org | Personal account |
|---|---|---|
| Who may use the deployer | members of the org | you, plus `--allowed-users` |
| Who can run `/new-app` | members allowed to create repos in the org | only you: nobody else can create repos in your account. Allowed users need write access to each app repo (add them as collaborators) to `/ship` |
| Merging into `main` | only the deployer's App (push restrictions) | anyone with write access, once the check passes: GitHub has no push restrictions for personal repos |
| `CODEOWNERS` default | the app's creator; `--codeowners @your-org/platform` sets a team | you |

Others connect with `/connect <deployer URL>` (`slipway connect <url>`), which saves the URL in their `~/.config/slipway/config.json`. `SLIPWAY_DEPLOYER_URL` overrides the saved URL.

**GitHub Free can't protect private repos.** On Free, registering an app still succeeds, but the deployer can't set branch protection on `main` and `/new-app` prints a warning. A direct push to `main` then deploys to staging without the check. GitHub Pro (personal) or Team (org) removes the limit; on Free, only change `main` through PRs.

### Changing things later

- **Allowed users and `CODEOWNERS`:** `slipway setup --yes --allowed-users ...` or `--codeowners ...`. They live in the SSM parameter `/slipway/deployer/github-access`, which the deployer reads at startup, so setup restarts the deployer. An empty value (`--allowed-users ""`) clears it.
- **Email and budget:** `--email`, `--budget`; updated in place. A new email gets a new SNS confirmation email. Your dashboard account keeps its old address; change it on the dashboard.
- **GitHub owner:** not supported. It would need a new GitHub App and a new deployer instance.
- **Region:** one slipway per AWS account. Moving means tearing it down (below) and setting up again.
- **Instance size, volume, swap, runner limits and pinned tools:** by hand (below). These are in the instance's user data, so changing them replaces the instance.

## Doing it by hand

Everything setup does can be done with the repo checked out, AWS credentials for the account (`AWS_PROFILE`) and `AWS_REGION` set. These are also the commands for anything setup doesn't do.

```sh
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET=slipway-tfstate-$ACCOUNT
TF=~/.cache/slipway/foundation-$ACCOUNT-$AWS_REGION      # setup's working copy; or use foundation/ in a checkout

# [AWS] the foundation's inputs, as setup last wrote them
aws s3 cp "s3://$BUCKET/foundation/terraform.tfvars.json" "$TF/terraform.tfvars.json"
# edit $TF/terraform.tfvars.json, e.g. add "runner_max_builds": 2, then keep the bucket's copy in step,
# or the next /setup run will plan to undo the change
# [AWS] saves the inputs next to the state
aws s3 cp "$TF/terraform.tfvars.json" "s3://$BUCKET/foundation/terraform.tfvars.json"
terraform -chdir="$TF" init -backend-config="bucket=$BUCKET" -backend-config="region=$AWS_REGION"
# [AWS] review the plan before applying it
terraform -chdir="$TF" plan -out tfplan
terraform -chdir="$TF" apply tfplan
terraform -chdir="$TF" output                                  # deployer_url, deployer_instance_id, ...
```

setup keeps any input it doesn't manage (it manages the ones in its flags table, plus `region` and `deployer_az_suffix`).

```sh
# [AWS] publish and roll out a release from a checkout (asks for confirmation)
deployer/scripts/release.sh [version]

# [AWS] a shell on the instance through Session Manager (needs the Session Manager plugin for the AWS CLI)
aws ssm start-session --target "$(terraform -chdir="$TF" output -raw deployer_instance_id)"
sudo /opt/slipway/bin/create-admin --email you@example.com --reset     # new temporary password, admin again
```

To create the GitHub App by hand, use the settings in step 4 under your org's or account's **Settings → Developer settings → GitHub Apps**. Then generate a private key, install the App on all repositories, and store `{"appId", "privateKey", "webhookSecret"}` as the secret `slipway/github-app`.

### Checking it end to end

From your machine:

- The deployer URL shows the login page over HTTPS.
- In the GitHub App's **Advanced → Recent Deliveries**, redeliver a recent delivery: it should get a 2xx.
- `curl -m 5 http://<deployer_public_ip>:8080/` times out: only CloudFront may connect.

On the instance (Session Manager):

```sh
sudo pm2 ls                                   # deployer and runner online, pm2-logrotate module running
systemctl status caddy slipway-nftables docker --no-pager
sudo -u slipway-runner aws sts get-caller-identity                 # assumed-role/slipway-deployer/...
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/     # 403: no origin header
# Isolation: the build user must not reach the metadata service or the deployer
sudo -u slipway-build curl -s -m 3 http://169.254.169.254/ && echo "NOT ISOLATED" || echo "metadata blocked"
sudo -u slipway-build curl -s -m 3 http://127.0.0.1:3000/ && echo "NOT ISOLATED" || echo "deployer blocked"
sudo ls /var/lib/slipway                     # works as root ...
sudo -u slipway-build ls /var/lib/slipway   # ... and is denied for the build user
```

### Tearing it down

There's no command for this; it deletes everything, so it's deliberately manual.

1. Destroy every app with `/destroy-app` and confirm each on the dashboard. Prod databases leave a final snapshot; delete those in the RDS console when you're sure.
2. Empty the artifacts bucket (`slipway-artifacts-<account>`), then `terraform -chdir="$TF" destroy` with the inputs, as above.
3. Delete the secret `slipway/github-app` (`aws secretsmanager delete-secret --secret-id slipway/github-app --force-delete-without-recovery`), and the SSM parameter `/slipway/deployer/version`.
4. Delete the GitHub App: **Settings → Developer settings → GitHub Apps → your App → Advanced → Delete**.
5. Empty and delete the state bucket, including old versions. Remove `deployerUrl` and `setup` from `~/.config/slipway/config.json`.

## Operating the deployer host

**What runs where.**

| Process | Managed by | User | Notes |
|---|---|---|---|
| Caddy | systemd `caddy.service` | `caddy` | `:8080` for CloudFront, proxies to `127.0.0.1:3000` only when the `X-Slipway-Origin` header matches; config `/etc/caddy/Caddyfile` from the current release, secret in `/etc/slipway/caddy.env` |
| deployer | pm2 | `slipway` | `127.0.0.1:3000`; data in `/var/lib/slipway` |
| runner | pm2 | `slipway-runner` | socket `/run/slipway/runner.sock`; runs in `/var/lib/slipway-runner/runs/<id>/` |
| pm2-logrotate | pm2 module | root | rotates `/root/.pm2/logs/*` daily or at 10 MB, keeps 14 compressed files per app |
| pm2 itself | systemd `pm2-root.service` | root | resurrects the saved process list at boot |
| Docker | systemd | root | image builds only; socket group `slipway-runner` |
| firewall | systemd `slipway-nftables.service` | | table `inet slipway` |

**Network.** The instance sits in a default subnet with an Elastic IP on its own network interface, so CloudFront's origin (the Elastic IP's public DNS name) survives instance replacements. Its security group admits only CloudFront's origin-facing ranges on 8080, and Caddy turns away anything without the secret `X-Slipway-Origin` header that only this distribution sends, which keeps other CloudFront distributions out too. Viewers get HTTPS from CloudFront; the hop from CloudFront to the instance is plain HTTP over AWS's network and the internet. That hop carries dashboard passwords and colleagues' GitHub tokens, which was an explicit trade-off for not running a NAT gateway and private subnet.

**pm2.** `sudo pm2 ls`, `sudo pm2 logs runner`, `sudo pm2 logs deployer --lines 200`, `sudo pm2 restart deployer`. Logs are in `/root/.pm2/logs/` (rotated daily, 14 days). `/usr/local/bin/pm2` is a wrapper that always talks to root's pm2 daemon. pm2 starts each process with only its user's primary group, so access is arranged through owners and primary groups: the runner's socket directory is setgid group `slipway`, and Docker's socket belongs to group `slipway-runner`.

**Caddy.** `systemctl status caddy`, `journalctl -u caddy`. `sudo systemctl reload caddy` after editing `/etc/caddy/Caddyfile` by hand (the next release overwrites it). Caddy refuses to start if `/etc/slipway/caddy.env` has no origin secret. Its admin API listens on `localhost:2019`; the firewall keeps the build user and containers away from it.

**The runner.** Each run has a directory in `/var/lib/slipway-runner/runs/<id>/` with its `log`, so `sudo tail -f /var/lib/slipway-runner/runs/<id>/log` follows a build. At most `RUNNER_MAX_BUILDS` builds (default 1) and `RUNNER_MAX_DEPLOYS` deploys (default 2) run at once; change them as foundation inputs (`runner_max_builds`, `runner_max_deploys`, by hand: see "Doing it by hand"; that replaces the instance) or in `/etc/slipway/runner.env` followed by `sudo pm2 startOrReload /opt/slipway/current/ecosystem.config.cjs --only runner --update-env && sudo pm2 save` (pm2 re-reads the env files only through the ecosystem file). The instance has 2 GB of memory and a 4 GB swap file; raise the builds limit only on a bigger instance.

**Permissions, isolation, and what changed from design 7.** The instance role (`slipway-deployer`) is used directly by the deployer and the runner. It may do anything in the foundation's region, which is dedicated to slipway. Outside the region it can only:

- manage IAM roles named `app-*` that carry the `slipway-boundary` permissions boundary, and pass them to ECS;
- create CloudFront distributions, and change or delete only those tagged `platform=slipway` with an `app` tag (the deployer's own has no `app` tag);
- tag a distribution `platform=slipway`, which creating one with tags needs. That would also let it tag one of the account's other distributions and then manage it, so the tag scoping guards against accidents, not against a compromised instance: another reason for a dedicated account;
- create CloudFront functions named `app-*` and origin access controls.

IAM and STS are excluded even inside the region, so the box can't assume other roles in the account.

Untrusted build steps (anything that executes app code: `npm ci`, type check, lint, tests, the frontend build) run as `slipway-build`. That user can't reach the instance metadata service, so it has no AWS credentials; it can't reach the deployer, Caddy or Caddy's admin API; and it can't read the deployer's data or the runner's other runs. Docker build steps run in containers with no host mounts, and the metadata hop limit of 1 keeps them away from credentials.

Design 7 said "the deployer, the most exposed component, holds the least AWS power" because CodeBuild held the deploy permissions in a separate sandbox. That no longer holds: the deployer host now holds them, and it can also read app secret values. Isolation rests on `slipway-build` having no credentials and on the deployer itself not being compromised.

**Rolling back a release.** The last three releases stay under `/opt/slipway/releases/`. Run `sudo /opt/slipway/bin/update-deployer.sh <older version>`; it reuses the installed copy. Set `/slipway/deployer/version` back too, or a replaced instance would come up on the newer release.

**Security updates.** `dnf-automatic` applies security updates within the instance's Amazon Linux 2023 release. New AMIs are ignored by Terraform (`ignore_changes = [ami]`) so an apply never replaces the instance by surprise.

**Disk.** A daily timer (`slipway-docker-prune.timer`) removes Docker images and build cache older than two days. Run directories are removed by the runner after 30 days.

**Hardware failure.** EC2's simplified automatic recovery (on by default for `t3`) moves the instance to healthy hardware, keeping its ID, volume, network interface and Elastic IP.

**Backups.** None yet. The deployer's state (dashboard accounts, the app registry, releases, job history, secret metadata) is one SQLite file, `/var/lib/slipway/deployer.db`, on the instance's root volume. EC2's automatic recovery keeps that volume. Terminating or replacing the instance loses it. Apps keep running either way, since their state is in their own RDS databases and Terraform state. Adding EBS snapshots (for example an AWS Data Lifecycle Manager policy) is a planned follow-up.

**Replacing the instance** (new AMI, a change to user data or the env files, or a broken box). Apps keep running; only merges and deploys pause, and catch-up on startup queues anything missed. Check nothing is building or deploying first. **Until EBS backups exist this starts the deployer with an empty database**: dashboard accounts, the app registry and job history are lost. Re-registering apps and creating accounts again would be manual.

```sh
# [AWS] replaces the deployer (its database is NOT kept until EBS backups exist)
terraform -chdir="$TF" apply -replace=aws_instance.deployer    # $TF: see "Doing it by hand"
```

Then run `/setup` again: it waits for the new instance's first boot and creates your dashboard account again.

The network interface, Elastic IP and CloudFront distribution stay as they are.

**Updating tools.** Node.js, pm2, pm2-logrotate and Caddy are pinned in `foundation/variables.tf` (`node_version`/`node_sha256`, `pm2_version`, `pm2_logrotate_version`, `caddy_version`/`caddy_sha512`; checksums from `SHASUMS256.txt` on nodejs.org and the Caddy GitHub release). Change them as foundation inputs (by hand, as below), then replace the instance as above. Terraform and gitleaks are pinned in `jobs/versions.env` and arrive with the next release, without replacing anything.

## Known limits and things to check

- **The GitHub App can reach every repo of the owner.** Installing it on all repositories covers every other repo there too. Use an org or account that holds only slipway apps; otherwise treat the deployer instance and the `slipway/github-app` secret as having write access to all of the owner's repos. Narrowing it is a possible follow-up (design, "Changes since Draft v7", item 9).
- **GitHub Free** can't protect private repos: see step 0.
- **Regions.** The first deployment ran in `ca-west-1`. Other regions should work if step 1 passes, but the first app's deploy is the real test. If it fails, check the AZ (`deployer_az_suffix`) and RDS classes first.
- **IAM outside the region.** Terraform may need an IAM or CloudFront action not listed. Add the exact action, scoped to `app-*` or the tag conditions, rather than widening.
- **Origin access controls** can't be tagged, so the role may create and delete any of them (deleting one in use fails). It can't update them.
- **Memory.** A `t3.small` builds one app at a time next to the deployer, with swap as the safety net. If builds get slow or the instance swaps hard, move to a `t3.medium`.
