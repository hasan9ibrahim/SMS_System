-- Administrator access group (§11, team trial round 10). Users given the "Administrator" group did not see the Admin
-- pages: only users.is_admin (the first administrator, made by the bootstrap) counted as an administrator, and the
-- group's Every page grant never covers the Admin pages. A group can now make its users full administrators.
ALTER TABLE access_groups ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false;
-- The starting group of that name (bootstrap and generator): its users become administrators.
UPDATE access_groups SET is_admin = true WHERE name = 'Administrator';
