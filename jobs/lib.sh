# shellcheck shell=bash source-path=SCRIPTDIR
# Shared helpers for build-release.sh and deploy-env.sh. Sourced, not run.
# The runner (deployer/src/runner) starts these scripts; see docs/contracts.md,
# "Runner".
#
# Log conventions the deployer parses:
#   "==> step: <slug>" before each step, and one "ERROR: <message>" line on failure.
# Exports: raw KEY=value lines in $SLIPWAY_EXPORTS; the runner returns the keys
# the contract allows for the job.

set -euo pipefail

JOBS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The release directory: jobs/ and modules/ are next to each other.
SLIPWAY_HOME="${SLIPWAY_HOME:-$(dirname "$JOBS_DIR")}"
# shellcheck source=versions.env
source "$JOBS_DIR/versions.env"

DEV="${SLIPWAY_DEV:-}" # set by the runner in dev mode (RUNNER_DEV=1, a laptop)
EXPORTS_FILE="${SLIPWAY_EXPORTS:-/dev/null}"
# The runner sets AWS_REGION from the foundation (runner.env).
: "${AWS_REGION:?AWS_REGION must be set}"
export AWS_REGION
export AWS_PAGER=""
export TF_IN_AUTOMATION=1
export NPM_CONFIG_UPDATE_NOTIFIER=false

CURRENT_STEP=""
# die() leaves this marker so a failure inside $(...) isn't reported twice.
ERROR_MARKER="${TMPDIR:-/tmp}/slipway-error.$$"
rm -f "$ERROR_MARKER"

step() {
  CURRENT_STEP="$1"
  printf '\n==> step: %s\n' "$1"
}

die() {
  touch "$ERROR_MARKER"
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

# Any failure without its own die() still ends with one ERROR line naming the step.
_on_exit() {
  local status=$?
  if ((status != 0)) && [[ ! -e "$ERROR_MARKER" ]]; then
    printf 'ERROR: %s failed (exit %d); see the output above\n' "${CURRENT_STEP:-startup}" "$status" >&2
  fi
  rm -f "$ERROR_MARKER"
}
trap _on_exit EXIT

require_env() {
  local name
  for name in "$@"; do
    [[ -n "${!name:-}" ]] || die "$name is not set"
  done
}

require_tools() {
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null || die "$tool is not installed on this host"
  done
}

export_var() {
  [[ "$2" != *$'\n'* ]] || die "export $1 contains a newline"
  printf '%s=%s\n' "$1" "$2" >>"$EXPORTS_FILE"
  printf 'export: %s=%s\n' "$1" "$2"
}

reset_exports() {
  : >"$EXPORTS_FILE"
}

# appyaml.mjs prints its own one-line ERROR: (e.g. every app.yaml problem) on failure.
appyaml() {
  SLIPWAY_LOG_ERRORS=1 node "$JOBS_DIR/appyaml.mjs" "$@" || {
    touch "$ERROR_MARKER"
    exit 1
  }
}

# Code from an app repo must not point outside its own folder: the runner reads
# and uploads files as a user that can see other apps' runs.
check_links() { # dir what
  appyaml check-links "$1" --what "$2"
}

# Pinned in versions.env; jobs/install-tools.sh installs them on the instance.
check_terraform() {
  require_tools terraform
  local have
  have=$(terraform version -json 2>/dev/null | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>{try{process.stdout.write(JSON.parse(b).terraform_version)}catch{}})' || true)
  [[ "$have" == "$TERRAFORM_VERSION" ]] || echo "warning: terraform ${have:-unknown} on PATH; versions.env pins $TERRAFORM_VERSION"
  echo "terraform $have"
}

# Sets GITLEAKS to a command (array) that runs gitleaks. In dev mode, Docker's
# gitleaks image stands in for a missing binary, or the scan is skipped.
# shellcheck disable=SC2034 # used by build-release.sh
GITLEAKS=()
# shellcheck disable=SC2034 # GITLEAKS is used by build-release.sh
find_gitleaks() {
  if command -v gitleaks >/dev/null; then
    GITLEAKS=(gitleaks)
  elif [[ -n "$DEV" ]] && command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    GITLEAKS=(docker run --rm -v "$PWD:/src:ro" -v "$JOBS_DIR/gitleaks.toml:/gitleaks.toml:ro"
      -w /src "ghcr.io/gitleaks/gitleaks:v$GITLEAKS_VERSION")
  elif [[ -z "$DEV" ]]; then
    die "gitleaks is not installed on this host (jobs/install-tools.sh)"
  fi
}
