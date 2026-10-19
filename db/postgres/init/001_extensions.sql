-- Runs once, on first start of an empty volume (docker-entrypoint-initdb.d).
-- Tables come with the data generator (build-order step 2) as versioned migrations
-- under db/postgres/migrations/, written so the Elixir backend can reuse them (spec §14).

-- Case-insensitive wildcard search (% and _) and regex filters on every list (spec §13.25)
-- are served by trigram indexes.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
-- Case-insensitive text columns (names, aliases, usernames).
CREATE EXTENSION IF NOT EXISTS citext;
-- UUIDs for EDR and audit references.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Application schema; the Elixir backend uses the same one later.
CREATE SCHEMA IF NOT EXISTS sms;
