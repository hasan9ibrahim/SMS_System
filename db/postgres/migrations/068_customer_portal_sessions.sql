-- Customer portal sign-in (§1, team trial round 5): portal sessions live in user_sessions (user_kind = 'customer'),
-- found by a hash of the session cookie. Five wrong passwords in a row lock a portal user for 15 minutes.
ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS token_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS user_sessions_token_uq ON user_sessions (token_hash) WHERE token_hash IS NOT NULL;
ALTER TABLE customer_portal_users ADD COLUMN IF NOT EXISTS failed_logins smallint NOT NULL DEFAULT 0;
ALTER TABLE customer_portal_users ADD COLUMN IF NOT EXISTS locked_until timestamptz;
