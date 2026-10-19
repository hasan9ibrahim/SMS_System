-- Rate Manager (build step 4.2, contract v0.4.0, spec §13.12).
SET search_path = sms, public;

-- Latest exchange rate per currency: units per 1 USD (USD itself is 1).
CREATE VIEW currency_latest AS
SELECT c.iso,
       COALESCE((SELECT r.rate_per_usd FROM currency_rates r
                  WHERE r.iso = c.iso AND r.valid_from <= now()
                  ORDER BY r.valid_from DESC LIMIT 1), 1)::numeric(18, 8) AS rate_per_usd
  FROM currencies c;

-- Best buy (§13.12 "best buy rate and best vendor"): the cheapest rate valid now per
-- destination and product category, over live, active vendor trunks, in USD. Sender-ID
-- lines and blocked lines don't count. Refreshed after vendor rate changes and every few
-- minutes (now() is taken at refresh time).
CREATE MATERIALIZED VIEW best_buy_rates AS
SELECT DISTINCT ON (l.mccmnc_id, rt.product_category_id)
       l.mccmnc_id,
       rt.product_category_id,
       (l.rate / cl.rate_per_usd)::numeric(14, 8) AS rate_usd,
       rt.vendor_trunk_id,
       l.id AS rate_line_id
  FROM rate_lines l
  JOIN rate_tables rt ON rt.id = l.rate_table_id AND rt.kind = 'vendor' AND rt.deleted_at IS NULL
  JOIN vendor_trunks vt ON vt.id = rt.vendor_trunk_id AND vt.deleted_at IS NULL AND vt.status = 'active'
  JOIN currency_latest cl ON cl.iso = l.currency
 WHERE l.sender_id IS NULL AND NOT l.is_blocked
   AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
 ORDER BY l.mccmnc_id, rt.product_category_id, l.rate / cl.rate_per_usd, l.id;
CREATE UNIQUE INDEX best_buy_rates_key ON best_buy_rates (mccmnc_id, product_category_id);

-- Per-table counts for the Rate Manager list (§13.12): rates valid now and current sell
-- rates below best buy. Kept current by refresh_rate_table_stats(): for one table after
-- its rates change, for all tables after best_buy_rates is refreshed.
CREATE TABLE rate_table_stats (
  rate_table_id   bigint PRIMARY KEY REFERENCES rate_tables(id),
  active_lines    integer NOT NULL,
  negative_lines  integer,                      -- NULL for vendor (buy) tables
  refreshed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION refresh_rate_table_stats(ids bigint[] DEFAULT NULL) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO rate_table_stats (rate_table_id, active_lines, negative_lines, refreshed_at)
  SELECT rt.id,
         (SELECT count(*) FROM rate_lines l
           WHERE l.rate_table_id = rt.id AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())),
         CASE WHEN rt.kind = 'customer' THEN (
           SELECT count(*) FROM rate_lines l
             JOIN best_buy_rates bb ON bb.mccmnc_id = l.mccmnc_id AND bb.product_category_id = rt.product_category_id
            WHERE l.rate_table_id = rt.id AND l.sender_id IS NULL AND NOT l.is_blocked
              AND l.valid_from <= now() AND (l.valid_to IS NULL OR l.valid_to > now())
              AND l.rate < bb.rate_usd * (SELECT cl.rate_per_usd FROM currency_latest cl WHERE cl.iso = rt.currency))
         END,
         now()
    FROM rate_tables rt
   WHERE ids IS NULL OR rt.id = ANY(ids)
  ON CONFLICT (rate_table_id) DO UPDATE
    SET active_lines = EXCLUDED.active_lines, negative_lines = EXCLUDED.negative_lines, refreshed_at = now();
$$;
