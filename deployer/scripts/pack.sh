#!/usr/bin/env bash
# Build and pack a release tarball of the deployer instance's software
# (docs/contracts.md, "Deployer host"): the deployer and runner, the job scripts
# and the per-app modules, plus the pm2 and Caddy configs. It builds in a
# scratch copy, so it never writes to the repo (or to the installed plugin,
# which `slipway setup` releases from). Used by release.sh; run it on its own
# to check a release builds.
#
# Usage: deployer/scripts/pack.sh <output.tgz>
#   SKIP_CHECKS=1 skips the type check and tests (slipway setup sets it: a
#   published plugin version has passed them already).
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

build=$(mktemp -d)
stage=$(mktemp -d)
trap 'rm -rf "$build" "$stage"' EXIT
copy() { # copy <dir> <dest>, without installed or built files
  mkdir -p "$2"
  tar -C "$1" --exclude ./node_modules --exclude ./dist --exclude ./data --exclude ./.env -cf - . | tar -C "$2" -xf -
}

echo "==> Deployer: install, check, build"
copy "$DEPLOYER" "$build/deployer"
cd "$build/deployer"
if [[ "${SKIP_CHECKS:-}" == "1" ]]; then
  # The build only needs TypeScript and Tailwind, not the native modules.
  npm ci --no-audit --no-fund --ignore-scripts
else
  npm ci --no-audit --no-fund
  npm run typecheck
  npm test
fi
npm run build

if [[ "${SKIP_CHECKS:-}" != "1" ]]; then
  echo "==> Jobs: test"
  copy "$INFRA/jobs" "$build/jobs"
  (cd "$build/jobs" && npm ci --no-audit --no-fund && npm test)
fi

echo "==> Packing $out"
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
