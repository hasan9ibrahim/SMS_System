-- Money keeps 4 decimals (Q20 in docs/BACKEND_PLAN.md, backend step 12): invoice, payment, SOA, balance, credit and
-- limit amounts move from cents (numeric(14,2)) to numeric(16,4). Existing values keep their cents. The balance_ledger
-- view (072/073) reads these columns, so it is dropped and created again with its own definition.
BEGIN;
CREATE TEMP TABLE money_4dp_views ON COMMIT DROP AS
  SELECT 'balance_ledger'::text AS name, pg_get_viewdef('balance_ledger'::regclass, true) AS def;
DROP VIEW balance_ledger;
ALTER TABLE invoices
  ALTER COLUMN opening_balance TYPE numeric(16,4),
  ALTER COLUMN usage_charges   TYPE numeric(16,4),
  ALTER COLUMN closing_balance TYPE numeric(16,4),
  ALTER COLUMN due_amount      TYPE numeric(16,4);
ALTER TABLE invoice_requests ALTER COLUMN amount TYPE numeric(16,4);
ALTER TABLE transactions
  ALTER COLUMN amount      TYPE numeric(16,4),
  ALTER COLUMN amount_base TYPE numeric(16,4);
ALTER TABLE soa_adjustments ALTER COLUMN amount TYPE numeric(16,4);
ALTER TABLE soa_reports ALTER COLUMN closing_balance TYPE numeric(16,4);
ALTER TABLE vendor_invoices
  ALTER COLUMN charge_amount TYPE numeric(16,4),
  ALTER COLUMN our_amount    TYPE numeric(16,4);
ALTER TABLE recon_rules ALTER COLUMN amount_fixed TYPE numeric(16,4);
ALTER TABLE enterprise_billing
  ALTER COLUMN credit_limit    TYPE numeric(16,4),
  ALTER COLUMN opening_balance TYPE numeric(16,4);
ALTER TABLE customer_trunks ALTER COLUMN revenue_limit TYPE numeric(16,4);
ALTER TABLE vendor_trunks ALTER COLUMN cost_limit TYPE numeric(16,4);
ALTER TABLE hlr_providers ALTER COLUMN daily_budget TYPE numeric(14,4);
ALTER TABLE route_rule_traffic ALTER COLUMN margin TYPE numeric(16,4);
ALTER TABLE user_targets
  ALTER COLUMN revenue_target TYPE numeric(16,4),
  ALTER COLUMN margin_target  TYPE numeric(16,4);

DO $$
DECLARE v record;
BEGIN
  FOR v IN SELECT name, def FROM money_4dp_views LOOP
    EXECUTE format('CREATE VIEW %I AS %s', v.name, v.def);
  END LOOP;
END $$;
COMMIT;
