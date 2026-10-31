-- Switch items approved 2026-10-31 (contract v0.131.0). Safe to run more than once.

-- Part Wise Routing removed (product owner 2026-10-31, spec §5.4, docs/SMPP_SCENARIOS.md S-3.8): the switch never
-- implemented it. The parts of a customer's multipart message are reassembled and routed as one message (S-3.2, S-4.3),
-- so the customer trunk setting goes. Old changes that name the field are skipped by undo; an import file that still
-- has the column is accepted and the column ignored.
ALTER TABLE customer_trunks DROP COLUMN IF EXISTS part_wise_routing;
