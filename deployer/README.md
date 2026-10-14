# slipway deployer

Two Node.js processes on one EC2 instance, run by pm2 behind Caddy:

- **The deployer** (design 5.5) serves the dashboard, the plugin API and the GitHub webhooks, and runs the job worker that starts builds and deploys and merges passing PRs. Its state is one SQLite file on the instance's volume.
- **The runner** runs builds and deploys on the instance itself instead of in CodeBuild, which keeps the platform to one instance and works in every region. It runs `jobs/build-release.sh` and `jobs/deploy-env.sh` as child processes, as its own user. The verify phase of a build, which executes the app's code, runs as a third user with no AWS credentials. The deployer talks to it over a Unix socket.

Interfaces are in [`../docs/contracts.md`](../docs/contracts.md) ("Runner" and "Deployer host").

CloudFront reaches the instance as a custom origin over HTTP on port 8080, at its Elastic IP. The instance's security group admits only CloudFront's origin-facing addresses, and Caddy only proxies requests that carry the `X-Slipway-Origin` header with the secret our distribution adds (`SLIPWAY_ORIGIN_SECRET` in `/etc/slipway/caddy.env`). Everything else gets 403.

```
src/
  server.ts           entry point: config, SQLite + migrations, server, worker, catch-up
  app.ts              Express app (middleware, sessions, routes)
  worker.ts           job loop: poll runs, propagate failures, supersede, start jobs
  jobs.ts             queueing helpers (build + deploy, checks, de-duplication)
  events.ts           GitHub push / pull_request handling, catch-up on startup (and "Sync with GitHub")
  deliveries.ts       the webhook log: every delivery and what was done with it (dashboard: Webhooks)
  automerge.ts        merge decisions (design 5.7)
  registration.ts     POST /api/apps
  secrets.ts          one-time links, Parameter Store writes, redeploys (design 5.8)
  serialize.ts        plugin API JSON shapes
  github.ts           the GitHub App (@octokit/app), installed on the owner org or personal account
  runs.ts             the runner's client: start runs over its socket, poll them, read logs
  aws.ts              Parameter Store, Secrets Manager, failed-deploy metric and alert
  fake.ts             in-memory GitHub + simulated runner (fake mode and tests)
  auth/               passwords, sessions, CSRF, login rate limiting, plugin token auth
  routes/             api, webhooks, auth, dashboard, secrets
  db/                 Drizzle schema, client, migrations
  scripts/create-admin.ts
  runner/             the runner process
    main.ts           entry point (dist/runner/main.js)
    runner.ts         queue, concurrency caps, phases, users, timeouts, cancel, cleanup
    store.ts          run directories (run.json, log, exports.env, work/)
    api.ts            the socket API
    config.ts         RUNNER_* settings
views/                EJS pages; static/ holds theme.js, elapsed.js and the built app.css
styles/app.css        the dashboard's stylesheet source: HeroUI v3 component classes + Tailwind (npm run build:css)
drizzle/              SQLite migrations (npm run db:generate after changing db/schema.ts)
deploy/
  ecosystem.config.cjs  pm2 apps: deployer, runner
  Caddyfile             :8080 (CloudFront, with its X-Slipway-Origin secret) -> 127.0.0.1:3000; anything else gets 403
scripts/pack.sh       build and pack a release tarball (deployer, runner, ../jobs, ../modules, deploy/)
scripts/release.sh    publish a release and roll it out (whoever runs slipway)
```

## Local development (fake mode)

Fake mode needs no AWS account, GitHub App or runner. GitHub is an in-memory org (`GITHUB_OWNER`, default `acme`; `FAKE_OWNER_TYPE=User` makes it a personal account) where every repo exists with an `app.yaml` the first time it's used, and runs succeed after `FAKE_BUILD_SECONDS`.

```sh
cp .env.example .env            # DEPLOYER_FAKE=1
npm ci
npm run create-admin -- --email you@example.com --name "You"   # prints a temporary password
npm run dev:fake                # http://localhost:8080
npm run dev:css                 # optional, in another terminal: rebuild app.css as views change
```

The dashboard is server-rendered EJS styled with [HeroUI](https://heroui.com) v3's framework-agnostic classes (`button button--primary`, `card`, `chip`, `table-root`, `alert`, `input`, ...) and Tailwind utilities, compiled into `views/static/app.css` from `styles/app.css`. It has no React and no inline scripts or styles (the CSP forbids them). `styles/app.css` imports only the HeroUI components the views use; import another one there before using its classes. Light or dark follows the system setting until someone uses the toggle in the header; that choice is remembered in their browser (`views/static/theme.js` sets `data-theme`). Running jobs show how long they've been going, and `views/static/elapsed.js` counts that up between page loads.

Use the plugin API with a token of the form `fake:<login>`:

```sh
curl -s -H 'Authorization: Bearer fake:alice' -H 'content-type: application/json' \
  -d '{"name":"loan-tracker"}' localhost:8080/api/apps
curl -s -H 'Authorization: Bearer fake:alice' localhost:8080/api/apps/loan-tracker
```

To run the plugin against it, set `SLIPWAY_DEPLOYER_URL=http://localhost:8080` and `SLIPWAY_GH_TOKEN=fake:<login>`.

Drive the fake GitHub through `/fake` (fake mode only):

| Request | Simulates |
|---|---|
| `POST /fake/github/repos/:app/commits` `{"files":{...}}` | a push to main |
| `POST /fake/github/repos/:app/pulls` `{"title","branch","files","draft"}` | opening a PR |
| `POST /fake/github/repos/:app/pulls/:n/commits` `{"files":{...}}` | pushing to a PR |
| `POST /fake/github/repos/:app/pulls/:n/close` | closing a PR |
| `GET /fake/github/repos/:app` | the repo's PRs, commit statuses and comments |

Add `"failStep": "test"` to a commit or PR to make its builds fail at that step. Repos named `missing-*` don't exist, and logins starting with `outsider` aren't org members.

## The runner on a laptop

The runner's dev mode (`RUNNER_DEV=1`) runs every phase as you, with the tools on your PATH, so you can run real check builds of an app without AWS:

```sh
(cd ../jobs && npm ci)
npm run dev:runner     # socket at ./data/runner/runner.sock, jobs from this checkout
```

Then start a run over the socket, for example from a script:

```js
import { readFileSync } from "node:fs";
import { SocketRuns } from "./dist/runs.js";
const runs = new SocketRuns("./data/runner/runner.sock");
const id = await runs.start({
  kind: "build-release",
  env: { APP: "my-app", COMMIT_SHA: "0".repeat(40), MODE: "check", PR_NUMBER: "1" },
  sourceZip: readFileSync("my-app.zip"), // like GitHub's zipball: one top-level folder
});
```

Check mode needs Node 24 and Docker; gitleaks is used from PATH, or from its Docker image. Publish and deploy phases use your own AWS credentials in dev mode, so don't start them against a real account unless you mean to.

## Tests

```sh
npm run typecheck
npm test          # Vitest: the fakes from src/fake.ts, and the runner against stand-in job scripts
npm run build     # dist/ (server.js and runner/main.js)
```

## Configuration

On the instance, the deployer's settings come from `/etc/slipway/deployer.env` and the runner's from `/etc/slipway/runner.env`. The foundation's user data writes both, and `deploy/ecosystem.config.cjs` loads them because pm2 can't. The variables are listed in [contracts.md](../docs/contracts.md#deployer-host).

Outside fake mode, `AWS_REGION` and `GITHUB_OWNER` are required; there are no defaults. The deployer asks GitHub for its own App's slug (`GET /app`) and looks for the App's installation on `GITHUB_OWNER` as an org, then as a personal account, so the App can have any name.

Deployer settings beyond the contract:

| Variable | Use |
|---|---|
| `HOST`, `PORT` | where it listens; `127.0.0.1:3000` on the instance, behind Caddy |
| `RUNNER_SOCKET` | the runner's socket; default `./data/runner/runner.sock` locally |
| `ALERTS_TOPIC_ARN` | SNS topic told about failed prod deploys. Every failed staging or prod deploy also adds 1 to the CloudWatch metric `slipway/FailedDeploys` (dimension `Env`) |
| `PUBLIC_URL` | the deployer's public URL (`https://dxxxx.cloudfront.net`); the instance's deployer.env sets it. `PUBLIC_URL_PARAM` (an SSM parameter holding it) is an alternative |
| `SECRETS_KMS_KEY_ID` | KMS key for app secrets in Parameter Store; unset (the default, and production) uses SSM's AWS-managed key |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` | override `GITHUB_APP_SECRET_ID`, for a local run against a test App |
| `WORKER_INTERVAL_SECONDS` | default 15 |

Runner settings beyond the contract:

| Variable | Use |
|---|---|
| `RUNNER_DEV` | `1` on a laptop: no build user, local tools; refused with `NODE_ENV=production` |
| `RUNNER_BUILD_TIMEOUT_MINUTES`, `RUNNER_DEPLOY_TIMEOUT_MINUTES` | default 45 and 120; a run that takes longer is stopped and fails |
| `RUNNER_SHUTDOWN_GRACE_SECONDS` | default 840: on SIGINT/SIGTERM the runner stops taking runs and waits this long for active ones before stopping them (pm2's `kill_timeout` is 15 minutes) |
| `RUNNER_RETENTION_DAYS` | default 30; older run directories are deleted |
| `RUNNER_PUBLISH_PROFILE`, `RUNNER_DEPLOY_PROFILE` | default empty: publish and deploy use the instance role directly. Set them to profile names in the runner's `~/.aws/config` to use other credentials |
| `RUNNER_SOCKET_GROUP` | give the socket this group; unset on the instance, where `/run/slipway` is setgid to the deployer's group |

The deployer exits on start if `PUBLIC_URL` isn't set or the `slipway/github-app` secret has no value yet. pm2 restarts it, backing off, until it has.

**How the runner keeps builds apart from everything else** (the host side is in `foundation/templates/user-data.sh.tftpl`):
- The verify phase (`npm ci`, type check, lint, tests, frontend build, i.e. the app's own code) runs as `slipway-build` through `sudo -n -H -u slipway-build`, with a clean environment: no AWS variables, nowhere to write exports. The host's nftables rules stop that user reaching the instance metadata service (so no instance-role credentials) and the deployer's, Caddy's and Caddy's admin ports.
- The runner's data is its own (`/var/lib/slipway-runner`, 0750). The build user gets only `x` on the path to the run it's building (an ACL on the run's directory, removed afterwards), and the work dir under it. It can't list runs or read any log, export file or source zip.
- The image (Docker) and publish phases, and deploys, run as the runner. Before reading or uploading anything from the app's folder, the scripts check that no symbolic link points outside it, and the frontend build may contain no links at all.
- Publish and deploy use the instance role, which they reach through the metadata service. The build user can't: nftables blocks it, so the instance role's permissions are only available to the runner's own phases and to the deployer.

**AWS calls the deployer makes:**
The instance has one role, shared by the deployer and the runner; the foundation grants it what deploys need in its region. The deployer's own calls are:
- `secretsmanager:GetSecretValue` on `slipway/github-app` and `slipway/clerk/local`.
- `ssm:PutParameter` on `/apps/*` (SecureString, AWS-managed key). The deployer never reads app secret values back; nothing in its code calls `GetParameter` on `/apps/*`.
- `cloudwatch:PutMetricData` with namespace `slipway`.
- `sns:Publish` to the alerts topic.

## How jobs run

- **Plugin API access:** the colleague's `gh auth token` names a GitHub login. If the owner is an org, the login must be a member of it. If it's a personal account, the login must be the owner or be listed in `GITHUB_ALLOWED_USERS` (those colleagues also need write access to the app repos, and only the owner can create repos there, so only the owner can run `/new-app`).
- **Registration** protects `main` (PRs required, the check must pass, no force pushes; on org repos only the App may push). GitHub Free can't protect private repos: then registration still succeeds, returns a `warning` the plugin prints, and `main` stays unprotected, so a direct push to `main` deploys to staging without a check. GitHub Pro or Team fixes that. Registration then queues `deploy shared`, then `build` of main's head, then `deploy staging`. Each waits for the previous one to succeed, and a failure fails the rest. The first failure is recorded on the app (`failedJob`) and the app becomes `failed`. Its owner can register it again to retry.
- **Concurrency:** one running job per `(app, env)`; checks are keyed per PR, so checks for different PRs run in parallel. Builds and deploys wait until the app's shared stack has deployed.
- **Superseding:** of several queued staging deploys for an app, only the newest runs. A new PR head supersedes queued checks for the old one.
- **Auto-merge:** a passing check on an open PR's current head merges it, unless:
  - the app has `auto_merge: false`;
  - the PR is a draft;
  - it touches `.github/` or `CODEOWNERS`;
  - it changes a platform-owned `app.yaml` field (`name`, `auth`, `auto_merge`, `sizes`);
  - its branch conflicts with main.

  In any of those cases the PR is marked `blocked` and gets one comment. A branch that's behind main is updated through GitHub, which triggers a fresh check.
- **Secrets:** setting a value redeploys the environment's current release. If a deploy of that environment is already queued, that deploy picks the value up instead. Every deploy passes `DEPLOY_ID`, so tasks restart even when the image hasn't changed.
- **Webhook log:** every delivery, including rejected ones, is recorded with what the deployer did, or why it did nothing (no app for the repo, not main, the app is destroyed, a bad signature...). The dashboard's Webhooks page and each app's page show it; the newest 2,000 are kept. Repo names are matched case-insensitively, like GitHub's, which may spell the owner `Acme` in payloads where the app's repo says `acme`.
- **Catch-up on startup**, and on demand with **Sync with GitHub** on an app's page:
  - queues a build for an unbuilt head of main;
  - queues checks for open PR heads that have none;
  - settles PRs that merged or closed while the deployer was down.

## Releasing

A release is everything the instance runs: the deployer, the runner, `../jobs` and `../modules`, and the pm2 and Caddy configs. Changing a job script or a module means releasing.

```sh
export AWS_PROFILE=<platform account profile>
export AWS_REGION=<the foundation's region>   # required
deployer/scripts/release.sh            # or release.sh <version>
```

It shows the account and region and asks for `yes`, then:
1. Runs typecheck and tests for the deployer and `jobs/`, builds, and packs the tarball (`scripts/pack.sh`).
2. Uploads the tarball to `s3://slipway-artifacts-<account>/deployer/<version>.tgz` (override with `RELEASES_BUCKET`).
3. Creates or updates `/slipway/deployer/version`.
4. Runs `/opt/slipway/bin/update-deployer.sh` on the instance through SSM Run Command and prints its output. That installs the release, runs `jobs/install-tools.sh` (Terraform and gitleaks at the versions in `jobs/versions.env`), installs the Caddyfile, and reloads pm2. The runner finishes the runs it has going before it restarts (up to about 15 minutes), so the command can take a while; runs that are still going after that fail and can be retried.

On the instance, `npm ci --omit=dev` installs the native modules from their prebuilt binaries. `package.json`'s `allowScripts` lets argon2's install script pick the right one, and blocks better-sqlite3's implicit `node-gyp rebuild`, because the instance has no compiler.

**The first admin**, through Session Manager:

```sh
sudo /opt/slipway/bin/create-admin --email <your email> --name "Your Name"
```

It prints a temporary password, and you choose your own at first sign-in. `--reset` gives an existing account a new temporary password and makes it an enabled admin again.
