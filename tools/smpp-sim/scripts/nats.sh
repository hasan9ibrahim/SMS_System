#!/usr/bin/env bash
# A NATS server only for load tests (backend step 7), on 127.0.0.1:4223 (monitoring 8223), so runs never touch the
# development stream and start empty:
#
#   nats.sh start always|default   (re)create it with nats/<mode>.conf
#   nats.sh stop
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
name=sms-nats-load
case "${1:-}" in
  start)
    mode="${2:-always}"
    docker rm -f "$name" >/dev/null 2>&1 || true
    # Host networking: docker's userland port proxy cost a third of a core at 250 msg/s (backend step 7).
    docker run -d --name "$name" --network host \
      -v "$here/../nats/$mode.conf:/etc/nats/nats.conf:ro" nats:2.14.8-alpine -c /etc/nats/nats.conf >/dev/null
    for _ in $(seq 1 40); do curl -sf http://127.0.0.1:8223/healthz >/dev/null && { echo "load-test NATS up ($mode)"; exit 0; }; sleep 0.25; done
    echo "load-test NATS did not start" >&2; exit 1
    ;;
  stop) docker rm -f "$name" >/dev/null 2>&1 || true; echo "load-test NATS stopped" ;;
  *) sed -n '2,7p' "$0"; exit 1 ;;
esac
