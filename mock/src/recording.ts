// Traffic recording (§9.2, team trial round 1): every packet kept this many days, 60 on the servers and 60 more
// off-site, fetched back when read (product owner 2026-10-27; PCAP_RECORDING_DAYS from deploy/ansible roles/service).
export const RECORDING_DAYS = Number(process.env.PCAP_RECORDING_DAYS ?? 120);
