# Runbooks (backend step 8, Q29)

What to check and what to do for each alert (`deploy/ansible/roles/monitoring/files/alerts.yml`). Commands run on
the machine named in the alert unless said otherwise. Secrets are in the Ansible vault. Fake data only until go-live.

Useful everywhere:

```sh
systemctl status sms-switch; journalctl -u sms-switch -n 200 -o cat     # the switch (JSON lines)
curl -s 127.0.0.1:9568/health; curl -s 127.0.0.1:9568/metrics | grep ^sms_
patronictl -c /etc/patroni/config.yml list                               # PostgreSQL primary / standby
redis-cli -p 26379 -a "$REDIS_PW" sentinel get-master-addr-by-name sms   # Redis primary
nats --user sms --password "$NATS_PW" server ls                          # NATS cluster (also: stream info SMS)
```

## MachineDown

A machine does not answer the monitoring host. **Check:** can you SSH to it? The provider's console (power, network).
**What happens on its own:** a server that is down is taken over by the other within about 30 s: customers reconnect
to the other address, the other server opens every vendor connection, PostgreSQL and Redis fail over, NATS and Keeper
continue on 2 of 3 (lab: no message lost). If the **witness** is down nothing changes for traffic, but one more
failure would stop the votes: bring it back soon. **Do:** restart the machine at the provider; it rejoins by itself.
Check afterwards: `patronictl list` (it comes back as standby), Grafana "Cluster peers" back to 2.

## DiskFilling

**Check:** `df -h`, then `du -sh /var/lib/{nats,postgresql,clickhouse,sms-pcap} /var/log`. **Do:** traffic recording
is the easiest to shrink (`pcap_local_days` in the inventory, then `site.yml`: older files go off-site at the next
`sms-pcap-archive`); EDRs older than `edr_hot_months` should be on the off-site volume (`SELECT disk_name,
formatReadableSize(sum(bytes_on_disk)) FROM system.parts WHERE active GROUP BY disk_name`); NATS keeps 2 days (`max_age_days`);
PostgreSQL WAL piling up means archiving fails (see BackupFailed). **At 5 %** (DiskAlmostFull) act at once: a full
disk stops NATS JetStream (it turns itself off and stays off until `systemctl restart nats` once space is free —
found in the lab) and Redis writes.

## MemoryLow

**Check:** `top` sorted by memory. ClickHouse is capped at a share of RAM (`ch_memory_ratio`), Redis at `maxmemory`.
A switch above a few GB means a backlog: see SwitchOverloaded.

## SwitchDown

The switch is down, or a data store does not answer it (`/health` names which). **Check:** `systemctl status
sms-switch`, `curl 127.0.0.1:9568/health`. **Do:** a crashed switch restarts by itself (systemd); a store that does
not answer: see its runbook below. If the other server is healthy, customers and vendors are already there.

## SwitchOverloaded

New submits are refused with 0x58 because accepted messages wait over 10 s for the sender (customers slow down and
retry; nothing accepted is lost). **Check:** Grafana "Sender backlog", CPU, the vendors' answer times. Seen briefly
in the lab right after a server failure while the databases fail over. **Do:** if it lasts, look for a slow vendor or
a stuck store; the guard ends by itself when the wait drops, or when nothing is waiting any more.

## ClusterSplit

(ServerSteppedBack, VendorSideMinority, ClusterPeerLost.) The servers lost each other. **ServerSteppedBack** is the
designed reaction: the server without the PostgreSQL primary stepped back, all traffic is on the other server, the
stepped-back one stopped its NATS, Redis and ClickHouse (`journalctl -t sms-step-back`). **Check:** the private link
between the two data centres (provider status page), `ping` between the servers. **Do:** nothing on the switch: when
the link is back the server resumes by itself (customers come back, vendor connections are shared again). If the link
stays down for long, consider `systemctl stop sms-switch` on the stepped-back server so it stops trying.
**VendorSideMinority** on a server: it reaches neither the other server nor the witness and opens no vendor
connection; the other side carries everything.

## SubmitsRefused

Submits refused with statuses other than throttling. **Check:** `journalctl -u sms-switch | grep -i "answered 0x"`;
typical causes: credit (0x45), no route or no bound vendor (0x45), bus unavailable (0x14). A sudden rise across all
customers is the platform (bus, Redis); one customer only is their credit, routing or content.

## PostgresNoPrimary

**Check:** `patronictl list`, `etcdctl endpoint health` (Patroni needs 2 of 3 etcd members). **Do:** with etcd healthy
Patroni promotes the standby in 10–30 s by itself. If both PostgreSQL servers are down, start the one that was primary
last (`systemctl start sms-patroni`). Never promote by hand outside Patroni. The switch keeps routing from memory
meanwhile; configuration changes and balances wait.

## PostgresStandby

The standby does not stream: a failover now would have nothing to promote. **Check:** `patronictl list`, its log
(`journalctl -u sms-patroni`). **Do:** `patronictl reinit sms <member>` rebuilds it from the primary.

## BackupFailed

(BackupMissing, BackupNeverRan, PostgresArchiveFailing.) **Check:** `journalctl -u sms-backup`, `sudo -u postgres
pgbackrest --stanza=sms check`, the bucket's credentials and reachability. **Do:** fix the cause, then `sms-backup`
on the primary. Archiving that keeps failing fills the primary's disk with WAL.

## PcapArchive

(PcapArchiveFailing.) The recording archive (`sms-pcap-archive`, every 15 minutes) has not finished: finished files
are not gzipped or moved off-site, and the PCAP screens list off-site files from an old index. **Check:** `journalctl -u
sms-pcap-archive`, the bucket's credentials and reachability (`RCLONE_CONFIG=/etc/sms/rclone.conf rclone lsd
offsite:`). **Do:** fix the cause, then `systemctl start sms-pcap-archive`. Files here more than two weeks past
`pcap_local_days` are deleted without upload so the disk never fills.

## RestoreTest

The monthly restore test did not pass. **Check:** `journalctl -u sms-restore-test` on the standby. **Do:** run
`sms-restore-test` by hand and fix what it reports; a backup that cannot be restored is not a backup.

## Restore

Point-in-time restore of PostgreSQL (after a bad change, not a server loss: Patroni handles that):

1. Stop the switch on both servers (`systemctl stop sms-switch`), then Patroni on the standby, then on the primary.
2. On the primary: `sudo -u postgres pgbackrest --stanza=sms --delta --type=time --target="<UTC time>"
   --target-action=promote restore`.
3. `patronictl remove sms` is **not** needed; start Patroni on it, check the data, then `patronictl reinit sms <the
   other server>` and start the switches.

ClickHouse: `RESTORE TABLE sms_edr.<table> AS sms_edr.<table>_restored FROM S3('<bucket>/clickhouse/full-…', …)` and
copy the rows needed. EDRs written meanwhile stay on the bus up to 2 days and are written again.

## Redis

(RedisNotOnePrimary, RedisReplicaMissing.) **Check:** `redis-cli -p 26379 -a … sentinel masters`, `redis-cli -a …
role` on both servers. **Do:** Sentinel fails over by itself (2 of 3 agree). Two primaries can only last seconds
after a link cut; the stepped-back server's Redis is stopped. A replica missing: `systemctl start redis-server` on it;
it resyncs.

## ClickHouse

(ClickHouseReplicaBehind, ClickHouseReadonly.) Read-only tables mean Keeper is not reached (2 of 3 needed): check
`clickhouse-keeper` on the witness and the Keeper inside each server. EDRs wait on the bus meanwhile (2 days) and are
written when it recovers. A replica behind catches up by itself.

## etcd

etcd without a leader blocks PostgreSQL failover (not the running primary). **Check:** `etcdctl endpoint status
--cluster -w table`. **Do:** start etcd where it is stopped; 2 of 3 members are enough.

## NATS

**Check:** `curl 127.0.0.1:8222/healthz?js-enabled-only=true`, `nats server ls`, `nats stream info SMS`. **Do:** a
server whose JetStream turned off (full disk, see DiskFilling): free space, `systemctl restart nats`. Leaders held by
the witness are handed back to a server every minute (`sms-nats-leaders` timer).

## AsteriskDown

Asterisk is not running on a server with SMS to voice on (`sms_voice_enabled`, `deploy/ansible/README.md` "SMS to
voice (Asterisk)"): the switch on that server cannot place calls, so messages for SMS-to-voice rules there end as not
answered. **Check:** `systemctl status asterisk`, `journalctl -u asterisk -n 100`, `/var/log/asterisk/messages.log`;
a configuration error usually names the file (`/etc/asterisk/pjsip_sms_voice.conf` is the switch's, the rest is
Ansible's). **Do:** `systemctl restart asterisk`; then `asterisk -rx "manager show connected"` lists the switch's
login (`sms_switch`) and `asterisk -rx "pjsip show endpoints"` the voice gateways. If the gateways file is broken,
save any gateway on the Voice gateways page: the switch writes it again.
