-- Tab groups with a label and colour, as in Chrome (team trial round 8, §13.5): [{id, label, color, collapsed}].
-- Each tab's group is in its own entry of `tabs` (groupId).
ALTER TABLE user_workspaces ADD COLUMN IF NOT EXISTS tab_groups jsonb NOT NULL DEFAULT '[]';
