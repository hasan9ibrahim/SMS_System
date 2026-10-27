-- Blue-grey theme next to light and dark (team trial round 6, §15.2).
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_theme_check;
ALTER TABLE users ADD CONSTRAINT users_theme_check CHECK (theme IN ('light', 'dark', 'bluegrey'));
