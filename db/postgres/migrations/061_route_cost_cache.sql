-- Rate Manager (team trial round 2, §13.12, §6.3): the vendor and cost the route rules choose for each destination
-- of a customer trunk, so sell lines show margin against the routed cost instead of the best buy. Filled by the
-- mock from the same engine as the Route map; the Elixir backend keeps it current from routing changes.
SET search_path = sms, public;

CREATE TABLE IF NOT EXISTS route_cost_cache (
  customer_trunk_id integer NOT NULL,
  mccmnc_id integer NOT NULL,
  vendor_trunk_id integer,
  vendor_name text,
  cost_eur numeric(16, 6),
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_trunk_id, mccmnc_id)
);
