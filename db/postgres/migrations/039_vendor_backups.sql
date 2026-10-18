-- Team trial round 1 (§6.3): a backup vendor can stand in for one primary vendor of the rule. When that
-- vendor is rejected, its traffic goes to its backups (split by their share %) before anything else.
ALTER TABLE route_rule_vendors ADD COLUMN IF NOT EXISTS backup_for_vendor_trunk_id bigint REFERENCES vendor_trunks(id);
