# slipway

Claude Code builds internal apps; slipway runs them. The platform side is the small AWS foundation, the per-app Terraform modules, the build and deploy job scripts, and the deployer. Colleagues never touch this repo; their apps hold no Terraform and no build scripts (see `docs/design.md`).

```
plugin/              the Claude Code plugin (/new-app, /ship, /status, /secret, /destroy-app) and app templates
foundation/          shared infrastructure in ca-west-1 (~17 resources): deployer instance, CloudFront,
                     IAM, artifacts bucket, alerts topic, budget
  bootstrap/         creates the Terraform state bucket (local state)
modules/
  app-shared/        per-app ECR repository and log group
  app-env/           one app environment: RDS, ECS Express service, migrate task, S3 + CloudFront
jobs/                build-release.sh and deploy-env.sh, run by the runner on the deployer instance
deployer/            the deployer (dashboard, plugin API, GitHub webhooks, job worker) and the runner
docs/
  design.md          the design doc (source of truth; see "Changes since Draft v7")
  contracts.md       names, conventions, API shapes and job inputs shared between the pieces
  foundation.md      runbook: foundation, secrets, GitHub App, Clerk, first release
```

## How the pieces fit

1. The plugin (`plugin/`) creates an app repo from its template and registers it with the deployer.
2. The deployer reacts to GitHub webhooks and queues jobs. For each job it hands the runner (a second process on the same instance, over a Unix socket) either the commit's zipball for a build or the inputs for a deploy.
3. The runner runs `jobs/build-release.sh` or `jobs/deploy-env.sh`. Steps that execute app code run as a separate Linux user with no AWS credentials. `deploy-env` renders a Terraform root config for the app and environment from `app.yaml` and applies `modules/app-env`.

The deployer, the runner, `jobs/` and `modules/` ship together as one release (`deployer/scripts/release.sh`). Changing build or deploy behaviour means releasing a new version.

CodeBuild isn't available in `ca-west-1`, which is why builds run on the deployer instance. The region is dedicated to slipway.

## Getting started

Follow `docs/foundation.md`. Every script that talks to AWS shows the account it is about to use and asks for confirmation first.
