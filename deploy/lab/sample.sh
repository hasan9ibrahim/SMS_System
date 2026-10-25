#!/usr/bin/env bash
# Samples each lab machine's switch metrics every 2 s while a drill runs (deploy/lab/README.md): vendor connections
# bound, the servers sharing them, cluster peers, overload. Output: one line per sample.
while true; do
  line="$(date -u +%H:%M:%S)"
  for m in srv-a srv-b witness; do
    metrics="$(docker exec "lab-$m" curl -s -m 6 http://127.0.0.1:9568/metrics 2>/dev/null)"
    bound="$(echo "$metrics" | awk '/^sms_vendor_sessions\{phase="bound"\}/ {print $2}')"
    nodes="$(echo "$metrics" | awk '/^sms_vendor_nodes / {print $2}')"
    peers="$(echo "$metrics" | awk '/^sms_cluster_peers_connected / {print $2}')"
    fenced="$(echo "$metrics" | awk '/^sms_fenced / {print $2}')"
    line="$line  $m bound=${bound:--} shared=${nodes:--} peers=${peers:--} fenced=${fenced:--}"
  done
  echo "$line"
  sleep 2
done
