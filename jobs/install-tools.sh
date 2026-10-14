#!/usr/bin/env bash
# shellcheck source-path=SCRIPTDIR
# Install the tools the jobs pin in versions.env (Terraform, gitleaks) on the
# deployer instance, checking each download's SHA-256. Runs as root from
# /opt/slipway/bin/update-deployer.sh every time a release is installed, so the
# release decides the versions. Idempotent: an installed version is reused.
#
# Usage: jobs/install-tools.sh [tools dir]   (default /opt/slipway/tools)
set -euo pipefail

JOBS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "$JOBS_DIR/versions.env"
TOOLS="${1:-/opt/slipway/tools}"
BIN=/usr/local/bin

die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ "$(uname -m)" == x86_64 ]] || die "versions.env pins linux x86_64 builds; this is $(uname -m)"
for cmd in curl sha256sum unzip tar; do command -v "$cmd" >/dev/null || die "$cmd is not installed"; done

download() { # url sha256 dest
  curl -fsSL --retry 3 --retry-delay 2 -o "$3" "$1" || die "could not download $1"
  echo "$2  $3" | sha256sum -c --quiet - >/dev/null || die "checksum mismatch for $1"
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

dir="$TOOLS/terraform-$TERRAFORM_VERSION"
if [[ ! -x "$dir/terraform" ]]; then
  download "https://releases.hashicorp.com/terraform/$TERRAFORM_VERSION/terraform_${TERRAFORM_VERSION}_linux_amd64.zip" \
    "$TERRAFORM_SHA256" "$tmp/terraform.zip"
  mkdir -p "$dir"
  unzip -q -o "$tmp/terraform.zip" terraform -d "$dir"
fi
ln -sfn "$dir/terraform" "$BIN/terraform"

dir="$TOOLS/gitleaks-$GITLEAKS_VERSION"
if [[ ! -x "$dir/gitleaks" ]]; then
  download "https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" \
    "$GITLEAKS_SHA256" "$tmp/gitleaks.tar.gz"
  mkdir -p "$dir"
  tar -xzf "$tmp/gitleaks.tar.gz" -C "$dir" gitleaks
fi
ln -sfn "$dir/gitleaks" "$BIN/gitleaks"

chmod -R a+rX "$TOOLS"
echo "terraform $TERRAFORM_VERSION, gitleaks $GITLEAKS_VERSION installed in $TOOLS"
