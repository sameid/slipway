# slipway: implementation contracts

`design.md` (Draft v7) says *what* the platform does. This file pins down the interfaces between the pieces so they can be built and changed independently: names, environment variables, SSM parameters, the deployer's HTTP API, the runner's socket API, and what each job script reads and writes. If you change one side of a contract, change the other side in the same PR and update this file.

## Layout

Everything lives in one repo, so a contract change lands in one PR.

| Path | Contents |
|---|---|
| `foundation/`, `modules/`, `jobs/`, `deployer/` | `foundation/` Terraform, `modules/` per-app Terraform, `jobs/` build and deploy scripts, `deployer/` (the deployer and the runner) |
| `plugin/` | Claude Code plugin and `templates/react-express/`. The marketplace is `.claude-plugin/marketplace.json` at the repo root |

## Names

| Thing | Name |
|---|---|
| Region | the foundation's `region` (required). It's dedicated to slipway: the instance role may do anything in it |
| Default tags | `platform=slipway`, plus `app=<name>`, `env=<env>` on per-app resources |
| GitHub owner | the foundation's `github_owner`: an org or a personal account. Every app repo is `<owner>/<name>` |
| GitHub App | any unique name (suggested: `slipway-<owner>`), installed on **all** repos of the owner. The deployer reads its slug from `GET /app` |
| Check commit status context | `slipway/check` |
| Deploy commit status context | `slipway/deploy-staging`, `slipway/deploy-prod` |
| Plugin marketplace / plugin | `slipway` / `slipway` (install `slipway@slipway`) |
| Stack skill | `slipway-stack` |
| App sign-in | none: apps are public until their developer adds authentication. The platform has no auth provider and no auth settings |
| CODEOWNERS entry | the foundation's `github_codeowners`; empty means `@<owner>` on a personal account and `@<app creator>` in an org |
| Build and deploy execution | the **runner**, a second process on the deployer instance (no CodeBuild, so it works in every region) |
| Instance role | `slipway-deployer` (the only platform role the deployer and runner use) |
| IAM permissions boundary | managed policy `slipway-boundary` |
| Express infrastructure role | `slipway-ecs-express-infra` (shared by every app; trusts `ecs.amazonaws.com`, AWS managed policy `AmazonECSInfrastructureRoleforExpressGatewayServices`) |
| Alerts topic | SNS `slipway-alerts` |
| Buckets | `slipway-tfstate-<account>` (Terraform state only), `slipway-artifacts-<account>` (`releases/`, `deployer/`) |

App names match `^[a-z][a-z0-9-]{1,18}[a-z0-9]$` (3–20 chars, lowercase letters, digits, hyphens, starts with a letter, doesn't end with a hyphen). Reserved: `slipway`, `deployer`, `platform`, `api`, `www`.

Per-app resources are named `app-<name>-<env>-<resource>` (`app-<name>-<resource>` for the shared stack):

| Resource | Name |
|---|---|
| ECR repository (shared) | `app-<name>` |
| CloudWatch log group (shared) | `/slipway/app-<name>` (stream prefixes `<env>/api`, `<env>/migrate`) |
| ECS cluster | `app-<name>-<env>` |
| Express service | `app-<name>-<env>-api-<4 hex>` |
| Migrate task definition family | `app-<name>-<env>-migrate` |
| RDS instance | `app-<name>-<env>-db` (database `app`, master user `app_admin`) |
| Web bucket | `app-<name>-<env>-web-<account>` |
| IAM roles | `app-<name>-<env>-exec`, `app-<name>-<env>-task` (both with the `slipway-boundary` boundary) |
| Security groups | `app-<name>-<env>-task`, `app-<name>-<env>-db` |
| App secret parameters | `/apps/<name>/<env>/<KEY>` (SecureString, AWS-managed `aws/ssm` key) |
| Terraform state keys | `apps/<name>/shared.tfstate`, `apps/<name>/staging.tfstate`, `apps/<name>/prod.tfstate` |
| Release artifacts | `s3://slipway-artifacts-<account>/releases/<name>/<sha>/web.tgz` and `.../app.yaml` |

## Shared resources and conventions

The foundation (17 Terraform resources) publishes no IDs. Everything else finds shared resources by convention:

| Thing | How it's found |
|---|---|
| Network | the default VPC (`data "aws_vpc" { default = true }`) and its default subnets (`default-for-az`). App tasks and the deployer get public IPs; RDS has none and accepts connections only from its app's task security group |
| Permissions boundary | `arn:aws:iam::<account>:policy/slipway-boundary` |
| Express infrastructure role | `arn:aws:iam::<account>:role/slipway-ecs-express-infra` |
| Alerts topic | `arn:aws:sns:<region>:<account>:slipway-alerts` |
| Buckets | `slipway-tfstate-<account>`, `slipway-artifacts-<account>` |

The foundation also creates the SSM String `/slipway/deployer/github-access`: JSON `{"allowedUsers":["login"],"codeowners":"@org/team"}` from the `github_allowed_users` and `github_codeowners` inputs. The deployer reads it at startup (`GITHUB_ACCESS_PARAM`); it's a parameter rather than user data so that changing it restarts the deployer instead of replacing the instance.

Created by `slipway setup` with the AWS CLI (docs/foundation.md), never by Terraform:

| Name | Kind | Value |
|---|---|---|
| `slipway-tfstate-<account>` | S3 bucket | Terraform state: `foundation/terraform.tfstate`, `apps/<app>/<env>.tfstate`. Also `foundation/terraform.tfvars.json`, the foundation's inputs as setup last applied them (`region`, `github_owner`, `alert_email`, `deployer_az_suffix`, and `budget_amount`, `github_allowed_users`, `github_codeowners` when set); setup merges its flags into it and keeps any other inputs |
| `slipway/github-app` | Secrets Manager | JSON `{"appId":"123","privateKey":"-----BEGIN...","webhookSecret":"..."}`, from GitHub's App manifest flow |
| `/slipway/deployer/version` | SSM String | release the instance runs (deployer, runner, job scripts, modules); created and updated by `deployer/scripts/release.sh`. setup releases `<plugin version>-<UTC yyyymmddhhmmss>`. Missing or `unset` means "nothing released yet" |

## Runner (replaces CodeBuild)

Builds and deploys run on the deployer instance in a second process, the **runner**, rather than in CodeBuild: one instance, and nothing that depends on a region offering CodeBuild. The deployer and the runner are plain Node.js processes under pm2. The only containers are the Docker builds of app images.

**Users on the instance**

| User | Runs | Access |
|---|---|---|
| `slipway` | the deployer | its data in `/var/lib/slipway`; the instance role; the runner socket (through the socket's group) |
| `slipway-runner` | the runner, Docker builds, publishing, Terraform | the instance role; the Docker socket (its group is `slipway-runner`) |
| `slipway-build` | the untrusted steps of a build, i.e. anything that executes app code (`npm ci`, type check, lint, tests, frontend build) | nothing else: nftables rejects its traffic to the instance metadata service (`169.254.169.254`) and to local TCP ports 2019 (Caddy admin), 3000 (deployer) and 8080 (Caddy); no Docker socket; can't read `/var/lib/slipway` |

pm2 drops supplementary groups when it starts a process as another user, so access never depends on group membership: it uses primary groups, a setgid directory and ACLs. pm2 doesn't set `HOME` either, so `ecosystem.config.cjs` sets it per app (`/var/lib/slipway-runner` for the runner, where its `.aws/config` lives). Docker bridge interfaces are blocked from the same local ports.

The runner starts untrusted steps with `sudo -H -n -u slipway-build` (a sudoers rule allows exactly that). It grants `slipway-build` traverse access to the run directory with an ACL, hands it `work/`, and deletes `work/` as that user when the run ends.

**Socket API.** The runner listens on the Unix socket `/run/slipway/runner.sock` and sets it to mode `0660`. `/run/slipway` is owner `slipway-runner`, group `slipway`, mode `2750`, so the socket gets the deployer's group. JSON over HTTP:

| Method and path | Request | Response |
|---|---|---|
| `POST /runs` | `{ "kind": "build-release" \| "deploy-env", "env": { "APP": "...", ... }, "sourceZip": "<base64>" }` (`sourceZip`, GitHub's zipball, only for build-release) | `201 { "id": "<run id>" }` |
| `GET /runs/:id` | | `{ "id", "kind", "status": "queued" \| "running" \| "succeeded" \| "failed", "exitCode": number \| null, "exported": { "KEY": "value" }, "createdAt", "startedAt", "finishedAt" }` |
| `GET /runs/:id/log?tail=N` | | `text/plain`, the last N lines (all of it without `tail`) |
| `POST /runs/:id/cancel` | | `202`; a queued run is dropped, a running one gets SIGTERM and ends `failed` |

Runs survive a runner restart: queued runs stay queued; runs that were running end `failed` with `ERROR: runner restarted during this run` appended to their log. Only keys listed under "Exports" below are accepted from a script's exports file.

**Concurrency.** At most `RUNNER_MAX_BUILDS` (default 1) build-release runs and `RUNNER_MAX_DEPLOYS` (default 2) deploy-env runs at once. The deployer still decides ordering per app and environment; the runner only caps parallelism for the instance's size.

**Run directory.** `/var/lib/slipway-runner/runs/<id>/` holds `run.json`, `log`, `exports.env` and `work/`. `work/` is deleted when the run ends; run directories are deleted after 30 days.

**AWS credentials.** The runner uses the instance role directly (`RUNNER_PUBLISH_PROFILE` and `RUNNER_DEPLOY_PROFILE` are empty, so no `AWS_PROFILE` is set). Anything running as `slipway` or `slipway-runner` has the instance role's permissions; `slipway-build` has none, because it can't reach the metadata service. The instance role can do anything in the region except IAM, STS, Organizations and Account actions. Outside the region it can manage only `app-*` IAM roles (which must carry `slipway-boundary`), CloudFront distributions tagged `platform=slipway`, and `app-*` CloudFront functions.

**Build user handoff.** pm2 drops supplementary groups, so the handoff uses modes and an ACL. The run directory stays the runner's (`0750`); while a build runs, an ACL gives `slipway-build` only traverse (`x`) on it. `work/` is `0777`: only the runner and `slipway-build` can reach it, so its "other" bits are effectively the build user's. `prepare` makes the source `a+rwX`, and `verify` leaves its output `a+rX` for the image and publish phases. When the run ends the runner deletes `work/` as `slipway-build` (`sudo -n -H -u slipway-build`) and removes the ACL. `verify` runs under `env -i`, without AWS variables, and its exports go to `/dev/null`.

**Job scripts** ship in the same release as the deployer (`jobs/` and `modules/`, see "Deployer host"). The runner runs them with:

| Variable | Value |
|---|---|
| job inputs | listed under build-release and deploy-env below |
| `AWS_REGION` | the foundation's region |
| `AWS_ACCOUNT_ID`, `RELEASES_BUCKET`, `STATE_BUCKET` | from the runner's environment |
| `SLIPWAY_HOME` | the release directory; scripts are in `$SLIPWAY_HOME/jobs`, modules in `$SLIPWAY_HOME/modules` |
| `SLIPWAY_WORK` | `<run dir>/work` |
| `SLIPWAY_EXPORTS` | `<run dir>/exports.env` (raw `KEY=value` lines) |
| `SLIPWAY_RUN_ID` | the run id |
| `SLIPWAY_SOURCE_ZIP` | the uploaded zipball (build-release `prepare`) |
| `SLIPWAY_IMAGE` | local image tag shared by the `image` and `publish` phases |
| `SLIPWAY_DEV`, `SLIPWAY_SHARE_WORK` | set by the runner's dev mode on a laptop (no build user) |

Tools on the instance: Docker and AWS CLI v2 from Amazon Linux; Terraform and gitleaks pinned in `jobs/versions.env` (`TERRAFORM_VERSION`, `TERRAFORM_SHA256`, `GITLEAKS_VERSION`, `GITLEAKS_SHA256`) and installed to `/usr/local/bin` by `update-deployer.sh` (or `jobs/install-tools.sh` when the release has one) with checksum checks.

**Log conventions** (the deployer reads the run log through the socket API):

- Before each step a script prints `==> step: <slug>` (for example `prepare`, `app-yaml`, `secret-scan`, `npm-ci`, `typecheck`, `lint`, `test`, `migrations-check`, `web-build`, `docker-build`, `publish`, `secrets-check`, `terraform-phase1`, `migrate`, `rollout-settings`, `terraform-phase2`, `web-sync`, `health-check`, `terraform-apply` (shared stack), `terraform-destroy`, `delete-secrets`, `release-cleanup`).
- On failure it prints one line `ERROR: <message>` and exits non-zero. The deployer stores the last step slug as the job's `failed_step` and the last `ERROR:` line as its `error`.
- Exports: scripts write `KEY=value` lines to `$SLIPWAY_EXPORTS`; the runner returns them as `exported`.

## `build-release`

Started by the deployer with `POST /runs`, `kind: "build-release"`, GitHub's zipball of the commit as `sourceZip`, and `env`: `APP`, `COMMIT_SHA` (full SHA), `MODE` (`release` | `check`), `PR_NUMBER` (check only).

`jobs/build-release.sh <phase>` runs in four phases, each started by the runner:

1. `prepare` (as `slipway-runner`): unpack the zipball (its single top-level directory becomes `$SLIPWAY_WORK/src`), validate `app.yaml` (`app-yaml`), and hand the work directory to `slipway-build`.
2. `verify` (as `slipway-build`, no AWS credentials): `secret-scan` (gitleaks), `npm-ci`, `typecheck` (`npm run typecheck`), `lint` (`npm run lint`), `test` (`npm test`), `migrations-check` (`npm run db:check -w api`), `web-build` (`web.build_command` from `app.yaml`, output in `web.output_dir`).
3. `image` (as `slipway-runner`): `docker-build` (`docker build --platform linux/amd64 -f api/Dockerfile .` at the source root). Dockerfile `RUN` steps run in build containers with no host mounts; the instance's metadata hop limit of 1 keeps them away from its credentials.
4. `publish` (as `slipway-runner` with the instance role, release mode only): push the image to `app-<app>:<COMMIT_SHA>` (reusing the existing digest if that tag already exists, since tags are immutable), upload `web.tgz` (contents of `output_dir`, no top-level folder) and `app.yaml` to `releases/<app>/<sha>/`. The local image is removed afterwards.

A failing phase ends the run.

Exports (release mode): `IMAGE_DIGEST` (`sha256:...`), `IMAGE_URI` (`<repo url>@sha256:...`), `WEB_ARTIFACT` (`s3://.../web.tgz`).

## `deploy-env`

Started by the deployer with `POST /runs`, `kind: "deploy-env"`, no source, and `env`:

| Variable | Notes |
|---|---|
| `APP` | |
| `ENV` | `shared`, `staging` or `prod` |
| `ACTION` | `apply` or `destroy` |
| `COMMIT_SHA` | release commit (staging/prod apply) |
| `IMAGE_DIGEST` | `sha256:...` (staging/prod apply) |
| `WEB_ARTIFACT` | `s3://...web.tgz` (staging/prod apply) |
| `DEPLOY_ID` | the deployer's job id. Goes into the container environment as `DEPLOY_ID`, so every deploy starts new tasks even when the image is unchanged (needed after a secret changes) |

`jobs/deploy-env.sh` runs as `slipway-runner` with the instance role. It never executes app code.

`app.yaml` comes from `releases/<app>/<sha>/app.yaml`; source zips aren't kept after a build.

Apply for staging/prod follows design 5.6: `secrets-check` → `terraform-phase1` (migrate image = new, service image and deploy id = what the state currently runs) → `migrate` (one-off Fargate task in the public subnets with a public IP, using the env's task security group; print its logs; fail on non-zero exit) → `rollout-settings` (once the service exists: shorter canary bake times, 0 and 0 minutes for staging and 2 and 1 for prod, and health checks every 10s with 2 to pass on both of its target groups, set on the ECS service and target groups directly because Express Mode's Terraform resource can't; best effort, a failure only warns) → `terraform-phase2` (service image = new, deploy id = `DEPLOY_ID`; waits for steady state; creates CloudFront on the first deploy; then the rollout settings again, which also shows whether Express Mode kept them) → `web-sync` (upload `web.tgz`: `assets/` with immutable caching and never deleted, so pages still open in a browser keep working; every other file `no-cache`, copied rather than synced so a rollback's older `index.html` still overwrites; `config.json` with `no-store`; then invalidate) → `health-check` (`GET <app url>/api/health` until it returns 200 and `release` equals the short SHA).

Destroy: prod first turns off deletion protection (apply with `destroying = true`) and keeps a final snapshot `app-<app>-prod-final-<UTC timestamp>`; then `terraform destroy`; then delete `/apps/<app>/<env>/*` parameters. Shared destroy deletes the ECR repo (force), the log group and `releases/<app>/`. The deployer sends `DEPLOY_ID` on every staging/prod job, destroys included.

Exports: `APP_URL` (`https://dxxxx.cloudfront.net`, staging/prod apply), `SERVICE_URL` (Express URL).

`config.json` written to the web bucket:

```json
{ "env": "staging", "release": "a1b2c3d" }
```

`release` everywhere (config.json, container `RELEASE`, `/api/health`) is the first 7 characters of the commit SHA.

## Per-app Terraform modules

`modules/app-shared` (inputs: `app`) → outputs `ecr_repository_url`, `ecr_repository_name`, `log_group_name`.

`modules/app-env` inputs: `app`, `env`, `size` (`small` | `medium` | `large`), `api_port`, `health_check_path`, `migrate_command` (list), `secret_names` (list), `service_image` (full reference `<repo url>@sha256:...`; `""` = no service and no CloudFront yet), `migrate_image` (same form; `""` = no migrate task definition), `release` (short SHA, container `RELEASE`), `deploy_id`, `destroying` (bool). Everything else (default VPC and subnets, boundary, Express infra role, alerts topic, ECR repo, log group) is found by the conventions above.

Outputs (all strings): `app_url`, `service_url`, `service_name`, `service_image`, `migrate_image`, `release`, `deploy_id`, `cluster_name`, `migrate_task_definition_arn`, `subnet_ids` (comma-joined default subnets), `task_security_group_id`, `web_bucket`, `distribution_id`, `log_group_name`, `env`, `inputs` (the JSON of the `app.yaml`-derived inputs, which teardown re-applies so lifting deletion protection never resizes anything).

Sizes:

| Size | Fargate CPU / memory | RDS class | RDS storage |
|---|---|---|---|
| small | 256 / 512 | db.t3.micro | 20 GB |
| medium | 512 / 1024 | db.t3.small | 50 GB |
| large | 1024 / 2048 | db.t3.medium | 100 GB |

The presets use `db.t3`, which every region offers (some, like `ca-west-1`, have no `db.t4g` classes for Postgres).

Container environment: `PORT` (= `api.port`), `APP_ENV` (`staging` | `prod`), `RELEASE`, `DEPLOY_ID`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_SECRET_ARN`; ECS secrets, one per `secrets:` name (from `/apps/<app>/<env>/<KEY>`).

Images are `linux/amd64`: provider 6.x's `aws_ecs_express_gateway_service` has no CPU architecture argument, so Express tasks run on X86_64.

## App repo contract (`templates/react-express`)

What `build-release` and `deploy-env` rely on:

- `app.yaml` at the root, schema as in design 5.2. Platform-owned fields: `name`, `auto_merge`, `sizes`.
- npm workspaces `api` and `web` with one root `package-lock.json`. Root scripts: `typecheck`, `lint`, `test` (Vitest, non-watch), `build`. `api` script `db:check` runs `drizzle-kit check`.
- `api/Dockerfile`, built from the repo root, base image from `public.ecr.aws/docker/library/node:24-slim` (avoids Docker Hub rate limits), listens on `PORT`, runs `node dist/index.js`, contains `dist/migrate.js` and the `drizzle/` folder, and bakes in the RDS CA bundle (`DB_SSL_CA`).
- `/api/health` returns 200 `{"ok":true,"release":"<RELEASE>","migrations":<n>}` only when the database is reachable.
- The frontend loads `/config.json` at runtime.

Template placeholders replaced by `/new-app` in every text file: `__APP_NAME__`, `__APP_DESCRIPTION__`, `__APP_OWNER__` (GitHub login). They currently appear in `app.yaml`, `CLAUDE.md`, `README.md`, `web/index.html` and `web/src/App.tsx`. The root npm package is always named `app`, so `package-lock.json` has no placeholders. The description sits in a double-quoted YAML string: strip newlines and escape it as a JSON string body. Copying skips `node_modules/` and `dist/` at any depth, `.env` and `.env.local`.

Apps aren't run locally (plugin 0.3.0 on): there's no local database, dev server or `.env`. A worktree only gets `npm ci`, so tests, typecheck, lint and `drizzle-kit` can run; tests mock the database. Colleagues preview changes on staging.

## Deployer HTTP API

Base URL: the deployer's CloudFront URL (the foundation's `deployer_url` output). The plugin reads it from `SLIPWAY_DEPLOYER_URL`, else from `~/.config/slipway/config.json` (`$XDG_CONFIG_HOME/slipway/config.json`), else from `deployerUrl` in `plugin/slipway.config.json` (empty upstream; a team fork can set it). The config file is `{"deployerUrl": "...", "setup": {"account": "...", "region": "...", "profile": "..." | null}}`: `slipway connect` writes `deployerUrl`, `slipway setup` writes both, and reads `setup` on later runs.

**Auth.** Every `/api/*` call sends `Authorization: Bearer <gh auth token>`. The deployer calls `GET https://api.github.com/user` with it, then decides whether the login may use the deployer. If the owner is an org: membership, checked with the App's installation token (`GET /orgs/<owner>/members/<login>` → 204). If it's a personal account: the login is the owner or is in the allowed users (`/slipway/deployer/github-access`, else `GITHUB_ALLOWED_USERS`; case-insensitive). The result is cached for 10 minutes keyed by the token's SHA-256. `401 {"error":"invalid GitHub token"}`; `403 {"error":"<login> is not a member of <owner>"}` (org) or `403 {"error":"<login> isn't allowed to use this deployer: ask <owner> to add you (slipway setup --allowed-users)"}` (personal account).

**Errors** are `{"error": "<message>"}` with a 4xx/5xx status.

**Fake mode for local development** (`DEPLOYER_FAKE=1`): tokens of the form `fake:<login>` are accepted as org members (except logins starting `outsider`); the owner is `GITHUB_OWNER` (default `acme`), an org; GitHub and the runner are simulated (builds succeed after `FAKE_BUILD_SECONDS`, default 5; deploys export fake URLs). The plugin CLI honours `SLIPWAY_GH_TOKEN` in place of `gh auth token`, so the two can be exercised end to end on a laptop.

Shapes:

```ts
type Job = {
  id: number; app: string;
  env: "shared" | "staging" | "prod" | "build" | "check";
  kind: "check" | "build" | "deploy" | "destroy";
  status: "queued" | "running" | "succeeded" | "failed" | "superseded";
  releaseId: number | null; commitSha: string | null; prNumber: number | null;
  requestedBy: string; failedStep: string | null; error: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;   // ISO 8601
  logPath: string;        // "/api/apps/<app>/jobs/<id>/log"
  dashboardUrl: string;   // "<deployer>/apps/<app>/jobs/<id>"
};
type Release = { id: number; commitSha: string; shortSha: string; status: "building" | "ready" | "failed"; imageDigest: string | null; createdAt: string };
type EnvState = { url: string | null; release: Release | null; lastDeploy: Job | null };
type App = {
  name: string; repo: string; repoUrl: string; owner: string;
  status: "registering" | "active" | "destroy_requested" | "destroying" | "destroyed" | "failed";
  autoMerge: boolean; dashboardUrl: string;
  phase: "registering" | "deploying_shared" | "building" | "deploying_staging" | "live" | "failed" | "destroying" | "destroyed";
  error: string | null;           // set when phase is "failed": the failed job's error
  failedJob: Job | null;          // the job that actually failed (a build, not the deploy that depended on it)
  staging: EnvState; prod: EnvState;
  activeJobs: Job[]; recentJobs: Job[];   // recentJobs: newest 10, plus failedJob if older
};
type PullRequest = {
  app: string; number: number; headSha: string;
  status: "checking" | "check_failed" | "blocked" | "merged" | "closed" | "unknown";
  check: Job | null;            // latest check job for headSha
  mergedSha: string | null;
  deploy: Job | null;           // staging deploy job for mergedSha
  live: boolean;                // staging runs mergedSha and its deploy succeeded
  stagingUrl: string | null;
  failure: { step: string | null; message: string | null; logPath: string } | null;  // check, release build or staging deploy; logPath is the job that failed
  note: string | null;          // e.g. "branch is behind main; updating it", "conflicts with main: rebase and push", "changes platform-owned files; needs dev team review"
};
type SecretStatus = { set: boolean; lastSetBy: string | null; lastSetAt: string | null };
```

| Method and path | Request | Response |
|---|---|---|
| `GET /api/whoami` | | `{ "login": "jane", "owner": "acme", "ownerType": "Organization" \| "User", "codeowners": "@acme/platform" }`. The plugin creates repos under `owner` and fills the template's `__APP_CODEOWNERS__` with `codeowners` |
| `GET /api/apps/:name` | | `App`, or `404` if not registered |
| `POST /api/apps` | `{ "name": "my-app" }` (repo is always `<owner>/<name>`) | `201 App` plus `"warning": string \| null`. The warning is set when GitHub's plan can't protect the private repo (GitHub Free): the app is registered anyway, with `main` unprotected. `409` if registered, `400` if the name is invalid, the repo is missing, or `app.yaml` on `main` is missing or its `name` differs (the repo and `app.yaml` are retried for a few seconds first, since the plugin calls this right after pushing). The caller's login becomes `owner`. Re-registering an app whose status is `failed` is allowed for its owner and queues the chain again. |
| `GET /api/apps/:name/pulls/:number` | | `PullRequest` (`status: "unknown"` and `headSha: ""` if the deployer hasn't seen it yet) |
| `GET /api/apps/:name/jobs?limit=20` | | `{ "jobs": Job[] }` newest first |
| `GET /api/apps/:name/jobs/:id/log?tail=200` | | `text/plain`, the last `tail` lines of the job's runner log (colleagues have no AWS console access, so logs are served here) |
| `POST /api/apps/:name/destroy` | | `202 { "status": "destroy_requested", "dashboardUrl": "..." }`. Only the app's owner. |
| `GET /api/apps/:name/secrets` | | `{ "secrets": [{ "key": "STRIPE_KEY", "staging": SecretStatus, "prod": SecretStatus }] }` for every name declared in `app.yaml` on `main` |
| `POST /api/apps/:name/secrets/:env/:key/link` | | `201 { "url": "<deployer>/secrets/set/<token>", "linkId": "<opaque>", "expiresAt": "..." }`. `400` if the key isn't declared in `app.yaml` on `main`. |
| `GET /api/apps/:name/secret-links/:linkId` | | `{ "status": "pending" \| "used" \| "expired", "usedAt": string \| null, "redeploy": Job \| null }` |

Browser and GitHub routes: `POST /webhooks/github`; `GET`/`POST /secrets/set/:token`; dashboard pages from design 5.5, including `GET`/`POST /apps/:name/secrets/:env` for setting several values at once.

## Deployer behaviour the plugin relies on

- **Registration** queues `deploy shared` → `build` (main's head) → `deploy staging`, chained so each starts only after the previous one succeeds (a failed dependency fails the rest). `phase` reflects where that chain is; when staging succeeds the app becomes `active`.
- **Concurrency key**: `(app, env)` for build and deploy jobs; `(app, "check", pr_number)` for checks, so checks for different PRs run in parallel.
- **Superseding**: a newer queued staging deploy supersedes older queued ones; a new head commit supersedes queued checks for the old head.
- **Auto-merge refusals**: a passing check is not merged, and the PR gets status `blocked` with a `note` and a PR comment, when the PR is a draft, touches `.github/**` or `CODEOWNERS`, changes a platform-owned `app.yaml` field, the app has `auto_merge: false`, or updating the branch from `main` conflicts.
- **Ordering**: builds and deploys of an app wait until its shared stack has deployed.
- **Login rate limits**: 5 failures in 15 minutes locks an email; 20 locks an IP (colleagues in one office share an address).
- **Secret set** writes `/apps/<app>/<env>/<KEY>` (SecureString with the `aws/ssm` key, overwrite), records it in `secrets`, marks the link used, and queues a deploy of that env's current release (if the env has one) with `requestedBy` = the GitHub login that created the link. Values set on the dashboard's secrets page are written the same way, with one deploy for the whole batch and `requestedBy` = the dashboard user's email.

## Deployer host

- **Instance:** `t3.small` (x86_64, Amazon Linux 2023) in a default subnet of the default VPC, with an Elastic IP; 40 GB gp3, a 4 GB swap file, IMDSv2 with a hop limit of 1. x86 because app images are `linux/amd64` and are built on it.
- **Ingress:** the security group admits only TCP 8080 from CloudFront's origin-facing prefix list (`com.amazonaws.global.cloudfront.origin-facing`). CloudFront reaches the instance as a custom origin (the Elastic IP's public DNS name, HTTP on 8080) and adds the header `X-Slipway-Origin: <secret>`. The secret is a 48-character alphanumeric `random_password`. Caddy proxies only requests whose header matches `{$SLIPWAY_ORIGIN_SECRET}` (from `/etc/slipway/caddy.env`, `root:caddy 0640`, loaded by `caddy.service`), strips the header, and answers 403 otherwise. It fails closed if the secret is missing or shorter than 32 characters. The CloudFront → instance hop is plain HTTP.
- **Processes:** Node.js 24 (linux-x64) at `/opt/slipway/node/bin/node`. pm2 (pinned, installed globally) runs as root from systemd (`pm2-root.service`) and starts each app as its own user, setting `HOME` for each: `deployer` (`slipway`) and `runner` (`slipway-runner`). The pm2-logrotate module (pinned) rotates `/root/.pm2/logs/*` daily or at 10 MB and keeps 14 compressed files per app.
- **Caddy** (`/usr/local/bin/caddy`, systemd `caddy.service`, `/etc/caddy/Caddyfile` from the release) listens on `:8080` and proxies to the deployer on `127.0.0.1:3000`, passing CloudFront's headers through. Its automatic HTTPS is off and its admin API is on `localhost:2019`. While the deployer is down it answers `503`. Before the first release, user data starts it with a placeholder config: 403 without the origin header, otherwise `503 no release installed yet`. That lets the CloudFront → instance path be checked on its own.
- **Releases** under `/opt/slipway/releases/<version>` (the last three are kept), the current one at `/opt/slipway/current`. Release tarball `s3://slipway-artifacts-<account>/deployer/<version>.tgz`:

```
deployer/              package.json, package-lock.json, dist/ (server.js: deployer + worker, applies SQLite
                       migrations on start; runner/main.js: the runner; scripts/create-admin.js), views/, drizzle/
jobs/                  build-release.sh, deploy-env.sh, lib.sh, appyaml.mjs, install-tools.sh, versions.env,
                       gitleaks.toml, package.json, package-lock.json
modules/               app-shared/, app-env/
ecosystem.config.cjs   pm2 apps; reads /etc/slipway/deployer.env and /etc/slipway/runner.env itself
Caddyfile
```

- **`/opt/slipway/bin/update-deployer.sh [version]`** (installed by user data) downloads the version in `/slipway/deployer/version` (or the one given; a missing parameter means nothing is released yet), runs `npm ci --omit=dev` in `deployer/` and `jobs/`, runs `jobs/install-tools.sh` (Terraform, gitleaks), installs `Caddyfile`, flips `current`, reloads Caddy, then `pm2 startOrReload ecosystem.config.cjs` and `pm2 save`. `deployer/scripts/release.sh` (run by `slipway setup`, or by hand) packs, uploads, sets `/slipway/deployer/version` and runs this script through SSM Run Command.
- **Data:** `DATA_DIR=/var/lib/slipway` (`deployer.db`; owner `slipway`, mode `0700`), on the root EBS volume with no backup yet (EBS snapshots are a planned follow-up). Runner data in `/var/lib/slipway-runner` (owner `slipway-runner`, mode `0750`).
- `/etc/slipway/deployer.env`:

```sh
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
AWS_REGION=<region>
DATA_DIR=/var/lib/slipway
GITHUB_OWNER=<owner>
GITHUB_ACCESS_PARAM=/slipway/deployer/github-access   # allowed users and codeowners; locally, GITHUB_ALLOWED_USERS and GITHUB_CODEOWNERS instead
PUBLIC_URL=https://dxxxx.cloudfront.net
RUNNER_SOCKET=/run/slipway/runner.sock
GITHUB_APP_SECRET_ID=slipway/github-app
ALERTS_TOPIC_ARN=arn:aws:sns:<region>:<account>:slipway-alerts
```

- `/etc/slipway/runner.env`:

```sh
NODE_ENV=production
AWS_REGION=<region>
AWS_ACCOUNT_ID=<account>
RELEASES_BUCKET=slipway-artifacts-<account>
STATE_BUCKET=slipway-tfstate-<account>
RUNNER_SOCKET=/run/slipway/runner.sock
RUNNER_DATA_DIR=/var/lib/slipway-runner
RUNNER_BUILD_USER=slipway-build
RUNNER_MAX_BUILDS=1
RUNNER_MAX_DEPLOYS=2
RUNNER_PUBLISH_PROFILE=
RUNNER_DEPLOY_PROFILE=
SLIPWAY_HOME=/opt/slipway/current
```

- **Secret values:** the deployer writes app secrets with `PutParameter` (SecureString, overwrite, no `KeyId`, so the `aws/ssm` key is used). The instance role has no `ssm:GetParameter` on `/apps/*`, so the deployer can't read them back. The runner can't either: it runs under the same role. App task execution roles can.
- **Failed deploys:** every failed deploy puts the CloudWatch metric `slipway` / `FailedDeploys` with dimension `Env`, and a failed prod deploy also publishes to `ALERTS_TOPIC_ARN`. The foundation creates no alarms, so the topic message is the alert.
- Extra settings for local runs (not in the instance's env files): `PUBLIC_URL_PARAM` (alternative to `PUBLIC_URL`), `SECRETS_KMS_KEY_ID` (optional key for app secrets), `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_WEBHOOK_SECRET` (instead of `GITHUB_APP_SECRET_ID`), `WORKER_INTERVAL_SECONDS`, `REGISTER_RETRY_MS`, `DEPLOYER_FAKE`, `FAKE_BUILD_SECONDS`. In fake mode the deployer simulates the runner and needs no socket.
- Native modules: `argon2` and `better-sqlite3` ship prebuilt linux-x64 binaries. The deployer's `package.json` `allowScripts` lets argon2's install script run and blocks better-sqlite3's (which would fall back to `node-gyp rebuild`).
