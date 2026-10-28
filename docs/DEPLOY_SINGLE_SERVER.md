# Putting the platform on one server and your domain

This guide takes the code from GitHub to a running platform on **one server**, reachable at your own domain, from
nothing. Each step says where it happens: **OVH panel**, **GoDaddy**, **GitHub**, **your laptop** (Windows) or **the
server**.

It assumes:

- the server is the OVH RISE-3: Ubuntu 24.04, 64 GB RAM, 2 × 3.84 TB NVMe;
- the domain is `example.net`, registered at GoDaddy;
- the screens will live at `https://sms.example.net`;
- partners will connect over SMPP to `smpp.example.net`;
- the server holds **no source code and no build tools**. GitHub builds the platform after every change merged into
  `main` (once all checks pass) and publishes it as one file, a *release bundle*. The server downloads and installs
  bundles with one command, `sms-update`;
- your laptop only needs a web browser and PowerShell (built into Windows 10 and 11); nothing is installed on it.

Replace `example.net`, `203.0.113.11` (the server's public IP) and the other example values with yours.

Everything runs on this one machine. A second server and the witness VM can be added later with no code change
(step 13).

> **One server means no failover.** If the server stops, traffic stops until it is back. The data is safe in the
> off-site backups (step 6). Add the second server and the witness before you depend on it for real traffic.

---

## 0. What you need before you start

| What | Why | Where to get it |
| --- | --- | --- |
| The OVH server | It runs everything | OVH panel → Bare Metal Cloud → Dedicated servers |
| Access to the GoDaddy DNS of `example.net` | To point the names at the server | godaddy.com → My Products |
| Admin access to the GitHub repository | To give the server a read-only token for the release bundles | github.com/hasan9ibrahim/SMS_System |
| An **S3-compatible bucket at another provider** (can wait: see 6.3) | Off-site backups, and old EDRs and recordings | OVH Public Cloud Object Storage in another region, Backblaze B2, Wasabi |
| An **SMTP account** for platform e-mail | Sign-in codes are e-mailed; without e-mail nobody can sign in | Microsoft 365, Google Workspace, Amazon SES, Mailgun |
| A **Telegram bot** (optional, recommended) | Alerts to your phone | @BotFather in Telegram |
| Your **office or home public IP** | Only these addresses may log in to the server | Step 1 |
| A password manager | For the passwords and keys made in step 6 | Bitwarden, 1Password, KeePass |

---

## 1. Your laptop: SSH key and public IP

In **PowerShell** (Start → type "PowerShell"; no administrator needed):

```powershell
ssh-keygen -t ed25519
```

- "Enter file in which to save the key": press **Enter** (if it asks to overwrite, answer **n**: you already have one).
- "Enter passphrase": press **Enter** twice, or type a passphrase twice (asked at each login).

Then print the **public** key and copy the whole line (`ssh-ed25519 … hp@LAPTOP-…`):

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub
```

`id_ed25519` without `.pub` is the private key: it never leaves the laptop.

Note your public IP (you need it in step 6):

```powershell
curl.exe -4 ifconfig.me
```

> If your home or office IP changes from time to time (most home connections), note each place you work from. After
> step 7 the server only accepts SSH from the addresses you list. If you are ever locked out, the OVH panel's **IPMI /
> KVM** console still works (step 11).

---

## 2. OVH panel: install Ubuntu

1. Open the server, then **Reinstall** (or **Install**), and choose **Installation from an OVHcloud template**.
2. **Step 1 of 4:**
   - **Type of OS:** Basic.
   - Open the **LINUX** list and choose **Ubuntu Server 24.04 LTS**.
   - **Target disk group:** leave the 2 × NVMe (JBOD). JBOD only means the server has no RAID card, so the RAID is
     done in software, and "Customise the hardware RAID" stays greyed out.
   - Tick **Customise the partition configuration**, then **Next**.
3. **Step 2 of 4, the partitions.** Every partition is **RAID 1** (on both disks, so one disk failing loses nothing),
   and `/` takes the rest of the disk, because the databases live under `/var/lib`:

   | Mount point | File system | RAID | Size |
   | --- | --- | --- | --- |
   | `/boot` | ext4 | 1 | 1 GiB |
   | `/` | ext4 | 1 | the rest (about 3.5 TiB) |
   | `swap` | swap | – | 2 × 512 MiB to 8 GiB |

   - Leave the EFI partition OVH adds (`/boot/efi`) as it is.
   - Delete any other partition the template proposes (`/home`, `/var/lib/vz`, a large `/data` and so on), then
     grow `/` to the remaining space.
   - "Space used" shows twice the usable size: that is the copy on the second disk.
4. **Step 3 of 4:**
   - **Hostname**, if asked: `srv-a`.
   - **Your Public SSH key:** select **ED25519** and paste the line from step 1.
   - Leave **Post-Installation Script** and **Cloud-init** empty, and **LACP** off.
5. **Step 4 of 4:** check the summary and **Confirm**. It takes 10–20 minutes; OVH e-mails you when it is done.
6. Note the server's **public IP** (the server's page, "IP"). This guide writes it `203.0.113.11`.
7. **Optional:** on the IP, set the **reverse DNS** to `sms.example.net` (after step 3, once the name exists).

**Optional, for later: the private network (vRack).** The second server will reach this one over it. You can add the
server to a vRack now and give its second network interface an address such as `10.0.0.11/24` (OVH's vRack guide), or
skip it and use the public IP as `private_ip` in step 6. The firewall keeps those ports closed to everyone else.

---

## 3. GoDaddy: point the names at the server

1. Sign in at godaddy.com, open **My Products**, then **DNS** next to `example.net` (or **Domain → Manage DNS**).
2. **Add New Record**, twice:

   | Type | Name | Value | TTL |
   | --- | --- | --- | --- |
   | A | `sms` | `203.0.113.11` | 1/2 hour |
   | A | `smpp` | `203.0.113.11` | 1/2 hour |

   `sms.example.net` is for the screens and the customer portal (`https://sms.example.net/portal`).
   `smpp.example.net` is the address you give partners.
   - **One name for everything also works:** skip the `smpp` record and give partners `sms.example.net` as the SMPP
     host. SMPP TLS uses the same certificate as the screens, so it is valid for that name.
   - A web address cannot contain `@` (that is an e-mail address): use a hyphen or a dot, e.g. `sms-company`.
   - To use the bare domain (`example.net`) instead, edit the existing `A` record named `@` (GoDaddy's "Parked"
     record must be replaced).
   - If the domain uses another provider's name servers (Cloudflare, for example), add the records there instead,
     set to **DNS only** (grey cloud): SMPP cannot pass through a proxy.
3. **E-mail records.** Your SMTP provider shows you records that stop sign-in codes landing in spam: an SPF `TXT`
   record, one or more DKIM `CNAME` or `TXT` records, and usually a DMARC `TXT` record. Add each one on the same page,
   exactly as the provider shows it.
4. Check from the laptop (PowerShell); it usually takes minutes, at most a few hours:

   ```powershell
   nslookup sms.example.net       # must answer 203.0.113.11
   nslookup smpp.example.net
   ```

   **Do not run step 7 until both answer with the server's IP:** the HTTPS certificate is only issued once the name
   points at the server.

---

## 4. The server: first login and tools

From the laptop (PowerShell):

```powershell
ssh ubuntu@203.0.113.11
```

- The first time it asks "Are you sure you want to continue connecting?": type **yes**.
- If `ubuntu` is refused, try `ssh root@203.0.113.11`.

Everything from here on runs **on the server as root**. Become root and update:

```sh
sudo -i
apt update && apt -y full-upgrade && reboot
```

Wait two minutes, log in again (`ssh ubuntu@203.0.113.11`, then `sudo -i`), and install Ansible, the only tool the
server needs (it installs everything else itself in step 7):

```sh
apt install -y pipx
pipx install ansible-core && pipx ensurepath
exec bash
ansible-playbook --version        # prints a version
```

---

## 5. GitHub: a read-only token for the server

The repository is private. The server gets a **token that can only read** it, which it uses to download the release
bundles. It cannot change anything on GitHub.

1. **On GitHub** (browser), click your photo (top right) → **Settings** → **Developer settings** (bottom of the left
   menu) → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**:
   - Token name: `srv-a releases`;
   - Expiration: 1 year (put a reminder in your calendar to renew it; step 12 says how);
   - Repository access: **Only select repositories** → `SMS_System`;
   - Permissions → Repository permissions → **Contents: Read-only** (Metadata: Read-only is added by itself);
   - **Generate token**, and copy it (it starts with `github_pat_`; GitHub shows it only once).
2. **On the server**, store it where only root can read it:

   ```sh
   mkdir -p /root/.config/sms && chmod 700 /root/.config/sms
   nano /root/.config/sms/github-token        # paste the token, save with Ctrl+O, Enter, then Ctrl+X
   chmod 600 /root/.config/sms/github-token
   ```

3. **Install the `sms-update` command** (one small script, the only file taken from the repository itself):

   ```sh
   curl -fsSL -H "Authorization: Bearer $(cat /root/.config/sms/github-token)" \
     -H "Accept: application/vnd.github.raw" -o /usr/local/bin/sms-update \
     https://api.github.com/repos/hasan9ibrahim/SMS_System/contents/deploy/ansible/sms-update
   chmod 755 /usr/local/bin/sms-update
   sms-update --list                # the releases on GitHub, newest first
   sms-update --download            # downloads the newest one to /root/sms-platform/<id>
   ```

   If `--list` shows nothing, no release was built yet: on GitHub open **Actions** → **Release** → **Run workflow**
   (on `main`), wait about 10 minutes, then try again.

`/root/sms-platform/<id>/` holds the bundle: the built platform and its install scripts. `sms-update` keeps the last
five.

---

## 6. The server: your settings and secrets (the inventory)

Your settings live in `/root/sms-inventory`, apart from the bundles, so a new release never touches them, and your
secrets never go to GitHub. Start from the example in the bundle you just downloaded:

```sh
cp -r /root/sms-platform/*/ansible/inventories/single.example /root/sms-inventory
cd /root/sms-inventory
```

### 6.1 `hosts.yml`

Edit it (`nano hosts.yml`; save with Ctrl+O, Enter, then Ctrl+X). The server's line becomes:

```yaml
srv-a: {ansible_host: 203.0.113.11, private_ip: 203.0.113.11, node_id: 1, ansible_connection: local}
```

- `ansible_host`: the public IP.
- `private_ip`: the vRack address (`10.0.0.11`) if you set one up, otherwise the public IP again.
- `ansible_connection: local`: the installation runs on this machine itself, without logging in to it.

### 6.2 `group_vars/all/main.yml`

`nano group_vars/all/main.yml` and set:

| Setting | Put |
| --- | --- |
| `admin_cidrs` | Your IP(s) from step 1, each with `/32`, e.g. `[198.51.100.7/32, 198.51.100.8/32]`. **Only these may use SSH** (and Grafana). |
| `smpp_cidrs` | The partners' IPs, or `[0.0.0.0/0]` for now (the Firewall screen and each trunk's allowed IPs still apply) |
| `s3_endpoint`, `s3_region`, `s3_bucket` | Your bucket, e.g. `s3.eu-central-003.backblazeb2.com`, `eu-central-003`, `sms-backups` |
| `telegram_chat_ids` | The chat id(s) for alerts (step 9), or leave empty for now |
| `web_domain` | `sms.example.net` |
| `web_letsencrypt`, `letsencrypt_email` | `true`, and an address for Let's Encrypt's expiry notices |
| `smtp_from` | The sender address your SMTP account may send from, e.g. `noreply@example.net` |

### 6.3 Secrets

```sh
cd /root/sms-inventory/group_vars/all
cp secrets.example.yml secrets.yml
openssl rand -hex 24       # run once per CHANGE_ME and paste each value
openssl rand -hex 64       # for vault_secret_key_base
openssl rand -hex 32       # for vault_mock_secret_key
nano secrets.yml
```

Fill in the rest:

- `vault_s3_access_key` / `vault_s3_secret_key`: the bucket's key. **No bucket yet?** Set both to `""`. The platform
  then runs with **no off-site backups**: PostgreSQL archives nothing, the backup and restore-test timers and their
  alerts are off, and EDRs and recordings stay on the server only (the recordings for `pcap_local_days`). Fill them in
  later and run `sms-update --setup` again; from the next update the EDRs older than 6 months move to the bucket.
  Until then, a lost server loses its data;
- `vault_smtp_url`: for example `smtp://user:password@smtp.office365.com:587` (or `smtps://…:465`);
- `vault_telegram_bot_token`: from @BotFather (step 9), or leave it for later.

Then lock the file with a **vault password** of your choice (asked at every install and update):

```sh
ansible-vault encrypt secrets.yml
```

**Store in your password manager, not only on the server:** the vault password, `vault_pgbackrest_cipher_pass` and
`vault_mock_secret_key`:

- without the cipher the backups cannot be read;
- `vault_mock_secret_key` must never change once the platform is in use.

To change a secret later: `ansible-vault edit /root/sms-inventory/group_vars/all/secrets.yml`.

---

## 7. The server: install everything

```sh
sms-update --setup
```

It asks for the vault password once. Then it installs, in order (15–30 minutes the first time):

1. the firewall;
2. PostgreSQL;
3. Redis;
4. NATS;
5. ClickHouse;
6. the switch's service;
7. the TypeScript service;
8. nginx with the Let's Encrypt certificate for `sms.example.net` (renewed by itself);
9. monitoring;
10. backups and traffic recording.

Then it installs the platform itself: the switch, the API, the TypeScript service and the screens. It runs the
database migrations, starts each part and waits until each one answers.

It is safe to run again after any change to the inventory.

If it stops, read the last red lines:

| Message | Fix |
| --- | --- |
| certbot fails | The DNS does not point at the server yet (step 3) |
| `vault_smtp_url` or S3 errors | A secret is wrong (step 6.3) |
| GitHub refused … | The token is wrong or expired (step 5) |

> The firewall comes first. Your current SSH session stays open, but a new login only works from an `admin_cidrs`
> address. Before closing this window, open a **second** PowerShell and check that `ssh ubuntu@203.0.113.11` still
> works.

---

## 8. The server: the first administrator

Once:

```sh
sudo -u sms bash -c 'set -a; . /etc/sms/service.env; set +a; cd /opt/sms/service/current; node bootstrap.mjs \
  --admin-username admin --admin-email you@example.net --admin-first-name Your --admin-last-name Name \
  --summary-emails rates@example.net,noc@example.net'
```

It prints a **temporary password** (valid 24 hours). It also fills in what every screen needs: currencies, billing
cycles, product categories, every country and network, and the starting access groups. It does not add network
prefixes; import those in Routing › Master table (`docs/GO_LIVE.md` §4).

---

## 9. Your laptop: sign in and check

1. In the browser open **https://sms.example.net**. It shows a padlock (a valid certificate).
2. Sign in with `admin` and the temporary password.
3. Enter the code e-mailed to you, then choose a new password (another code).

If no code arrives, check `vault_smtp_url`, the e-mail DNS records (step 3.3), and Switch › Email logs.

On the server every service must be **active**:

```sh
systemctl status sms-switch sms-service nginx patroni redis-server nats clickhouse-server --no-pager | grep -E "●|Active"
```

**Grafana:** `http://203.0.113.11:3000`, only from the `admin_cidrs` addresses. The user is `admin`; the password is
`vault_grafana_admin_password` (`ansible-vault view /root/sms-inventory/group_vars/all/secrets.yml`). The "SMS
platform" dashboard shows the server.

**Alerts on Telegram (optional):**

1. In Telegram, talk to **@BotFather**: send `/newbot` and put the token in `vault_telegram_bot_token`.
2. Add the bot to your chat or group and send it a message.
3. Open `https://api.telegram.org/bot<token>/getUpdates` and copy the chat `id` (a negative number for a group) into
   `telegram_chat_ids`.
4. Run step 7 again.
5. To test: `systemctl stop sms-switch` on the server; an alert arrives within about two minutes. Then
   `systemctl start sms-switch`.

---

## 10. Give partners the SMPP details

| | |
| --- | --- |
| Host | `smpp.example.net` |
| Port | `2775` (plain) or `2776` (TLS, using the same Let's Encrypt certificate) |
| System ID / password | From the customer trunk in Enterprises › trunk |

Partner IPs must be in `smpp_cidrs` (if you restricted it) and in the trunk's allowed IPs.

---

## 11. If you are locked out (your IP changed)

1. In the OVH panel open the server, then **IPMI** (or **KVM**), and open the console in the browser.
2. Log in as `root` (set a root password once in advance with `passwd` on the server, and keep it in the password
   manager), or use OVH's **rescue mode**.
3. Add your new IP to `admin_cidrs` in `/root/sms-inventory/group_vars/all/main.yml` and run step 7 again. In a hurry,
   `systemctl stop nftables` opens SSH until the next run of step 7.

---

## 12. Updating

Changes are made on GitHub (pull requests merged into `main`). Once its checks pass, GitHub builds a new release
bundle by itself (Actions → Release, about 10 minutes). To install it:

```sh
sms-update                     # the newest release
```

- **Roll back:** `sms-update --list`, then `sms-update <previous id>`. The last five bundles stay on the server, and
  the switch keeps its last five releases.
- **A setting changed** in `/root/sms-inventory`: `sms-update --setup`.
- **New database migrations** run by themselves during the update.
- **Renew the GitHub token** before it expires: generate a new one (step 5.1) and replace the line in
  `/root/.config/sms/github-token`.

| What | How |
| --- | --- |
| Backups | Automatic: PostgreSQL and ClickHouse every night to the bucket, plus a monthly restore test. An alert fires after 26 hours without a backup. |
| Certificate | Renewed by itself about every 60 days. nginx pauses for a few seconds while the check on port 80 runs. SMPP TLS uses the renewed certificate from the switch's next restart (any deploy). |
| Disk | Grafana shows it. An alert fires when less than 15 % is free. |
| Ubuntu updates | Security updates install by themselves. Once a month: `apt update && apt -y full-upgrade`, and reboot at a quiet hour if it asks. |

---

## 13. Growing to two servers and the witness

The application code does not change: the switch, the API and the TypeScript service read their cluster settings at
start. What changes is the inventory, plus a short planned stop. We will rehearse this in the lab (`deploy/lab`)
before you do it. The outline:

1. **Order** the second server and the witness VM:
   - the second server: same provider, another data centre, the same vRack;
   - the witness: another provider, 4–6 vCPU, 8–12 GB RAM, 200 GB.

   Give each a `private_ip` reachable from the others, either the vRack or a VPN to the witness.
2. **Inventory:**
   - Copy the layout of `/root/sms-platform/<id>/ansible/inventories/production.example/hosts.yml` into
     `/root/sms-inventory/hosts.yml`.
   - Keep `srv-a` as it is, and add `srv-b` and `witness`. Remove `ansible_connection: local` from `srv-a` once the
     installation runs from one place for all three (srv-a logs in to the others over SSH).
   - On the two new machines set `etcd_initial_state: existing`.
3. **etcd:** on srv-a, register each new member before installing it (`etcdctl member add srv-b
   --peer-urls=http://10.0.0.12:2380`, then the same for the witness).
4. **Planned stop of about 30 minutes.** The event bus becomes a three-machine cluster, so its 2 days of in-flight
   events must be empty first:
   1. stop customer intake (`systemctl stop sms-switch` once the queues shown in Grafana are empty, or warn partners
      first);
   2. let the queues drain (Grafana);
   3. stop NATS and move its store aside.
5. Run `sms-update --setup` with the new inventory. It does the following:
   - PostgreSQL gets its standby on srv-b (copied from srv-a);
   - Redis gets a replica, and Sentinel moves to 3 votes;
   - ClickHouse Keeper grows to three voters and srv-b copies the EDRs;
   - NATS becomes the cluster, and each event is kept 3 times;
   - the switch gets the witness quorum;
   - monitoring moves to the witness, with the cluster alerts.
6. Run `sms-update`. Point DNS `sms` and `smpp` at both servers, or at the provider's failover IP.
7. Run the failover drill from `docs/FAILOVER_DRILLS.md` before relying on it.
