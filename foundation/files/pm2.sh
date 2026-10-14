#!/bin/sh
# /usr/local/bin/pm2 on the deployer host. pm2 runs as root (pm2-root.service)
# and starts the deployer and the runner as their own users; this
# wrapper makes `sudo pm2 ls` and `sudo pm2 logs runner` reach that daemon from
# a Session Manager shell regardless of sudo's environment handling.
export PM2_HOME=/root/.pm2
export PATH="/opt/slipway/node/bin:$PATH"
exec /opt/slipway/node/bin/node /opt/slipway/node/lib/node_modules/pm2/bin/pm2 "$@"
