# Baby Schedule for Yuvomi

Plan your baby's week together: bottles, water, meals, fruit, naps and sleep,
Monday to Sunday. Both parents edit the same schedule from their phones and see
each other's changes within seconds.

![Week view with today's overview](screenshots/BfWLi3yJIX.png)

![Adding an activity to several days at once](screenshots/KhP57zotPL.png)

## Features

- **Week at a glance:** tap a day or swipe between days; each day shows its
  activities as a timeline with the time, an emoji and the amount (120 ml, 1.5 hours).
- **Fast planning:** quick-add buttons (Bottle, Water, Meal, Fruit, Nap), add one
  activity to several days at once, and "Add another" to fill a whole day in one go.
- **Week tools:** copy a day, repeat an activity, move or duplicate it, save the
  week as a template, start from an example day, clear a day or the week.
- **Today overview:** up next, next feeding, next sleep and food entries.
- **Home screen widget:** "Baby today" shows what's next for the baby.
- **"Today at a glance" and Wall Mode:** the baby's next activity appears as one
  task. Tick it off and the next one appears.
- **Roles:** uses Yuvomi's permissions, so a member can be given view-only access.

## Install

Baby Schedule is installed with a script, not through Yuvomi's module upload,
because it has two parts: the module (the page in Yuvomi) and a small service
that stores the schedule. See [Why a script?](#why-a-script) below.

On the server where Yuvomi runs, as root. Read the script first, then run it:

```sh
curl -fsSLo install.sh https://cdn.jsdelivr.net/gh/HSinghHira/Baby-Schedule-Module-for-Yuvomi@main/install.sh
less install.sh
sh install.sh
```

Or in one line: `curl -fsSL https://cdn.jsdelivr.net/gh/HSinghHira/Baby-Schedule-Module-for-Yuvomi@main/install.sh | sh`

The script installs the newest [release](https://github.com/HSinghHira/Baby-Schedule-Module-for-Yuvomi/releases),
so every install of a version is the same. It lists what it will change and asks
before doing it. If your Yuvomi is behind a proxy (Cloudflare Tunnel, Nginx Proxy
Manager, ...), it shows the one route to add and waits until it works.

### What the installer changes on your server

- Runs as root with Docker access.
- Builds the image `baby-schedule-sidecar:<version>` and starts the container
  `baby-schedule` (restarts automatically, one published port, 6540 by default).
- Creates the data folder for the schedule database.
- Copies the module into Yuvomi's modules folder and **restarts the Yuvomi
  container**. On an update where the module did not change, Yuvomi is not restarted.
- Only with `BS_GATEWAY=1`: starts the container `baby-schedule-gateway`
  (nginx), which sits **in front of Yuvomi**. You then open Yuvomi through it.
- Nothing else: no system packages, no changes to Yuvomi's own files or database.

Then, as an admin in Yuvomi:

1. Open **Baby Schedule** in the menu.
2. Optional: **Settings → Modules → Baby Schedule → Turn on** to show the baby's
   next activity in "Today at a glance" and Wall Mode.
3. Optional: switch on the **Baby today** widget with **Customize** on the home screen.

**Update:** run the same command again. It moves to the newest release and keeps
your schedule. Yuvomi's Settings cannot update a module installed this way.
To install a specific version: `BS_VERSION=v1.0.0 sh install.sh`. If a new version
fails to start, the script switches back to the one that was running.

**Uninstall:** `BS_UNINSTALL=1 sh install.sh` removes the containers, images and
module, and keeps the schedule data (the script tells you where).

**Requirements:** Docker, and a Yuvomi with a modules folder (ZimaOS / IceStore,
Unraid, TrueNAS, Portainer, plain Docker; not Umbrel).

**Options:** `BS_VERSION`, `BS_DOMAIN`, `BS_PORT`, `BS_DATA`, `BS_GATEWAY=1` (no
proxy in front of Yuvomi), `BS_YES=1` (do not ask) and `YUVOMI_CONTAINER`. Put
them before `sh`, for example `BS_PORT=6600 sh install.sh`. Details at the top of
[install.sh](install.sh).

**Backup:** the schedule is stored in its own folder (`/DATA/AppData/baby-schedule/data`
on ZimaOS). Yuvomi's own backup does not include it.

### Why a script?

A Yuvomi module is browser code: a page and widgets that run on the phone. That
is enough for a page that shows Yuvomi's own data, but this schedule is shared
data that both parents edit at the same time, so it must be stored and checked
on the server. Baby Schedule therefore comes with a small service of its own
(Node, SQLite). That service:

- stores the week, templates and changes, and keeps two phones in sync;
- checks every request against the Yuvomi session, so roles such as view-only
  are enforced on the server and not only hidden in the page;
- keeps the baby's next activity as a task in "Today at a glance" and Wall Mode
  every 30 seconds, even when nobody has Yuvomi open (this uses an API token that
  must never reach a browser).

Uploading the module in Settings would add the page but not that service, nor
the proxy route that sends `/api/extensions/baby-schedule/` to it, and the page
would only say "The schedule service is not reachable". The script installs all
three parts together, at the same version.

## Languages

English is included. To add a language, copy
`modules/baby-schedule/locales/en.json` to `locales/<code>.json` (for example
`de.json` or `hi.json`) and translate the text.
