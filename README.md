# slipway

A self-hosted platform for internal apps built with Claude Code. A colleague runs `/new-app` in Claude Code and gets a GitHub repo and a live staging link with working sign-in a few minutes later. After that they describe features, and `/ship` opens a pull request that merges and deploys to staging once its check passes. A person promotes staging to prod from the deployer dashboard.

You bring the accounts: slipway runs in **your AWS account**, creates app repos under **your GitHub org or personal account**, and signs users in with **your Clerk applications**. Colleagues need no AWS credentials; the plugin only uses the GitHub CLI and the deployer's API.

Every app gets a staging and a prod environment: Postgres on RDS, an API on ECS Express Mode (Fargate), and a frontend on S3 and CloudFront. App repos hold no Terraform and no build scripts, so nothing an agent changes in an app can change how its infrastructure is built.

## What you need

- **An AWS account and a region dedicated to slipway.** The deployer's instance role may do anything in that region (outside it, it's limited to slipway's own IAM roles and CloudFront distributions), so don't share the region with anything else. A separate AWS account is best. The region must offer ECS Express Mode. `docs/foundation.md` has the checks to run first.
- **A GitHub org or personal account** for the app repos, where you can create a GitHub App. The App is installed on every repo of that owner and can write to them, so use an owner that holds only slipway apps.
  - In an org, its members can use slipway. On a personal account, you can, plus anyone you list in `github_allowed_users`, but only you can create apps.
  - GitHub Free can't protect branches of private repos. Apps still work, but `main` isn't protected, so a direct push deploys to staging without the check. GitHub Pro or Team fixes that.
- **A Clerk account** with three applications (local, staging and prod). Who may sign in to apps (your email domain, say) is set in Clerk.
- **Tools:** Terraform 1.11 or later (or Docker with the `hashicorp/terraform` image), the AWS CLI, Node.js 24 and the GitHub CLI.
- **A budget.** The foundation is one `t3.small`, an Elastic IP, a CloudFront distribution and two buckets. Each app environment adds its own RDS instance, ECS Express Mode service (Fargate behind a load balancer) and CloudFront distribution. The foundation sets an AWS Budget for the region (default $500 a month) that emails you at 80% and at the 100% forecast.

## Set it up

`docs/foundation.md` is the full runbook. In short:

1. Create the Terraform state bucket: `foundation/bootstrap` with `-var region=<region>`.
2. Copy `foundation/terraform.tfvars.example` to `terraform.tfvars`. Set `region`, `github_owner` and `alert_email`, and apply `foundation/`.
3. Create the GitHub App on your org or account and your Clerk applications, and store their keys in Secrets Manager (`slipway/github-app`, `slipway/clerk/{local,stage,production}`).
4. Release the deployer: `AWS_REGION=<region> deployer/scripts/release.sh`. Then create your dashboard account.
5. Each colleague installs the plugin and points it at your deployer:

   ```
   /plugin marketplace add sameid/slipway
   /plugin install slipway@slipway
   /setup https://dxxxx.cloudfront.net
   ```

   The URL is the foundation's `deployer_url` output. Then `/new-app`.

Every script that talks to AWS shows the account it's about to use and asks for confirmation first.

## Layout

```
plugin/              the Claude Code plugin (/setup, /new-app, /ship, /status, /secret, /destroy-app)
                     and the app template; .claude-plugin/marketplace.json at the root lists it
foundation/          shared infrastructure in your region (~17 resources): deployer instance, CloudFront,
                     IAM, artifacts bucket, alerts topic, budget
  bootstrap/         creates the Terraform state bucket (local state)
modules/
  app-shared/        per-app ECR repository and log group
  app-env/           one app environment: RDS, ECS Express service, migrate task, S3 + CloudFront
jobs/                build-release.sh and deploy-env.sh, run by the runner on the deployer instance
deployer/            the deployer (dashboard, plugin API, GitHub webhooks, job worker) and the runner
docs/
  foundation.md      runbook: foundation, GitHub App, Clerk, secrets, first release, plugin setup
  contracts.md       names, conventions, API shapes and job inputs shared between the pieces
  design.md          the original design doc, with "Changes since Draft v7"
```

## How the pieces fit

1. The plugin creates an app repo from its template under your GitHub owner and registers it with the deployer.
2. The deployer reacts to GitHub webhooks and queues jobs. For each job it hands the runner (a second process on the same instance, over a Unix socket) either the commit's zipball for a build or the inputs for a deploy.
3. The runner runs `jobs/build-release.sh` or `jobs/deploy-env.sh`. Steps that execute app code run as a separate Linux user with no AWS credentials. `deploy-env` renders a Terraform root config for the app and environment from `app.yaml` and applies `modules/app-env`.

The deployer, the runner, `jobs/` and `modules/` ship together as one release (`deployer/scripts/release.sh`). Changing build or deploy behaviour means releasing a new version. Builds run on the deployer instance rather than in CodeBuild, which keeps the platform to one instance and works in every region.

## Development

```sh
(cd plugin && npm test)                 # CLI and hook tests, no dependencies
(cd jobs && npm ci && npm test)         # app.yaml rendering
(cd deployer && npm ci && npm run typecheck && npm test)
```

The deployer has a fake mode (`DEPLOYER_FAKE=1`) with an in-memory GitHub and a simulated runner, so the plugin and the deployer can be run end to end on a laptop (`deployer/README.md`). Interfaces between the pieces are pinned in `docs/contracts.md`; change both sides in the same PR.

## License

MIT. See `LICENSE`.
