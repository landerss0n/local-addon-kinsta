# Database Merge Push — Design

**Date:** 2026-06-06
**Status:** Approved approach A (three-way merge with baseline snapshot)

## Problem

Today a push overwrites the entire remote database with a local mysqldump. If someone
edited content on Production/Staging while you worked locally, their changes are lost.
We want a merge mode: push local DB changes while remote changes survive, with a
preview and per-row conflict resolution.

## Scope

- **In scope:** pages/posts (`wp_posts` + `wp_postmeta` + term relationships),
  options (`wp_options`), terms (`wp_terms` + `wp_term_taxonomy`).
- **Out of scope:** comments, users, WooCommerce/plugin tables (remote wins — untouched
  by merge mode), multisite (falls back to overwrite with a clear message), field-level
  merging inside a post (a Bricks page is effectively one serialized blob).
- Merge is a **separate mode** next to today's overwrite: the database option in the
  push preview gets a `FlySelect` with "Merge changes" / "Overwrite everything".

## Architecture

### Baseline snapshot

After every successful DB sync (pull, overwrite push, merge push) we store a snapshot at
`addons-data/kinsta-sync/baselines/<localSiteId>-<envId>.json` — **per environment**
(Production and Staging have separate baselines):

```json
{
  "createdAt": "ISO",
  "posts": {
    "<ID>": {
      "hash": "…",
      "modified": "post_modified_gmt",
      "title": "…",
      "type": "page",
      "status": "publish"
    }
  },
  "options": { "<option_name>": "<hash>" },
  "terms": { "<term_id>": { "hash": "…", "name": "…", "taxonomy": "category" } }
}
```

Hashes only + display fields — no content copies, so the file stays small.

### Units and hashing

- **Post unit** = the `wp_posts` row + all its `wp_postmeta` rows + its
  `wp_term_relationships`. Hashed as one canonical block (sorted keys). Volatile meta
  excluded (`_edit_lock`, `_edit_last`).
- **Option unit** = one `wp_options` row. Volatile options excluded via deny-list:
  `_transient_%`, `_site_transient_%`, `cron`, `rewrite_rules`, `recently_edited`,
  `auto_updater.lock`, plus `siteurl`/`home` (legitimately differ — never touched).
- **Term unit** = `wp_terms` row + its `wp_term_taxonomy` row.

**Domain normalization:** before hashing, the site's own domain (local resp. remote,
`https://`, `http://` and protocol-relative forms) is replaced with a placeholder —
otherwise every URL-bearing row would look changed on both sides.

**Execution:** the same hashing PHP snippet runs via WP-CLI on both sides (locally via
the bundled phar + MySQL socket; remotely via SSH). Each side returns only
`{id: hash, …display fields}` JSON — the preview never downloads whole tables.

### Three-way classification

Per unit, compare local-vs-baseline and remote-vs-baseline:

| Local           | Remote           | Result                                                    |
| --------------- | ---------------- | --------------------------------------------------------- |
| changed         | unchanged        | **push** (pre-checked)                                    |
| unchanged       | changed          | **keep theirs** (not pushed, shown informatively)         |
| changed         | changed          | **conflict** — user picks Mine/Theirs per row             |
| new             | —                | **insert**; ID collision with a new remote row → conflict |
| —               | new              | keep theirs                                               |
| deleted locally | unchanged        | **delete remote** (unchecked by default)                  |
| deleted locally | changed          | **conflict** (delete vs their edit)                       |
| unchanged       | deleted remotely | stays deleted (shown informatively)                       |
| changed         | deleted remotely | **conflict** (my edit vs their delete)                    |

**First run (no baseline):** posts classified via `post_modified_gmt` vs `lastPullAt`;
options that differ are shown as conflicts (minus the volatile deny-list). After the
first sync a baseline exists and classification is exact.

### Convergence

After a merge push, the **local** database is also updated with "their" rows (rows not
pushed + conflicts resolved as Theirs), so the same rows don't reappear as "my changes"
on the next push. Both sides land on the merged result. Controlled by a pre-checked
checkbox ("Update local with their changes"); a local DB backup is taken first.

### ID collision prevention

After every successful pull, set local `AUTO_INCREMENT` on `wp_posts`, `wp_terms`,
`wp_term_taxonomy` to `remote_max + 100000`. New local entities can then never collide
with new remote ones. **IDs are never rewritten** — critical because Bricks Builder
embeds post IDs in serialized meta (query loops, template conditions, popups).
Pre-existing genuine collisions surface as conflicts.

## Merge push pipeline

1. **Pre-flight:** local site running (socket), WP-CLI reachable remotely,
   multisite → fall back to overwrite with message.
2. **Safety nets:** native Kinsta backup (existing checkbox, default on) + remote DB
   export to `~/kinsta-sync-pre-push-backup.sql` (existing) + **local DB backup** (new —
   convergence writes locally).
3. **Generate SQL** for exactly the selected rows: `REPLACE INTO wp_posts`,
   delete+insert of the post's meta and term relationships, options via
   `INSERT … ON DUPLICATE KEY UPDATE`, deletions via `DELETE`. All values escaped via a
   proper SQL string escaper — never naive interpolation.
4. **Apply remotely:** SCP the SQL file up → `wp db import` over SSH.
5. **Search-replace remotely** (×3 passes as today). Safe because the local domain only
   exists in rows we just inserted — a full search-replace is effectively row-scoped.
   WP-CLI handles serialized data correctly (recomputes length prefixes).
6. **Convergence locally** (if enabled): reverse SQL for "their" rows → import locally →
   search-replace in the other direction.
7. **Clear Kinsta cache**; rebuild and store the new baseline (both sides now identical
   modulo domain).
8. **Rollback** (existing pattern): failure after remote import started → restore remote
   backup; failure after local import started → restore local backup. Cancellation uses
   the existing `CancelledError` + fresh-`ActiveSync` flow.

## UI

The fullscreen push preview gets **tabs above the table: "Files" | "Database"**
(different column sets, same `VirtualTable` pattern).

Database tab columns: checkbox (or **Mine/Theirs selector** for ⚠ conflict rows), title
(post title / option name / term name), type (Page/Post/Option/Category…), change
(New/Changed/Deleted/Conflict), local-modified and remote-modified timestamps where
available.

Sidebar additions: DB mode `FlySelect` ("Merge changes" / "Overwrite everything") under
"Include database"; counters ("12 push · 3 kept · 2 conflicts unresolved"); convergence
checkbox. **The push button is disabled until every conflict is resolved** — no silent
defaults.

## Error handling and degraded modes

- No baseline → first-run mode (timestamps for posts, conflicts for differing options).
- WP-CLI unreachable remotely → merge mode unavailable with an explanation; overwrite
  still works.
- Cancelled mid-merge → same cancel/rollback flow as existing syncs.

## Testing

Pure helpers exported from `src/main/` and unit-tested with vitest (same pattern as
`parseItemizeLine` & co.):

- canonical serialization + domain normalization for hashing
- the three-way classifier (every cell of the matrix, incl. ID collisions)
- SQL generation incl. escaping (quotes, backslashes, NULs, emoji)
- volatile-options deny-list matching
- auto-increment offset computation
- baseline file read/write/migration

Integration verification via CDP/Playwright screenshots of the preview (read-only
dry-run only — never an actual push), per CLAUDE.md.

## Decisions log

- Scope: pages/posts + options (user), terms added for referential integrity (design).
- Conflicts: user picks per row in the preview (user).
- Merge is a separate mode next to overwrite (user).
- Bricks Builder is in use → never rewrite IDs; prevent collisions via auto-increment
  offset at pull; real collisions are conflicts (design, delegated by user).
