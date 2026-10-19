# Team trial guide (build step 6)

The whole GUI runs on **fake data**: invented partners, trunks, rates and users, with production-like
volume (about 940 enterprises, 1,300 trunks, 1,000 rate tables with 1.4 million rate lines, 3,000 route
rules and 5 million EDRs over 30 days). Nothing here talks to the current platform or to real traffic.
Try it, break it, and tell us what to change. Every change you ask for goes into the API contract and
`docs/BACKEND_TODO.md`, so the Elixir backend is built to match.

## 1. Open the trial instance

### Shared instance (one server for the whole team)

**Recommended: from images, no source code on the server.** GitHub builds the images from `main` and the
server pulls them; with a domain, Caddy adds HTTPS. Follow [`deploy/server/README.md`](../deploy/server/README.md).
The steps below build from a clone of the repository instead (for a machine where the code may live).

On the trial server (Docker with Compose v2, 4 CPUs, 8 GB RAM, 20 GB disk):

```bash
git clone <this repository> && cd SMS_System
cp .env.example .env            # fake local values; change the passwords if the server is shared
docker compose --profile app up -d --build                 # databases, mock server, web app
docker compose --profile seed run --rm seed                # load the fake data (once)
```

Then open `http://<server>:8080` (set `WEB_PORT` in `.env` for another port).

**Lock it before sharing the address:**

- **Team password.** Set `TEAM_PASSWORD` (and optionally `TEAM_USER`, default `team`) in `.env`, then
  `docker compose --profile app up -d` again. The browser then asks for that one username and password
  before anything loads; pages, the API and the live WebSocket are all covered. Leave it empty for an
  open instance (the web container logs a warning). Avoid `$` in the password (Compose reads it as a
  variable). To change it, edit `.env` and run the same command. This is a gate for the trial only, not
  the platform's own sign-in (§13.28), which comes with the backend.
- **Database ports.** Postgres, ClickHouse and Redis listen on `127.0.0.1` only, so the network sees just
  the web port (8080). Tools on the server itself (`psql`, the npm scripts) still connect as before;
  from another machine use an SSH tunnel, e.g. `ssh -L 5432:127.0.0.1:5432 <server>`.
- Still keep the instance on the office network or VPN and open only port 8080 in the firewall: the team
  password travels over plain HTTP unless you put the server behind HTTPS.

- `SEED_PROFILE=small docker compose --profile seed run --rm seed` loads a small set in a few minutes.
  The default `full` profile is the production-like volume the screens were tuned for, and takes longer.
- Re-running the seed job **resets all data**, including everything changed during the trial. Export
  anything worth keeping first (Migration center → New export).
- If the server reaches the internet only through a proxy, the image build's `npm ci` fails. Pass the
  proxy to the build, e.g. `HTTPS_PROXY=http://proxy:3128 docker compose --profile app build
  --build-arg HTTPS_PROXY --build-arg HTTP_PROXY`. If the proxy re-signs TLS, its CA must also be trusted
  in the build (`NODE_EXTRA_CA_CERTS`). Docker Hub may also rate-limit image pulls (HTTP 429); wait and
  retry, or sign in with `docker login`.
- The web container waits until the mock answers its health check (a few seconds at start).
- Stop with `docker compose --profile app down`. The data stays in Docker volumes until you
  add `-v`.

### Updating to a new version

On the machine that runs the trial, from the `SMS_System` folder:

```bash
git pull                                          # get the new version (the server follows main)
docker compose --profile app up -d --build        # rebuild and restart the mock server and the web app
```

Then reload the page in the browser with **Ctrl+Shift+R** (or **Ctrl+F5**) so it loads the new web app.

When an update changes the database, its notes say so. Either reseed (`docker compose --profile seed run
--rm seed`, which **resets all data**), or keep your data and run the upgrade script it names, e.g.:

```bash
( echo "SET search_path = sms, public;"; cat db/postgres/upgrades/2026-10-18_trial_round_1.sql ) \
  | docker compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1'
```

Upgrade scripts are safe to run more than once, and do nothing on a database seeded after them.

### On your own machine

```bash
npm install
cp .env.example .env
npm run db:up && npm run seed:full     # or seed:small
npm run dev:mock                       # API on :4010
npm run dev:web                        # GUI on http://localhost:5173
```

Re-seeding works while the mock server is running, but restart the mock afterwards (Ctrl+C, then
`npm run dev:mock`) so it drops what it cached from the old data.

## 2. Who you are in the trial

There is no sign-in screen in this phase. Everyone using the instance works as the demo
administrator, **Daniel Khoury** (all pages and buttons).

- To see the system as an account manager or another role sees it, use the user menu (top right) →
  **View as user…**. Lists, records, search and exports then answer under that user's visibility
  policy (§13.17). End the preview from the strip under the tabs.
- Every seeded user has the fake password `demo-password-2026`. The demo administrator's fake 2FA
  secret is `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` (add it to any authenticator app to try My password, the
  2FA steps of exports, and the Change Password screen). Neither is a real credential.
- Because everyone is the same user, Change history and the Audit trail show all trial edits under one
  name, and anyone's Undo can undo anyone's change. Agree among testers who edits what, or use separate
  records.

## 3. What is real and what is simulated

| Area | In the trial |
| --- | --- |
| Lists, filters, sorting, search | Real, on the server, at full volume (§13.25 filter grammar: per-column filters, the AND/OR builder, `%` and `_` wildcards, regex) |
| Saves, undo, history, safe delete | Real: every save is one change you can undo (§13.10); delete archives (§13.29) |
| Live dashboard, analytics, alerts, hover volumes | A traffic simulator pushes events over the WebSocket in the format the backend will use |
| E-mails (rate sheets, invoices, alerts, reminders) | Logged under Switch → Email logs, never sent |
| SMPP binds, network status, signaling, diagnosis | Simulated; no connection to any SMSC |
| EDRs | Generated, with both legs, rates and costs as at send time |

## 4. What to try

Start with the screens the team uses every day (build order 4), then the rest.

| Area | Page | Try |
| --- | --- | --- |
| Enterprises | Enterprises, Customer trunks, Vendor trunks | Open a partner, edit billing, add a trunk; delete one and look at the dependency check |
| Rates | Rate manager | Open a vendor table, change rates, upload a file, look at history and best buy |
| Routing | Route rules | Filter by destination, open a rule's Conditions / Vendors / Traffic / History / Test; hover the volumes |
| Routing | Rate lookup | Side by side: filter customer and vendor rates separately (category, trunk, country, MCCMNC), open a destination to see its tables; One destination for margins |
| Reports | Enterprise report | Run a customer and a vendor report for last month; export |
| Dashboard | Dashboard, Live analytics | Watch the live figures; acknowledge an alert pop-up |
| Rates | Incoming RNs, Market moves, Bulk rating | Review an RN against live traffic; re-price several clients at once |
| Routing | Route map, LCR, Re-rating, Simulator | Which rule and vendor a message gets, and why |
| Switch | Translation rules, HLR, Number lists, Notifications, Email logs, Firewall, Traffic alerts, Broadcast | |
| Finance | Transactions, Invoices, Vendor invoices, SOA, Balances | Generate an invoice; reconcile a vendor invoice; send an SOA (logged) |
| Monitoring | Alert rules, Incidents, EDR search and download, Network status, Failed EDRs | Search EDRs by number or message ID; download a period |
| Reports | Master, Sales, Billing, NOC, Team, Scheduled | Group and filter by anything; schedule a report |
| Admin | Users, Access groups, Visibility policies, Security settings, Cleanup center, Migration center, Audit trail | Force a password change; preview an AM's view; run a cleanup scan; dry-run an import |

Everywhere: tabs (drag one out into its own window), Ctrl K to jump to any page or record, the theme
switch (light and dark), and Undo after a save.

## 5. How to send a change request

One request per item, in the team's tracker or to the product owner, with:

1. **Page** (and record, e.g. "Route rules → rule #1234 → Vendors").
2. **What happened** or what is missing.
3. **What you expected**, and why it matters in your daily work.
4. A screenshot if it helps.

Each accepted request is logged in `docs/BACKEND_TODO.md` with the contract change and the spec section
it touches, then built.

## 6. Readiness check (run before each trial round)

- `npm run check`: contract lint, generated types, type checks, all tests, production build.
- `cd mock && node --env-file=../.env --import tsx scripts/perf-lists.ts 1000`: times every list endpoint at the
  loaded volume (first page, next page, quick search, every sortable column) and flags anything over
  1 second. Run it against the full profile.
- Do not run the test suite against the shared trial database: the tests change the demo
  administrator's password and add test records.
