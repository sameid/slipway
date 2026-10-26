# jobs/

The two jobs behind every build and deploy (design 5.6). The **runner** runs them on the deployer instance (`deployer/src/runner`) rather than in CodeBuild, which keeps the platform to one instance and works in every region. They expect `AWS_REGION` in the environment (the runner sets it from the foundation's region). They ship in the same release as the deployer, with `modules/` next to them. Interfaces, variables and log conventions are in `docs/contracts.md` ("Runner", "build-release", "deploy-env").

| File | What it does |
|---|---|
| `build-release.sh <phase>` | One commit of an app, in phases the runner starts one at a time, each as the right user, in one of three modes: `check` (a PR's head), `release` (a commit on `main`) or `verify` (Verify on the dashboard, which prod requires). **prepare** (runner): unpack GitHub's zipball, check for symbolic links out of the repo, validate `app.yaml`. **verify** (build user, no AWS credentials): check mode, the secret scan; release mode, the secret scan, `npm ci`, `drizzle-kit check` and the frontend build; verify mode, `npm ci`, typecheck, lint and tests. **image** (runner, release mode only): Docker build of `api/Dockerfile`, then the image's `/app` as `app.tgz` and `image.json` for staging code swaps. **publish** (runner, with the instance role's credentials, release mode only): push `app-<app>:<sha>` to ECR (reusing the digest if the tag exists), upload `web.tgz`, `app.yaml`, `migrations.sha256`, `app.tgz` and `image.json` to `releases/<app>/<sha>/`. |
| `deploy-env.sh` | Runs as the runner with the instance role's credentials; never runs app code. `ENV=shared`: the app's ECR repo and log group. `ENV=staging\|prod`: checks the secrets `app.yaml` requires and injects every secret the environment has (except `SECRETS_REMOVED`); on staging, when only the code changed, swaps it into the running tasks (design 5.11: the bundle and `current.json` to the swap bucket, then waits for each task's launcher); otherwise phase 1 apply (the service stays as it runs), migrate task (skipped when the release's `migrations.sha256` matches the env's last deploy), phase 2 apply, frontend sync, health check; a custom domain (`CUSTOM_DOMAIN`, `CERTIFICATE_ARN`) is attached by both applies. `ACTION=destroy` tears a stack down (prod keeps a final snapshot). |
| `appyaml.mjs` | Validates `app.yaml`, renders the Terraform root config (`main.tf.json`) for a stack (S3 backend key `apps/<app>/<stack>.tfstate`, pinned providers, module source relative to `modules/`), `check-links` (no symbolic link out of a folder), `migrations-hash` (what a release's migrate task applies), `swap-image` (a release's `image.json`) and `tree-hash` (the platform hash of `modules/app-env`). |
| `lib.sh` | Step and error logging, the exports file, tool checks. |
| `install-tools.sh` | Run as root by the instance's `update-deployer.sh` for every release: installs the Terraform and gitleaks versions pinned here into `/opt/slipway/tools` and links them into `/usr/local/bin`. |
| `versions.env` | Terraform, gitleaks and provider versions, with SHA-256 checksums of the linux x86_64 downloads. Bump a version and its checksum together; the next release installs it. |
| `terraform.lock.hcl` | The pinned providers' checksums for linux and macOS (x86_64 and arm64), copied into each run's root config so `terraform init` takes the providers from the runner's cache instead of downloading the AWS provider (about 730 MB unpacked) every time. Regenerate it whenever a provider version in `versions.env` changes (a test checks they agree): `terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_amd64 -platform=darwin_arm64` in a rendered root config. |
| `gitleaks.toml` | The scan config: gitleaks' defaults, skipping `node_modules/`, `dist/` and lockfiles. |

Every step prints `==> step: <slug>`, and every failure ends with one `ERROR: <message>` line. The deployer shows these to colleagues as the failing step and its reason, so keep the messages actionable. Exports are raw `KEY=value` lines in `$SLIPWAY_EXPORTS`; the runner passes on only the keys the contract lists for the job.

## Run a check locally

Use the runner's dev mode (see `deployer/README.md`, "The runner on a laptop"). It runs the same phases a PR check or a verify runs, as you, with the tools on your PATH: Node 24, and gitleaks or Docker to run its image. In dev mode a `.gitleaksignore` file is honoured; on the platform it's deleted first.

## Tests

```sh
cd jobs && npm ci && npm test            # appyaml.mjs, the staging launcher, deploy-env.sh
```

`test/launcher.test.mjs` runs `modules/app-env/launcher.cjs` in front of a fake app, against a fake S3. `test/deploy-env.test.mjs` runs `deploy-env.sh` against stand-ins for `aws`, `terraform` and `curl`; it needs bash 4 or later and skips on macOS's bash 3.2, so run it in a Linux container there:

```sh
docker run --rm -v "$PWD/..:/w" -w /w/jobs public.ecr.aws/docker/library/node:24-slim \
  bash -c 'apt-get update -qq && apt-get install -y -qq jq && node --test test/deploy-env.test.mjs'
```

To check the modules, render a root config with `appyaml.mjs render-env` into a scratch folder next to a copy of `modules/`, then run `terraform init -backend=false && terraform validate` there.
