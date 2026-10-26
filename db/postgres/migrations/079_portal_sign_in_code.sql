-- Customer portal 2FA (backend step 13, spec §15 security): a code e-mailed at every portal sign-in, unless staff
-- turn it off for the user. The challenges share sign_in_challenges with staff sign-in: a row belongs to a staff user
-- or to a portal user, never both.
ALTER TABLE customer_portal_users
  ADD COLUMN IF NOT EXISTS otp_method text NOT NULL DEFAULT 'email' CHECK (otp_method IN ('email', 'off'));

ALTER TABLE sign_in_challenges ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE sign_in_challenges ADD COLUMN IF NOT EXISTS portal_user_id bigint REFERENCES customer_portal_users(id);
ALTER TABLE sign_in_challenges DROP CONSTRAINT IF EXISTS sign_in_challenges_one_user;
ALTER TABLE sign_in_challenges ADD CONSTRAINT sign_in_challenges_one_user
  CHECK (num_nonnulls(user_id, portal_user_id) = 1);
CREATE INDEX IF NOT EXISTS sign_in_challenges_portal_idx ON sign_in_challenges (portal_user_id, created_at DESC)
  WHERE portal_user_id IS NOT NULL;
