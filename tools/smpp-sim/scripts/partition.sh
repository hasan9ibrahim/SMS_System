#!/usr/bin/env bash
# Cuts or heals the link between two switch nodes on this machine (backend step 7: "cut the network between servers"),
# by dropping the traffic of their distribution ports (start them with DIST_PORT, scripts/switch.sh). Both nodes keep
# reaching PostgreSQL, Redis and NATS, as two servers would when only the link between them fails.
#
#   partition.sh cut PORT...    drop TCP to and from these ports
#   partition.sh heal PORT...   remove those rules
set -euo pipefail
action="${1:-}"; shift || true
[ $# -gt 0 ] || { sed -n '2,8p' "$0"; exit 1; }
for port in "$@"; do
  for dir in --dport --sport; do
    rule=(INPUT -i lo -p tcp "$dir" "$port" -j DROP)
    case "$action" in
      cut) sudo iptables -C "${rule[@]}" 2>/dev/null || sudo iptables -I "${rule[@]}" ;;
      heal) while sudo iptables -C "${rule[@]}" 2>/dev/null; do sudo iptables -D "${rule[@]}"; done ;;
      *) sed -n '2,8p' "$0"; exit 1 ;;
    esac
  done
done
echo "link on port(s) $*: ${action}"
