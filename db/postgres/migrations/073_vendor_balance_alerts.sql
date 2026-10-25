-- Product owner decisions 2026-10-25 (backend step 6, contract v0.95.0):
--
-- 1. Prepaid vendors (Q22): the vendor side can be prepaid (we pay the vendor in advance), with balance alerts when a
--    share of the prepaid funds is used: Notice / Warning / Critical, default 50 / 70 / 90 %, set per vendor.
-- 2. Payments, invoices and vendor invoices in another currency count in a balance at the exchange rate of their own
--    date (`rate_per_eur_at`), not as entered.

ALTER TABLE enterprise_billing
  ADD COLUMN IF NOT EXISTS balance_alert boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS balance_alert_notice smallint NOT NULL DEFAULT 50 CHECK (balance_alert_notice BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS balance_alert_warning smallint NOT NULL DEFAULT 70 CHECK (balance_alert_warning BETWEEN 1 AND 100),
  ADD COLUMN IF NOT EXISTS balance_alert_critical smallint NOT NULL DEFAULT 90 CHECK (balance_alert_critical BETWEEN 1 AND 100);

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
         SELECT sum(CASE WHEN (b.side = 'customer') = (tx.payment_type = 'credit') THEN 1 ELSE -1 END
                    * CASE WHEN tx.currency = b.currency THEN tx.amount
                           ELSE tx.amount * rate_per_eur_at(b.currency, tx.payment_date::timestamptz)
                                / rate_per_eur_at(tx.currency, tx.payment_date::timestamptz) END)
                AS amount
           FROM transactions tx
          WHERE tx.enterprise_id = b.enterprise_id AND tx.side = b.side AND tx.deleted_at IS NULL) p ON true
  LEFT JOIN LATERAL (
         SELECT CASE WHEN b.side = 'customer'
                  THEN (SELECT sum(CASE WHEN iv.currency = b.currency THEN iv.usage_charges
                                        ELSE iv.usage_charges * rate_per_eur_at(b.currency, iv.invoice_date::timestamptz)
                                             / rate_per_eur_at(iv.currency, iv.invoice_date::timestamptz) END)
                          FROM invoices iv
                         WHERE iv.enterprise_id = b.enterprise_id AND iv.deleted_at IS NULL AND iv.status <> 'failed'
                           AND iv.kind = 'traffic')
                  ELSE (SELECT sum(CASE WHEN vi.currency = b.currency THEN vi.charge_amount
                                        ELSE vi.charge_amount * rate_per_eur_at(b.currency, vi.invoice_date::timestamptz)
                                             / rate_per_eur_at(vi.currency, vi.invoice_date::timestamptz) END)
                          FROM vendor_invoices vi
                         WHERE vi.enterprise_id = b.enterprise_id AND vi.deleted_at IS NULL
                           AND vi.recon_status = 'accepted')
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
