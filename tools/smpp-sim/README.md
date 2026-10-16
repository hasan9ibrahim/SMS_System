# tools/smpp-sim/ (later phase)

SMPP v3.4 simulator and load tests for the Elixir switch: fake customer ESMEs that bind
and submit, and fake vendor SMSCs that answer submit_sm and send delivery receipts
(spec §2, §13.1). Fake data only: no real hosts, system_ids or passwords.
