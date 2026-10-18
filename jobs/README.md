# jobs/

The two jobs behind every build and deploy (design 5.6). The **runner** runs them on the deployer instance (`deployer/src/runner`) rather than in CodeBuild, which keeps the platform to one instance and works in every region. They expect `AWS_REGION` in the environment (the runner sets it from the foundation's region). They ship in the same release as the deployer, with `modules/` next to them. Interfaces, variables and log conventions are in `docs/contracts.md` ("Runner", "build-release", "deploy-env").

| File | What it does |
|---|---|
| `build-release.sh <phase>` | One commit of an app, in phases the runner starts one at a time, each as the right user. **prepare** (runner): unpack GitHub's zipball, check for symbolic links out of the repo, validate `app.yaml`. **verify** (build user, no AWS credentials): secret scan, `npm ci`, typecheck, lint, tests, `drizzle-kit check`, frontend build. **image** (runner): Docker build of `api/Dockerfile`. **publish** (runner, with the instance role's credentials, release mode only): push `app-<app>:<sha>` to ECR (reusing the digest if the tag exists), upload `web.tgz` and `app.yaml` to `releases/<app>/<sha>/`. |
| `deploy-env.sh` | Runs as the runner with the instance role's credentials; never runs app code. `ENV=shared`: the app's ECR repo and log group. `ENV=staging\|prod`: checks secrets, phase 1 apply, migrate task, phase 2 apply, frontend sync, health check; a custom domain (`CUSTOM_DOMAIN`, `CERTIFICATE_ARN`) is attached by both applies. `ACTION=destroy` tears a stack down (prod keeps a final snapshot). |
| `appyaml.mjs` | Validates `app.yaml`, renders the Terraform root config (`main.tf.json`) for a stack (S3 backend key `apps/<app>/<stack>.tfstate`, pinned providers, module source relative to `modules/`), and `check-links` (no symbolic link out of a folder). |
| `lib.sh` | Step and error logging, the exports file, tool checks. |
| `install-tools.sh` | Run as root by the instance's `update-deployer.sh` for every release: installs the Terraform and gitleaks versions pinned here into `/opt/slipway/tools` and links them into `/usr/local/bin`. |
| `versions.env` | Terraform, gitleaks and provider versions, with SHA-256 checksums of the linux x86_64 downloads. Bump a version and its checksum together; the next release installs it. |
| `gitleaks.toml` | The scan config: gitleaks' defaults, skipping `node_modules/`, `dist/` and lockfiles. |

Every step prints `==> step: <slug>`, and every failure ends with one `ERROR: <message>` line. The deployer shows these to colleagues as the failing step and its reason, so keep the messages actionable. Exports are raw `KEY=value` lines in `$SLIPWAY_EXPORTS`; the runner passes on only the keys the contract lists for the job.

## Run a check locally

Use the runner's dev mode (see `deployer/README.md`, "The runner on a laptop"). It runs the same phases a PR check runs, as you, with the tools on your PATH: Node 24, Docker, and gitleaks or Docker to run its image. In dev mode a `.gitleaksignore` file is honoured; on the platform it's deleted first.

## Tests

```sh
cd jobs && npm ci && npm test            # appyaml.mjs: validation, rendering, link checks
```

To check the modules, render a root config with `appyaml.mjs render-env` into a scratch folder next to a copy of `modules/`, then run `terraform init -backend=false && terraform validate` there.
