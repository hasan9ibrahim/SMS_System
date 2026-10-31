-- Archive, restore and undo reach the switch (QA 2026-10-31, §13.29, §13.10). The switch reloads its configuration when
-- a fingerprint changes (Sms.Switch.Pipeline.Config.Loader), for these tables their row count and latest updated_at.
-- Archiving keeps the row and sets deleted_at, and the archive, restore and undo writes left updated_at as it was, so
-- an archived trunk, enterprise, rate table or HLR rule kept routing until something else changed. Any write that
-- changes deleted_at now moves updated_at too, whoever writes it (the TS service, the Elixir API, undo). The clock
-- rather than the transaction's start, so the change is later than anything committed while it ran.
CREATE OR REPLACE FUNCTION touch_updated_at_on_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['business_companies', 'customer_trunks', 'dial_codes', 'enterprises', 'hlr_policies',
                           'hlr_provider_rates', 'hlr_providers', 'hlr_rules', 'mccmnc', 'number_lists', 'rate_tables',
                           'vendor_trunks'] LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER archive_touches_updated_at BEFORE UPDATE OF deleted_at ON %I FOR EACH ROW '
      'WHEN (OLD.deleted_at IS DISTINCT FROM NEW.deleted_at) EXECUTE FUNCTION touch_updated_at_on_archive()', t);
  END LOOP;
END
$$;
