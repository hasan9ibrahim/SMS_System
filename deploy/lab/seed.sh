#!/usr/bin/env bash
# Seeds the lab's PostgreSQL (after deploy/ansible site.yml and deploy.yml) for the step 8 drills: the reference data
# from the development database (docker compose, fake data only), then the load-test trunks, rates and route rule of
# tools/smpp-sim/scripts/setup.sql, with the vendors' SMSC on this host (the simulator). Writes the simulator's
# tools/smpp-sim/run/loadtest.json for the lab.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
set -a; . "$root/.env"; set +a
DEV_PG="${DEV_PG:-sms_system-postgres-1}"
VENDOR_HOST="${VENDOR_HOST:-10.88.0.1}"
TABLES=(currencies currency_rates countries mccmnc dial_code_profiles dial_codes product_categories business_companies
        billing_cycles)

primary="$(docker exec lab-srv-a curl -s -m 5 http://127.0.0.1:8008/cluster \
  | python3 -c 'import json,sys; print([m["name"] for m in json.load(sys.stdin)["members"] if m["role"] == "leader"][0])')"
lab_psql() { docker exec -i "lab-$primary" su postgres -c "psql -p 5433 -d sms_config -v ON_ERROR_STOP=1 -q $*"; }
echo "primary: $primary"

args=(); for t in "${TABLES[@]}"; do args+=(--table="sms.$t"); done
echo "reference data: ${TABLES[*]}"
{
  echo "SET session_replication_role = replica;"
  for t in "${TABLES[@]}"; do echo "TRUNCATE sms.$t CASCADE;"; done
  docker exec "$DEV_PG" pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --data-only --no-owner "${args[@]}"
} | lab_psql >/dev/null

echo "load-test trunks (vendors at $VENDOR_HOST:${VENDOR_PORT:-9100})"
lab_psql -v customer_trunks="${CUSTOMER_TRUNKS:-10}" -v vendor_trunks="${VENDOR_TRUNKS:-10}" \
  -v vendor_host="$VENDOR_HOST" -v vendor_port="${VENDOR_PORT:-9100}" \
  -v vendor_connections="${VENDOR_CONNECTIONS:-4}" -c "'SET search_path = sms, public'" -f - \
  < "$root/tools/smpp-sim/scripts/setup.sql"

# The simulator's customers connect from this host, not 127.0.0.1.
lab_psql -c "\"UPDATE sms.customer_trunks SET host_ips = '{127.0.0.1,$VENDOR_HOST}' WHERE name LIKE 'LOADTEST_C%'\""

mkdir -p "$root/tools/smpp-sim/run"
lab_psql -At -c "\"
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
  )\"" > "$root/tools/smpp-sim/run/loadtest-lab.json"
echo "tools/smpp-sim/run/loadtest-lab.json: $(grep -o '"system_id"' "$root/tools/smpp-sim/run/loadtest-lab.json" | wc -l) customer trunks"
