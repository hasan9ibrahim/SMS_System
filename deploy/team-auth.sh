#!/bin/sh
# Optional shared team password for the trial instance (CLAUDE.md step 6).
# nginx's entrypoint runs this before start. With TEAM_PASSWORD set, every request (pages, /api and the
# /socket WebSocket) needs TEAM_USER / TEAM_PASSWORD; with it empty, the instance is open.
set -eu
conf=/etc/nginx/team-auth.conf
if [ -n "${TEAM_PASSWORD:-}" ]; then
  user="${TEAM_USER:-team}"
  printf '%s:%s\n' "$user" "$(printf '%s\n' "$TEAM_PASSWORD" | mkpasswd -m sha512)" > /etc/nginx/team.htpasswd
  chmod 640 /etc/nginx/team.htpasswd
  chown root:nginx /etc/nginx/team.htpasswd
  printf 'auth_basic "SMS platform trial";\nauth_basic_user_file /etc/nginx/team.htpasswd;\n' > "$conf"
  echo "team-auth: team password on for user '$user'"
else
  : > "$conf"
  echo "team-auth: WARNING no TEAM_PASSWORD set, the web app is open to anyone who can reach it"
fi
