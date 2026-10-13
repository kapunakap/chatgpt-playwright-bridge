#!/bin/sh
set -eu
node /opt/patch-tabs.cjs
exec node /app/cli.js "$@"
