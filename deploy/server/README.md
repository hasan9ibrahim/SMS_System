# Trial server from images (no source code on the server)

GitHub builds two images from `main` on every push (`.github/workflows/images.yml`) and keeps them in the
private GitHub Container Registry:

| Image | What is inside |
| --- | --- |
| `ghcr.io/hasan9ibrahim/sms-mock` | The API server and the fake-data seed tool as two minified bundles, the SQL files and the contract. No source tree, no `node_modules`. |
| `ghcr.io/hasan9ibrahim/sms-web` | The built web app (minified, no source maps) behind nginx, with the team password gate. |

The server only needs this folder's `docker-compose.yml` and a filled-in `.env`. Fake data only
(CLAUDE.md rule 1): never connect this server to the current production platform.

Below, `sms.example.com` is your domain and `203.0.113.10` the server's IP. Server: Ubuntu 22.04/24.04,
4 CPUs, 16 GB RAM (8 GB with `SEED_PROFILE=small`), 40 GB disk, Docker with Compose v2.

## 1. DNS

At your domain provider add an **A** record: name `sms` (or `@`), value `203.0.113.10`. Wait until
`ping sms.example.com` answers with that IP.

## 2. A read-only registry token

On GitHub (the account that owns the repository): **Settings → Developer settings → Personal access
tokens → Tokens (classic) → Generate new token**, scope **`read:packages`** only, then copy the token.

On the server:

```bash
echo '<token>' | docker login ghcr.io -u hasan9ibrahim --password-stdin
```

## 3. The two files

From your PC (in the `SMS_System` folder), copy the two files over; nothing else goes to the server:

```powershell
ssh root@203.0.113.10 "mkdir -p /opt/sms"
scp deploy/server/docker-compose.yml deploy/server/.env.example root@203.0.113.10:/opt/sms/
```

On the server:

```bash
cd /opt/sms && cp .env.example .env && nano .env
```

Fill in `POSTGRES_PASSWORD`, `CLICKHOUSE_PASSWORD`, `MOCK_SECRET_KEY`
(`openssl rand -hex 24` for each) and `TEAM_PASSWORD`. Keep `WEB_BIND=127.0.0.1:8080`.

```bash
chmod 600 .env
```

## 4. Start and load the fake data

```bash
docker compose pull
docker compose up -d
docker compose --profile seed run --rm seed          # full set, about 10 minutes
#   SEED_PROFILE=small docker compose --profile seed run --rm seed   (8 GB servers, ~1 minute)
docker compose restart mock
curl -I http://127.0.0.1:8080                        # 401 = password gate on, 200 = open
```

## 5. HTTPS for your domain (Caddy)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
sms.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo systemctl reload caddy
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw enable
```

Caddy gets and renews the certificate and passes the live WebSocket through. Also open 22, 80 and 443
in your hosting provider's firewall if it has one. Open **https://sms.example.com**.

## Updating

When `main` changes, wait for the **Images** workflow on GitHub to finish, then:

```bash
cd /opt/sms
docker compose pull && docker compose up -d
```

Press **Ctrl+Shift+R** in the browser. To pin or roll back, set `IMAGE_TAG=<commit SHA>` in `.env`.

Database changes are applied automatically: when the `mock` container starts it runs the upgrade scripts in
`db/postgres/upgrades/` that changed since they last ran, keeping all data (check with
`docker compose logs mock | grep "database"`: "database upgraded: …" or "database schema up to date"). If the
database is not reachable or not seeded yet, it retries every minute. To run a script by hand anyway:

```bash
docker compose exec -T mock cat db/postgres/upgrades/2026-10-18_trial_round_1.sql \
  | (echo "SET search_path = sms, public;"; cat) \
  | docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
```

or reload the fake data (step 4), which **resets all data**: export anything worth keeping first
(Admin › Migration center).

## Checks

```bash
docker compose ps                    # mock and web "healthy"
docker compose logs -f mock          # API server log
sudo journalctl -u caddy -n 50       # certificate problems (DNS not pointing here, port 80 closed)
docker compose down                  # stop; data stays in the volumes
```
