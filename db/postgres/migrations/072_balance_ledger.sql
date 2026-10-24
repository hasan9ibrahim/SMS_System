-- Backend build step 6: live balances (spec §7, decision Q24, product owner 2026-10-24).
--
-- A partner's balance is its opening balance, plus payments, minus invoiced charges, minus the traffic not invoiced
-- yet. The switch charges each message when it becomes billable (Billing Type) into 15-minute buckets, kept in Redis
-- for the per-message credit check and written here every few seconds; an invoice covers the buckets up to the end of
-- its usage period (midnight in the partner's time zone), so later buckets are the uninvoiced traffic.
--
-- Credit check (product owner): a customer may send while balance + credit limit covers the message; prepaid has no
-- credit limit, so it stops at 0. Credit alerts start once the balance is below 0 and the credit limit is being used.

CREATE TABLE IF NOT EXISTS traffic_charges (
  enterprise_id  bigint NOT NULL REFERENCES enterprises(id),
  side           text NOT NULL CHECK (side IN ('customer','vendor')),
  bucket         timestamptz NOT NULL,                 -- start of the 15-minute bucket (UTC)
  amount         numeric(18,6) NOT NULL DEFAULT 0,     -- in the side's billing currency
  messages       bigint NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enterprise_id, side, bucket)
);

-- One row per enterprise and billing side: the parts of the balance and the balance itself (positive = the partner's
-- credit, negative = owed; the sign convention of 016_balance_sign.sql).
CREATE OR REPLACE VIEW balance_ledger AS
SELECT b.enterprise_id,
       b.side,
       b.currency,
       b.billing_type,
       b.credit_limit,
       b.opening_balance + COALESCE(p.amount, 0) - COALESCE(i.amount, 0) AS base,
       c.cutoff,
       COALESCE(t.amount, 0)                                            AS uninvoiced,
       b.opening_balance + COALESCE(p.amount, 0) - COALESCE(i.amount, 0) - COALESCE(t.amount, 0) AS balance
  FROM enterprise_billing b
  LEFT JOIN LATERAL (
         SELECT sum(CASE WHEN (b.side = 'customer') = (tx.payment_type = 'credit') THEN tx.amount ELSE -tx.amount END)
                AS amount
           FROM transactions tx
          WHERE tx.enterprise_id = b.enterprise_id AND tx.side = b.side AND tx.deleted_at IS NULL) p ON true
  LEFT JOIN LATERAL (
         SELECT CASE WHEN b.side = 'customer'
                  THEN (SELECT sum(usage_charges) FROM invoices
                         WHERE enterprise_id = b.enterprise_id AND deleted_at IS NULL AND status <> 'failed'
                           AND kind = 'traffic')
                  ELSE (SELECT sum(charge_amount) FROM vendor_invoices
                         WHERE enterprise_id = b.enterprise_id AND deleted_at IS NULL AND recon_status = 'accepted')
                END AS amount) i ON true
  LEFT JOIN LATERAL (
         SELECT COALESCE(CASE WHEN b.side = 'customer'
                  THEN (SELECT (max(usage_end) + 1)::timestamp AT TIME ZONE b.timezone FROM invoices
                         WHERE enterprise_id = b.enterprise_id AND deleted_at IS NULL AND status <> 'failed'
                           AND kind = 'traffic')
                  ELSE (SELECT (period_to + 1)::timestamp AT TIME ZONE timezone FROM vendor_invoices
                         WHERE enterprise_id = b.enterprise_id AND deleted_at IS NULL AND recon_status = 'accepted'
                         ORDER BY period_to DESC LIMIT 1)
                END, '-infinity'::timestamptz) AS cutoff) c ON true
  LEFT JOIN LATERAL (
         SELECT sum(amount) AS amount FROM traffic_charges tc
          WHERE tc.enterprise_id = b.enterprise_id AND tc.side = b.side AND tc.bucket >= c.cutoff) t ON true;
