-- Route Rules page (build step 4.3, contract v0.5.0, spec §15.4, §13.27).
SET search_path = sms, public;

-- Traffic per rule and time frame for the grid's 24h / ASR / DLR / Margin columns, so they
-- can be filtered and sorted with the rest of the list. Filled from the EDR store every
-- minute (the backend can fill it from its live counters instead). Margin in base currency.
CREATE TABLE route_rule_traffic (
  route_rule_id bigint NOT NULL REFERENCES route_rules(id),
  time_window   text NOT NULL CHECK (time_window IN ('15m', '1h', '24h', '7d', '30d')),
  messages      integer NOT NULL,
  asr           numeric(5, 1),          -- delivery-attempt success %
  dlr           numeric(5, 1),          -- delivered % of accepted
  margin        numeric(14, 2) NOT NULL,
  refreshed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (time_window, route_rule_id)
);
