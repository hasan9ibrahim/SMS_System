#!/usr/bin/env bash
# Runs switch nodes against the load-test environment (backend step 7; databases from setup.sh).
#
#   switch.sh start NAME PORT NODE_ID [PEER...]  start node NAME@127.0.0.1 listening for customers on PORT
#   switch.sh stop NAME                          stop it cleanly (SIGTERM: drains, unbinds)
#   switch.sh kill NAME                          kill it at once (SIGKILL: a server that dies)
#   switch.sh pid NAME                           the BEAM's OS process id
#   switch.sh purge                              empty the load-test NATS stream (between runs)
#
# Each node uses the load-test NATS (scripts/nats.sh, LOAD_NATS) and logs to run/NAME.log at warning level.
# CLUSTER_SIZE (default: 1 + the number of peers) is the number of servers sharing the TPS limits. DIST_PORT fixes the
# node's distribution port, so scripts/partition.sh can cut the link between two nodes. Never point this at production.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
run="$here/../run"
mkdir -p "$run"
set -a; . "$root/.env"; set +a
cookie="${SWITCH_COOKIE:-loadtest}"

case "${1:-}" in
  start)
    name="$2"; port="$3"; node_id="$4"; shift 4
    peers=""
    for p in "$@"; do peers="${peers:+$peers,}$p@127.0.0.1"; done
    cd "$root/backend"
    mix compile >/dev/null
    POSTGRES_DB="${LOAD_DB:-sms_load}" CLICKHOUSE_DB="${LOAD_CH_DB:-sms_load_edr}" NATS_HOSTS="${LOAD_NATS:-localhost:4223}" \
      SMPP_PORTS="$port" SMPP_TLS_PORTS="" SWITCH_NODE_ID="$node_id" SWITCH_PEERS="$peers" \
      SWITCH_CLUSTER_SIZE="${CLUSTER_SIZE:-$(( $# + 1 ))}" POSTGRES_POOL_SIZE="${POSTGRES_POOL_SIZE:-10}" \
      REDIS_POOL_SIZE="${REDIS_POOL_SIZE:-10}" CLICKHOUSE_POOL_SIZE="${CLICKHOUSE_POOL_SIZE:-5}" \
      nohup elixir --name "$name@127.0.0.1" --cookie "$cookie" \
        --erl "+K true +sbwt none +sbwtdcpu none +sbwtdio none -kernel net_ticktime 10 ${DIST_PORT:+-kernel inet_dist_listen_min $DIST_PORT inet_dist_listen_max $DIST_PORT}" \
        -S mix run --no-compile --no-halt -e 'Logger.configure(level: :warning)' > "$run/$name.log" 2>&1 &
    echo $! > "$run/$name.pid"
    # Up when it accepts SMPP connections.
    for _ in $(seq 1 120); do
      if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then echo "$name up on $port (pid $(cat "$run/$name.pid"))"; exit 0; fi
      sleep 0.5
    done
    echo "$name did not start; see $run/$name.log" >&2; exit 1
    ;;
  stop|kill)
    name="$2"; pidfile="$run/$name.pid"
    [ -f "$pidfile" ] || { echo "$name not running"; exit 0; }
    pid="$(cat "$pidfile")"
    # `elixir` execs the BEAM, so the pid is the node itself.
    if [ "$1" = kill ]; then kill -KILL "$pid" 2>/dev/null || true; else kill -TERM "$pid" 2>/dev/null || true; fi
    for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    rm -f "$pidfile"; echo "$name ${1}ed"
    ;;
  pid)
    cat "$run/$2.pid"
    ;;
  purge)
    cd "$root/backend"
    host="${LOAD_NATS:-localhost:4223}"; host="${host%%,*}"
    mix run --no-start -e "
      {:ok, _} = Application.ensure_all_started(:gnat)
      [h, p] = String.split(\"$host\", \":\")
      {:ok, c} = Gnat.start_link(%{host: String.to_charlist(h), port: String.to_integer(p)})
      {:ok, %{body: body}} = Gnat.request(c, \"\$JS.API.STREAM.PURGE.SMS\", \"\", receive_timeout: 10_000)
      IO.puts(\"NATS: \" <> body)
    "
    ;;
  *)
    sed -n '2,13p' "$0"; exit 1
    ;;
esac
