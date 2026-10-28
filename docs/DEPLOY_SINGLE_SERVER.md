# Putting the platform on one server and your domain

This guide takes the code from GitHub to a running platform on **one server**, reachable at your own domain.
It assumes:

- the server is the OVH RISE-3: Ubuntu 24.04, 64 GB RAM, 2 × 3.84 TB NVMe;
- the domain is `example.net`, registered at GoDaddy;
- the screens will live at `https://sms.example.net`;
- partners will connect over SMPP to `smpp.example.net`.

Replace `example.net`, `203.0.113.11` (the server's public IP) and the other example values with yours.

Everything runs on this one machine. The platform is built so that a second server and the witness VM can be added
later with no code change (last section).

> **One server means no failover.** If the server stops, traffic stops until it is back. The data is safe in the
> off-site backups (step 4). Add the second server and the witness before you depend on it for real traffic.

---

## 0. What you need before you start

| What | Why | Example |
| --- | --- | --- |
| The server and its **public IP** | It runs everything | OVH control panel → Bare Metal Cloud → your server → IP |
| Access to **GoDaddy DNS** for `example.net` | To point the names at the server | godaddy.com → My Products → example.net → DNS |
| A **build and deploy machine**: Ubuntu 24.04 (a laptop, a small VM, or WSL2 on Windows) | It builds the release and runs Ansible over SSH | Your laptop with WSL2 "Ubuntu 24.04" |
| An **S3-compatible bucket at another provider** | Off-site backups, and old EDRs and recordings | Backblaze B2, Wasabi, or OVH Object Storage in another region |
| An **SMTP account** for platform e-mail | Sign-in codes are e-mailed; without e-mail nobody can sign in | Microsoft 365, Google Workspace, Amazon SES, Mailgun |
| A **Telegram bot** (optional, recommended) | Alerts to your phone | @BotFather in Telegram |
| Your **office or home public IP** | Only these addresses may use SSH and the monitoring pages | Run `curl -4 ifconfig.me` on your computer |

---

## 1. Install the server

1. In the OVH control panel open the server, then **Reinstall** (or **Install**).
2. Step 1 of the OVH dialog:
   - **Type of OS:** Basic.
   - Open the **LINUX** list and choose **Ubuntu Server 24.04 LTS**.
   - **Target disk group:** leave the 2 × NVMe (JBOD). JBOD only means the server has no RAID card, so the RAID is
     done in software, and "Customise the hardware RAID" stays greyed out.
   - Tick **Customise the partition configuration**, then **Next**.
3. Step 2, the partitions. Every partition must be **RAID 1** (on both disks, so one disk failing loses nothing),
   and `/` must take the rest of the disk, because the databases live under `/var/lib`:

   | Mount point | File system | RAID | Size |
   | --- | --- | --- | --- |
   | `/boot` | ext4 | 1 | 1 GiB |
   | `swap` | swap | – | 8 GiB |
   | `/` | ext4 | 1 | the rest (tick "use the remaining space") |

   - Leave the EFI partition OVH adds (`/boot/efi`) as it is.
   - Delete any other partition the template proposes (`/home`, `/var/lib/vz`, a large `/data` and so on), then
     grow `/` to the remaining space.
4. Paste your **SSH public key** (step 3 of the dialog), then confirm the installation (step 4):
   - If you have none, run `ssh-keygen -t ed25519` on the build machine.
   - Then paste the contents of `~/.ssh/id_ed25519.pub`.
5. Wait for the installation e-mail. Then, from the build machine:

   ```sh
   ssh root@203.0.113.11        # the OVH template may log you in as "ubuntu"; then: sudo -i
   apt update && apt -y full-upgrade && reboot
   ```

6. **Optional, recommended: the private network (vRack).** The second server will reach this one over it later.
   - Add the server to a vRack in the OVH panel.
   - Give its second network interface a private address, for example `10.0.0.11/24` (OVH's vRack guide).
   - If you skip this for now, use the public IP as `private_ip` in step 4. The firewall keeps those ports closed to
     everyone else.

---

## 2. Point your domain at the server (GoDaddy)

1. Sign in at godaddy.com, open **My Products**, then **DNS** next to `example.net` (or **Domain → Manage DNS**).
2. Click **Add New Record** and create these two records:

   | Type | Name | Value | TTL |
   | --- | --- | --- | --- |
   | A | `sms` | `203.0.113.11` | 1/2 hour |
   | A | `smpp` | `203.0.113.11` | 1/2 hour |

   `sms.example.net` is for the screens and the customer portal. `smpp.example.net` is the address you give partners.
   - To use the bare domain (`example.net`), edit the existing `A` record named `@` instead. Note that GoDaddy's
     "Parked" record must be replaced.
   - If the domain uses another provider's name servers (Cloudflare, for example), add the records there instead.
     With Cloudflare, set the records to **DNS only** (grey cloud), as SMPP cannot pass through its proxy.
3. Check from the build machine:

   ```sh
   dig +short sms.example.net      # must print 203.0.113.11
   dig +short smpp.example.net
   ```

   It usually takes a few minutes, at most a few hours. **Do not continue to step 5 until it shows the IP.** The HTTPS
   certificate is only issued once the name points at the server.
4. **E-mail records:** your SMTP provider gives you records that stop sign-in codes landing in spam:
   - an SPF `TXT` record;
   - one or more DKIM `CNAME` or `TXT` records;
   - usually a DMARC `TXT` record.

   Add each one in the same GoDaddy DNS page, exactly as the provider shows it.
5. **Optional:** in the OVH panel, set the IP's **reverse DNS** to `sms.example.net`.

---

## 3. Prepare the build and deploy machine

On Ubuntu 24.04 (the release is built for the server's Ubuntu 24.04):

```sh
sudo apt update
sudo apt install -y git curl build-essential autoconf libssl-dev libncurses-dev unzip pipx
pipx install ansible-core && pipx ensurepath          # open a new terminal after this

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs

# Erlang 28 and Elixir 1.19 (the versions in .tool-versions), with mise. Erlang compiles once (10-20 minutes).
curl https://mise.run | sh && echo 'eval "$(~/.local/bin/mise activate bash)"' >> ~/.bashrc && exec bash
mise use -g erlang@28.5.0.8 elixir@1.19.6-otp-28

git clone https://github.com/hasan9ibrahim/SMS_System.git
cd SMS_System/deploy/ansible
```

Check that it can reach the server: `ssh root@203.0.113.11 true` must return without asking for a password.

### Without a separate build machine: build and deploy on the server itself

If you do not want Ubuntu on your computer (or another machine involved), the server can build the release and run
Ansible on itself. Your computer then only needs SSH, which Windows 10 and 11 have built in.

1. **Your SSH key, on Windows.** In PowerShell (no administrator needed):

   ```powershell
   ssh-keygen -t ed25519                         # press Enter three times
   type $env:USERPROFILE\.ssh\id_ed25519.pub     # paste this line into the OVH install (step 1)
   ssh root@203.0.113.11                         # how you log in from now on
   ```

2. **On the server, as root:** run the commands at the top of this step, without `sudo`.
3. **The code is in a private GitHub repository.** Give the server its own read-only key:
   - Run `ssh-keygen -t ed25519` on the server and print the key with `cat ~/.ssh/id_ed25519.pub`.
   - On GitHub, open the repository, then **Settings → Deploy keys → Add deploy key**, and paste it. Leave
     "Allow write access" off.
   - Then clone with `git clone git@github.com:hasan9ibrahim/SMS_System.git` (in `/root`, not in `/opt/sms`).
4. **The inventory (step 4):** add `ansible_connection: local` to the server's line, so Ansible works on this machine
   instead of logging in to it:

   ```yaml
   srv-a: {ansible_host: 203.0.113.11, private_ip: 10.0.0.11, node_id: 1, ansible_connection: local}
   ```

5. Everything else is the same: steps 5 and 6 run in `/root/SMS_System/deploy/ansible` on the server.

`admin_cidrs` (step 4) must still hold your office or home IP: after step 5 the server accepts SSH only from there.
Ansible itself does not need SSH in this mode.

---

## 4. Describe your server (the inventory)

```sh
cp -r inventories/single.example inventories/production
```

1. **`inventories/production/hosts.yml`:**
   - `ansible_host:` the public IP (`203.0.113.11`);
   - `private_ip:` the vRack address (`10.0.0.11`), or the public IP if you skipped the vRack.
2. **`inventories/production/group_vars/all/main.yml`:**

   | Setting | Put |
   | --- | --- |
   | `admin_cidrs` | Your office or home IP, e.g. `[198.51.100.7/32]`. **Only these may use SSH** (and Grafana). A wrong value locks you out; then use the OVH KVM / rescue mode to fix `/etc/nftables.conf`. Add every address you work from. |
   | `smpp_cidrs` | The partners' IPs, or `[0.0.0.0/0]` for now (the Firewall screen and trunk IP lists still apply) |
   | `s3_endpoint`, `s3_region`, `s3_bucket` | Your bucket (e.g. `s3.eu-central-003.backblazeb2.com`, `eu-central-003`, `sms-backups`) |
   | `telegram_chat_ids` | The chat id(s) for alerts (step 9) |
   | `web_domain` | `sms.example.net` |
   | `web_letsencrypt`, `letsencrypt_email` | `true`, and an address for Let's Encrypt's expiry notices |
   | `smtp_from` | The sender address your SMTP account may send from, e.g. `noreply@example.net` |

3. **Secrets:**

   ```sh
   cd inventories/production/group_vars/all
   cp secrets.example.yml secrets.yml
   openssl rand -hex 24       # run once per CHANGE_ME and paste each value
   openssl rand -hex 64       # for vault_secret_key_base
   openssl rand -hex 32       # for vault_mock_secret_key
   ```

   Then fill in the rest:
   - `vault_s3_access_key` / `vault_s3_secret_key`: the bucket's key.
   - `vault_smtp_url`: for example `smtp://user:password@smtp.office365.com:587` (or `smtps://…:465`).
   - `vault_telegram_bot_token`: from @BotFather.

   Then lock the file:

   ```sh
   ansible-vault encrypt secrets.yml        # choose a vault password
   cd ../../../..                           # back to deploy/ansible
   ```

   **Keep the vault password, `vault_pgbackrest_cipher_pass` and `vault_mock_secret_key` somewhere safe outside the
   server**, for example a password manager:
   - without the cipher the backups cannot be read;
   - `vault_mock_secret_key` must never change once the platform is in use.

---

## 5. Install everything on the server

```sh
ansible-playbook -i inventories/production site.yml --ask-vault-pass
```

It takes 15–30 minutes the first time. In order, it installs:
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

It is safe to run again after any change to the inventory.

If it stops, read the last red lines:

| Message | Fix |
| --- | --- |
| certbot fails | DNS does not point at the server yet (step 2), or port 80 is blocked |
| `vault_smtp_url` or S3 errors | A secret is wrong (step 4) |
| SSH unreachable after the firewall step | `admin_cidrs` does not include your IP (step 4) |

---

## 6. Build and deploy the application

```sh
./build-release.sh                 # prints the release id, e.g. 1a2b3c4d5e
ansible-playbook -i inventories/production deploy.yml -e release=1a2b3c4d5e --ask-vault-pass
```

This uploads the switch, the API, the TypeScript service and the screens, then runs the database migrations. Then it
starts each part and waits until each one answers.

---

## 7. Create the first administrator

On the server (`ssh root@203.0.113.11`), once:

```sh
sudo -u sms bash -c 'set -a; . /etc/sms/service.env; set +a; cd /opt/sms/service/current; node bootstrap.mjs \
  --admin-username admin --admin-email you@example.net --admin-first-name Your --admin-last-name Name \
  --summary-emails rates@example.net,noc@example.net'
```

It prints a **temporary password** (valid 24 hours). It also fills in what every screen needs:
- currencies, billing cycles and product categories;
- every country and network;
- the starting access groups.

It does not add network prefixes; import those in Routing › Master table. See `docs/GO_LIVE.md` §4.

---

## 8. Sign in and check

1. Open **https://sms.example.net**. The browser shows a padlock (a valid certificate).
2. Sign in with `admin` and the temporary password.
3. Enter the code e-mailed to you, then choose a new password (another code).

If no code arrives:
- check `vault_smtp_url`;
- check the e-mail DNS records (step 2.4);
- check Switch › Email logs.

On the server, every service must be **active**:

```sh
systemctl status sms-switch sms-service nginx patroni redis-server nats clickhouse-server --no-pager | grep -E "●|Active"
```

**Grafana:** `http://203.0.113.11:3000`. It only opens from the `admin_cidrs` addresses. The user is `admin`; the
password is `vault_grafana_admin_password`. The "SMS platform" dashboard shows the server.

---

## 9. Alerts on Telegram (optional)

1. In Telegram, talk to **@BotFather**: send `/newbot` and copy the token into `vault_telegram_bot_token`.
2. Add the bot to your chat or group and send it a message.
3. Open `https://api.telegram.org/bot<token>/getUpdates` and copy the chat `id` (a negative number for a group) into
   `telegram_chat_ids`.
4. Run `site.yml` again (step 5).
5. To test, run `systemctl stop sms-switch` on the server. An alert arrives within about two minutes. Then run
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

## 11. Later: updates, backups, renewals

| What | How |
| --- | --- |
| A new version | Run `git pull`, then step 6 (`build-release.sh` and `deploy.yml`). The last five releases stay on the server; to roll back, run `deploy.yml` with the previous id. |
| A setting changed in the inventory | Run step 5 again (`site.yml`) |
| Backups | Automatic: PostgreSQL and ClickHouse every night to the bucket, plus a monthly restore test. An alert fires after 26 hours without a backup. |
| Certificate | Renewed by itself about every 60 days. nginx pauses for a few seconds while the check on port 80 runs. SMPP TLS uses the renewed certificate from the switch's next restart (any deploy). |
| Disk | Grafana shows it. An alert fires when less than 15 % is free. |

---

## 12. Growing to two servers and the witness

The application code does not change: the switch, the API and the TypeScript service read their cluster settings at
start. What changes is the inventory, plus a short planned stop. We will rehearse this in the lab (`deploy/lab`)
before you do it. The outline:

1. **Order** the second server and the witness VM:
   - the second server: same provider, another data centre, the same vRack;
   - the witness: another provider, 4–6 vCPU, 8–12 GB RAM, 200 GB.

   Give each a `private_ip` reachable from the others, either the vRack or a VPN to the witness.
2. **Inventory:**
   - Copy `inventories/production.example/hosts.yml`'s layout into `inventories/production/hosts.yml`.
   - Keep `srv-a` as it is, and add `srv-b` and `witness`.
   - On the two new machines set `etcd_initial_state: existing`.
3. **etcd:** on srv-a, register each new member before installing it (`etcdctl member add srv-b
   --peer-urls=http://10.0.0.12:2380`, then the same for the witness).
4. **Planned stop of about 30 minutes.** The event bus becomes a three-machine cluster, so its 2 days of in-flight
   events must be empty first:
   1. stop customer intake (`systemctl stop sms-switch` once the queues shown in Grafana are empty, or warn partners
      first);
   2. let the queues drain (Grafana);
   3. stop NATS and move its store aside.
5. Run `site.yml` with the new inventory. It does the following:
   - PostgreSQL gets its standby on srv-b (copied from srv-a);
   - Redis gets a replica, and Sentinel moves to 3 votes;
   - ClickHouse Keeper grows to three voters and srv-b copies the EDRs;
   - NATS becomes the cluster, and each event is kept 3 times;
   - the switch gets the witness quorum;
   - monitoring moves to the witness, with the cluster alerts.
6. Run `deploy.yml` (step 6). Point DNS `sms` and `smpp` at both servers, or at the provider's failover IP.
7. Run the failover drill from `docs/FAILOVER_DRILLS.md` before relying on it.
