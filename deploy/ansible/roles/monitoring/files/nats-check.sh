#!/bin/sh
# NATS JetStream health for Prometheus (deploy/ansible/roles/monitoring): written to node_exporter's text files, as
# no NATS exporter is installed. $1 = the monitoring port.
port="${1:-8222}"
out=/var/lib/prometheus/node-exporter/nats.prom
tmp="$out.$$"
healthy=0
curl -sf -m 5 "http://127.0.0.1:$port/healthz?js-enabled-only=true" >/dev/null && healthy=1
jsz="$(curl -sf -m 5 "http://127.0.0.1:$port/jsz?streams=true" || echo '{}')"
{
  echo "# HELP sms_nats_healthy 1 when this NATS server and JetStream answer healthy"
  echo "# TYPE sms_nats_healthy gauge"
  echo "sms_nats_healthy $healthy"
  echo "$jsz" | python3 -c '
import json, sys
d = json.load(sys.stdin)
meta = d.get("meta_cluster") or {}
print("# HELP sms_nats_meta_leader 1 when the JetStream cluster has a leader")
print("# TYPE sms_nats_meta_leader gauge")
# A single server runs JetStream on its own: no cluster, so nothing to lead (deploy/ansible single_server).
print("sms_nats_meta_leader", 1 if meta.get("leader") or "meta_cluster" not in d else 0)
print("# HELP sms_nats_store_bytes JetStream bytes stored on this server")
print("# TYPE sms_nats_store_bytes gauge")
print("sms_nats_store_bytes", d.get("storage", 0))
print("# HELP sms_nats_stream_messages Messages in each stream on this server")
print("# TYPE sms_nats_stream_messages gauge")
for acc in d.get("account_details") or []:
    for s in acc.get("stream_detail") or []:
        print("sms_nats_stream_messages{stream=\"%s\"} %d" % (s["name"], s.get("state", {}).get("messages", 0)))
' 2>/dev/null
} > "$tmp" && mv "$tmp" "$out"
