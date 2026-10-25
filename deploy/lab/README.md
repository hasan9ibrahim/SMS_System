# Rehearsal lab (backend step 8)

Three Ubuntu 24.04 machines with systemd and SSH in containers, on one docker network, standing in for the two
servers and the witness VM, plus an S3 store standing in for the off-site backup storage. `deploy/ansible` sets them
up exactly as it will set up the real servers. Fake data only; every secret in the lab inventory is a lab-only value.

| Machine | Address |
| --- | --- |
| srv-a | 10.88.0.11 |
| srv-b | 10.88.0.12 |
| witness | 10.88.0.13 |
| s3 (SeaweedFS S3 gateway, self-signed TLS) | 10.88.0.20:9000, bucket `sms-backups` |

Needs Docker (cgroup v1 or v2), `ssh`, `openssl`, Ansible (`pip install ansible-core`) and about 12 GB of disk.

```sh
deploy/lab/lab.sh up                     # build and start (LAB_CA_FILE, LAB_HTTPS_PROXY: see lab.sh)
cd deploy/ansible
ansible-playbook site.yml                # everything: etcd, Patroni, Redis + Sentinel, NATS, ClickHouse + Keeper,
                                         # switch service, monitoring, backups, traffic recording
ansible-playbook deploy.yml -e release=$(./build-release.sh)
../lab/seed.sh                           # reference data and the load-test trunks (vendors on this host)
```

Drills (`docs/FAILOVER_DRILLS.md`):

```sh
deploy/lab/lab.sh cut srv-a srv-b        # cut the link between two machines; lab.sh heal
deploy/lab/lab.sh poweroff srv-b         # a server losing power; lab.sh start srv-b
deploy/lab/sample.sh                     # vendor connections and stepped-back state every 2 s
deploy/lab/lab.sh ssh srv-a              # a shell
```

Grafana, Prometheus and Alertmanager run on the witness (`http://10.88.0.13:3000`, admin / the lab vault value). The
lab sends no Telegram alerts.

The NATS stream grows about 1 GB per 20 minutes at 100 msg/s; between drills, once drained:
`deploy/lab/lab.sh ssh srv-a nats --user sms --password lab-only-nats stream purge SMS -f`.

`deploy/lab/lab.sh down` removes everything.
