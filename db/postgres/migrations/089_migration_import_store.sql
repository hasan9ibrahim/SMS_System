-- Migration Center imports (§13.22, team trial round 9).
-- The uploaded files were kept in the service's private /tmp, which systemd empties on every restart (each update), so
-- Apply after an update failed. They are now kept here, encrypted (MOCK_SECRET_KEY), and removed with the import.
ALTER TABLE migration_imports ADD COLUMN IF NOT EXISTS files_enc text;
-- Apply runs in the background (status 'applying'); why the last one wrote nothing.
ALTER TABLE migration_imports ADD COLUMN IF NOT EXISTS apply_error text;
-- Delete an import: hidden from the list, files removed; an applied import's change stays in History.
ALTER TABLE migration_imports ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE migration_imports DROP CONSTRAINT IF EXISTS migration_imports_status_check;
ALTER TABLE migration_imports ADD CONSTRAINT migration_imports_status_check
  CHECK (status IN ('validated', 'applying', 'applied', 'failed'));
