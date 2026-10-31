-- Switch items approved 2026-10-31 (contract v0.131.0). Additive only; safe to run more than once.

-- Part Wise Routing removed (product owner 2026-10-31, spec §5.4, docs/SMPP_SCENARIOS.md S-3.8): the switch never
-- implemented it. The parts of a customer's multipart message are reassembled and routed as one message (S-3.2, S-4.3),
-- so the customer trunk setting goes from the contract, the services, the screens and the import (an import file that
-- still has the column is accepted and the column ignored; undo of an old change naming the field writes nothing).
-- customer_trunks.part_wise_routing is now UNUSED but kept in this release: migrations must work with the version
-- still running on the other server while a deploy rolls (add, never rename or drop in the same release; Sms.Core.
-- Release), and that version still reads the column. Its NOT NULL DEFAULT false lets new rows leave it out. Drop it in
-- the next release (ALTER TABLE customer_trunks DROP COLUMN IF EXISTS part_wise_routing).

-- Credit reserved for messages in flight (§7, decision Q24 follow-up, product owner 2026-10-31, docs/SMPP_SCENARIOS.md
-- S-6.3): the switch holds a customer message's full cost against the account when it accepts the message (available
-- = base + credit limit - charged - held) until the charge replaces the hold or a final outcome that bills nothing
-- releases it. The holds live in Redis; the switch's ledger sync writes each customer account's total here every few
-- seconds when it changes (Sms.Switch.Pipeline.Ledger.Sync), so the Enterprise Balance screen shows "Reserved" next
-- to the balance. Amounts in the customer billing currency.
CREATE TABLE IF NOT EXISTS credit_reservations (
  enterprise_id  bigint PRIMARY KEY REFERENCES enterprises(id),
  reserved       numeric(18,6) NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
