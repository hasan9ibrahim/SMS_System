#!/usr/bin/env bash
# Builds the one file a server downloads and installs (docs/DEPLOY_SINGLE_SERVER.md, sms-update): the release
# (build-release.sh) and this folder's setup and deploy scripts, without any source code. GitHub builds it after CI
# passed on main (.github/workflows/release.yml); it can also be built by hand on Ubuntu 24.04 with Node.js 22 and the
# Erlang/Elixir of backend/.tool-versions.
#
#   dist/sms-platform-<id>.tar.gz
#     VERSION             the release id
#     sms-update          downloads and installs a bundle (the server copies it to /usr/local/bin)
#     ansible/            the playbooks, roles and example inventories of this folder (not the lab's)
#     ansible/releases/   sms-, service- and web-<id>.tar.gz
#
# Prints the release id on its last line.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
id="$("$here/build-release.sh" | tail -n 1)"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/ansible/releases"
# Never a filled-in secrets file, even when built by hand from a working copy.
tar -C "$here" --exclude=./releases --exclude=./dist --exclude=./inventories/lab \
  --exclude=./build-release.sh --exclude=./build-bundle.sh --exclude=./sms-update --exclude='secrets.yml' --exclude='*.retry' -cf - . |
  tar -C "$stage/ansible" -xf -
cp "$here/releases/sms-$id.tar.gz" "$here/releases/service-$id.tar.gz" "$here/releases/web-$id.tar.gz" \
  "$stage/ansible/releases/"
cp "$here/sms-update" "$stage/sms-update"
echo "$id" > "$stage/VERSION"

mkdir -p "$here/dist"
tar -czf "$here/dist/sms-platform-$id.tar.gz" -C "$stage" .
echo "$id"
