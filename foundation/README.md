# foundation

The shared platform infrastructure, created once per account by the dev team (design 5.4). `ca-west-1` is dedicated to slipway, so this stack uses what the region already has (the default VPC and its subnets) and adds little:

| File | Creates |
|---|---|
| `deployer.tf` | the deployer host (x86_64 `t3.small` with an Elastic IP), its security group, and the CloudFront distribution in front of it |
| `iam.tf` | the instance role, the `slipway-boundary` permissions boundary for app roles, and the shared ECS Express infrastructure role |
| `alerts.tf` | the `slipway-alerts` SNS topic and email subscription, and the budget for `ca-west-1` |
| `main.tf` | the `slipway-artifacts-<account>` bucket (releases and the deployer's backups) |

About 17 resources. CodeBuild isn't available in `ca-west-1`, so the instance runs the deployer and the runner (builds and deploys) under pm2, which also rotates their logs, with Caddy in front. Untrusted build steps run as a separate user with no AWS credentials.

The instance role may do anything in `ca-west-1`. Outside the region it's limited to IAM roles named `app-*` (which must carry the boundary) and CloudFront distributions tagged as slipway apps, because the account runs production elsewhere.

Not here on purpose: secrets and Clerk keys. The dev team creates them with the CLI once the values exist. The release version parameter is created by `deployer/scripts/release.sh`.

- `bootstrap/` creates the Terraform state bucket (local state, run once).
- `templates/user-data.sh.tftpl` and `files/` set up the instance on first boot; `files/update-deployer.sh` installs each platform release.

How to apply it, operate the host, and what to do afterwards (Clerk, GitHub App, first release, first admin) is in [docs/foundation.md](../docs/foundation.md). The names other components rely on are in [docs/contracts.md](../docs/contracts.md).
