# Go-live test pass (backend step 15, 2026-10-26)

Everything was run on the development machine (4 CPUs, 15 GB) on fake data. Production figures come from the 1,000 TPS
test and the drills on the real servers (`docs/GO_LIVE.md`, section 7).

## What was tested

| Area | How | Result |
| --- | --- | --- |
| Every screen, as an administrator | Browser (Chromium) signed in through the Elixir API, every page of the menu (74), console errors, failed calls | All 74 load; **1 bug found and fixed**: the Bulk workspace crashed as soon as it listed a table (its table picker read fields the names-only lookup of step 10 does not send) |
| Department access | The same, signed in as an Account Manager, a Finance user and a NOC engineer | Each sees only its group's pages; every other page shows "No access" (also when opened by its address); an allowed page never calls something the user may not reach (no 403 behind any open page); no errors |
| Access on the server | Direct API calls as the Account Manager | Users, Audit trail, Access groups, Invoices, EDR search refused (403); Enterprises answered |
| Empty production database | Production server (`SMS_MODE=production`) on a database made by the migrations and the bootstrap only; every list (82) and every GET (41) | All answer, no server error |
| SMPP end to end | `tools/smpp-sim` steady, 2 switch nodes, 40 vendor binds, 40 customer binds, 200 msg/s for 60 s, 5 % multipart, random DLR statuses | 12,825 submits accepted, 0 errors, 0 refused, 0 duplicates; every receipt delivered (12,976, no duplicate or unknown); every message part has an EDR and every vendor attempt an outcome row. Latency p50 13 ms / p99 116 ms with the whole platform and the simulator on one 4-CPU machine at 87 % CPU (the 50 ms p99 target is for the real servers, see `docs/LOAD_TEST_RESULTS.md`) |
| Automated suites | Mock tests (399), `INTEGRATION=1 mix check` (Elixir: format, Credo, Dialyzer, every test with real stores and NATS), Ansible syntax, contract lint, web build | All pass except two mock tests that need more local EDR history than the dev data has (Master report hours, Traffic alerts; they pass on CI's full data set) |
| Full volume | The step 6 performance audit of every list at the full generated volume; the mock suite runs on the full data set in CI | Not re-measured in this pass |

## Not tested here (needs the real machines)

1,000 TPS, real SMTP delivery, real partner binds and Telegram alerts: `docs/GO_LIVE.md` sections 3–7. The playbooks,
the first sign-in, a failover and the backup restore were rehearsed in the lab (below) and are run again on the real
servers.

## Go-live rehearsal in the lab (2026-10-26)

`docs/GO_LIVE.md` sections 3–7 run end to end on three fresh lab machines (`deploy/lab`: srv-a, srv-b, the witness and an
S3 store), with the production bootstrap instead of the dev data and a mail catcher standing in for the platform mailbox.
Same 4-CPU development machine as above, so the figures show behaviour, not capacity.

| Step | Result |
| --- | --- |
| `site.yml` on empty machines | Passed after fixes 1–2; a second run changes only what a settings change needs (safe to repeat) |
| `build-release.sh`, `deploy.yml` | Passed (twice: a first release and an update under the API, one machine at a time) |
| Bootstrap (step 4) | Reference data, access groups, system user, first administrator with a temporary password |
| First sign-in over HTTPS, on srv-a and srv-b | Temporary password → e-mailed code → new password with a second e-mailed code → dashboard; the password rules refused a password containing the administrator's name; Email logs shows every code sent |
| SMPP through both servers (40 customer and 40 vendor binds, 100 msg/s, 5 % multipart) | 0 errors, 0 duplicates, every receipt delivered; EDRs replicated on both servers; revenue and cost on the receipts (€0.01 / €0.005 a message); EDR search and Network status show the traffic and the binds |
| `sms-switch` stopped on srv-a under traffic, started again after 90 s (§7) | srv-a's customers rebound to srv-b, its vendor connections moved over, 100 msg/s throughout; 0 accepted messages without a receipt, 0 duplicates at the vendors (12 messages were in flight on srv-a at the stop) |
| Alerts | `SwitchDown` (srv-a) and `ClusterPeerLost` fired in Alertmanager; `DiskAlmostFull` fired correctly on the lab's nearly full disk (no Telegram in the lab) |
| `sms-backup full`, `sms-restore-test` | Full PostgreSQL and ClickHouse backup to S3 (encrypted) in 8 s; restored and checked on the standby in 5 s |

Found and fixed (each would have stopped or broken the real installation):

1. **PostgreSQL never got its standby.** On a first install Patroni was restarted while it created the cluster (a reload
   handler starts a stopped service, the restart handler then stops it), so the primary had no replication role and srv-b
   could not copy it. The handlers now touch only a running Patroni, and settings changes are applied before it starts.
2. **Every page answered 500.** `/opt/sms` was `0750`, so nginx could not reach the screens' files; now `0751`.
3. **Live screens, bind status, credit alerts and switch commands got nothing.** The service's NATS login was written in
   `NATS_URL`, which the NATS library ignores ("Authorization Violation"); it is now passed as options.
4. **`. /etc/sms/service.env` (the bootstrap step) dropped the sender name** (a value with a space); the mail settings are
   quoted.
5. **A settings change restarted the service on both servers at once**; `site.yml` now restarts them one at a time.
6. **The first administrator cannot finish signing in without platform e-mail**: a password change always needs an
   e-mailed code (R6), so `--admin-without-code` does not help. `docs/GO_LIVE.md` (1.6, step 4) and the bootstrap now say
   so, and the bootstrap warns when `SMTP_URL` is not set.
