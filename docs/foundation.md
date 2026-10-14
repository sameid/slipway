# Foundation runbook (rollout steps 1–2)

This runbook takes an AWS account to a running platform foundation: the deployer host behind CloudFront, its IAM role, the permissions boundary for app roles, the artifacts bucket, alerts and a budget, then the Clerk applications, the GitHub App, the first release and the first admin. It covers design 11 steps 1 and 2. Step 3 (the first app) starts once this is done.

Run every command from the root of this repo. Every command block that touches AWS starts with a `# [AWS]` comment. Read those before you run them, and check `aws sts get-caller-identity` shows the right account first.

What gets created is in `foundation/*.tf` (about 17 resources); the names other components rely on are in [contracts.md](contracts.md).

**`ca-west-1` is dedicated to slipway.** The foundation uses the region's default VPC and subnets instead of building a network, and the deployer's role may do anything in the region. Outside it (IAM, CloudFront), the role is scoped tightly, because the account runs production in other regions.

**CodeBuild isn't available in `ca-west-1`**, so builds and deploys run on the deployer instance itself, in a second process called the runner (contracts.md, "Runner"). One instance runs the deployer and the runner under pm2 (pm2-logrotate rotates their logs), with Caddy in front and CloudFront in front of Caddy.

## 0. Before you start

You need:

- Terraform ≥ 1.11. Install it from HashiCorp's tap (`brew tap hashicorp/tap && brew install hashicorp/tap/terraform`); Homebrew's own formula is stuck at 1.5. The `hashicorp/terraform` Docker image works too.
- AWS CLI v2, `jq`, and the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) for the AWS CLI.
- Admin credentials for the account, exported as `AWS_PROFILE`. Not the root user.
- Owner access to the `acme` GitHub org, to create the GitHub App.
- Access to the company Clerk account.

Standing costs once applied: the deployer's `t3.small`, its 40 GB volume and Elastic IP, and the CloudFront distribution. Secrets Manager charges per secret (four). There's no NAT gateway.

```sh
export AWS_PROFILE=<admin-profile>
export AWS_REGION=ca-west-1
# [AWS] confirm which account you're about to change
aws sts get-caller-identity
```

## 1. Region availability check

`ca-west-1` is an opt-in region. Confirm everything the design uses is there before building anything (design 5.4, risks table).

```sh
# [AWS] read-only checks
aws account get-region-opt-status --region-name ca-west-1          # expect ENABLED

# The default VPC and its subnets, which the foundation and every app use
aws ec2 describe-subnets --filters Name=default-for-az,Values=true \
  --query 'Subnets[].[AvailabilityZone,SubnetId]' --output text     # one per AZ
#   none? aws ec2 create-default-vpc

# EC2: the deployer's instance type (x86_64)
aws ec2 describe-instance-type-offerings --location-type availability-zone \
  --filters Name=instance-type,Values=t3.small --query 'InstanceTypeOfferings[].Location'

# RDS: every size preset (small, medium, large) for Postgres 17. ca-west-1 has no
# db.t4g classes for Postgres, which is why the presets use db.t3.
for class in db.t3.micro db.t3.small db.t3.medium; do
  printf '%s: ' "$class"
  aws rds describe-orderable-db-instance-options --engine postgres \
    --db-instance-class "$class" \
    --query "length(OrderableDBInstanceOptions[?starts_with(EngineVersion, '17.')])"
done                                                                # > 0 for each (--engine-version needs a full version like 17.6)

# ECS Express Mode: a describe call on a service that doesn't exist should fail
# with a "not found"-style error, not "Unknown operation" or "Could not connect"
aws ecs describe-express-gateway-service \
  --service-arn "arn:aws:ecs:ca-west-1:$(aws sts get-caller-identity --query Account --output text):service/none/none" \
  || true

# Services AWS lists for the region (CodeBuild isn't one of them, hence the runner)
aws ssm get-parameters-by-path --region us-east-1 \
  --path /aws/service/global-infrastructure/regions/ca-west-1/services \
  --query 'Parameters[].Value' --output text | tr '\t' '\n' | sort \
  | grep -xE 'ecs|rds|cloudfront|ecr|ssm|secretsmanager|logs|sns|ec2|s3|elb|acm'
```

One Express service deployed in `ca-west-1` (for example the spike in `../spike`) is the real test of ECS Express Mode and Fargate. Fargate runs X86_64 here: provider 6.x's `aws_ecs_express_gateway_service` has no CPU architecture argument, so ARM/Graviton for app tasks is out of scope for now. That's also why the deployer instance is x86_64: it builds the `linux/amd64` app images.

If anything is missing, stop and adjust the design before going further.

## 2. Bootstrap the state bucket

Creates `slipway-tfstate-<account>` (versioned, encrypted, private). This one stack keeps its state locally in `foundation/bootstrap/terraform.tfstate`, which is git-ignored. Keep a copy, for example in the bucket itself (`s3://slipway-tfstate-<account>/bootstrap/terraform.tfstate`). Losing it only means re-importing the bucket.

```sh
terraform -chdir=foundation/bootstrap init
# [AWS] creates the state bucket
terraform -chdir=foundation/bootstrap apply
terraform -chdir=foundation/bootstrap output -raw backend_hcl > foundation/backend.hcl
```

## 3. Apply the foundation

```sh
cp foundation/terraform.tfvars.example foundation/terraform.tfvars   # set alert_email; adjust budget_amount
# [AWS] reads the state bucket
terraform -chdir=foundation init -backend-config=backend.hcl
# [AWS] creates the foundation; review the plan first
terraform -chdir=foundation plan -out tfplan
terraform -chdir=foundation apply tfplan
```

The first apply takes 10–20 minutes, most of it the CloudFront distribution. If it fails right after creating the IAM role with an "invalid IAM instance profile" or similar error, IAM hasn't propagated yet: run `terraform apply` again.

The budget (`slipway-ca-west-1`) counts only spend billed to `ca-west-1`. CloudFront and other global services aren't billed to a region, so they don't count towards it.

Afterwards:

1. Confirm the SNS subscription email sent to `alert_email`.
2. Note the outputs you'll need below:
   ```sh
   terraform -chdir=foundation output deployer_url          # https://dxxxx.cloudfront.net
   terraform -chdir=foundation output github_webhook_url
   terraform -chdir=foundation output deployer_instance_id
   ```
3. Give the instance about five minutes for first-boot setup (packages, swap, Docker, Node.js, pm2 and pm2-logrotate, Caddy). Then open the deployer URL: it should answer **503 "slipway deployer: no release installed yet"**. That's Caddy's placeholder, and it proves CloudFront → instance works, secret header included. A CloudFront 502/504 instead means the instance isn't answering on 8080 yet: check `/var/log/cloud-init-output.log` through Session Manager. A direct request to the instance's Elastic IP on 8080 should time out (only CloudFront's ranges may connect), and one that gets through without CloudFront's header gets 403.
4. Put the deployer URL in the plugin's `slipway.config.json` (`sameid/slipway` repo) as `deployerUrl`.

`backend.hcl` holds only the bucket name and region; commit it if you want everyone to use the same command.

## 4. Clerk applications (rollout step 2)

In the company Clerk account, create three applications (design 5.4, "Clerk setup"). Each starts with a development instance, which is what all three use until we have custom domains.

| Application | Used by |
|---|---|
| `slipway-local` | `localhost` on colleagues' laptops |
| `slipway-stage` | every app's staging |
| `slipway-production` | every app's prod |

Each Clerk application gets one Secrets Manager secret named after it, all three the same shape: `{"publishableKey": "pk_test_...", "secretKey": "sk_test_..."}`. `slipway/clerk/stage` serves every app's `staging` and `slipway/clerk/production` serves `prod`; the deploy script and the app module map each environment to its Clerk name.

For each one:

- **Sign-in options:** Google and email.
- **Restrictions → Allowlist:** only the company email domain. This runbook assumes `example.com`; change it if colleagues sign in with another domain. Check that the allowlist is available on our Clerk plan.
- **Sign-up:** open, so anyone on the allowed domain can use any app immediately.
- **Sessions → Customize session token:** add the claims below. The template's `requireUser` copies them into each app's own `users` table; without them, `email` and `name` stay empty.
  ```json
  { "email": "{{user.primary_email_address}}", "name": "{{user.full_name}}" }
  ```

Then store the keys (they aren't in Terraform). The simplest way is the AWS console in `ca-west-1`: **Secrets Manager → Store a new secret → Other type of secret → Key/value**, with two rows, `publishableKey` and `secretKey`, named `slipway/clerk/local`, `slipway/clerk/stage` and `slipway/clerk/production`. Or with the CLI, using `read -rs` so secret keys don't land in your shell history:

```sh
for name in local stage production; do
  read -r -p "slipway-$name publishable key: " PK
  read -rs -p "slipway-$name secret key: " SK; echo
  # [AWS] creates the Clerk secret for this application
  aws secretsmanager create-secret --name "slipway/clerk/$name" --tags Key=platform,Value=slipway \
    --secret-string "$(jq -n --arg pk "$PK" --arg sk "$SK" '{publishableKey: $pk, secretKey: $sk}')"
done
unset PK SK
```

To change a value later, edit the secret (console, or `aws secretsmanager put-secret-value`), then redeploy the affected environments.

The local application's secret key does reach laptops (through `GET /api/dev-config`, design 5.1). That's by design; staging and prod secret keys never leave AWS.

## 5. GitHub App `slipway-deployer`

Create it under the org: **GitHub → acme → Settings → Developer settings → GitHub Apps → New GitHub App**.

| Setting | Value |
|---|---|
| Name | `slipway-deployer` |
| Homepage URL | the deployer URL |
| Webhook URL | `<deployer URL>/webhooks/github` (`terraform -chdir=foundation output github_webhook_url`) |
| Webhook secret | `openssl rand -hex 32`; keep it for the next step |
| Repository permissions | Administration: read and write · Commit statuses: read and write · Contents: read and write · Metadata: read-only · Pull requests: read and write |
| Organization permissions | Members: read-only |
| Subscribe to events | Push · Pull request |
| Where can this app be installed? | Only on this account |

Then:

1. **Generate a private key** (downloads a `.pem`).
2. **Install App → acme → All repositories.** It must be installed on all repositories so every new app repo is covered without extra steps.
3. Store the App ID, private key and webhook secret, then delete the `.pem`:

```sh
read -rs WEBHOOK_SECRET && export WEBHOOK_SECRET
# [AWS] creates the GitHub App secret
aws secretsmanager create-secret --name slipway/github-app --tags Key=platform,Value=slipway \
  --secret-string "$(
  jq -n --arg appId '<App ID>' --rawfile privateKey ./slipway-deployer.*.private-key.pem \
        --arg webhookSecret "$WEBHOOK_SECRET" \
        '{appId: $appId, privateKey: $privateKey, webhookSecret: $webhookSecret}')"
unset WEBHOOK_SECRET
rm ./slipway-deployer.*.private-key.pem
```

GitHub will show failed webhook deliveries until the deployer is running (step 6). That's fine: the deployer catches up on startup.

## 6. Release the platform

One release carries everything that runs on the instance: the deployer, the runner, the job scripts (`jobs/`) and the per-app modules (`modules/`), plus `ecosystem.config.cjs` and the `Caddyfile` (contracts.md, "Deployer host").

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
sudo /opt/slipway/bin/create-admin --email you@example.com --name "Your Name"   # prints a temporary password
```

The wrapper runs the current release's `deployer/dist/scripts/create-admin.js` as the `slipway` user with the deployer's environment. Sign in at the deployer URL; you'll be asked to change the password. Create everyone else's accounts from the dashboard's Users page.

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

Then go on to rollout step 3: the template, one app by hand, and signing in on staging and prod.

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

**Network.** The instance sits in a default subnet with an Elastic IP on its own network interface, so CloudFront's origin (the Elastic IP's public DNS name) survives instance replacements. Its security group admits only CloudFront's origin-facing ranges on 8080, and Caddy turns away anything without the secret `X-Slipway-Origin` header that only our distribution sends, which keeps other CloudFront distributions out too. Viewers get HTTPS from CloudFront; the hop from CloudFront to the instance is plain HTTP over AWS's network and the internet. That hop carries dashboard passwords and colleagues' GitHub tokens, which was an explicit trade-off for not running a NAT gateway and private subnet.

**pm2.** `sudo pm2 ls`, `sudo pm2 logs runner`, `sudo pm2 logs deployer --lines 200`, `sudo pm2 restart deployer`. Logs are in `/root/.pm2/logs/` (rotated daily, 14 days). `/usr/local/bin/pm2` is a wrapper that always talks to root's pm2 daemon. pm2 starts each process with only its user's primary group, so access is arranged through owners and primary groups: the runner's socket directory is setgid group `slipway`, and Docker's socket belongs to group `slipway-runner`.

**Caddy.** `systemctl status caddy`, `journalctl -u caddy`. `sudo systemctl reload caddy` after editing `/etc/caddy/Caddyfile` by hand (the next release overwrites it). Caddy refuses to start if `/etc/slipway/caddy.env` has no origin secret. Its admin API listens on `localhost:2019`; the firewall keeps the build user and containers away from it.

**The runner.** Each run has a directory in `/var/lib/slipway-runner/runs/<id>/` with its `log`, so `sudo tail -f /var/lib/slipway-runner/runs/<id>/log` follows a build. At most `RUNNER_MAX_BUILDS` builds (default 1) and `RUNNER_MAX_DEPLOYS` deploys (default 2) run at once; change them in `terraform.tfvars` (`runner_max_builds`, `runner_max_deploys`) or in `/etc/slipway/runner.env` followed by `sudo pm2 restart runner --update-env`. The instance has 2 GB of memory and a 4 GB swap file; raise the builds limit only on a bigger instance.

**Permissions, isolation, and what changed from design 7.** The instance role (`slipway-deployer`) is used directly by the deployer and the runner. It may do anything in `ca-west-1`, which is dedicated to slipway. Outside the region it can only:

- manage IAM roles named `app-*` that carry the `slipway-boundary` permissions boundary, and pass them to ECS;
- create CloudFront distributions, and change or delete only those tagged `platform=slipway` with an `app` tag (the deployer's own has no `app` tag);
- create CloudFront functions named `app-*` and origin access controls.

IAM and STS are excluded even inside the region, so the box can't assume other roles in the account.

Untrusted build steps (anything that executes app code: `npm ci`, type check, lint, tests, the frontend build) run as `slipway-build`. That user can't reach the instance metadata service, so it has no AWS credentials; it can't reach the deployer, Caddy or Caddy's admin API; and it can't read the deployer's data or the runner's other runs. Docker build steps run in containers with no host mounts, and the metadata hop limit of 1 keeps them away from credentials.

Design 7 said "the deployer, the most exposed component, holds the least AWS power" because CodeBuild held the deploy permissions in a separate sandbox. That no longer holds: the deployer host now holds them, and it can also read app secret values. Isolation rests on `slipway-build` having no credentials and on the deployer itself not being compromised. Update design 7 to match.

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

## Known uncertainties

- **The GitHub App can reach every repo in the org.** Installing `slipway-deployer` on all repositories also covers every other repo in the org. Narrowing it is planned (design, "Changes since Draft v7", item 9). Until then, treat the deployer instance and the `slipway/github-app` secret as having write access to all of `acme`.

Things this config couldn't verify without running it. Check each during rollout steps 1 and 3 and fix the Terraform or this runbook:

- **CloudFront tag conditions.** Changing or deleting a distribution requires `aws:ResourceTag/platform = slipway` and an `app` tag. If creating a distribution with tags (`CreateDistributionWithTags`) also checks `cloudfront:TagResource` against the not-yet-existing resource, the first app deploy fails with AccessDenied on TagResource. The fix is a narrow `TagResource` allowance conditioned on `aws:RequestTag/platform`. That would also let the box tag other distributions, so look for a better option first.
- **IAM outside the region.** Terraform may need an IAM or CloudFront action not listed. Add the exact action, scoped to `app-*` or the tag conditions, rather than widening.
- **Origin access controls** can't be tagged, so the role may create and delete any of them (deleting one in use fails). It can't update them.
- **npm install scripts.** The deployer's native dependencies (`better-sqlite3`, `argon2`) must install from prebuilt linux-x64 binaries during `npm ci --omit=dev` on the box; the instance has no compiler.
- **Memory.** A `t3.small` builds one app at a time next to the deployer, with swap as the safety net. If builds get slow or the instance swaps hard, move to a `t3.medium`.
- **Clerk allowlist** availability on the company's Clerk plan.
