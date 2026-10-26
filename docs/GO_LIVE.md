# Go-live checklist (backend step 14)

From empty machines to the first test partners. Each step names who does it and how to check it worked. The servers'
setup itself is in `deploy/ansible/README.md`; this list adds what the platform needs around it.

## 1. Before the machines

| # | What | Check |
| --- | --- | --- |
| 1.1 | Two servers (two data centres, same provider) and the witness VM (another provider), Ubuntu 24.04, a private network or VPN between the three (Q32) | `ping` between private addresses |
| 1.2 | The S3 bucket for backups and an access key limited to it (Q31) | – |
| 1.3 | A name for the screens and the portal, e.g. `sms.<your-domain>`: an A record to **both** servers (or the provider's failover address) | `dig +short sms.<your-domain>` shows both |
| 1.4 | The SMPP address partners bind to: each server's public address (customers are given both; S-1.17 TLS on 2776) | – |
| 1.5 | A certificate for the screens' name (full chain + key), and one for SMPP TLS if partners use it. Renewal: when the certificate is replaced on the servers, run `systemctl reload nginx` | `openssl x509 -noout -dates -in web.crt` |
| 1.6 | A mailbox the platform sends from (sign-in codes, password codes, alerts): SMTP host, port, login | send a test mail with any client |
| 1.7 | A Telegram bot and the engineer's and NOC's chat ids (Q29) | – |

## 2. Inventory and secrets

Copy `deploy/ansible/inventories/production.example` to `inventories/production` and fill in:

* `hosts.yml`: public and private addresses.
* `group_vars/all/main.yml`: `admin_cidrs`, `smpp_cidrs` (the partners' ranges, Q33), S3, Telegram chat ids,
  `web_domain`, `smtp_from`, the certificate paths.
* `group_vars/all/secrets.yml` (from `secrets.example.yml`): every `CHANGE_ME` (`openssl rand -hex 24`), and
  `vault_smtp_url` (`smtp://user:password@host:587` or `smtps://user:password@host:465`). Then
  `ansible-vault encrypt` it.

Keep these outside the servers, in the company's password manager: the vault password, `vault_pgbackrest_cipher_pass`
(without it the backups cannot be read) and `vault_mock_secret_key` (it encrypts the stored trunk and mailbox passwords
and authenticator secrets; **it must never change** after go-live, or they can no longer be read).

## 3. Install

1. Put the screens' certificate and key on both servers at `/etc/sms/tls/web.crt` and `/etc/sms/tls/web.key` (and the
   SMPP ones at `smpp_tls_certfile` / `smpp_tls_keyfile`).
2. `ansible-playbook -i inventories/production site.yml --ask-vault-pass`
3. `./build-release.sh` (Ubuntu 24.04 with Elixir and Node.js 22), then
   `ansible-playbook -i inventories/production deploy.yml -e release=<id> --ask-vault-pass`.

Check: `https://<web_domain>` shows the sign-in page with a valid certificate; Grafana on the witness shows the three
machines; `systemctl status sms-switch sms-service nginx` is active on both servers.

## 4. First administrator and reference data

On srv-a, once:

```sh
sudo -u sms bash -c 'set -a; . /etc/sms/service.env; set +a; cd /opt/sms/service/current; node bootstrap.mjs \
  --admin-username <name> --admin-email <their address> --admin-first-name <First> --admin-last-name <Last> \
  --summary-emails <rates mailbox>,<noc mailbox>'
```

It fills what every screen needs (safe to run again: tables that have rows are left alone):

* currencies USD, EUR, GBP, AED, INR with **approximate** starting rates (replaced by the first exchange-rate fetch);
* billing cycles and product categories (spec §5.5, §7);
* every country and network of the MCC/MNC list, one "All networks" code per MCC, and each country's dial code in the
  Master table (§6.1). **Network prefixes are not included** (no reliable public list): import them in Routing ›
  Master table before routing by network;
* the departments and GUI access groups to start from (§11; edit them in Admin): Administrator, Department Manager,
  Account Manager, NOC Engineer, Rates Analyst, Finance and Read Only (every page but Finance and Admin);
* Cleanup Center changes set to wait for an approval;
* the `system` user the background jobs act as (cannot sign in);
* the first administrator, with a temporary password printed once (valid 24 hours).

Then sign in at `https://<web_domain>`: the temporary password, the code e-mailed to the administrator, then a new
password (another e-mailed code). If no code arrives, check `vault_smtp_url` and Switch › Email logs.

## 5. In the screens (administrator)

| # | Where | What |
| --- | --- | --- |
| 5.1 | Admin › Business companies | The company: name, base currency, SMPP host, invoice numbering, address, bank details, logo; its mailboxes (billing, rates, NOC) with their SMTP and, for the rates mailbox, IMAP (Incoming RNs) |
| 5.2 | Finance › Currencies | Exchange-rate source and its key; fetch the rates and check them |
| 5.3 | Admin › Security settings | Password lifetime, temporary password hours, minimum length (defaults: 30 days, 24 hours, 12 characters; five wrong passwords lock a user for 15 minutes) |
| 5.4 | Admin › Departments, GUI access groups, Users | Review the starting groups; create the team's users (each gets a temporary password and signs in with an e-mailed code) |
| 5.5 | Admin › Email templates | Check sender names and wording of invoices, rate notices, alerts |
| 5.6 | Admin › Cleanup center | Weekly summary recipients (set by `--summary-emails`) |
| 5.7 | Routing › Master table, MCCMNC codes | Network prefixes; destination DLR targets where wanted |
| 5.8 | Monitoring › Alert rules | The alert rules the NOC wants (none are created by the bootstrap) |
| 5.9 | Switch › HLR | HLR/MNP providers, if used |

## 6. First test partners

1. Enterprises and trunks (§5): the test customer's IPs and SMPP credentials; the test vendor's host, port, credentials.
2. Rate tables for both (§13.12), a route rule (§6.3).
3. Monitoring › Network status: the vendor bind is up; the customer binds to both servers.
4. Send from the customer; check Monitoring › EDR search, Dashboard and Live analytics, the vendor's receipt, and the
   customer's DLR. A Test SMS reaches the vendor without billing the customer.
5. Next day: Finance › Enterprise balance and the Enterprise report show the traffic.

## 7. Before real traffic

| Check | How |
| --- | --- |
| Alerts reach Telegram | stop `sms-switch` on one server for two minutes, start it again |
| Backups | `sms-backup full` on the PostgreSQL primary; the monthly restore test (`sms-restore-test`) passes |
| Failover | stop `sms-switch` on srv-a: customers rebind to srv-b, traffic continues; start it again |
| The 1,000 TPS test and the drills on the real servers | `docs/LOAD_TEST_RESULTS.md`, `docs/FAILOVER_DRILLS.md` |
| Sign-in codes are e-mailed | Switch › Email logs shows them as sent |
