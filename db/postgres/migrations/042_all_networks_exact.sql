-- A 3-digit code is the country's "All networks" default entry, not the whole country (team trial
-- round 1, §6.1, §13.21). Rules that used a 3-digit code for the whole country now list every code of
-- that country (its networks and its All networks entry), so they route exactly as before.
BEGIN;
CREATE TEMP TABLE expand_codes ON COMMIT DROP AS
  SELECT mcc, array_agg(mccmnc ORDER BY is_all_networks DESC, mccmnc) AS codes
    FROM mccmnc WHERE deleted_at IS NULL GROUP BY mcc;

UPDATE route_rules r SET mccmncs = (
    SELECT array_agg(DISTINCT x) FROM (
      SELECT c AS x FROM unnest(r.mccmncs) c WHERE length(c) <> 3
      UNION ALL
      SELECT unnest(COALESCE(e.codes, ARRAY[c])) FROM unnest(r.mccmncs) c LEFT JOIN expand_codes e ON e.mcc = c
       WHERE length(c) = 3) t)
 WHERE EXISTS (SELECT 1 FROM unnest(r.mccmncs) c WHERE length(c) = 3);

UPDATE translation_rules r SET mccmncs = (
    SELECT array_agg(DISTINCT x) FROM (
      SELECT c AS x FROM unnest(r.mccmncs) c WHERE length(c) <> 3
      UNION ALL
      SELECT unnest(COALESCE(e.codes, ARRAY[c])) FROM unnest(r.mccmncs) c LEFT JOIN expand_codes e ON e.mcc = c
       WHERE length(c) = 3) t)
 WHERE EXISTS (SELECT 1 FROM unnest(r.mccmncs) c WHERE length(c) = 3);
COMMIT;
