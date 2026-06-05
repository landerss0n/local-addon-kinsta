# Kinsta Sync for Local

Sync WordPress sites between [Local](https://localwp.com) and [Kinsta](https://kinsta.com) hosting — pull and push files **and** database, with automatic URL search-replace, safety backups, and rollback.

> **Community project.** Not affiliated with, endorsed by, or supported by Kinsta Inc. or WP Engine. "Kinsta" and the Kinsta logo are trademarks of Kinsta Inc. Use at your own risk — see [Safety nets](#safety-nets) for how the add-on protects your data.

## Features

- **Pull from Kinsta** — files + database from Production or Staging into your Local site
- **Push to Kinsta** — files + database from Local to Production or Staging
- **Automatic search-replace** — `https://`, `http://` and protocol-relative URLs, multisite-aware, `guid` column untouched
- **Safety first** — local + remote database backups before every destructive step, optional native Kinsta backup before push, automatic rollback if a sync fails or is cancelled mid-import
- **Live progress** — real rsync progress, per-step status, cancellable at any time
- **Cache clearing** — clears Kinsta's page, edge and CDN caches after a push (and on demand)
- **Site search** — quickly find the right site even with 100+ sites on the account

## Requirements

- **macOS or Linux** (Windows is not supported — the add-on shells out to `rsync`/`ssh`)
- **Local** 9.x or newer
- **rsync** — macOS ships with a limited rsync; `brew install rsync` is recommended for full live progress (everything works without it, you just get coarser progress)
- **A Kinsta account** with:
  - an [API key](https://my.kinsta.com/account/api-keys) (create with an expiry and rotate it periodically)
  - your **Company ID** — found in your MyKinsta URL (`my.kinsta.com/?idCompany=<id>`) or under MyKinsta → *your username* → Company settings → Billing details
  - your **SSH key added** to MyKinsta (file/database transfer runs over SSH)

## Installation

### From a release (recommended)

1. Download the latest `.tgz` from [Releases](https://github.com/landerss0n/local-addon-kinsta/releases)
2. In Local: **Add-ons → Installed → Install from disk** and pick the file
3. Enable the add-on and relaunch Local when prompted

### From source

```bash
cd ~/Library/Application\ Support/Local/addons   # macOS
# cd ~/.config/Local/addons                      # Linux

git clone https://github.com/landerss0n/local-addon-kinsta.git
cd local-addon-kinsta
npm install
npm run build
```

Restart Local, then enable **Kinsta Sync** under **Add-ons → Installed**.

## Getting started

1. **Connect your account** — Local → Preferences → **Kinsta Sync**: paste your API key and Company ID, click Connect. The key is validated against the Kinsta API before anything is stored.
2. **Link a site** — open a site in Local → **More → Kinsta Sync** → **Link site**, search and pick the matching Kinsta site.
3. **Pull or Push** — from the same page. Pick the environment (Production/Staging) and what to sync (files / database) per run.

Sites are linked at the *site* level, so you can sync against Production one time and Staging the next without relinking. A status badge in the site's top-right corner shows the link state and live sync progress.

## What a sync does

**Pull** (Kinsta → Local): rsync files → back up the local database → export the remote database over SSH (WP-CLI) → import into Local's MySQL → search-replace URLs (3 passes: `https://`, `http://`, `//`).

**Push** (Local → Kinsta): confirmation dialog for Production → *(optional, default on)* create a native Kinsta backup → back up the remote database to `~/kinsta-sync-pre-push-backup.sql` on the server → rsync files (with `--delete`) → export the Local database → import on Kinsta → search-replace → clear Kinsta page/edge/CDN caches.

Excluded from file sync: `.git`, `node_modules`, caches, SQL dumps, `wp-config.php`, `.htaccess`, Kinsta's mu-plugins and other host-specific files.

### Safety nets

- **Before a pull**, the local database is backed up to a temp file (kept until the next pull).
- **Before a push**, the remote database is exported to `~/kinsta-sync-pre-push-backup.sql` on the Kinsta server, outside the web root.
- **Native Kinsta backup before push** (checkbox, default on): creates a manual backup via the Kinsta API and waits for it to finish — if it can't be created, the push is aborted. Kinsta allows max 5 manual backups per environment; the add-on only ever deletes its *own* old backups (tagged `kinsta-sync`) to free a slot, never yours.
- **Automatic rollback**: if a sync fails or is cancelled after the database import started, the respective backup is restored automatically — you're never left with a half-imported database. (Pushed files synced with `--delete` can't be rolled back — only the database.)
- **Production pushes** always require an explicit confirmation.

## Security

- **Your API key never leaves your machine** except in HTTPS requests to `api.kinsta.com`. It is encrypted at rest with Electron's `safeStorage` (backed by the macOS Keychain / OS credential store) and is never shown in the UI after entry — only a mask.
- **SSH uses your existing keys/agent** — the add-on stores no SSH credentials and no passwords.
- **No shell strings** — every external command (`rsync`, `ssh`, `mysql`, `wp`) is spawned with argument arrays, so site names and paths can't be used for command injection.
- **No telemetry** — the add-on talks to the Kinsta API and your Kinsta SSH host. Nothing else, ever.
- `wp-config.php` is modified temporarily during database import (to use Local's MySQL socket) and always restored — including crash recovery via a `.kinsta-sync-bak` copy.

Stored locally (in Local's app-data directory under `addons-data/kinsta-sync/`): the encrypted API key, your Company ID, site links with last-sync timestamps, and temporary SQL dumps.

## Troubleshooting

| Problem | Fix |
|---|---|
| No live file-progress during sync | `brew install rsync` (macOS ships openrsync, which can't report totals) |
| "The local site must be running for database sync" | Start the site in Local first — DB import needs its MySQL socket |
| SSH errors during sync | Make sure your SSH key is added in MyKinsta and the environment has SSH access enabled |
| Kinsta backup step skipped | All 5 manual backup slots are taken by your own backups — delete one in MyKinsta |
| "N file(s) were skipped" warning after sync | Those files have names in a legacy encoding (e.g. Latin-1 `åäö`) that macOS can't store. Everything else synced. Fix permanently by renaming the files on the server (and updating any references) |

## Development

```bash
npm install
npm run build          # main + renderer
npm run watch          # rebuild on change (renderer hot-reloads; main needs a Local restart)
```

See [CLAUDE.md](CLAUDE.md) for architecture notes, the hooks used, and findings about Local's add-on API (including why a native Connect-tab integration isn't possible).

- [Local add-on API docs](https://build.localwp.com/)
- [Local components](https://getflywheel.github.io/local-components/)
- [Kinsta API reference](https://api-docs.kinsta.com/)

## License

MIT
