#!/usr/bin/env bash
# Create a deployer admin account (design 5.5). Installed at
# /opt/slipway/bin/create-admin. Run it through Session Manager:
#
#   sudo /opt/slipway/bin/create-admin <arguments for dist/scripts/create-admin.js>
#
# It runs the current release's create-admin script as the slipway user,
# with the deployer's environment, so it writes to the same database.
set -euo pipefail

script=/opt/slipway/current/deployer/dist/scripts/create-admin.js
if [[ ! -f "$script" ]]; then
  echo "No release is installed yet. Publish one with deployer/scripts/release.sh first." >&2
  exit 1
fi

cd /var/lib/slipway
# shellcheck disable=SC2016 # expanded by the inner shell
exec sudo -u slipway bash -c '
  set -a
  . /etc/slipway/deployer.env
  set +a
  exec /opt/slipway/node/bin/node "$0" "$@"
' "$script" "$@"
