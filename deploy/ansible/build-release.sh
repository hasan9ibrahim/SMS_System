#!/usr/bin/env bash
# Builds the three parts of a release for the servers (Ubuntu 24.04, x86-64) into releases/ and prints the id to pass
# to deploy.yml (backend steps 8 and 14):
#   sms-<id>.tar.gz      the switch and the API (Elixir release, with the Erlang runtime and the SQL files)
#   service-<id>.tar.gz  the TypeScript service: server.mjs, bootstrap.mjs, the contract, the MCC/MNC and
#                        leaked-password lists, the SQL files
#   web-<id>.tar.gz      the screens (the built web app)
# Build on Ubuntu 24.04 (the Elixir release is linked against its libraries), with Node.js 22 and npm.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
cd "$root"
id="$(git rev-parse --short=10 HEAD)$(git diff --quiet HEAD -- backend db mock web contract || echo "-dirty-$(date -u +%Y%m%d%H%M%S)")"
mkdir -p "$here/releases"

# The switch and the API.
(cd backend && MIX_ENV=prod mix deps.get --only prod >/dev/null && MIX_ENV=prod mix release --overwrite --quiet)
cp backend/_build/prod/sms-*.tar.gz "$here/releases/sms-$id.tar.gz"

# The TypeScript service and the screens.
npm ci --no-audit --no-fund >/dev/null
npm run bundle -w mock >/dev/null
npm run build -w web >/dev/null
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/service/contract" "$stage/service/data" "$stage/service/db"
cp mock/dist/index.mjs "$stage/service/server.mjs"
cp mock/dist/bootstrap.mjs "$stage/service/bootstrap.mjs"
mkdir -p "$stage/service/contract/generated"
cp contract/openapi.yaml contract/access.json "$stage/service/contract/"
cp contract/generated/operations.json "$stage/service/contract/generated/"
cp mock/data/mccmnc.csv mock/data/leaked-passwords.txt "$stage/service/data/"
cp -r db/postgres db/clickhouse "$stage/service/db/"
tar -czf "$here/releases/service-$id.tar.gz" -C "$stage/service" .
tar -czf "$here/releases/web-$id.tar.gz" -C web/dist .
echo "$id"
