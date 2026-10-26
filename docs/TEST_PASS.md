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

The playbooks on the real servers, 1,000 TPS, the failover drills, real SMTP delivery, real partner binds, Telegram
alerts and the backup restore: `docs/GO_LIVE.md` sections 3–7.
