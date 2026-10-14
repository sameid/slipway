#!/usr/bin/env bash
# Build and pack a release tarball of the deployer instance's software
# (docs/contracts.md, "Deployer host"): the deployer and runner, the job scripts
# and the per-app modules, plus the pm2 and Caddy configs. Touches
# nothing outside this repo. Used by release.sh; run it on its own to check a
# release builds.
#
# Usage: deployer/scripts/pack.sh <output.tgz>
#
# Layout of the tarball (its root becomes /opt/slipway/releases/<version>):
#   deployer/              package.json, package-lock.json, dist/, views/, drizzle/
#   jobs/                  scripts, appyaml.mjs, versions.env, gitleaks.toml, package*.json
#   modules/               app-shared/, app-env/
#   ecosystem.config.cjs   Caddyfile
# node_modules are installed on the instance (npm ci --omit=dev in deployer/ and jobs/).
set -euo pipefail
cd "$(dirname "$0")/.."
DEPLOYER="$PWD"
INFRA="$(dirname "$DEPLOYER")"

out="${1:?usage: scripts/pack.sh <output.tgz>}"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac

echo "==> Deployer: install, check, build"
npm ci --no-audit --no-fund
npm run typecheck
npm test
npm run build

echo "==> Jobs: test"
(cd "$INFRA/jobs" && npm ci --no-audit --no-fund && npm test)

echo "==> Packing $out"
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/deployer" "$stage/jobs"
cp -R package.json package-lock.json dist views drizzle "$stage/deployer/"
# package.json's allowScripts decides which install scripts `npm ci --omit=dev`
# runs on the instance: argon2's, not better-sqlite3's (its prebuilt binary is used).
(cd "$INFRA/jobs" && cp -R appyaml.mjs build-release.sh deploy-env.sh install-tools.sh lib.sh \
  versions.env gitleaks.toml package.json package-lock.json README.md "$stage/jobs/")
cp -R "$INFRA/modules" "$stage/modules"
cp deploy/ecosystem.config.cjs deploy/Caddyfile "$stage/"
find "$stage" -name .terraform -prune -exec rm -rf {} + -o -name '*.tfstate*' -exec rm -f {} +
# Every user on the instance runs this code (the build user runs jobs/), none may change it.
chmod -R a+rX,go-w "$stage"
# No macOS metadata (._* files, extended attributes) in the tarball.
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$out" -C "$stage" .
echo "==> $(du -h "$out" | cut -f1) $out"
