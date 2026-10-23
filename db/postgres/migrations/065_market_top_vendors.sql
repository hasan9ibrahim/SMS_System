-- Team trial round 5 (§13.14): hand-picked top vendors per destination for market move detection, instead of the
-- cheapest N. Tier 1 vendors count too when include_tier1. Destinations without a row follow unlisted_mode.
CREATE TABLE IF NOT EXISTS market_top_vendors (
  mccmnc_id        bigint PRIMARY KEY REFERENCES mccmnc(id) ON DELETE CASCADE,
  vendor_trunk_ids bigint[] NOT NULL DEFAULT '{}',
  include_tier1    boolean NOT NULL DEFAULT true,
  updated_by_id    bigint REFERENCES users(id),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE market_move_settings ADD COLUMN IF NOT EXISTS unlisted_mode text NOT NULL DEFAULT 'cheapest'
  CHECK (unlisted_mode IN ('cheapest', 'skip'));
