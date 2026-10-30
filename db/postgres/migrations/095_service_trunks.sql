-- Team trial round 12 (§5.5): service trunks. A vendor trunk with protocol 'service' sends nothing: routed to, the
-- message is ended by the switch and the client gets a receipt with the trunk's dlr_timeout_stat after its
-- dlr_timeout_s. One outcome per trunk. Customer trunks stay SMPP or HTTP.
ALTER TABLE vendor_trunks DROP CONSTRAINT IF EXISTS vendor_trunks_protocol_check;
ALTER TABLE vendor_trunks ADD CONSTRAINT vendor_trunks_protocol_check CHECK (protocol IN ('smpp', 'http', 'service'));
