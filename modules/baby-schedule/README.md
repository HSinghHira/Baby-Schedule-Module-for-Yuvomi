# Baby Schedule (Yuvomi module)

Plan your baby's week together: bottles, water, meals, fruit, vegetables,
snacks, naps and night sleep, Monday to Sunday. Both parents see and edit the
same household schedule from their phones.

This folder is the browser half. The schedule is stored by the **Baby Schedule
sidecar**, a small service that must run beside Yuvomi and be reachable on the
same address under `/api/extensions/baby-schedule/`. Without it the page shows
"The schedule service is not reachable".

Full installation, configuration and security notes are in the repository's
main README.

## Files

| File | Purpose |
|------|---------|
| `module.json` | Manifest: page composition, menu entry, `ext:baby-schedule` permission, API prefix |
| `index.js` | The page (`render(container, context)`) |
| `lib/schedule.js` | Categories, sorting, daily summary (no DOM) |
| `lib/client.js` | Calls to the sidecar, with its CSRF token |
| `lib/sheet.js` | Sheets and confirmations using Yuvomi's dialog |
| `style.css` | Component styles on Yuvomi tokens |
| `locales/en.json` | English strings; add `locales/<lang>.json` for more languages |
