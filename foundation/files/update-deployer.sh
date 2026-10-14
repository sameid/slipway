#!/usr/bin/env bash
# Install a platform release (deployer, runner, job scripts, modules) and
# (re)start everything under pm2 (docs/contracts.md, "Deployer host").
#
# Installed at /opt/slipway/bin/update-deployer.sh by the foundation's user
# data. Runs as root: on first boot from cloud-init, and afterwards through
# SSM Run Command from deployer/scripts/release.sh.
#
# Usage: update-deployer.sh [version]
#   version defaults to the /slipway/deployer/version SSM parameter, which
#   release.sh creates. Before the first release it doesn't exist (or says
#   "unset"), and this installs nothing.
set -euo pipefail

set -a
# shellcheck source=/dev/null
. /etc/slipway/deployer.env
# shellcheck source=/dev/null
. /etc/slipway/runner.env
set +a

export PATH="/opt/slipway/node/bin:/usr/local/bin:$PATH"
export PM2_HOME=/root/.pm2
ROOT=/opt/slipway
KEEP_RELEASES=3

die() { echo "ERROR: $*" >&2; exit 1; }

version_param() {
  local out
  if out=$(aws ssm get-parameter --name /slipway/deployer/version --query Parameter.Value --output text 2>&1); then
    echo "$out"
  elif [[ "$out" == *ParameterNotFound* ]]; then
    echo unset
  else
    die "can't read /slipway/deployer/version: $out"
  fi
}

version="${1:-$(version_param)}"
if [[ -z "$version" || "$version" == "unset" ]]; then
  echo "No release published yet (/slipway/deployer/version doesn't exist); nothing to start."
  exit 0
fi
[[ "$version" =~ ^[A-Za-z0-9._-]+$ ]] || die "invalid release version '$version'"

dest="$ROOT/releases/$version"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# --- Download and install the release ------------------------------------------

if [[ ! -f "$dest/.installed" ]]; then
  echo "==> Downloading release $version"
  aws s3 cp --only-show-errors "s3://$RELEASES_BUCKET/deployer/$version.tgz" "$work/release.tgz"
  mkdir "$work/x"
  tar -xzf "$work/release.tgz" -C "$work/x"

  # Accept a tarball with or without a single top-level folder.
  src="$work/x"
  if [[ ! -f "$src/ecosystem.config.cjs" ]]; then
    shopt -s nullglob
    dirs=("$src"/*/)
    shopt -u nullglob
    [[ ${#dirs[@]} -eq 1 && -f "${dirs[0]}ecosystem.config.cjs" ]] || die "release $version has no ecosystem.config.cjs"
    src="${dirs[0]%/}"
  fi
  for f in deployer/package.json jobs/package.json jobs/versions.env modules ecosystem.config.cjs Caddyfile; do
    [[ -e "$src/$f" ]] || die "release $version has no $f"
  done

  echo "==> Installing dependencies"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -a "$src/." "$dest/"
  (cd "$dest/deployer" && npm ci --omit=dev --no-audit --no-fund)
  (cd "$dest/jobs" && npm ci --omit=dev --no-audit --no-fund)
  chown -R root:root "$dest"
  chmod -R go-w,a+rX "$dest"
  touch "$dest/.installed"
fi

# --- Tools the job scripts use, pinned by the release --------------------------

pin() {
  local value
  value=$(sed -n "s/^$1=//p" "$dest/jobs/versions.env" | tail -n 1)
  [[ -n "$value" ]] || die "jobs/versions.env in release $version has no $1"
  echo "$value"
}

# install_tool NAME VERSION URL SHA256 ARCHIVE_MEMBER
install_tool() {
  local name=$1 ver=$2 url=$3 sha=$4 member=$5 dir="$ROOT/tools/$1-$2"
  if [[ ! -x "$dir/$name" ]]; then
    echo "==> Installing $name $ver"
    curl -fsSL --retry 5 -o "$work/$name.archive" "$url"
    echo "$sha  $work/$name.archive" | sha256sum -c - >/dev/null || die "$name $ver checksum mismatch"
    mkdir -p "$work/$name" "$dir"
    case "$url" in
      *.zip) unzip -q -o "$work/$name.archive" "$member" -d "$work/$name" ;;
      *) tar -xzf "$work/$name.archive" -C "$work/$name" "$member" ;;
    esac
    install -m 0755 "$work/$name/$member" "$dir/$name"
  fi
  ln -sfn "$dir/$name" "/usr/local/bin/$name"
}

# A release may ship its own installer; otherwise install the pinned
# Terraform and gitleaks here. Either way they end up in /usr/local/bin,
# where the job scripts expect them.
if [[ -x "$dest/jobs/install-tools.sh" ]]; then
  "$dest/jobs/install-tools.sh"
else
  tf_ver=$(pin TERRAFORM_VERSION)
  install_tool terraform "$tf_ver" \
    "https://releases.hashicorp.com/terraform/$tf_ver/terraform_${tf_ver}_linux_amd64.zip" \
    "$(pin TERRAFORM_SHA256)" terraform
  gl_ver=$(pin GITLEAKS_VERSION)
  install_tool gitleaks "$gl_ver" \
    "https://github.com/gitleaks/gitleaks/releases/download/v$gl_ver/gitleaks_${gl_ver}_linux_x64.tar.gz" \
    "$(pin GITLEAKS_SHA256)" gitleaks
fi

# --- Caddy configuration -------------------------------------------------------

# Validate with the origin secret loaded, as caddy.service runs it.
# shellcheck source=/dev/null
(set -a; . /etc/slipway/caddy.env; caddy validate --config "$dest/Caddyfile" --adapter caddyfile >/dev/null) ||
  die "release $version has an invalid Caddyfile"
install -m 0644 "$dest/Caddyfile" /etc/caddy/Caddyfile

# --- Switch and (re)start -------------------------------------------------------

ln -sfn "$dest" "$ROOT/current.new"
mv -Tf "$ROOT/current.new" "$ROOT/current"

echo "==> Starting release $version"
systemctl reload-or-restart caddy
pm2 startOrReload "$ROOT/current/ecosystem.config.cjs" --update-env
pm2 save

# Keep the newest few releases for a quick manual rollback.
current=$(readlink -f "$ROOT/current")
# shellcheck disable=SC2012 # release names are restricted to [A-Za-z0-9._-]
ls -1dt "$ROOT"/releases/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
  old="${old%/}"
  if [[ "$(readlink -f "$old")" != "$current" ]]; then
    rm -rf "$old"
  fi
done

pm2 ls
echo "==> Release $version is running"
