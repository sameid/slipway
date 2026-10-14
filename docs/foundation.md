# Foundation runbook: self-hosting slipway

This runbook takes your own AWS account and your own GitHub org or personal account to a running slipway: the deployer host behind CloudFront, its IAM role, the permissions boundary for app roles, the artifacts bucket, alerts and a budget, then your Clerk applications, your GitHub App, the first release, the first admin, and the plugin on colleagues' laptops. It covers design 11 steps 1 and 2. Step 3 (the first app) starts once this is done.

Run every command from the root of this repo. Every command block that touches AWS starts with a `# [AWS]` comment. Read those before you run them, and check `aws sts get-caller-identity` shows the right account first.

What gets created is in `foundation/*.tf` (about 17 resources); the names other components rely on are in [contracts.md](contracts.md).

**The region is dedicated to slipway.** The foundation uses the region's default VPC and subnets instead of building a network, and the deployer's role may do anything in the region. Don't run anything else there. A separate AWS account just for slipway is best. Outside the region (IAM, CloudFront), the role is scoped tightly.

**There's no CodeBuild.** Builds and deploys run on the deployer instance itself, in a second process called the runner (contracts.md, "Runner"). That keeps the platform to one instance and works in every region. The instance runs the deployer and the runner under pm2 (pm2-logrotate rotates their logs), with Caddy in front and CloudFront in front of Caddy.

## 0. Before you start

### Choose where it runs

- **AWS account and region.** Any region where the checks in step 1 pass. The region is slipway's alone.
- **GitHub owner.** Every app repo is created under one GitHub org or personal account (`github_owner`). The deployer's GitHub App is installed on all of that owner's repositories and can write to every one of them, so use an org or account that holds only slipway apps.

| | Org | Personal account |
|---|---|---|
| Who may use the plugin | members of the org | you, plus the logins in `github_allowed_users` |
| Who can run `/new-app` | members allowed to create repos in the org | only you: nobody else can create repos in your account. Allowed users need write access to each app repo (add them as collaborators) to `/ship` |
| Merging into `main` | only the deployer's App (push restrictions) | anyone with write access, once the check passes: GitHub has no push restrictions for personal repos |
| `CODEOWNERS` default | the app's creator; set `github_codeowners` to a team instead, e.g. `@your-org/platform` | you |

**GitHub Free can't protect private repos.** On Free, registering an app still succeeds, but the deployer can't set branch protection on `main` and `/new-app` prints a warning. A direct push to `main` then deploys to staging without the check. GitHub Pro (personal) or Team (org) removes the limit; on Free, only change `main` through PRs.

### Tools and access

- Terraform ≥ 1.11. Install it from HashiCorp's tap (`brew tap hashicorp/tap && brew install hashicorp/tap/terraform`); Homebrew's own formula is stuck at 1.5. The `hashicorp/terraform` Docker image works too.
- AWS CLI v2, `jq`, and the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) for the AWS CLI.
- Admin credentials for the account, exported as `AWS_PROFILE`. Not the root user.
- Owner access to the GitHub org (or your personal account), to create the GitHub App.
- A [Clerk](https://clerk.com) account.

Standing costs once applied: the deployer's `t3.small`, its 40 GB volume and Elastic IP, and the CloudFront distribution. Secrets Manager charges per secret (three or four). There's no NAT gateway.

```sh
export AWS_PROFILE=<admin-profile>
export AWS_REGION=<region>        # dedicated to slipway; every later step uses it
# [AWS] confirm which account you're about to change
aws sts get-caller-identity
```

## 1. Region availability check

Confirm everything the design uses is in your region before building anything (design 5.4, risks table).

```sh
# [AWS] read-only checks

# Opt-in regions only (most newer regions): expect ENABLED or ENABLED_BY_DEFAULT
aws account get-region-opt-status --region-name "$AWS_REGION"

# The default VPC and its subnets, which the foundation and every app use
aws ec2 describe-subnets --filters Name=default-for-az,Values=true \
  --query 'Subnets[].[AvailabilityZone,SubnetId]' --output text     # one per AZ
#   none? aws ec2 create-default-vpc

# EC2: the deployer's instance type (x86_64), and which AZs offer it.
# deployer_az_suffix (default "a") must be one of them.
aws ec2 describe-instance-type-offerings --location-type availability-zone \
  --filters Name=instance-type,Values=t3.small --query 'InstanceTypeOfferings[].Location'

# RDS: every size preset (small, medium, large) for Postgres 17. The presets use
# db.t3 because some regions (ca-west-1, for one) have no db.t4g classes for Postgres.
for class in db.t3.micro db.t3.small db.t3.medium; do
  printf '%s: ' "$class"
  aws rds describe-orderable-db-instance-options --engine postgres \
    --db-instance-class "$class" \
    --query "length(OrderableDBInstanceOptions[?starts_with(EngineVersion, '17.')])"
done                                                                # > 0 for each (--engine-version needs a full version like 17.6)

# ECS Express Mode: a describe call on a service that doesn't exist should fail
# with a "not found"-style error, not "Unknown operation" or "Could not connect"
aws ecs describe-express-gateway-service \
  --service-arn "arn:aws:ecs:$AWS_REGION:$(aws sts get-caller-identity --query Account --output text):service/none/none" \
  || true

# Services AWS lists for the region: expect all ten
aws ssm get-parameters-by-path --region us-east-1 \
  --path "/aws/service/global-infrastructure/regions/$AWS_REGION/services" \
  --query 'Parameters[].Value' --output text | tr '\t' '\n' | sort \
  | grep -xE 'ecs|rds|ecr|ssm|secretsmanager|logs|sns|ec2|s3|elb'
```

The first app's deploy (design 11 step 3) is the real test of ECS Express Mode and Fargate in your region. App tasks run X86_64: provider 6.x's `aws_ecs_express_gateway_service` has no CPU architecture argument, so ARM/Graviton for app tasks is out of scope for now. That's also why the deployer instance is x86_64: it builds the `linux/amd64` app images.

If anything is missing, pick another region.

## 2. Bootstrap the state bucket

Creates `slipway-tfstate-<account>` (versioned, encrypted, private) in your region. This one stack keeps its state locally in `foundation/bootstrap/terraform.tfstate`, which is git-ignored. Keep a copy, for example in the bucket itself (`s3://slipway-tfstate-<account>/bootstrap/terraform.tfstate`). Losing it only means re-importing the bucket.

```sh
terraform -chdir=foundation/bootstrap init
# [AWS] creates the state bucket
terraform -chdir=foundation/bootstrap apply -var "region=$AWS_REGION"
terraform -chdir=foundation/bootstrap output -raw backend_hcl > foundation/backend.hcl
```

`backend.hcl` holds the bucket name (which includes your account ID) and the region. It's git-ignored.

## 3. Apply the foundation

```sh
cp foundation/terraform.tfvars.example foundation/terraform.tfvars
```

Edit `foundation/terraform.tfvars`:

| Variable | |
|---|---|
| `region` | required; the same region as `$AWS_REGION` |
| `github_owner` | required; the org or personal account that owns app repos |
| `alert_email` | required; deployer alerts and budget alerts |
| `github_allowed_users` | personal accounts only: other logins allowed to use the plugin (default none) |
| `github_codeowners` | `CODEOWNERS` entry for platform-owned files in new apps (default: you on a personal account, the app's creator in an org) |
| `budget_amount` | monthly AWS Budgets limit in USD for the region (default 500) |

```sh
# [AWS] reads the state bucket
terraform -chdir=foundation init -backend-config=backend.hcl
# [AWS] creates the foundation; review the plan first
terraform -chdir=foundation plan -out tfplan
terraform -chdir=foundation apply tfplan
```

The first apply takes 10–20 minutes, most of it the CloudFront distribution. If it fails right after creating the IAM role with an "invalid IAM instance profile" or similar error, IAM hasn't propagated yet: run `terraform apply` again.

The budget (`slipway-<region>`) counts only spend billed to the region. CloudFront and other global services aren't billed to a region, so they don't count towards it.

Afterwards:

1. Confirm the SNS subscription email sent to `alert_email`.
2. Note the outputs you'll need below:
   ```sh
   terraform -chdir=foundation output deployer_url          # https://dxxxx.cloudfront.net
   terraform -chdir=foundation output github_webhook_url
   terraform -chdir=foundation output deployer_instance_id
   ```
3. Give the instance about five minutes for first-boot setup (packages, swap, Docker, Node.js, pm2 and pm2-logrotate, Caddy). Then open the deployer URL: it should answer **503 "slipway deployer: no release installed yet"**. That's Caddy's placeholder, and it proves CloudFront → instance works, secret header included. A CloudFront 502/504 instead means the instance isn't answering on 8080 yet: check `/var/log/cloud-init-output.log` through Session Manager. A direct request to the instance's Elastic IP on 8080 should time out (only CloudFront's ranges may connect), and one that gets through without CloudFront's header gets 403.

**Changing a GitHub setting later.** `github_owner`, `github_allowed_users` and `github_codeowners` reach the deployer through user data, which only runs on first boot, so `terraform apply` with a new value **replaces the instance** (and, until backups exist, its database: see "Replacing the instance" below). To change one without that, edit `/etc/slipway/deployer.env` on the instance (`GITHUB_OWNER`, `GITHUB_ALLOWED_USERS` as a comma-separated list, `GITHUB_CODEOWNERS`), run `sudo pm2 startOrReload /opt/slipway/current/ecosystem.config.cjs --only deployer --update-env && sudo pm2 save`, and put the same value in `terraform.tfvars` only when you next replace the instance on purpose.

## 4. Clerk applications (rollout step 2)

Sign-in for every app is Clerk's. In your Clerk account, create these applications (design 5.4, "Clerk setup"). The names are up to you; the ones below match the secret names. Each starts with a development instance, which is fine until you add custom domains.

| Application | Secret | Used by |
|---|---|---|
| `slipway-stage` | `slipway/clerk/stage` | every app's staging |
| `slipway-production` | `slipway/clerk/production` | every app's prod |
| `slipway-local` (optional) | `slipway/clerk/local` | only `GET /api/dev-config`, which the current plugin doesn't use (apps aren't run locally) |

Each secret has the same shape: `{"publishableKey": "pk_test_...", "secretKey": "sk_test_..."}`. The deploy script and the app module map each environment to its Clerk name.

For each application:

- **Sign-in options:** for example Google and email.
- **Who may sign in** is decided in Clerk, not by slipway. Use **Restrictions → Allowlist** with your own email domain or a list of addresses (check that your Clerk plan includes it), or leave sign-up open for public apps.
- **Sign-up:** open, so anyone allowed can use any app immediately.
- **Sessions → Customize session token:** add the claims below. The template's `requireUser` copies them into each app's own `users` table; without them, `email` and `name` stay empty.
  ```json
  { "email": "{{user.primary_email_address}}", "name": "{{user.full_name}}" }
  ```

Then store the keys (they aren't in Terraform). The simplest way is the AWS console in your region: **Secrets Manager → Store a new secret → Other type of secret → Key/value**, with two rows, `publishableKey` and `secretKey`, named `slipway/clerk/stage` and `slipway/clerk/production` (and `slipway/clerk/local` if you made it). Or with the CLI, using `read -rs` so secret keys don't land in your shell history:

```sh
for name in stage production; do      # add local if you created it
  read -r -p "slipway-$name publishable key: " PK
  read -rs -p "slipway-$name secret key: " SK; echo
  # [AWS] creates the Clerk secret for this application
  aws secretsmanager create-secret --name "slipway/clerk/$name" --tags Key=platform,Value=slipway \
    --secret-string "$(jq -n --arg pk "$PK" --arg sk "$SK" '{publishableKey: $pk, secretKey: $sk}')"
done
unset PK SK
```

To change a value later, edit the secret (console, or `aws secretsmanager put-secret-value`), then redeploy the affected environments.

If you do create the local application, its secret key reaches laptops through `GET /api/dev-config` (design 5.1). Staging and prod secret keys never leave AWS.

## 5. Your GitHub App

GitHub App names are unique across GitHub, so pick your own, for example `slipway-<owner>`. The deployer asks GitHub for its App's name, so nothing else needs to know it.

Create it under the owner you set as `github_owner`:

- **Org:** **GitHub → your org → Settings → Developer settings → GitHub Apps → New GitHub App**.
- **Personal account:** **GitHub → your profile picture → Settings → Developer settings → GitHub Apps → New GitHub App**.

| Setting | Value |
|---|---|
| Name | yours, e.g. `slipway-<owner>` |
| Homepage URL | the deployer URL |
| Webhook URL | `<deployer URL>/webhooks/github` (`terraform -chdir=foundation output github_webhook_url`) |
| Webhook secret | `openssl rand -hex 32`; keep it for the next step |
| Repository permissions | Administration: read and write · Commit statuses: read and write · Contents: read and write · Metadata: read-only · Pull requests: read and write |
| Organization permissions | Members: read-only (orgs only; a personal account has none to set) |
| Subscribe to events | Push · Pull request |
| Where can this app be installed? | Only on this account |

Then:

1. **Generate a private key** (downloads a `.pem`).
2. **Install App → your org or account → All repositories.** It must be installed on all repositories so every new app repo is covered without extra steps. That's also why the owner should hold only slipway apps.
3. Store the App ID, private key and webhook secret, then delete the `.pem`:

```sh
read -rs WEBHOOK_SECRET && export WEBHOOK_SECRET
# [AWS] creates the GitHub App secret
aws secretsmanager create-secret --name slipway/github-app --tags Key=platform,Value=slipway \
  --secret-string "$(
  jq -n --arg appId '<App ID>' --rawfile privateKey ./<app-name>.*.private-key.pem \
        --arg webhookSecret "$WEBHOOK_SECRET" \
        '{appId: $appId, privateKey: $privateKey, webhookSecret: $webhookSecret}')"
unset WEBHOOK_SECRET
rm ./<app-name>.*.private-key.pem
```

GitHub will show failed webhook deliveries until the deployer is running (step 6). That's fine: the deployer catches up on startup.

## 6. Release the platform

One release carries everything that runs on the instance: the deployer, the runner, the job scripts (`jobs/`) and the per-app modules (`modules/`), plus `ecosystem.config.cjs` and the `Caddyfile` (contracts.md, "Deployer host"). `release.sh` needs `AWS_REGION` (from step 0) and shows the account and region before it asks for `yes`.

```sh
# [AWS] uploads s3://slipway-artifacts-<account>/deployer/<version>.tgz, creates or
# updates /slipway/deployer/version, and runs /opt/slipway/bin/update-deployer.sh
# on the instance through SSM
deployer/scripts/release.sh <version>
```

On the instance, `update-deployer.sh`:

1. downloads the release and runs `npm ci --omit=dev` in `deployer/` and `jobs/`;
2. installs the Terraform and gitleaks versions pinned in the release's `jobs/versions.env` into `/usr/local/bin` (a release can bring its own `jobs/install-tools.sh` instead);
3. installs the release's `Caddyfile` (validated with the origin secret loaded);
4. points `/opt/slipway/current` at the release, reloads Caddy, and runs `pm2 startOrReload ecosystem.config.cjs` and `pm2 save`.

It keeps the last three releases. Before the first release, `/slipway/deployer/version` doesn't exist and the script installs nothing. If you ever need to run it by hand:

```sh
# [AWS] runs the update script on the deployer instance
aws ssm send-command --document-name AWS-RunShellScript \
  --instance-ids "$(terraform -chdir=foundation output -raw deployer_instance_id)" \
  --parameters 'commands=["/opt/slipway/bin/update-deployer.sh"]' \
  --query 'Command.CommandId' --output text
```

Releasing restarts the runner, which waits for running builds and deploys to finish first (up to 14 minutes) and fails any that don't. Check the dashboard is idle before releasing. A deploy killed mid-Terraform can leave a state lock (`apps/<app>/<env>.tfstate.tflock` in the state bucket) that the next deploy of that environment trips over; delete the lock file once you're sure nothing is running.

## 7. Create the first admin

```sh
# [AWS] opens a shell on the deployer through Session Manager (no SSH)
aws ssm start-session --target "$(terraform -chdir=foundation output -raw deployer_instance_id)"
```

On the instance:

```sh
sudo /opt/slipway/bin/create-admin --email <your email> --name "Your Name"   # prints a temporary password
```

The wrapper runs the current release's `deployer/dist/scripts/create-admin.js` as the `slipway` user with the deployer's environment. Sign in at the deployer URL; you'll be asked to change the password. Create everyone else's accounts from the dashboard's Users page. Dashboard accounts are separate from GitHub: they're for people who promote to prod, confirm teardowns and watch jobs.

## 8. Check it end to end

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

## 9. Connect the plugin

Nobody needs to fork the plugin. Each colleague needs Claude Code, Node.js 24 and the GitHub CLI signed in (`gh auth login`) as a member of the org, or as you or an allowed user on a personal account. Then, in Claude Code:

```
/plugin marketplace add sameid/slipway
/plugin install slipway@slipway
/setup https://dxxxx.cloudfront.net
```

`/setup` takes the `deployer_url` output, runs `slipway setup --deployer-url <url>`, saves it in `~/.config/slipway/config.json` (or `$XDG_CONFIG_HOME/slipway/config.json`), and checks it: it prints who you're signed in as and the account new apps are created under. `SLIPWAY_DEPLOYER_URL` overrides the saved URL.

A team that would rather not have everyone run `/setup` can fork the repo, set `deployerUrl` in `plugin/slipway.config.json`, and add their fork as the marketplace instead. The saved URL and `SLIPWAY_DEPLOYER_URL` still win over it.

Then go on to rollout step 3: `/new-app`, one app by hand, and signing in on staging and prod.

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

**The runner.** Each run has a directory in `/var/lib/slipway-runner/runs/<id>/` with its `log`, so `sudo tail -f /var/lib/slipway-runner/runs/<id>/log` follows a build. At most `RUNNER_MAX_BUILDS` builds (default 1) and `RUNNER_MAX_DEPLOYS` deploys (default 2) run at once; change them in `terraform.tfvars` (`runner_max_builds`, `runner_max_deploys`; that replaces the instance) or in `/etc/slipway/runner.env` followed by `sudo pm2 startOrReload /opt/slipway/current/ecosystem.config.cjs --only runner --update-env && sudo pm2 save` (pm2 re-reads the env files only through the ecosystem file). The instance has 2 GB of memory and a 4 GB swap file; raise the builds limit only on a bigger instance.

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
terraform -chdir=foundation apply -replace=aws_instance.deployer
```

The network interface, Elastic IP and CloudFront distribution stay as they are.

**Updating tools.** Node.js, pm2, pm2-logrotate and Caddy are pinned in `foundation/variables.tf` (`node_version`/`node_sha256`, `pm2_version`, `pm2_logrotate_version`, `caddy_version`/`caddy_sha512`; checksums from `SHASUMS256.txt` on nodejs.org and the Caddy GitHub release). Change them in `terraform.tfvars`, then replace the instance as above. Terraform and gitleaks are pinned in `jobs/versions.env` and arrive with the next release, without replacing anything.

## Known limits and things to check

- **The GitHub App can reach every repo of the owner.** Installing it on all repositories covers every other repo there too. Use an org or account that holds only slipway apps; otherwise treat the deployer instance and the `slipway/github-app` secret as having write access to all of the owner's repos. Narrowing it is a possible follow-up (design, "Changes since Draft v7", item 9).
- **GitHub Free** can't protect private repos: see step 0.
- **Regions.** The first deployment ran in `ca-west-1`. Other regions should work if step 1 passes, but the first app's deploy is the real test. If it fails, check the AZ (`deployer_az_suffix`) and RDS classes first.
- **IAM outside the region.** Terraform may need an IAM or CloudFront action not listed. Add the exact action, scoped to `app-*` or the tag conditions, rather than widening.
- **Origin access controls** can't be tagged, so the role may create and delete any of them (deleting one in use fails). It can't update them.
- **Memory.** A `t3.small` builds one app at a time next to the deployer, with swap as the safety net. If builds get slow or the instance swaps hard, move to a `t3.medium`.
- **Clerk allowlist** availability on your Clerk plan.
