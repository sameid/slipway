# foundation

The shared platform infrastructure, created once per AWS account by `slipway setup` (design 5.4). The region you pick (`--region`) is dedicated to slipway, so this stack uses what the region already has (the default VPC and its subnets) and adds little:

| File | Creates |
|---|---|
| `deployer.tf` | the deployer host (x86_64 `t3.small` with an Elastic IP), its security group, and the CloudFront distribution in front of it |
| `iam.tf` | the instance role, the `slipway-boundary` permissions boundary for app roles, and the shared ECS Express infrastructure role |
| `alerts.tf` | the `slipway-alerts` SNS topic and email subscription, and the budget for the region |
| `main.tf` | the `slipway-artifacts-<account>` bucket (releases and the deployer's backups) |

About 17 resources. There's no CodeBuild: the instance runs the deployer and the runner (builds and deploys) under pm2, which also rotates their logs, with Caddy in front. That keeps the platform to one instance and works in every region. Untrusted build steps run as a separate user with no AWS credentials.

The instance role may do anything in the region, so don't run anything else there; a separate AWS account just for slipway is best. Outside the region it's limited to IAM roles named `app-*` (which must carry the boundary) and CloudFront distributions tagged as slipway apps.

Inputs are in `variables.tf`. `slipway setup` sets `region`, `github_owner` (the GitHub org or personal account that owns app repos), `alert_email` and `deployer_az_suffix`, and `budget_amount`, `github_allowed_users` and `github_codeowners` when you pass them. It keeps them in `s3://slipway-tfstate-<account>/foundation/terraform.tfvars.json`, next to the state, and applies this stack from a copy in `~/.cache/slipway/`. The instance settings keep their defaults.

Not here on purpose: the state bucket and the GitHub App's keys (`slipway/github-app`), which `slipway setup` creates with the AWS CLI, and the release version parameter, which `deployer/scripts/release.sh` creates.

- `templates/user-data.sh.tftpl` and `files/` set up the instance on first boot; `files/update-deployer.sh` installs each platform release. They're user data, so changing them replaces the instance (`slipway setup` refuses to without `--allow-replace`).

What setup does step by step, how to operate the host, and how to run this stack by hand are in [docs/foundation.md](../docs/foundation.md). The names other components rely on are in [docs/contracts.md](../docs/contracts.md).
