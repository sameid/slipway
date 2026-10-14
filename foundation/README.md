# foundation

The shared platform infrastructure, created once per AWS account by whoever runs slipway (design 5.4). The region you pick (`region` in `terraform.tfvars`) is dedicated to slipway, so this stack uses what the region already has (the default VPC and its subnets) and adds little:

| File | Creates |
|---|---|
| `deployer.tf` | the deployer host (x86_64 `t3.small` with an Elastic IP), its security group, and the CloudFront distribution in front of it |
| `iam.tf` | the instance role, the `slipway-boundary` permissions boundary for app roles, and the shared ECS Express infrastructure role |
| `alerts.tf` | the `slipway-alerts` SNS topic and email subscription, and the budget for the region |
| `main.tf` | the `slipway-artifacts-<account>` bucket (releases and the deployer's backups) |

About 17 resources. There's no CodeBuild: the instance runs the deployer and the runner (builds and deploys) under pm2, which also rotates their logs, with Caddy in front. That keeps the platform to one instance and works in every region. Untrusted build steps run as a separate user with no AWS credentials.

The instance role may do anything in the region, so don't run anything else there; a separate AWS account just for slipway is best. Outside the region it's limited to IAM roles named `app-*` (which must carry the boundary) and CloudFront distributions tagged as slipway apps.

Inputs (see `terraform.tfvars.example`): `region`, `github_owner` (the GitHub org or personal account that owns app repos) and `alert_email` are required. `github_allowed_users`, `github_codeowners`, `budget_amount` and the instance settings are optional.

Not here on purpose: secrets and Clerk keys. You create them with the CLI once the values exist. The release version parameter is created by `deployer/scripts/release.sh`.

- `bootstrap/` creates the Terraform state bucket (local state, run once; it needs `region` too).
- `templates/user-data.sh.tftpl` and `files/` set up the instance on first boot; `files/update-deployer.sh` installs each platform release.

How to apply it, operate the host, and what to do afterwards (Clerk, GitHub App, first release, first admin, plugin setup) is in [docs/foundation.md](../docs/foundation.md). The names other components rely on are in [docs/contracts.md](../docs/contracts.md).
