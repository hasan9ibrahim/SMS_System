-- Favourite pages in Search or jump to (Ctrl K, team trial round 6, §15.1), per user.
ALTER TABLE users ADD COLUMN IF NOT EXISTS favourite_pages text[] NOT NULL DEFAULT '{}';
