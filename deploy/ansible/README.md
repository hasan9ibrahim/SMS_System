# Servers: setup, deploys, failover (backend step 8)

The two servers and the witness VM are set up and updated from this folder with Ansible, run from the engineer's
machine over SSH. Everything here was rehearsed on three local machines (`deploy/lab`, results in
`docs/FAILOVER_DRILLS.md`); on the real servers it is the same playbooks with the production inventory.

Fake data only until the go-live (CLAUDE.md rule 1).

**Starting on one server:** `inventories/single.example` runs everything on one machine (each piece of data stored
once, no witness, monitoring on the server itself, no cluster alerts). The step-by-step guide, including pointing a
domain at it and adding the second server and the witness later, is `docs/DEPLOY_SINGLE_SERVER.md`. Any other mix
(two servers without the witness) is refused by the playbook.

## What runs where

| | srv-a | srv-b | witness VM |
| --- | --- | --- | --- |
| Switch (`sms-switch`) | traffic | traffic | `SWITCH_ROLE=witness`: no traffic, breaks ties |
| API (in `sms-switch`, 127.0.0.1:4100) | ✓ | ✓ | – |
| TypeScript service (`sms-service`, 127.0.0.1:4010; jobs on one server at a time) | ✓ | ✓ | – |
| nginx: the screens and the portal over HTTPS (80 → 443) | ✓ | ✓ | – |
| PostgreSQL 16 (Patroni) | primary or standby | primary or standby | – |
| HAProxy → current primary | 127.0.0.1:5432 | 127.0.0.1:5432 | – |
| etcd (Patroni's lease) | ✓ | ✓ | ✓ |
| Redis | primary or replica | primary or replica | – |
| Redis Sentinel | ✓ | ✓ | ✓ |
| NATS JetStream (every event on all three) | ✓ | ✓ | ✓ (third copy) |
| ClickHouse (EDRs, replicated) | ✓ (+ Keeper) | ✓ (+ Keeper) | Keeper only |
| Prometheus, Alertmanager, Grafana | – | – | ✓ |
| Exporters, backups, traffic recording | ✓ | ✓ | exporters |

Every vote (etcd, Sentinel, NATS, Keeper, the switch's own) needs 2 of the 3 machines (BACKEND_PLAN §3.5).

**When the two servers lose each other** but both still reach the witness, the one holding the PostgreSQL primary
keeps all traffic; the other steps back (`Sms.Switch.Fence`): it unbinds its customers (they reconnect to the other
server's address), closes its vendor connections (the other server opens them all) and stops its NATS, Redis and
ClickHouse so every primary moves to the active side. When the link is back it resumes on its own. A server that is
really down (the witness lost it too) is simply taken over.

## Sizing (production)

Sized 2026-10-27 for 10 million messages a day (product owner): detailed EDRs 6 months on the servers and 6 more
off-site, report totals for ever, traffic recording 60 days on the servers and 60 more off-site (docs/BACKEND_PLAN.md
§3.7).

| Machine | CPU / RAM | Disk |
| --- | --- | --- |
| Each server | 12+ fast cores (e.g. Ryzen 9 5900X), 64 GB (128 GB makes year-long reports faster) | 2 × 3.84 TB NVMe, RAID 1 |
| Witness VM | 4–6 vCPU, 8–12 GB | 200 GB (100 GB is the minimum) |
| Off-site bucket | – | S3-compatible, at another provider: EDR months 7–12, recording days 61–120 and backups, from ~2 TB |

What one server stores at 10 million messages a day (both servers hold every EDR):

| Data | Size |
| --- | --- |
| Detailed EDRs, the last 6 months (`edr_hot_months`; ClickHouse, ~250–450 bytes a message) | 0.45–0.8 TB |
| Report totals per 15 minutes and Sender IDs per day, kept for ever | tens of GB a year (measure in the first month) |
| Traffic recording, 60 days (`pcap_local_days`, gzipped; ~2 KB a message before) | 0.2–0.4 TB |
| Event bus, 2 days (`max_age_days`; capped by `nats_max_file_store`, 200 G) | ~0.2 TB |
| PostgreSQL, OS, applications, logs, ClickHouse merge headroom | ~0.2 TB |
| **Total** | **~1.1–1.6 TB of 3.84 TB** |

Off-site, each server writes its own copy of EDR months 7–12 (ClickHouse tiered storage, 0.45–0.8 TB each) and its
recording days 61–120 (0.15–0.2 TB each). RAM at that volume: ~22–32 GB in use, up to ~50 GB when year-long reports
meet a traffic peak (ClickHouse is capped at 40 %); the rest is file cache.

Each server can carry all the traffic alone (1,000 TPS peak). The witness keeps a third copy of the event bus (capped
at 60 G there, `inventories/production.example/hosts.yml`) and Prometheus (30 days, at most 15 GB). Storage grows with
traffic: at about 150 million messages a month, look again at the disks or the months kept online.

## First setup

1. **Machines:** Ubuntu 24.04, root SSH key access from the engineer's machine, a private network (or VPN) between
   the three. Two servers in two data centres of the same provider, the witness at another provider (Q32).
2. **Bucket:** create the S3 bucket for backups at the storage provider, and an access key limited to it.
3. **Inventory:** copy `inventories/production.example` to `inventories/production`, fill in `hosts.yml` (public and
   private addresses) and `group_vars/all/main.yml` (admin ranges, partner ranges, S3, Telegram chats). Then:

   ```sh
   cp inventories/production/group_vars/all/secrets.example.yml inventories/production/group_vars/all/secrets.yml
   # fill in every CHANGE_ME (openssl rand -hex 24), then
   ansible-vault encrypt inventories/production/group_vars/all/secrets.yml
   ```

   Keep the vault password and a copy of `vault_pgbackrest_cipher_pass` outside the servers: without it the backups
   cannot be read.
4. **Install:** `pip install ansible-core`, then

   ```sh
   ansible-playbook -i inventories/production site.yml --ask-vault-pass
   ```

   `site.yml` is safe to run again; run it after any change to the inventory or the roles.
5. **Screens and e-mail (backend step 14):** in the inventory set `web_domain` (the name DNS points at both servers),
   `smtp_from`, and `vault_smtp_url` in the secrets; put the certificate (full chain) and key for `web_domain` on both
   servers at `web_tls_certfile` / `web_tls_keyfile` before `site.yml` (the web role stops without them). Then deploy a
   release (below) and create the first administrator: `docs/GO_LIVE.md` has the whole list.
6. **Telegram:** create a bot with @BotFather, add it to the engineer's and the NOC's chats, put the token and the
   chat ids in the inventory, run `site.yml` again. Test: stop the switch on one server for two minutes.

## Deploying a new version

```sh
./build-release.sh                       # on Ubuntu 24.04 with Node.js 22; prints the release id, e.g. 1a2b3c4d5e
ansible-playbook -i inventories/production deploy.yml -e release=1a2b3c4d5e --ask-vault-pass
```

`deploy.yml` uploads the release to the three machines, runs the database migrations once (from srv-a), then
restarts srv-a, srv-b and the witness one at a time: each stops cleanly (customers unbound, vendors unbound, queued
work left to the other server), starts the new version, and must be healthy, back in the cluster and have its routing
configuration before the next one goes. Then, one server at a time, the TypeScript service is pointed at the new
release, restarted and must answer, and the screens are switched to the new files (nginx serves them at once). While
one server's service restarts (a few seconds) its API answers 502; the other server is unaffected. In the lab, a deploy under 100 msg/s took about a minute with no message lost
(2 submits refused, 49 resent by the customers after their session closed).

**Migrations** must work with the version still running on the other server: add columns and tables, never rename or
drop in the same release (spec §14.1). `bin/sms eval "Sms.Core.Release.migrate()"` refuses a file whose content
changed after it was applied.

**Rollback:** the same command with the previous release id. The last five releases stay on the machines. A
migration is not rolled back; that is why migrations must suit both versions.

## Planned maintenance

| Task | How |
| --- | --- |
| Move the PostgreSQL primary (before working on its server) | `patronictl -c /etc/patroni/config.yml switchover --candidate srv-b` (no message lost in the lab, no error) |
| Take a server out | `systemctl stop sms-switch` on it (the other takes customers and vendors), then the services |
| Reboot a server | switchover first if it is the primary, then reboot; it rejoins by itself |
| Check the cluster | `patronictl -c /etc/patroni/config.yml list`, `redis-cli -p 26379 -a … sentinel masters`, `nats server ls` (with `--user sms --password …`), Grafana |
| Restore test by hand | `sms-restore-test` on the standby (monthly by timer) |
| Backup by hand | `sms-backup full` on the primary |

## Backups (Q31)

- PostgreSQL: pgBackRest to the bucket, encrypted. WAL archived continuously, full backup on Sunday, differential the
  other nights, four full backups kept. Point-in-time restore: `pgbackrest --stanza=sms --type=time
  --target="2026-11-20 10:00:00+00" restore` on a stopped standby (see `docs/RUNBOOKS.md#restore`).
- ClickHouse: the EDR database to the same bucket nightly (full on Sunday, incremental otherwise). Old ClickHouse
  backups are removed by a lifecycle rule on the bucket (set it at the provider: 35 days).
- NATS is not backed up: it holds 2 days of events in flight on three machines.
- Every run is recorded for monitoring; an alert fires after 26 hours without a backup, and after 35 days without a
  passing restore test. The restore test measures how long a restore takes (plan §4).

## Monitoring (Q29)

Grafana at `http://<witness>:3000` (admin password in the vault), dashboard "SMS platform". Prometheus keeps 30
days. Alerts (`roles/monitoring/files/alerts.yml`) go to Telegram: critical ones at any hour (traffic stopped or at
risk), warnings in working hours. Each alert names its runbook in `docs/RUNBOOKS.md`.

## Traffic recording (spec §9.2)

`dumpcap` on each server writes the SMPP traffic (customers and vendors, not the traffic between the three machines)
in files of whole 15-minute quarters (UTC) outside the switch (`roles/pcap`). Every 15 minutes `sms-pcap-archive`
gzips finished files, moves those older than `pcap_local_days` (60) to the off-site bucket (`pcap/<server>/`, deleted
there after `pcap_offsite_days` more) and lists them in `archive.index`; the switch fetches a moved file back when a
screen reads or extracts it (`sms-pcap-fetch`, rclone; alert PcapArchiveFailing). The switch reads
them for the PCAP screens (backend step 11c): the PCAP Trace list and downloads (both servers' files of a quarter joined
into one pcapng), and Extract Recording (`tshark` cuts the window's files with the criteria). Live captures run
`dumpcap` as the switch user (capture rights through the `wireshark` group, effective after the switch's next restart)
and write to `/var/lib/sms-pcap/captures`, kept 30 days unless kept on the screen. Network Diagnosis uses `ping`,
`traceroute`, `mtr` and a TCP connect on the server that has the chosen source address.

## Firewall

Only listed traffic is accepted (`roles/base/templates/nftables.conf.j2`): SSH and the monitoring pages from
`admin_cidrs`, SMPP from `smpp_cidrs`, HTTPS (and 80, which only redirects) to the servers from `web_cidrs` (everyone
by default, for the customer portal), the cluster's ports between the three machines only. The API and the TypeScript
service listen on the servers' loopback only, behind nginx. The Firewall screen's
banned and trusted lists (§8) apply on top, in the switch.
