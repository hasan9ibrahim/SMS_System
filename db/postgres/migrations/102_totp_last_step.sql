-- Authenticator codes work once (§13.28, §13.22). A code stays valid for its 30-second step and the clock-drift steps
-- either side, so a code seen over someone's shoulder or caught in transit could be used again inside that time. The
-- last step accepted for the user is kept here; a code whose step is not later is refused ("This code was already
-- used"). It is moved forward with one conditional UPDATE (… WHERE totp_last_step IS NULL OR totp_last_step < $step
-- RETURNING), so two requests with the same code cannot both pass. Both the Elixir API (sign-in) and the TypeScript
-- service (sign-in, enrolment, password change, credential exports and imports) use it. A new or removed
-- authenticator secret clears it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step bigint;
