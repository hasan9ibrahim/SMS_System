-- Team trial round 2: notice periods for decreases and new destinations next to increases, how each partner
-- writes "all networks" in rate sheets, and the header row an incoming RN was read from.
ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS rate_notice_days_decrease integer NOT NULL DEFAULT 0
  CHECK (rate_notice_days_decrease BETWEEN 0 AND 90);
ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS rate_notice_days_new integer NOT NULL DEFAULT 0
  CHECK (rate_notice_days_new BETWEEN 0 AND 90);
ALTER TABLE enterprises ADD COLUMN IF NOT EXISTS all_networks_code text NOT NULL DEFAULT 'mcc'
  CHECK (all_networks_code IN ('mcc', 'mcc0', 'mcc00', 'mcc000', 'mccStar'));
ALTER TABLE rate_notifications ADD COLUMN IF NOT EXISTS header_row integer;
