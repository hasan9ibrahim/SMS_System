-- Backend step 11c: the traffic recording's files on each switch server (spec §9.2 PCAP Trace), refreshed every minute
-- from the switches (mock/src/switch/operations.ts refreshPcapFiles), so the PCAP Trace list filters, sorts and pages
-- on the server like every other list. One row per server and 15-minute file; the list joins a quarter's files.
CREATE TABLE IF NOT EXISTS pcap_files (
  node         text        NOT NULL,
  name         text        NOT NULL,
  started_at   timestamptz NOT NULL,
  size_bytes   bigint      NOT NULL,
  modified_at  timestamptz NOT NULL,
  PRIMARY KEY (node, name)
);

CREATE INDEX IF NOT EXISTS pcap_files_started_at ON pcap_files (started_at);
