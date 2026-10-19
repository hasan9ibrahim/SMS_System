-- Finance (spec §7, §13.33), build step 5.5: transactions, currencies, exchange rates, billing
-- cycles, enterprise balances.
SET search_path = sms, public;

-- Transaction Conversion (§7): the Final Amount is in the enterprise's business company base
-- currency at the payment date, with the rate kept so later rate changes never move it.
ALTER TABLE transactions
  ADD COLUMN base_currency char(3) REFERENCES currencies(iso),
  ADD COLUMN ex_rate       numeric(18,8),
  -- §13.33 confirmation: when it was sent and to whom (re-sent copies overwrite).
  ADD COLUMN confirmation_sent_at   timestamptz,
  ADD COLUMN confirmation_recipients text[] NOT NULL DEFAULT '{}';

-- Rate as of a moment: units per USD, the latest row valid then (USD = 1).
CREATE FUNCTION rate_per_usd_at(p_iso char(3), p_at timestamptz) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p_iso = 'USD' THEN 1 ELSE COALESCE(
    (SELECT r.rate_per_usd FROM currency_rates r WHERE r.iso = p_iso AND r.valid_from <= p_at
      ORDER BY r.valid_from DESC LIMIT 1),
    (SELECT r.rate_per_usd FROM currency_rates r WHERE r.iso = p_iso ORDER BY r.valid_from LIMIT 1)) END
$$;

UPDATE transactions t
   SET base_currency = bc.base_currency,
       ex_rate = round(rate_per_usd_at(bc.base_currency, t.payment_date::timestamptz)
                       / rate_per_usd_at(t.currency, t.payment_date::timestamptz), 8)
  FROM enterprises e JOIN business_companies bc ON bc.id = e.business_company_id
 WHERE e.id = t.enterprise_id AND t.base_currency IS NULL;
UPDATE transactions SET amount_base = round(amount * ex_rate, 2) WHERE ex_rate IS NOT NULL;

-- Who last changed currencies and billing cycles (§13.10 history shows it too).
ALTER TABLE currencies ADD COLUMN updated_by_id bigint REFERENCES users(id);
ALTER TABLE billing_cycles ADD COLUMN updated_by_id bigint REFERENCES users(id);
-- Undoing an added currency archives it (§13.10); archived currencies leave pickers.
ALTER TABLE currencies ADD COLUMN deleted_at timestamptz;
