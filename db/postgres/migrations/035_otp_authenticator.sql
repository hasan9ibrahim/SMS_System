-- Team trial round 1 (§13.28): OTP at login by e-mail or from an authenticator app.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_otp_method_check;
ALTER TABLE users ADD CONSTRAINT users_otp_method_check CHECK (otp_method IN ('off', 'email', 'authenticator'));
