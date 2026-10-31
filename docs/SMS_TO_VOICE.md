# SMS to voice

Decided with the product owner on 2026-10-31 (§8 "SMS To Voice", docs/BACKEND_TODO.md "Decisions"). This file is the
shared design for the contract, mock, web, switch and deployment work. Fake data only in code and tests.

## What it does

A message that matches an active SMS-to-voice rule is **always** a phone call instead of an SMS:

1. **Match.** After ingress translation and before routing, the switch checks the active rules in order of id. A rule
   matches when every field it sets matches the message: Sender ID (the sender, case-insensitive; `%`/`_` wildcards as
   the rule screens use them), Receiver ID (the receiver number), Prefix (the receiver number starts with it) and
   Destination (`mccmnc`: the receiver's network, as routing resolves it). Empty fields match anything.
2. **Code.** The code is the first run of 4 to 8 digits in the message text (after ingress translation). No code: the rule
   does not apply and the message goes as a normal SMS.
3. **Call.** The switch asks the local Asterisk (AMI) to call the receiver over SIP through the rule's voice gateway (the
   rule's `gateway_id`, or else the active gateway with the lowest `priority`). Caller ID: the message's sender when it is
   a number (digits, optional leading `+`), else the gateway's `fixed_caller_id`; `caller_id_mode = 'fixed'` always uses
   `fixed_caller_id`. The number dialled is `dial_prefix` + the receiver number (digits only).
4. **What the person hears, in English:** "Your verification code is 4, 8, 2, 9, 1, 3." (digit by digit), the whole phrase
   said `repeat_count` times (1 to 5) with a one-second pause between. The phrase is by default a fixed recording made at
   install time with `flite`; **a rule may have its own recording instead** (uploaded on the rule, product owner
   2026-10-31), played in place of "Your verification code is", the digits still said after it. The digits are
   Asterisk's English digit prompts.
5. **Outcome.**
   - **Answered:** DELIVRD receipt to the customer (if asked), the message billed at the customer's normal SMS rate (as a
     delivered SMS: one unit per message, whatever its parts were).
   - **Not answered** (no answer within `ring_timeout_s`, busy, rejected, congestion, gateway unreachable): one retry
     after `retry_delay_s`; still not answered: UNDELIV receipt (error `001`), **not charged**.
   - Vendor cost: 0 (the operator's own voice switch).
6. **Limits.** At most `max_calls` calls at once per gateway; more wait in a queue (durable, like the vendor buffers) and
   go as calls end. A message waiting longer than its validity period gets EXPIRED.

## Data (migrations on branch `voice-base`)

- PostgreSQL `105_sms_voice.sql`: table `voice_gateways` (name, host, port, transport udp/tcp/tls, username,
  `password_enc` encrypted like `business_company_mailboxes.smtp_password_enc`, from_domain, caller_id_mode
  sender/fixed, fixed_caller_id, dial_prefix, codecs `{alaw,ulaw}`, max_calls, ring_timeout_s, retry_delay_s, priority,
  status, audit columns, soft delete); `sms_voice_rules.gateway_id` (nullable).
- PostgreSQL `106_sms_voice_recording.sql`: `sms_voice_rules.prompt_wav` (bytea, null = default phrase),
  `prompt_wav_name` (the uploaded file's name), `prompt_wav_sha256` (hex of `prompt_wav`, names the file on disk). Stored
  as Asterisk plays it: WAV, mono, 8 kHz, 16-bit PCM, at most 1 MB (about 60 s). The API accepts any PCM WAV (8/16/24-bit,
  mono or stereo, any sample rate) and converts it (mix to mono, resample to 8 kHz); anything else (MP3, compressed WAV,
  too long) is refused with a plain message.
- ClickHouse `011_edr_voice.sql`: `edr.voice_gateway_id`, `voice_answered`, `voice_hangup_cause` (Asterisk's cause text,
  e.g. `NORMAL_CLEARING`, `NO_ANSWER`, `USER_BUSY`), `voice_duration_ms`. An attempt that was a call has
  `route_type = 'voice'`, `v_trunk_id = 0`, `cost = 0`. The code itself is never put in these columns.

## Switch ⇄ Asterisk

- Asterisk runs on each switch server (Ubuntu 24.04 packages `asterisk`, `asterisk-core-sounds-en-wav`, `flite`, `sox`),
  installed by the Ansible role `asterisk`. AMI listens on 127.0.0.1:5038 only; user `sms_switch`, secret from the vault
  (`vault_asterisk_ami_secret`). Switch config: `SMS_ASTERISK_AMI_HOST`, `SMS_ASTERISK_AMI_PORT`,
  `SMS_ASTERISK_AMI_USER`, `SMS_ASTERISK_AMI_SECRET`; voice is off when the host is unset.
- Gateways: the switch rewrites `/etc/asterisk/pjsip_sms_voice.conf` **in place** (included from `pjsip.conf`; created
  once by Ansible, owned by the switch user, group `asterisk`, mode 0640; the switch user cannot create files in
  `/etc/asterisk`, and a replaced file would lose its group) with one endpoint/aor/auth per active gateway, named
  `smsvoice-gw<id>`, using the transports Ansible defines (`transport-udp`, `transport-tcp`, `transport-tls`) and no
  `context` (calls coming in are refused), whenever the gateway config changes, then sends AMI `Action: Command` /
  `Command: module reload res_pjsip.so`.
- Dialplan (Ansible, `extensions_sms_voice.conf`, context `sms-voice`): on answer, `Wait(1)`, then `REPEAT` times:
  `Playback(${PROMPT})`, `SayDigits(${CODE})`, `Wait(1)`; then `Hangup()`. `PROMPT` defaults to `custom/sms-voice-code`
  (the flite phrase "Your verification code is", 8 kHz WAV) when the variable is empty.
- Custom recordings: when the switch loads the rules it writes each rule's `prompt_wav` to
  `<sounds dir>/en/custom/sms-voice-rule-<sha256>.wav` on its own server (if not already there; the directory is
  writable by the switch user, group `asterisk`, files 0640) and removes files of that pattern no rule uses any more;
  a call for such a rule passes `PROMPT=custom/sms-voice-rule-<sha256>`. Config: `SMS_ASTERISK_SOUNDS_DIR`.
- Placing a call: AMI `Originate` with `Channel: PJSIP/<dial>@smsvoice-gw<id>`, `Context: sms-voice`, `Exten: s`,
  `Priority: 1`, `CallerID: <caller id>`, `Timeout: <ring_timeout_s * 1000>`, `Async: true`, `ActionID: <message id>:<try>`,
  `Variable: CODE=<digits>,REPEAT=<n>,PROMPT=<prompt or empty>`. The `OriginateResponse` event (same ActionID) says answered (`Response: Success`) or
  not (`Reason` 0/1/3/5/8: no such channel / no answer / busy / congestion …). For an answered call the `Hangup` event of
  its channel (`Uniqueid` from the response) gives the cause and the switch measures the duration from answer to hangup.
- Tests use a fake AMI server (TCP) in the test suite; no Asterisk in CI.

## Screens (contract version 0.133.0)

- **Voice gateways** (Switch tools, next to SMS To Voice): list and form with the fields above. Password write-only
  (shown as set / not set, as mailbox secrets are). Safe delete: blocked while a rule uses the gateway.
- **SMS To Voice**: the rule form gains **Gateway** (optional; "Default: the first active gateway") and **Recording**:
  "Default phrase" or an uploaded .wav (with a play button to listen to it in the browser, and Remove to go back to the
  default); the list shows Default / the file name. The test box shows
  what would happen: the gateway, the number dialled, the caller ID, the code found and the phrase as spoken, or why the
  message would go as an SMS (no rule matches, or no code in the text).
- **EDR search / detail**: route type "Voice"; columns Voice gateway, Answered, Hangup cause, Call duration.
- **Test system**: calls are simulated (answered about 80 % of the time); no Asterisk.
