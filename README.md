# slipway

A Claude Code plugin that builds and ships apps on your own AWS and GitHub accounts. Install it, run `/setup` once, and slipway sets itself up in your AWS account. Then `/new-app` gives you a GitHub repo and a live staging link a few minutes later. After that you describe features, and `/ship` opens a pull request that merges and deploys to staging once a quick check passes (app.yaml and a secret scan). On the deployer dashboard you verify a release (type check, lint and tests) and promote it to prod.

Everything runs in **your AWS account** and creates repos under **your GitHub org or personal account**. There's no slipway service in between and nothing to sign up for.

Every app gets a staging and a prod environment: Postgres on RDS, an API on ECS Express Mode (Fargate), and a frontend on S3 and CloudFront. Apps have no sign-in: what you deploy is public until you add authentication yourself. App repos hold no Terraform and no build scripts, so nothing an agent changes in an app can change how its infrastructure is built.

## Get started

You need:

- **Claude Code**, **Node.js 24**, and the **GitHub CLI** signed in (`gh auth login`).
- **An AWS account** with admin credentials in the AWS CLI v2, and **a region you'll use only for slipway**. The deployer's instance role may do anything in that region, so a separate AWS account just for slipway is best. The region must offer ECS Express Mode.
- **Terraform 1.11 or later** (on a Mac: `brew tap hashicorp/tap && brew install hashicorp/tap/terraform`).
- **A GitHub org or personal account** for the app repos. slipway's GitHub App is installed on all of its repositories and can write to them, so use one that holds only slipway apps.

Then, in Claude Code:

```
/plugin marketplace add sameid/slipway
/plugin install slipway@slipway
/setup
```

`/setup` asks for your AWS profile, region, GitHub owner and email, shows what it will create, and waits for your yes. Then, over 20 to 30 minutes, it:

1. creates a Terraform state bucket and applies the foundation: one `t3.small` deployer instance behind CloudFront, IAM roles, an artifacts bucket, an alerts topic and a budget;
2. creates slipway's GitHub App through GitHub's manifest flow. A browser page sends you to GitHub, where you click **Create GitHub App**, then install it on **All repositories**;
3. releases the deployer onto the instance and creates your dashboard account.

Then run `/new-app`. Run `/setup` again after a plugin update to update your deployer; it remembers everything from the first run.

**Cost.** The foundation costs about $20–25 a month before any apps. Each app adds its own small RDS database, ECS Express Mode service and CloudFront distribution per environment. The foundation sets an AWS Budget for the region (default $500 a month; `--budget` changes it) that emails you at 80% and at the 100% forecast.

**GitHub Free** can't protect branches of private repos. Apps still work, but `main` isn't protected, so a direct push deploys to staging without the check. GitHub Pro or Team fixes that.

## Sharing a deployer

One person runs `/setup`; everyone else runs `/connect <deployer url>`.

- **Org:** every member of the org can use the deployer.
- **Personal account:** only you can, unless you add people with `slipway setup --yes --allowed-users <logins>`. They also need write access to the app repos, and only you can run `/new-app`, because nobody else can create repos in your account.

## Your own domain

Apps live on `https://dxxxx.cloudfront.net` addresses. To serve an app's staging or prod from a domain you already own, open the app on the dashboard and choose **Add a custom domain** under that environment. slipway requests a certificate for the name and shows two DNS records to create: one proves the name is yours, the other points it at the app. Once the certificate is issued, slipway redeploys the environment with the domain attached. If you set slipway up before custom domains existed, run `slipway setup --yes` again first, so the deployer may request certificates.

## Layout

The repo is the plugin: Claude Code installs all of it, so `/setup` has the infrastructure code next to it.

```
.claude-plugin/      plugin.json and marketplace.json
bin/slipway          the plugin's CLI (on PATH in Claude Code); the code is in plugin/cli
plugin/              commands (/setup, /connect, /new-app, /ship, /status, /secret, /destroy-app),
                     skills, hooks, the app template and the CLI
foundation/          shared infrastructure in your region: deployer instance, CloudFront, IAM,
                     artifacts bucket, alerts topic, budget
modules/
  app-shared/        per-app ECR repository and log group
  app-env/           one app environment: RDS, ECS Express service, migrate task, S3 + CloudFront
jobs/                build-release.sh and deploy-env.sh, run by the runner on the deployer instance
deployer/            the deployer (dashboard, plugin API, GitHub webhooks, job worker) and the runner
docs/
  foundation.md      what /setup does, operating the deployer, and doing it all by hand
  contracts.md       names, conventions, API shapes and job inputs shared between the pieces
  design.md          the original design doc, with "Changes since Draft v7"
```

## How the pieces fit

1. The plugin creates an app repo from its template under your GitHub owner and registers it with the deployer.
2. The deployer reacts to GitHub webhooks and queues jobs. For each job it hands the runner, a second process on the same instance reached over a Unix socket, one of two things: the commit's zipball for a build, or the inputs for a deploy.
3. The runner runs `jobs/build-release.sh` or `jobs/deploy-env.sh`. Steps that execute app code run as a separate Linux user with no AWS credentials. `deploy-env` renders a Terraform root config for the app and environment from `app.yaml` and applies `modules/app-env`.

The deployer, the runner, `jobs/` and `modules/` ship together as one release, versioned with the plugin. Builds run on the deployer instance rather than in CodeBuild, which keeps the platform to one instance and works in every region. Only `/setup` uses AWS credentials; everything else the plugin does goes through the GitHub CLI and the deployer's API.

## Development

```sh
(cd plugin && npm test)                 # CLI, setup and hook tests, no dependencies
(cd jobs && npm ci && npm test)         # app.yaml rendering
(cd deployer && npm ci && npm run typecheck && npm test)
(cd plugin && npm run validate)         # plugin and marketplace manifests
```

The deployer has a fake mode (`DEPLOYER_FAKE=1`) with an in-memory GitHub and a simulated runner, so the plugin and the deployer can be run end to end on a laptop (`deployer/README.md`). To try the plugin from a checkout, `claude --plugin-dir .` loads it in place. Interfaces between the pieces are pinned in `docs/contracts.md`; change both sides in the same PR.

## License

MIT. See `LICENSE`.
