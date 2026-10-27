-- Team trial round 6 defaults (product owner 2026-10-27): loop detection off on new customer trunks (§5), the Bind Down
-- alert off on new enterprises (§8), any destination TON/NPI on new vendor trunks (§5), warm-ups counted per customer
-- trunk and reset daily (§13.27). Existing rows keep their settings.
SET search_path = sms, public;
ALTER TABLE customer_trunks ALTER COLUMN loop_detection SET DEFAULT false;
ALTER TABLE enterprises ALTER COLUMN bind_alert SET DEFAULT false;
ALTER TABLE vendor_trunks ALTER COLUMN allowed_dst_ton SET DEFAULT NULL;
ALTER TABLE vendor_trunks ALTER COLUMN allowed_dst_npi SET DEFAULT NULL;
