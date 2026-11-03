# Baby Schedule Module for Yuvomi

A Yuvomi third-party module for planning a baby's week: wake-up, milk bottles,
water, breakfast, fruit, vegetables, lunch, snacks, dinner, naps, night sleep
and anything else, Monday to Sunday. Both parents work on the same household
schedule from their phones, and each sees the other's changes within about
20 seconds without reloading.

It has two parts:

| Part | Folder | What it is |
|------|--------|------------|
| Module | [`modules/baby-schedule/`](modules/baby-schedule/) | The page inside Yuvomi (browser code) |
| Sidecar | [`sidecar/`](sidecar/) | A small Node service with its own SQLite database that stores the schedule |

Yuvomi core is not changed. The module uses only the documented module
contract (`MODULES.md`), Yuvomi's public browser libraries and
`GET /api/v1/auth/me`.

---

## Features

**Week at a glance**

- Seven-day strip (Mon–Sun) with the number of activities per day; today is marked.
- Tap a day, swipe left/right on the timeline, or use the arrow keys to change day.

**Daily timeline**

- Activities sorted by time and grouped into Morning / Afternoon / Evening.
- Each row shows the time, a category emoji (🍼 💧 🥣 🍲 🍽️ 🍐 🥕 🍌 😴 🌅 🧸 📝),
  the name, the amount or duration (120 ml, 1.5 hours), the food and notes.
- On today's timeline: an "Up next" card, the next activity highlighted, past ones dimmed.

**Fast entry**

- Quick-add chips: Bottle (120 ml pre-filled), Water, Meal (breakfast / lunch /
  snack / dinner chosen by time of day), Fruit, Nap (1 hour pre-filled), Other.
- One sheet for everything: type, time, name, food/details, amount + unit, notes.
- **Add to several days at once** (Every day / Mon–Fri / Weekend shortcuts).
- **Add another** keeps the sheet open and moves the time on by 30 minutes,
  so a whole day can be entered in one go.
- New entries suggest a time 30 minutes after the day's last activity.

**Changing entries**

- Edit, delete, duplicate, move to another day, move earlier/later (swaps places
  with the neighbour), repeat on other days.
- Edits change **only the selected day** unless you tick more days under
  "Also apply this change to"; there the matching activity is updated, or added
  if it is missing.

**Planning the whole week**

- **Copy a day** to any other days (add to what's there, or replace it).
- **Repeat** one activity on chosen days (days that already have it are skipped).
- **Week templates**: save the whole week under a name, apply it later
  (replace the week or add to it), delete it.
- **Example day**: fill any days with a typical day (from the brief) and adjust.
- **Clear a day** or **clear the week**, each with confirmation.

**Overview** (side column on desktop, below the timeline on phones)

- Today's date, number of activities, food entries, next feeding, next sleep,
  milk total, up next.
- The week as a list with activities and feeds per day.

**On the home dashboard: the "Baby today" widget**

- Shows what's up next for the baby today (with "in 25 minutes"), the following
  activities, next feed and next sleep, and links to the full schedule.
- Refreshes every minute. Size 1×1 shows 3 rows, 1×2 or larger shows 6.
- Yuvomi's "Today at a glance" is built only from Yuvomi's own data (calendar,
  meals, shifts) and has no slot for modules, so the widget sits next to it.
  Show, hide, move or resize it with the dashboard's Customize button.

**In "Today at a glance" and Wall Mode: one baby task at a time** (optional)

- The baby's current or next activity appears as **one** Yuvomi task, e.g.
  "🍼 Milk bottle · 120 ml", due today at its time.
- Tick it off anywhere (phone, Tasks page, wall tablet): within about 30 seconds
  it is removed and the next activity becomes the task.
- Not ticked off? When the following activity's time arrives it moves on, so no
  overdue baby tasks pile up. Schedule edits update the task right away.
- Tasks carry 0 reward points and are visible to the whole household.
- **Setup (admin, once):** *Settings → Modules → Baby Schedule → Turn on*. The page
  creates an API token limited to **Tasks: write** through the admin's own session
  and hands it to the sidecar, which keeps it and never sends it back to a browser.
  It is listed under *Settings → Household → API access* and can be revoked there.
  A token is needed because the next task must be created even when nobody has
  Yuvomi open (for example after a tick on the wall tablet). Pasting your own
  token is possible under "Advanced".
- Why a task: Yuvomi's "Today at a glance" and Wall Mode accept no rows or
  widgets from modules, but they do show open tasks due today.

**Household sharing and roles**

- One schedule per household, shared by every member with access.
- Uses Yuvomi's permission system: *Settings → Household → Roles & permissions →
Baby Schedule* can be `write` (default), `read` (view only: no edit controls),
  or `none`.
- "Last changed by …" on each activity.

---

## Architecture

```text
Phone / browser
      │  https://your-yuvomi/…            (one origin)
      ▼
 ┌──────────── reverse proxy (nginx gateway in deploy/) ────────────┐
 │  /api/extensions/baby-schedule/*  ──►  baby-schedule sidecar     │
 │  everything else                  ──►  Yuvomi                    │
 └──────────────────────────────────────────────────────────────────┘
                         sidecar ──GET /api/v1/auth/me (with the caller's cookie)──► Yuvomi
                         sidecar ──► /data/baby-schedule.db (its own SQLite file)
```

- **Same origin.** Yuvomi's `capabilities.api.prefix` must be exactly
  `/api/extensions/baby-schedule`, and the browser must reach the sidecar on the
  same host as Yuvomi so the session cookie is sent. Yuvomi does not proxy this
  path itself, so a reverse proxy routes it (an nginx gateway is included).
- **Identity comes from Yuvomi.** For every request the sidecar forwards only the
  Yuvomi session cookie (`yuvomi.sid`, legacy `oikos.sid`, wall-display
  `yuvomi.display`) to `GET /api/v1/auth/me` and trusts only that answer. A user
  id or role in a request body is never read. Answers are cached for 10 seconds
  per session (Yuvomi rate-limits `/api/` to 300 requests/minute per IP); the
  caller's IP is passed on in `X-Forwarded-For` so that limit applies per phone.
- **Permissions.** Access needs `permissions.modules['ext:baby-schedule']` to be
  `read` or `write`; writes need `write`. That key only exists while the module is
  **enabled** in Yuvomi, so disabling the module also locks its API. Split-expense
  guests and deactivated accounts are refused.
- **Writes** additionally need: an `Origin` matching the public address (and no
  cross-site `Sec-Fetch-Site`), and the sidecar's own CSRF token sent as both the
  `bs_csrf` cookie and the `X-Baby-Schedule-CSRF` header. The token is an HMAC of
  the session, so it cannot be planted or reused across accounts. Writes are
  limited to 240 per minute per user. Bodies are JSON only, at most 64 KB, and
  every field is validated (time format, category and unit lists, lengths, day 0–6).
- **Household isolation.** Every row carries a `household` column and every
  query filters on it. One sidecar serves one Yuvomi installation (one
  household); its Yuvomi URL is fixed in its configuration, so sessions from
  another Yuvomi cannot be validated by it.
- **No `yuvomi.db` access.** The schedule lives only in the sidecar's database.
- **Browser side:** no external CDNs, no `innerHTML`; all text from the database
  is escaped. `render()` never throws (Yuvomi switches off a module whose page
  throws for an admin), every listener and timer is tied to the router's
  `context.signal`, and the page uses `page-layout.js`, the `dashboard`
  composition with `.page-columns`, Yuvomi tokens, and Yuvomi's own sheet dialog.

---

## Installation

### Quick install: one command

On the server where Yuvomi runs (as root):

```sh
curl -fsSL https://raw.githubusercontent.com/HSinghHira/yuvomi-baby-schedule/main/install.sh | sh
```

or, from a copy of this repository on the server: `sh install.sh`.

The script finds your Yuvomi container, its port and its modules folder; builds
and starts the Baby Schedule service (picking a free port, fixing folder
permissions); copies the module into Yuvomi and restarts it. Then it shows the
one route to add in your proxy (exact values for Cloudflare Tunnel or Nginx
Proxy Manager when it finds them) and waits until that route works. Without any
proxy in front of Yuvomi, run it with `BS_GATEWAY=1` to get a gateway port to
open Yuvomi at instead.

Afterwards, an admin taps **Settings → Modules → Baby Schedule → Turn on** to show
the baby's next activity in "Today at a glance" and Wall Mode. That button creates
a Tasks-only API token by itself; there is nothing to copy.

Run the same command again to update. Data, port and address are kept.
Options: `BS_DOMAIN`, `BS_PORT`, `BS_DATA`, `BS_GATEWAY`, `YUVOMI_CONTAINER` (see
the top of [install.sh](install.sh)).

The manual steps below do the same by hand.

You need: Yuvomi with a writable, persistent modules folder (Docker, Unraid,
TrueNAS, Portainer, Podman, ZimaOS/IceStore; **not Umbrel**, which mounts no
modules folder), and Docker to run the sidecar.

Order: **1.** start the sidecar and the gateway, **2.** install the module,
**3.** open Yuvomi through the gateway.

### A. Existing Yuvomi (for example ZimaOS / IceStore)

On IceStore, Yuvomi is published on the host at port **6161** and its modules
folder is `/DATA/AppData/yuvomi/modules`.

1. Copy this repository to the server, for example `/DATA/AppData/baby-schedule`.
2. Start the sidecar and the gateway:
   
   ```sh
   cd /DATA/AppData/baby-schedule/deploy
   YUVOMI_URL=http://host.docker.internal:6161 docker compose -f docker-compose.addon.yml up -d --build
   ```
   
   The gateway listens on **6162**. Data is stored in `deploy/baby-schedule-data/`.
3. Install the module (either way):
   
   - **Copy the folder:** copy `modules/baby-schedule` to
     `/DATA/AppData/yuvomi/modules/baby-schedule`. A hand-copied module starts enabled.
   - **From Settings:** see [section C](#c-install-the-module-from-settings--modules--add-custom-module).
4. Open Yuvomi at `http://<server>:6162` from now on (both phones). The old
   address `:6161` still works for everything except the baby schedule, which
   would show "The schedule service is not reachable".
5. Optional, recommended: in Yuvomi's app settings set `TRUST_PROXY=1` (one proxy,
   the gateway, in front) so its rate limit sees each phone's address.

If you use an HTTPS proxy (Nginx Proxy Manager, Traefik, Caddy, Cloudflare
Tunnel), point it at the gateway (`:6162`) instead of Yuvomi, set
`TRUST_PROXY_HOPS=2` and `ALLOWED_ORIGINS=https://your-domain` for the sidecar,
and `TRUST_PROXY=2` for Yuvomi.

**Already have a reverse proxy and don't want the gateway?** Add one route to it
and run only the `baby-schedule` service:

- nginx / Nginx Proxy Manager (custom location, or Advanced tab):
  
  ```nginx
  location ^~ /api/extensions/baby-schedule/ {
      proxy_pass http://<sidecar-host>:8080;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-Host $host;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
  ```
- Traefik (labels on the sidecar container):
  
  ```yaml
  - traefik.http.routers.baby-schedule.rule=Host(`yuvomi.example.com`) && PathPrefix(`/api/extensions/baby-schedule/`)
  - traefik.http.routers.baby-schedule.priority=100
  - traefik.http.services.baby-schedule.loadbalancer.server.port=8080
  ```
- Caddy: `handle /api/extensions/baby-schedule/* { reverse_proxy baby-schedule:8080 }` before the Yuvomi block.

### B. New installation: Yuvomi + Baby Schedule together

```sh
cd deploy
cp .env.example .env          # fill in SESSION_SECRET and DB_ENCRYPTION_KEY (openssl rand -hex 32)
docker compose up -d --build
```

Open `http://<server>:3000`, create the admin account, and **Baby Schedule**
is already in the navigation (this repository's `modules/` folder is Yuvomi's
modules folder).

### C. Install the module from Settings → Modules → Add custom module

This only installs the browser part. The sidecar (A or B) must run as well.

1. The server operator must allow web installs: set
   `MODULES_ALLOW_WEB_INSTALL=true` for Yuvomi and restart it.
2. Publish this repository on GitHub (public), ideally with a release tag
   (`v1.0.0`) and the topic `yuvomi-module`.
3. As an admin, in a browser: *Settings → Modules → Add custom module*, paste
   
   ```text
   https://github.com/<you>/<repo>/tree/main/modules/baby-schedule
   ```
   
   (or the repository address, if this is the only module in it), or upload a
   ZIP of the `modules/baby-schedule` folder.
4. A module installed from Settings arrives **disabled**. Review it under
   *Settings → Modules → Active modules* and switch it on.
5. Check *Settings → Household → Roles & permissions → Baby Schedule*: both
   parents need `write`.

All files in the module folder are of types the installer copies (`.js`,
`.css`, `.json`, `.md`); a test checks this.

### Updating

- Module: install the new version again (Settings replaces it and switches it
  off for review), or copy the folder over.
- Sidecar: `docker compose … up -d --build`. Database migrations run
  automatically at start.

### Backups

Back up the sidecar's data folder (`baby-schedule-data/`, the
`baby-schedule.db*` files and `.csrf_secret`). Yuvomi's own backup does not
include it. SQLite in WAL mode: stop the container, or use
`sqlite3 baby-schedule.db ".backup backup.db"`, for a consistent copy.

---

## Configuration (sidecar environment)

| Variable | Default | Meaning |
|----------|---------|---------|
| `YUVOMI_INTERNAL_URL` | `http://yuvomi:3000` | How the sidecar reaches Yuvomi to check sign-ins |
| `ALLOWED_ORIGINS` | empty | Exact browser origins allowed to write, comma-separated (`https://home.example.com`). Empty: derived from `X-Forwarded-Proto` + `X-Forwarded-Host`/`Host` |
| `TRUST_PROXY_HOPS` | `1` | Proxies in front of the sidecar, for reading the caller's IP |
| `PORT` | `8080` | Listen port |
| `DATA_DIR` | `/data` (image) | Database folder |
| `HOUSEHOLD_ID` | `default` | Household key stored on every row |
| `AUTH_CACHE_SECONDS` | `10` | How long a `/auth/me` answer is reused (0–60) |
| `AUTH_TIMEOUT_MS` | `5000` | Timeout for `/auth/me` |
| `WRITES_PER_MINUTE` | `240` | Write limit per user |
| `CSRF_SECRET` | generated | Signing secret; generated once into `DATA_DIR/.csrf_secret` if unset |
| `COOKIE_SECURE` | auto | Force `Secure` on the CSRF cookie (`true`/`false`); auto = when the request came over HTTPS |
| `LOG_REQUESTS` | `false` | Log each request |

---

## Sidecar API

All routes are under `/api/extensions/baby-schedule`. Days are `0` (Monday)
to `6` (Sunday). Every successful response is `{ "data": … }`; writes return
the complete new state plus a `result`. Errors are
`{ "error", "code", "reason" }` (`not_signed_in` 401, `module_forbidden` /
`read_only` / `bad_origin` / `csrf_invalid` 403, `gone` 404, `day_full` /
`week_empty` / `too_many_templates` 409, `invalid` 422, `rate_limited` 429,
`yuvomi_unreachable` 502).

| Method | Path | Body |
|--------|------|------|
| GET | `/health` | (no session needed) |
| GET | `/state` | → `{ entries, templates, revision, access, user, limits }` |
| GET | `/revision` | → `{ revision }` (polled for live updates) |
| POST | `/entries` | `{ entry, days: [0..6] }` |
| PATCH | `/entries/:id` | `{ entry: {partial}, alsoDays: [] }` |
| DELETE | `/entries/:id` | |
| POST | `/entries/:id/move` | `{ day }` |
| POST | `/entries/:id/repeat` | `{ days }` |
| POST | `/entries/:id/swap` | `{ targetId }` |
| POST | `/days/:day/copy` | `{ targets, mode: "append" \| "replace" }` |
| DELETE | `/days/:day` | |
| DELETE | `/week` | |
| POST | `/bulk` | `{ entries, days, mode }` |
| POST | `/templates` | `{ name }` (saves the current week) |
| POST | `/templates/:id/apply` | `{ mode }` |
| DELETE | `/templates/:id` | |
| GET | `/bridge` | (admin) → `{ enabled, hasToken, timeZone, task, lastError, lastRunAt }` |
| PUT | `/bridge` | (admin) `{ enabled?, token?, timeZone?, labels? }`; a new token is tested against Yuvomi first |

An entry: `time` (`HH:MM`), `category` (`wake milk water breakfast lunch dinner fruits vegetables snacks sleep activity other`), `title`, `description`,
`quantity` (number or null), `unit` (`ml oz g pcs tsp tbsp cup min h` or null),
`notes`.

## Database schema

[`sidecar/migrations/001_initial.sql`](sidecar/migrations/001_initial.sql);
applied migrations are recorded in `schema_migrations`. New migrations go in
`sidecar/migrations/NNN_name.sql` and run once, in order, at start.

| Table | Contents |
|-------|----------|
| `entries` | One activity: household, day, time, category, title, description, quantity, unit, notes, position, created/updated by and at |
| `templates` | A saved week: household, name, entries (JSON), count, creator, date |
| `households` | Change counter (`revision`) per household for live updates |
| `bridge` | "Today at a glance" settings: on/off, API token, time zone, labels, the current Yuvomi task (migration 002) |
| `bridge_done` | Activities already ticked off per day |

---

## Development and tests

Requires Node 22.13 or newer (Node 24 recommended). No npm packages are needed.

```sh
npm test                 # module logic + sidecar end-to-end tests
cd sidecar && npm start  # run the sidecar locally (YUVOMI_INTERNAL_URL, DATA_DIR)
```

- `sidecar/test/api.test.js` (27 tests): a mock Yuvomi `/auth/me` with two
  parents, a read-only member, a member without access, a split-expenses guest
  and a disabled module, against the real HTTP server and SQLite file: sign-in,
  Origin and CSRF checks, one parent's token not working for the other, both
  parents sharing the week, add/edit/"also apply"/move/repeat/swap/copy/bulk,
  templates, clear day/week, validation, deleted-elsewhere, revision,
  Yuvomi unreachable, data surviving a restart, and a second household seeing nothing.
- `test/schedule.test.js` (13 tests): sorting, grouping, summaries, the example
  day, browser and sidecar agreeing on categories and units, and the module
  folder containing only installable file types.

## Adding a language

Copy `modules/baby-schedule/locales/en.json` to `locales/<code>.json` (one of
Yuvomi's 27 locale codes, e.g. `de.json`, `hi.json`) and translate the values.
Times follow each user's 12/24-hour setting and day names their language.

