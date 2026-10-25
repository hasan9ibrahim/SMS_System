#!/usr/bin/env bash
# Prepares a load-test environment (backend step 7) from the seeded development data, on the docker-compose
# services. Never point this at production: it creates databases and switches trunks off in its copy.
#
#   1. PostgreSQL: a fresh copy of the seeded database ($POSTGRES_DB) as $LOAD_DB, with the seeded trunks switched off
#      and fake load-test trunks, rates and one route rule added (scripts/setup.sql);
#   2. ClickHouse: an empty EDR database $LOAD_CH_DB with every migration applied;
#   3. Redis flushed (live counters, ledger, TPS) and a fresh load-test NATS (scripts/nats.sh, NATS_MODE always or
#      default), so runs start alike;
#   4. run/loadtest.json: the customer logins and dial prefixes the simulator uses.
#
# Environment: the repo's .env, plus CUSTOMER_TRUNKS (10), VENDOR_TRUNKS (10), VENDOR_CONNECTIONS (4),
# VENDOR_HOST (127.0.0.1), VENDOR_PORT (9100), LOAD_DB (sms_load), LOAD_CH_DB (sms_load_edr), PREFIXES (400).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
set -a; . "$root/.env"; set +a

LOAD_DB="${LOAD_DB:-sms_load}"
LOAD_CH_DB="${LOAD_CH_DB:-sms_load_edr}"
PG_CONTAINER="${PG_CONTAINER:-sms_system-postgres-1}"
CH_URL_BASE="${CH_URL_BASE:-http://localhost:${CLICKHOUSE_HTTP_PORT:-8123}}"
psql() { docker exec -i "$PG_CONTAINER" psql -U "$POSTGRES_USER" -v ON_ERROR_STOP=1 -q "$@"; }

echo "PostgreSQL: $LOAD_DB as a copy of $POSTGRES_DB"
psql -d postgres -c "DROP DATABASE IF EXISTS $LOAD_DB WITH (FORCE)"
psql -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$POSTGRES_DB' AND pid <> pg_backend_pid()" >/dev/null
psql -d postgres -c "CREATE DATABASE $LOAD_DB TEMPLATE $POSTGRES_DB"
psql -d "$LOAD_DB" \
  -v customer_trunks="${CUSTOMER_TRUNKS:-10}" -v vendor_trunks="${VENDOR_TRUNKS:-10}" \
  -v vendor_host="${VENDOR_HOST:-127.0.0.1}" -v vendor_port="${VENDOR_PORT:-9100}" \
  -v vendor_connections="${VENDOR_CONNECTIONS:-4}" < "$here/setup.sql"

echo "ClickHouse: $LOAD_CH_DB"
ch() { curl -sSf -u "$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" "$CH_URL_BASE/" --data-binary "$1" >/dev/null; }
ch "DROP DATABASE IF EXISTS $LOAD_CH_DB SYNC"
ch "CREATE DATABASE $LOAD_CH_DB"
CH_URL="$CH_URL_BASE/?database=$LOAD_CH_DB" CH_AUTH="$CLICKHOUSE_USER:$CLICKHOUSE_PASSWORD" \
  python3 "$root/tools/apply_clickhouse.py" >/dev/null

echo "Redis: flushed"
redis-cli -h "${REDIS_HOST:-localhost}" -p "${REDIS_PORT:-6379}" ${REDIS_PASSWORD:+-a "$REDIS_PASSWORD"} FLUSHALL >/dev/null
"$here/nats.sh" start "${NATS_MODE:-always}"

mkdir -p "$here/../run"
psql -d "$LOAD_DB" -At -c "
  SET search_path = sms, public;
  SELECT json_build_object(
    'customers', (SELECT json_agg(json_build_object('system_id', username, 'password', password) ORDER BY id)
                    FROM customer_trunks WHERE name LIKE 'LOADTEST_C%'),
    'vendor_port', ${VENDOR_PORT:-9100},
    'vendor_connections', (SELECT sum(max_connections) FROM vendor_trunks WHERE name LIKE 'LOADTEST_V%'),
    'customer_enterprise_id', (SELECT id FROM enterprises WHERE name = 'LoadTest Customer'),
    'prefixes', (SELECT json_agg(prefix) FROM (
                   SELECT d.prefix FROM dial_codes d JOIN mccmnc m ON m.id = d.mccmnc_id
                    WHERE d.profile = 'All' AND d.deleted_at IS NULL AND m.deleted_at IS NULL
                      AND length(d.prefix) BETWEEN 3 AND 7
                    ORDER BY md5(d.prefix) LIMIT ${PREFIXES:-400}) p)
  )" > "$here/../run/loadtest.json"
echo "run/loadtest.json: $(grep -o '"system_id"' "$here/../run/loadtest.json" | wc -l) customer trunks"
