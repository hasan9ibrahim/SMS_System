-- Team trial round 12: a new enterprise has no rate increase notice unless one is set (it was 7 days, and new
-- customer increases then started a week later, so a rate just set did not show in Rate lookup). Existing
-- enterprises keep their own setting.
ALTER TABLE enterprises ALTER COLUMN rate_notice_days SET DEFAULT 0;
