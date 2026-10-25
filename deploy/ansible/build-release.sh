#!/usr/bin/env bash
# Builds the switch release for the servers (Ubuntu 24.04, x86-64) into releases/sms-<commit>.tar.gz and prints the id
# to pass to deploy.yml. Build on Ubuntu 24.04 (the release includes the Erlang runtime, linked against its libraries).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../../backend"
id="$(git rev-parse --short=10 HEAD)$(git diff --quiet HEAD -- . ../db || echo -dirty)"
MIX_ENV=prod mix deps.get --only prod >/dev/null
MIX_ENV=prod mix release --overwrite --quiet
mkdir -p "$here/releases"
cp _build/prod/sms-*.tar.gz "$here/releases/sms-$id.tar.gz"
echo "$id"
