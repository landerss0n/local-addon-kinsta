# Database Merge Push Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Merge changes" database mode to the push preview that three-way-diffs posts/options/terms against a per-environment baseline, lets the user resolve conflicts per row, applies only the selected rows remotely, and converges the local DB with "their" changes.

**Architecture:** Pure merge logic (classifier, SQL builders, volatile filters, baseline IO) lives in a new `src/main/dbMerge.ts`, unit-tested with vitest. PHP snippets (snapshot hashing + full-unit fetch) live in `src/main/dbMergePhp.ts` and run via WP-CLI on both sides (locally: phar + socket wp-config dance; remotely: `wp eval-file -` over SSH). `src/main/index.ts` gets two integration points: a `kinsta:dbPreview` IPC handler and a merge branch inside `kinsta:push`. The renderer adds a Files|Database tab switch to `KinstaPushScreen.tsx` with the DB table in a new `src/renderer/PushDatabaseTab.tsx`.

**Tech Stack:** TypeScript, vitest, WP-CLI (eval-file), MySQL via Local's socket, rsync/ssh/scp via existing `runCommand`.

**Spec:** `docs/superpowers/specs/2026-06-06-db-merge-push-design.md`

---

## Codebase facts you need (read this first)

- `src/main/index.ts` (1511 lines) holds everything main-process. Pure helpers are `export`ed and tested in `src/main/index.test.ts` (vitest; `npm test`). `@getflywheel` imports are **type-only** so the module imports outside Electron.
- `runCommand(sync, cmd, args, opts)` (index.ts:393) spawns without shell, supports `stdinFile`/`stdoutFile`/`onStdout`, rejects `CancelledError` if `sync.cancelled`. One `ActiveSync {cancelled, child}` per site in `activeSyncs`.
- `sshArgs(envInfo, remoteCmd)` (index.ts:459) builds ssh args. SCP pattern: see index.ts:1114.
- Local WP-CLI: `findServiceBinary(['php-'],'php')` + `findWpCliPhar()`; **wp-config.php must be temporarily rewritten** to point DB_HOST at the site socket (the dance at index.ts:1140-1184, currently inline in the pull handler — Task 6 extracts it).
- DB creds: `getDbCredentials(site)`; socket: `getMysqlSocketPath(localSiteId)`; mysql binary: `findServiceBinary(['mysql-','mariadb-'],'mysql')`.
- Remote WP-CLI runs as `ssh ... "cd ~/public && wp <cmd>"` (index.ts:1111).
- `SyncOptions` (index.ts:129) is the push options bag — extended in Task 8.
- Baselines dir: `CONFIG_DIR` is `<userDataPath>/addons-data/kinsta-sync/`; `TEMP_DIR` is `<CONFIG_DIR>/tmp`. **Note `cleanupTempFiles()` (index.ts:292) deletes `*.sql` in TEMP_DIR on startup** — baselines are JSON in their own subdir, unaffected.
- Renderer mirrors main-process types by hand (see `DiffRow` comment, KinstaPushScreen.tsx:53) — do the same for DB rows; there is no shared-types module.
- local-components gotchas (CLAUDE.md): `Checkbox` onChange gives the **boolean**; `FlySelect` needs static `options`; VirtualTable `cellRenderer` must return `args.children` (never `false`) for default cells.
- Commit messages: plain, no Co-Authored-By (user rule).

---

### Task 1: Volatile filters + domain normalization (`dbMerge.ts`)

**Files:**

- Create: `src/main/dbMerge.ts`
- Create: `src/main/dbMerge.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/dbMerge.test.ts
import { describe, it, expect } from 'vitest';
import { isVolatileOption, isVolatileMetaKey, normalizeDomain } from './dbMerge';

describe('isVolatileOption', () => {
  it('excludes transients, cron, rewrite_rules and URL options', () => {
    for (const name of [
      '_transient_foo',
      '_transient_timeout_foo',
      '_site_transient_update_core',
      'cron',
      'rewrite_rules',
      'recently_edited',
      'auto_updater.lock',
      'siteurl',
      'home',
    ])
      expect(isVolatileOption(name), name).toBe(true);
  });
  it('keeps real options', () => {
    for (const name of [
      'blogname',
      'bricks_global_settings',
      'sidebars_widgets',
      'cron_jobs_custom',
    ])
      expect(isVolatileOption(name), name).toBe(false);
  });
});

describe('isVolatileMetaKey', () => {
  it('excludes edit locks only', () => {
    expect(isVolatileMetaKey('_edit_lock')).toBe(true);
    expect(isVolatileMetaKey('_edit_last')).toBe(true);
    expect(isVolatileMetaKey('_thumbnail_id')).toBe(false);
  });
});

describe('normalizeDomain', () => {
  it('replaces https, http and protocol-relative URLs with a placeholder', () => {
    const text = 'a https://my.local/x b http://my.local/y c //my.local/z d';
    expect(normalizeDomain(text, 'my.local')).toBe(
      'a __KSYNC_URL__/x b __KSYNC_URL__/y c __KSYNC_URL__/z d',
    );
  });
  it('does not touch other domains or escape regex chars unsafely', () => {
    expect(normalizeDomain('https://example.com //my.local.evil.com', 'my.local')).toBe(
      'https://example.com //my.local.evil.com',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/dbMerge.test.ts`
Expected: FAIL — `Cannot find module './dbMerge'` (or named exports missing).

- [ ] **Step 3: Write the implementation**

```ts
// src/main/dbMerge.ts
// Pure helpers for the database merge push. No Electron/Local imports —
// everything here must be importable by vitest outside Electron.

// Options that legitimately differ between environments or churn constantly.
// `siteurl`/`home` are handled by search-replace and must never be merged.
const VOLATILE_OPTION_EXACT = new Set([
  'cron',
  'rewrite_rules',
  'recently_edited',
  'auto_updater.lock',
  'siteurl',
  'home',
]);
const VOLATILE_OPTION_PREFIXES = ['_transient_', '_site_transient_'];

export function isVolatileOption(name: string): boolean {
  if (VOLATILE_OPTION_EXACT.has(name)) return true;
  return VOLATILE_OPTION_PREFIXES.some((p) => name.startsWith(p));
}

export function isVolatileMetaKey(key: string): boolean {
  return key === '_edit_lock' || key === '_edit_last';
}

// Domain placeholder used by BOTH the TS side and the PHP snapshot snippet
// (dbMergePhp.ts) — hashes are only comparable if both normalize identically.
export const DOMAIN_PLACEHOLDER = '__KSYNC_URL__';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replace https://domain, http://domain and //domain with the placeholder so
// content hashes are comparable across environments with different domains.
// The trailing (?![a-zA-Z0-9.-]) guard stops `my.local` matching `my.local.evil.com`.
export function normalizeDomain(text: string, domain: string): string {
  const d = escapeRegExp(domain);
  return text.replace(new RegExp(`(https?:)?//${d}(?![a-zA-Z0-9.-])`, 'g'), DOMAIN_PLACEHOLDER);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/dbMerge.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/dbMerge.ts src/main/dbMerge.test.ts
git commit -m "Add volatile filters and domain normalization for DB merge"
```

---

### Task 2: Snapshot types + three-way classifier

**Files:**

- Modify: `src/main/dbMerge.ts`
- Modify: `src/main/dbMerge.test.ts`

- [ ] **Step 1: Add the types to `dbMerge.ts`** (no test yet — types only)

```ts
// --- Snapshot / diff types -------------------------------------------------

export type UnitKind = 'post' | 'option' | 'term';

export interface UnitSnapshot {
  hash: string;
  // Display fields (posts/terms only)
  title?: string; // post_title or term name
  type?: string; // post_type or taxonomy
  status?: string; // post_status
  modified?: string; // post_modified_gmt 'YYYY-MM-DD HH:MM:SS'
}

// What the snapshot PHP returns from each side (and what baselines store)
export interface DbSnapshot {
  prefix: string; // $wpdb->prefix
  posts: Record<string, UnitSnapshot>; // key: post ID as string
  options: Record<string, string>; // key: option_name, value: hash
  terms: Record<string, UnitSnapshot>; // key: term_id as string
  maxPostId: number;
  maxTermId: number;
  maxTtId: number; // max term_taxonomy_id
}

export interface Baseline {
  version: 1;
  createdAt: string;
  envId: string;
  posts: Record<string, UnitSnapshot>;
  options: Record<string, string>;
  terms: Record<string, UnitSnapshot>;
}

export type DbChange = 'push' | 'keep' | 'conflict' | 'delete-remote' | 'keep-deleted';
export type ConflictKind = 'edit-edit' | 'edit-delete' | 'delete-edit' | 'id-collision';

export interface DbDiffRow {
  kind: UnitKind;
  id: string; // post ID / option_name / term ID
  label: string; // post title / option name / term name
  subtype: string; // post_type / 'option' / taxonomy
  change: DbChange;
  conflictKind?: ConflictKind;
  localModified?: string; // posts only
  remoteModified?: string; // posts only
}
```

- [ ] **Step 2: Write the failing classifier tests**

Append to `src/main/dbMerge.test.ts`:

```ts
import { classifySnapshots, DbSnapshot, Baseline } from './dbMerge';

const snap = (over: Partial<DbSnapshot>): DbSnapshot => ({
  prefix: 'wp_',
  posts: {},
  options: {},
  terms: {},
  maxPostId: 0,
  maxTermId: 0,
  maxTtId: 0,
  ...over,
});
const base = (over: Partial<Baseline>): Baseline => ({
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  envId: 'e1',
  posts: {},
  options: {},
  terms: {},
  ...over,
});
const post = (hash: string, modified = '2026-01-01 00:00:00') => ({
  hash,
  title: 'T',
  type: 'page',
  status: 'publish',
  modified,
});

describe('classifySnapshots (with baseline)', () => {
  it('classifies the full matrix for posts', () => {
    const baseline = base({
      posts: {
        '1': post('a'),
        '2': post('a'),
        '3': post('a'),
        '4': post('a'),
        '5': post('a'),
        '6': post('a'),
        '7': post('a'),
      },
    });
    const local = snap({
      posts: {
        '1': post('b'), // changed locally only        → push
        '2': post('a'), // unchanged / changed remotely → keep
        '3': post('b'), // changed both, differently    → conflict edit-edit
        '4': post('b'), // changed both, identically    → (skip)
        /* 5 deleted locally, unchanged remotely                  → delete-remote */
        /* 6 deleted locally, changed remotely                    → conflict delete-edit */
        '7': post('b'), // changed locally, deleted remotely → conflict edit-delete
        '10': post('n'), // new locally                  → push
        '11': post('x'), // new BOTH sides, different    → conflict id-collision
        '12': post('s'), // new both sides, same hash    → (skip)
      },
    });
    const remote = snap({
      posts: {
        '1': post('a'),
        '2': post('c'),
        '3': post('c'),
        '4': post('b'),
        '5': post('a'),
        '6': post('c'),
        /* 7 deleted remotely */
        '11': post('y'),
        '12': post('s'),
        '20': post('r'), // new remotely                 → keep
      },
    });

    const rows = classifySnapshots(local, remote, baseline);
    const byId = Object.fromEntries(rows.filter((r) => r.kind === 'post').map((r) => [r.id, r]));

    expect(byId['1'].change).toBe('push');
    expect(byId['2'].change).toBe('keep');
    expect(byId['3']).toMatchObject({ change: 'conflict', conflictKind: 'edit-edit' });
    expect(byId['4']).toBeUndefined();
    expect(byId['5'].change).toBe('delete-remote');
    expect(byId['6']).toMatchObject({ change: 'conflict', conflictKind: 'delete-edit' });
    expect(byId['7']).toMatchObject({ change: 'conflict', conflictKind: 'edit-delete' });
    expect(byId['10'].change).toBe('push');
    expect(byId['11']).toMatchObject({ change: 'conflict', conflictKind: 'id-collision' });
    expect(byId['12']).toBeUndefined();
    expect(byId['20'].change).toBe('keep');
  });

  it('shows remote deletions of unchanged local rows informatively', () => {
    const baseline = base({ posts: { '1': post('a') } });
    const rows = classifySnapshots(snap({ posts: { '1': post('a') } }), snap({}), baseline);
    expect(rows[0]).toMatchObject({ id: '1', change: 'keep-deleted' });
  });

  it('classifies options and skips volatile ones', () => {
    const baseline = base({ options: { blogname: 'a', cron: 'x' } });
    const local = snap({ options: { blogname: 'b', cron: 'y', new_opt: 'n' } });
    const remote = snap({ options: { blogname: 'a', cron: 'z' } });
    const rows = classifySnapshots(local, remote, baseline).filter((r) => r.kind === 'option');
    expect(rows).toHaveLength(2); // blogname push + new_opt push; cron is volatile
    expect(rows.find((r) => r.id === 'blogname')!.change).toBe('push');
    expect(rows.find((r) => r.id === 'new_opt')!.change).toBe('push');
  });
});

describe('classifySnapshots (first run, no baseline)', () => {
  it('uses post_modified vs lastSyncAt for posts', () => {
    const local = snap({
      posts: {
        '1': post('b', '2026-06-01 10:00:00'), // modified after sync, remote not → push
        '2': post('a', '2026-01-01 00:00:00'), // remote modified after sync      → keep
        '3': post('b', '2026-06-01 10:00:00'), // both modified after sync        → conflict
      },
    });
    const remote = snap({
      posts: {
        '1': post('a', '2026-01-01 00:00:00'),
        '2': post('c', '2026-06-01 10:00:00'),
        '3': post('c', '2026-06-02 10:00:00'),
      },
    });
    const rows = classifySnapshots(local, remote, null, '2026-05-01T00:00:00Z');
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId['1'].change).toBe('push');
    expect(byId['2'].change).toBe('keep');
    expect(byId['3'].change).toBe('conflict');
  });

  it('treats differing options as conflicts on first run', () => {
    const rows = classifySnapshots(
      snap({ options: { blogname: 'a' } }),
      snap({ options: { blogname: 'b' } }),
      null,
      '2026-05-01T00:00:00Z',
    );
    expect(rows[0]).toMatchObject({ kind: 'option', id: 'blogname', change: 'conflict' });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/main/dbMerge.test.ts`
Expected: FAIL — `classifySnapshots` not exported.

- [ ] **Step 4: Implement the classifier**

Append to `src/main/dbMerge.ts`:

```ts
// --- Three-way classifier ----------------------------------------------------

type State = 'unchanged' | 'changed' | 'new' | 'deleted';

function stateOf(current: string | undefined, baseline: string | undefined): State {
  if (baseline === undefined) return current === undefined ? 'deleted' : 'new'; // 'deleted' unused pre-baseline
  if (current === undefined) return 'deleted';
  return current === baseline ? 'unchanged' : 'changed';
}

// Map (local state × remote state) → row change, or null to skip the unit.
function classifyPair(
  l: State,
  r: State,
  localHash?: string,
  remoteHash?: string,
): { change: DbChange; conflictKind?: ConflictKind } | null {
  if (localHash !== undefined && localHash === remoteHash) return null; // identical → in sync
  if (l === 'new' && r === 'new') return { change: 'conflict', conflictKind: 'id-collision' };
  if (l === 'new') return { change: 'push' };
  if (r === 'new') return { change: 'keep' };
  if (l === 'deleted' && r === 'deleted') return null;
  if (l === 'deleted')
    return r === 'unchanged'
      ? { change: 'delete-remote' }
      : { change: 'conflict', conflictKind: 'delete-edit' };
  if (r === 'deleted')
    return l === 'unchanged'
      ? { change: 'keep-deleted' }
      : { change: 'conflict', conflictKind: 'edit-delete' };
  if (l === 'changed' && r === 'changed') return { change: 'conflict', conflictKind: 'edit-edit' };
  if (l === 'changed') return { change: 'push' };
  if (r === 'changed') return { change: 'keep' };
  return null; // unchanged/unchanged
}

// First-run fallback: WP timestamps for posts, conflict for differing options/terms.
function classifyPairFirstRun(
  kind: UnitKind,
  localUnit: UnitSnapshot | undefined,
  remoteUnit: UnitSnapshot | undefined,
  lastSyncAt: string | undefined,
): { change: DbChange; conflictKind?: ConflictKind } | null {
  if (localUnit && remoteUnit && localUnit.hash === remoteUnit.hash) return null;
  if (localUnit && !remoteUnit) return { change: 'push' }; // assume new locally
  if (!localUnit && remoteUnit) return { change: 'keep' }; // assume new remotely
  if (!localUnit || !remoteUnit) return null;
  if (kind === 'post' && lastSyncAt) {
    const syncMs = new Date(lastSyncAt).getTime();
    const lMs = new Date((localUnit.modified || '') + 'Z').getTime() || 0;
    const rMs = new Date((remoteUnit.modified || '') + 'Z').getTime() || 0;
    const lChanged = lMs > syncMs;
    const rChanged = rMs > syncMs;
    if (lChanged && rChanged) return { change: 'conflict', conflictKind: 'edit-edit' };
    if (lChanged) return { change: 'push' };
    if (rChanged) return { change: 'keep' };
    return { change: 'conflict', conflictKind: 'edit-edit' }; // differs but no timestamp signal
  }
  return { change: 'conflict', conflictKind: 'edit-edit' };
}

export function classifySnapshots(
  local: DbSnapshot,
  remote: DbSnapshot,
  baseline: Baseline | null,
  lastSyncAt?: string,
): DbDiffRow[] {
  const rows: DbDiffRow[] = [];

  const allKeys = (a: object, b: object, c: object) =>
    Array.from(new Set([...Object.keys(a), ...Object.keys(b), ...Object.keys(c)]));

  // Posts and terms share UnitSnapshot shape
  for (const kind of ['post', 'term'] as const) {
    const lMap = kind === 'post' ? local.posts : local.terms;
    const rMap = kind === 'post' ? remote.posts : remote.terms;
    const bMap = baseline ? (kind === 'post' ? baseline.posts : baseline.terms) : {};
    for (const id of allKeys(lMap, rMap, bMap)) {
      const lu = lMap[id],
        ru = rMap[id],
        bu = (bMap as Record<string, UnitSnapshot>)[id];
      const res = baseline
        ? classifyPair(stateOf(lu?.hash, bu?.hash), stateOf(ru?.hash, bu?.hash), lu?.hash, ru?.hash)
        : classifyPairFirstRun(kind, lu, ru, lastSyncAt);
      if (!res) continue;
      const display = lu || ru || bu;
      rows.push({
        kind,
        id,
        label: display?.title || `#${id}`,
        subtype: display?.type || kind,
        ...res,
        localModified: lu?.modified,
        remoteModified: ru?.modified,
      });
    }
  }

  const bOpts = baseline ? baseline.options : {};
  for (const name of allKeys(local.options, remote.options, bOpts)) {
    if (isVolatileOption(name)) continue;
    const lh = local.options[name],
      rh = remote.options[name],
      bh = bOpts[name];
    const res = baseline
      ? classifyPair(stateOf(lh, bh), stateOf(rh, bh), lh, rh)
      : classifyPairFirstRun(
          'option',
          lh !== undefined ? { hash: lh } : undefined,
          rh !== undefined ? { hash: rh } : undefined,
          lastSyncAt,
        );
    if (!res) continue;
    rows.push({ kind: 'option', id: name, label: name, subtype: 'option', ...res });
  }

  return rows;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/dbMerge.test.ts`
Expected: PASS. Also run the full suite: `npm test` — all green.

- [ ] **Step 6: Commit**

```bash
git add src/main/dbMerge.ts src/main/dbMerge.test.ts
git commit -m "Add three-way snapshot classifier for DB merge"
```

---

### Task 3: SQL escaping + statement builders

**Files:**

- Modify: `src/main/dbMerge.ts`
- Modify: `src/main/dbMerge.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/main/dbMerge.test.ts`:

```ts
import {
  sqlEscape,
  sqlValue,
  buildReplaceSql,
  buildDeleteSql,
  buildOptionUpsertSql,
  buildAutoIncrementSql,
} from './dbMerge';

describe('sqlEscape / sqlValue', () => {
  it('escapes quotes, backslashes and control chars', () => {
    expect(sqlEscape(`O'Brien \\ "q"`)).toBe(`O\\'Brien \\\\ \\"q\\"`);
    expect(sqlEscape('a\nb\rc\0d\x1az')).toBe('a\\nb\\rc\\0d\\Zz');
  });
  it('renders NULL, numbers and strings', () => {
    expect(sqlValue(null)).toBe('NULL');
    expect(sqlValue(42)).toBe('42');
    expect(sqlValue('x')).toBe("'x'");
    expect(sqlValue('åäö 🎉')).toBe("'åäö 🎉'"); // utf8mb4 passthrough
  });
});

describe('statement builders', () => {
  it('builds REPLACE INTO with column list from row keys', () => {
    const sql = buildReplaceSql('wp_posts', [
      { ID: 5, post_title: "It's", post_parent: 0, post_content: null },
    ]);
    expect(sql).toBe(
      'REPLACE INTO `wp_posts` (`ID`, `post_title`, `post_parent`, `post_content`) ' +
        "VALUES (5, 'It\\'s', 0, NULL);",
    );
  });
  it('builds DELETE with a numeric or string key', () => {
    expect(buildDeleteSql('wp_postmeta', 'post_id', 5)).toBe(
      'DELETE FROM `wp_postmeta` WHERE `post_id` = 5;',
    );
    expect(buildDeleteSql('wp_options', 'option_name', "a'b")).toBe(
      "DELETE FROM `wp_options` WHERE `option_name` = 'a\\'b';",
    );
  });
  it('builds option upsert', () => {
    expect(
      buildOptionUpsertSql('wp_options', {
        option_name: 'blogname',
        option_value: 'Hi',
        autoload: 'yes',
      }),
    ).toBe(
      'INSERT INTO `wp_options` (`option_name`, `option_value`, `autoload`) ' +
        "VALUES ('blogname', 'Hi', 'yes') " +
        "ON DUPLICATE KEY UPDATE `option_value` = 'Hi', `autoload` = 'yes';",
    );
  });
  it('rejects table/column names that are not [A-Za-z0-9_]', () => {
    expect(() => buildDeleteSql('wp_posts; DROP', 'ID', 1)).toThrow();
    expect(() => buildReplaceSql('wp_posts', [{ 'bad`col': 1 }])).toThrow();
  });
  it('builds auto-increment bumps with the +100000 margin', () => {
    expect(buildAutoIncrementSql('wp_', { maxPostId: 410, maxTermId: 30, maxTtId: 35 })).toEqual([
      'ALTER TABLE `wp_posts` AUTO_INCREMENT = 100411;',
      'ALTER TABLE `wp_terms` AUTO_INCREMENT = 100031;',
      'ALTER TABLE `wp_term_taxonomy` AUTO_INCREMENT = 100036;',
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/dbMerge.test.ts`
Expected: FAIL — missing exports.

- [ ] **Step 3: Implement**

Append to `src/main/dbMerge.ts`:

```ts
// --- SQL generation ----------------------------------------------------------
// Generated SQL is imported via `wp db import` (remote) / mysql --socket (local).
// Values are escaped per mysql_real_escape_string; identifiers are whitelisted
// to [A-Za-z0-9_] and backtick-quoted — content can never break out.

export function sqlEscape(s: string): string {
  return s.replace(
    /[\0\x08\x09\x1a\n\r"'\\]/g,
    (ch) =>
      ({
        '\0': '\\0',
        '\x08': '\\b',
        '\x09': '\\t',
        '\x1a': '\\Z',
        '\n': '\\n',
        '\r': '\\r',
        '"': '\\"',
        "'": "\\'",
        '\\': '\\\\',
      })[ch] as string,
  );
}

export function sqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${sqlEscape(String(v))}'`;
}

function ident(name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `\`${name}\``;
}

export type SqlRow = Record<string, unknown>;

export function buildReplaceSql(table: string, rows: SqlRow[]): string {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const colList = cols.map(ident).join(', ');
  const values = rows.map((r) => `(${cols.map((c) => sqlValue(r[c])).join(', ')})`).join(',\n');
  return `REPLACE INTO ${ident(table)} (${colList}) VALUES ${values};`;
}

export function buildDeleteSql(table: string, keyCol: string, keyVal: string | number): string {
  return `DELETE FROM ${ident(table)} WHERE ${ident(keyCol)} = ${sqlValue(keyVal)};`;
}

export function buildOptionUpsertSql(table: string, row: SqlRow): string {
  const cols = Object.keys(row);
  const colList = cols.map(ident).join(', ');
  const vals = cols.map((c) => sqlValue(row[c])).join(', ');
  const updates = cols
    .filter((c) => c !== 'option_name')
    .map((c) => `${ident(c)} = ${sqlValue(row[c])}`)
    .join(', ');
  return `INSERT INTO ${ident(table)} (${colList}) VALUES (${vals}) ON DUPLICATE KEY UPDATE ${updates};`;
}

// New local posts can never collide with new remote posts if local IDs start
// far above anything the remote will reach between syncs.
export const AUTO_INCREMENT_MARGIN = 100000;

export function buildAutoIncrementSql(
  prefix: string,
  max: { maxPostId: number; maxTermId: number; maxTtId: number },
): string[] {
  if (!/^[A-Za-z0-9_]+$/.test(prefix)) throw new Error(`Unsafe table prefix: ${prefix}`);
  return [
    `ALTER TABLE \`${prefix}posts\` AUTO_INCREMENT = ${max.maxPostId + AUTO_INCREMENT_MARGIN + 1};`,
    `ALTER TABLE \`${prefix}terms\` AUTO_INCREMENT = ${max.maxTermId + AUTO_INCREMENT_MARGIN + 1};`,
    `ALTER TABLE \`${prefix}term_taxonomy\` AUTO_INCREMENT = ${max.maxTtId + AUTO_INCREMENT_MARGIN + 1};`,
  ];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/dbMerge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/dbMerge.ts src/main/dbMerge.test.ts
git commit -m "Add SQL escaping and statement builders for DB merge"
```

---

### Task 4: Merge-script assembly from fetched units

**Files:**

- Modify: `src/main/dbMerge.ts`
- Modify: `src/main/dbMerge.test.ts`

The fetch PHP (Task 5) returns full unit data; this task turns selections + fetched
units into one SQL script. The same builder serves both directions (push to remote,
converge to local).

- [ ] **Step 1: Write the failing tests**

Append to `src/main/dbMerge.test.ts`:

```ts
import { buildMergeScript, FetchedUnits } from './dbMerge';

describe('buildMergeScript', () => {
  const units: FetchedUnits = {
    prefix: 'wp_',
    posts: [
      {
        post: { ID: 7, post_title: 'Hello', post_status: 'publish' },
        meta: [{ post_id: 7, meta_key: '_k', meta_value: 'v' }],
        termRelationships: [{ object_id: 7, term_taxonomy_id: 3, term_order: 0 }],
      },
    ],
    options: [{ option_name: 'blogname', option_value: 'Hi', autoload: 'yes' }],
    terms: [
      {
        term: { term_id: 3, name: 'News', slug: 'news', term_group: 0 },
        taxonomy: [
          {
            term_taxonomy_id: 3,
            term_id: 3,
            taxonomy: 'category',
            description: '',
            parent: 0,
            count: 1,
          },
        ],
      },
    ],
  };

  it('emits SET NAMES, replaces and meta rebuild in order', () => {
    const sql = buildMergeScript({
      units,
      deletePosts: ['99'],
      deleteOptions: ["stale'opt"],
      deleteTerms: [],
      deletedTermTtIds: [],
    });
    expect(sql).toContain('SET NAMES utf8mb4;');
    // term before post (posts may reference term_taxonomy rows)
    expect(sql.indexOf('`wp_terms`')).toBeLessThan(sql.indexOf('`wp_posts`'));
    expect(sql).toContain(
      "REPLACE INTO `wp_posts` (`ID`, `post_title`, `post_status`) VALUES (7, 'Hello', 'publish');",
    );
    expect(sql).toContain('DELETE FROM `wp_postmeta` WHERE `post_id` = 7;');
    expect(sql).toContain(
      "REPLACE INTO `wp_postmeta` (`post_id`, `meta_key`, `meta_value`) VALUES (7, '_k', 'v');",
    );
    expect(sql).toContain('DELETE FROM `wp_term_relationships` WHERE `object_id` = 7;');
    expect(sql).toContain('ON DUPLICATE KEY UPDATE `option_value`');
    // deletions
    expect(sql).toContain('DELETE FROM `wp_posts` WHERE `ID` = 99;');
    expect(sql).toContain('DELETE FROM `wp_postmeta` WHERE `post_id` = 99;');
    expect(sql).toContain('DELETE FROM `wp_term_relationships` WHERE `object_id` = 99;');
    expect(sql).toContain("DELETE FROM `wp_options` WHERE `option_name` = 'stale\\'opt';");
  });

  it('deletes terms with their taxonomy and relationship rows', () => {
    const sql = buildMergeScript({
      units: { prefix: 'wp_', posts: [], options: [], terms: [] },
      deletePosts: [],
      deleteOptions: [],
      deleteTerms: ['3'],
      deletedTermTtIds: [33],
    });
    expect(sql).toContain('DELETE FROM `wp_terms` WHERE `term_id` = 3;');
    expect(sql).toContain('DELETE FROM `wp_term_taxonomy` WHERE `term_id` = 3;');
    expect(sql).toContain('DELETE FROM `wp_term_relationships` WHERE `term_taxonomy_id` = 33;');
  });

  it('rejects non-numeric post/term ids', () => {
    expect(() =>
      buildMergeScript({
        units: { prefix: 'wp_', posts: [], options: [], terms: [] },
        deletePosts: ['7; DROP TABLE x'],
        deleteOptions: [],
        deleteTerms: [],
        deletedTermTtIds: [],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/dbMerge.test.ts`
Expected: FAIL — missing exports.

- [ ] **Step 3: Implement**

Append to `src/main/dbMerge.ts`:

```ts
// --- Merge script assembly ----------------------------------------------------

export interface FetchedPostUnit {
  post: SqlRow; // full wp_posts row (ID included)
  meta: SqlRow[]; // wp_postmeta rows (volatile keys already excluded by PHP)
  termRelationships: SqlRow[]; // wp_term_relationships rows for this object
}
export interface FetchedTermUnit {
  term: SqlRow; // wp_terms row
  taxonomy: SqlRow[]; // wp_term_taxonomy rows for this term
}
export interface FetchedUnits {
  prefix: string;
  posts: FetchedPostUnit[];
  options: SqlRow[]; // full wp_options rows minus option_id
  terms: FetchedTermUnit[];
}

function numericId(id: string): number {
  if (!/^\d+$/.test(id)) throw new Error(`Unsafe numeric id: ${id}`);
  return parseInt(id, 10);
}

export function buildMergeScript(args: {
  units: FetchedUnits;
  deletePosts: string[];
  deleteOptions: string[];
  deleteTerms: string[];
  deletedTermTtIds: number[]; // term_taxonomy_ids of deleted terms (from snapshot fetch)
}): string {
  const p = args.units.prefix;
  if (!/^[A-Za-z0-9_]+$/.test(p)) throw new Error(`Unsafe table prefix: ${p}`);
  const out: string[] = ['SET NAMES utf8mb4;'];

  // Terms first: pushed posts may reference new term_taxonomy rows
  for (const t of args.units.terms) {
    out.push(buildReplaceSql(`${p}terms`, [t.term]));
    out.push(buildReplaceSql(`${p}term_taxonomy`, t.taxonomy));
  }
  for (const u of args.units.posts) {
    const id = numericId(String(u.post.ID));
    out.push(buildReplaceSql(`${p}posts`, [u.post]));
    out.push(buildDeleteSql(`${p}postmeta`, 'post_id', id));
    if (u.meta.length) out.push(buildReplaceSql(`${p}postmeta`, u.meta));
    out.push(buildDeleteSql(`${p}term_relationships`, 'object_id', id));
    if (u.termRelationships.length)
      out.push(buildReplaceSql(`${p}term_relationships`, u.termRelationships));
  }
  for (const o of args.units.options) {
    out.push(buildOptionUpsertSql(`${p}options`, o));
  }

  for (const idStr of args.deletePosts) {
    const id = numericId(idStr);
    out.push(buildDeleteSql(`${p}posts`, 'ID', id));
    out.push(buildDeleteSql(`${p}postmeta`, 'post_id', id));
    out.push(buildDeleteSql(`${p}term_relationships`, 'object_id', id));
  }
  for (const name of args.deleteOptions) {
    out.push(buildDeleteSql(`${p}options`, 'option_name', name));
  }
  for (const idStr of args.deleteTerms) {
    const id = numericId(idStr);
    out.push(buildDeleteSql(`${p}terms`, 'term_id', id));
    out.push(buildDeleteSql(`${p}term_taxonomy`, 'term_id', id));
  }
  for (const tt of args.deletedTermTtIds) {
    out.push(buildDeleteSql(`${p}term_relationships`, 'term_taxonomy_id', numericId(String(tt))));
  }

  return out.filter(Boolean).join('\n') + '\n';
}
```

- [ ] **Step 4: Run tests, verify pass, run full suite**

Run: `npx vitest run` — all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/dbMerge.ts src/main/dbMerge.test.ts
git commit -m "Add merge SQL script assembly"
```

---

### Task 5: Baseline IO + PHP snippets

**Files:**

- Modify: `src/main/dbMerge.ts` (baseline IO)
- Create: `src/main/dbMergePhp.ts` (PHP source strings)
- Modify: `src/main/dbMerge.test.ts`

- [ ] **Step 1: Write the failing baseline tests**

Append to `src/main/dbMerge.test.ts`:

```ts
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { baselineFilePath, loadBaseline, saveBaseline, snapshotToBaseline } from './dbMerge';

describe('baseline IO', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksync-baseline-'));

  it('round-trips a baseline derived from a snapshot', () => {
    const s = snap({ posts: { '1': post('a') }, options: { blogname: 'h' } });
    const b = snapshotToBaseline(s, 'env9');
    expect(b).toMatchObject({ version: 1, envId: 'env9' });
    saveBaseline(dir, 'site1', 'env9', b);
    const loaded = loadBaseline(dir, 'site1', 'env9');
    expect(loaded).toEqual(b);
    expect(baselineFilePath(dir, 'site1', 'env9')).toMatch(/site1-env9\.json$/);
  });

  it('returns null for missing or unreadable baselines', () => {
    expect(loadBaseline(dir, 'nope', 'env')).toBeNull();
    fs.writeFileSync(baselineFilePath(dir, 'bad', 'env'), '{corrupt');
    expect(loadBaseline(dir, 'bad', 'env')).toBeNull();
  });

  it('rejects path-traversal site/env ids', () => {
    expect(() => baselineFilePath(dir, '../evil', 'env')).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**, then implement in `dbMerge.ts`:

```ts
// --- Baseline storage ---------------------------------------------------------
// JSON files under <CONFIG_DIR>/baselines (created by the caller in index.ts).
// fs is required lazily so the pure helpers above stay side-effect free.
import * as nodeFs from 'fs';
import * as nodePath from 'path';

function safeIdSegment(s: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error(`Unsafe id segment: ${s}`);
  return s;
}

export function baselineFilePath(dir: string, localSiteId: string, envId: string): string {
  return nodePath.join(dir, `${safeIdSegment(localSiteId)}-${safeIdSegment(envId)}.json`);
}

export function snapshotToBaseline(snapshot: DbSnapshot, envId: string): Baseline {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    envId,
    posts: snapshot.posts,
    options: snapshot.options,
    terms: snapshot.terms,
  };
}

export function saveBaseline(
  dir: string,
  localSiteId: string,
  envId: string,
  baseline: Baseline,
): void {
  nodeFs.mkdirSync(dir, { recursive: true });
  nodeFs.writeFileSync(baselineFilePath(dir, localSiteId, envId), JSON.stringify(baseline));
}

export function loadBaseline(dir: string, localSiteId: string, envId: string): Baseline | null {
  try {
    const raw = nodeFs.readFileSync(baselineFilePath(dir, localSiteId, envId), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed?.version === 1 ? (parsed as Baseline) : null;
  } catch {
    return null;
  }
}
```

Run: `npx vitest run src/main/dbMerge.test.ts` — PASS.

- [ ] **Step 3: Create the PHP snippets** (no unit test — exercised live in Task 11)

```ts
// src/main/dbMergePhp.ts
// PHP sources executed via `wp eval-file -` (stdin) on BOTH sides. They must:
//  - print exactly one JSON document on stdout (preceded by KSYNC_JSON marker
//    so WP notices/warnings on stderr/stdout can be skipped)
//  - normalize the site's own domain to __KSYNC_URL__ before hashing (must match
//    DOMAIN_PLACEHOLDER + normalizeDomain() in dbMerge.ts)
//  - take the domain (and for fetch: a base64 request) from $args.
// Volatile postmeta keys here must match isVolatileMetaKey() in dbMerge.ts.

// Output: { prefix, posts: {id: {hash,title,type,status,modified}},
//           options: {name: hash}, terms: {id: {hash,title,type}},
//           maxPostId, maxTermId, maxTtId }
export const SNAPSHOT_PHP = String.raw`<?php
global $wpdb;
$domain = $args[0];
$norm = function ($text) use ($domain) {
  $d = preg_quote($domain, '~');
  return preg_replace('~(https?:)?//' . $d . '(?![a-zA-Z0-9.-])~', '__KSYNC_URL__', $text);
};
$volatileMeta = array('_edit_lock', '_edit_last');
$p = $wpdb->prefix;
$out = array('prefix' => $p, 'posts' => new stdClass(), 'options' => new stdClass(), 'terms' => new stdClass());

$metaByPost = array();
$metaRows = $wpdb->get_results("SELECT post_id, meta_key, meta_value FROM {$p}postmeta ORDER BY post_id, meta_key, meta_id", ARRAY_A);
foreach ($metaRows as $m) {
  if (in_array($m['meta_key'], $volatileMeta, true)) continue;
  $metaByPost[$m['post_id']][] = $m['meta_key'] . '=' . $m['meta_value'];
}
$relByPost = array();
foreach ($wpdb->get_results("SELECT object_id, term_taxonomy_id FROM {$p}term_relationships ORDER BY object_id, term_taxonomy_id", ARRAY_A) as $r) {
  $relByPost[$r['object_id']][] = $r['term_taxonomy_id'];
}
$posts = $wpdb->get_results("SELECT * FROM {$p}posts WHERE post_status NOT IN ('auto-draft') AND post_type != 'revision' ORDER BY ID", ARRAY_A);
foreach ($posts as $row) {
  $id = $row['ID'];
  $copy = $row;
  unset($copy['post_modified'], $copy['post_modified_gmt']); // volatile; shown separately
  $blob = json_encode($copy) . '|' . implode('|', isset($metaByPost[$id]) ? $metaByPost[$id] : array())
        . '|' . implode(',', isset($relByPost[$id]) ? $relByPost[$id] : array());
  $out['posts']->$id = array(
    'hash' => md5($norm($blob)),
    'title' => $row['post_title'], 'type' => $row['post_type'],
    'status' => $row['post_status'], 'modified' => $row['post_modified_gmt'],
  );
}
foreach ($wpdb->get_results("SELECT option_name, option_value, autoload FROM {$p}options ORDER BY option_name", ARRAY_A) as $o) {
  $name = $o['option_name'];
  $out['options']->$name = md5($norm($o['option_value']) . '|' . $o['autoload']);
}
$ttByTerm = array();
foreach ($wpdb->get_results("SELECT * FROM {$p}term_taxonomy ORDER BY term_id, term_taxonomy_id", ARRAY_A) as $tt) {
  $ttByTerm[$tt['term_id']][] = $tt;
}
foreach ($wpdb->get_results("SELECT * FROM {$p}terms ORDER BY term_id", ARRAY_A) as $t) {
  $id = $t['term_id'];
  $tax = isset($ttByTerm[$id]) ? $ttByTerm[$id] : array();
  $out['terms']->$id = array(
    'hash' => md5($norm(json_encode($t) . '|' . json_encode($tax))),
    'title' => $t['name'],
    'type' => count($tax) ? $tax[0]['taxonomy'] : 'term',
  );
}
$out['maxPostId'] = (int) $wpdb->get_var("SELECT COALESCE(MAX(ID),0) FROM {$p}posts");
$out['maxTermId'] = (int) $wpdb->get_var("SELECT COALESCE(MAX(term_id),0) FROM {$p}terms");
$out['maxTtId'] = (int) $wpdb->get_var("SELECT COALESCE(MAX(term_taxonomy_id),0) FROM {$p}term_taxonomy");
echo "KSYNC_JSON" . json_encode($out);
`;

// Input ($args[0]): base64 of {"posts":[ids],"options":[names],"terms":[ids]}
// Output: FetchedUnits-shaped JSON (see dbMerge.ts) + deletedTermTtIds helper data.
export const FETCH_UNITS_PHP = String.raw`<?php
global $wpdb;
$req = json_decode(base64_decode($args[0]), true);
$volatileMeta = array('_edit_lock', '_edit_last');
$p = $wpdb->prefix;
$out = array('prefix' => $p, 'posts' => array(), 'options' => array(), 'terms' => array());
foreach ($req['posts'] as $id) {
  $id = (int) $id;
  $post = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$p}posts WHERE ID = %d", $id), ARRAY_A);
  if (!$post) continue;
  $meta = $wpdb->get_results($wpdb->prepare(
    "SELECT post_id, meta_key, meta_value FROM {$p}postmeta WHERE post_id = %d ORDER BY meta_id", $id), ARRAY_A);
  $meta = array_values(array_filter($meta, function ($m) use ($volatileMeta) {
    return !in_array($m['meta_key'], $volatileMeta, true);
  }));
  $rel = $wpdb->get_results($wpdb->prepare(
    "SELECT object_id, term_taxonomy_id, term_order FROM {$p}term_relationships WHERE object_id = %d", $id), ARRAY_A);
  $out['posts'][] = array('post' => $post, 'meta' => $meta, 'termRelationships' => $rel);
}
foreach ($req['options'] as $name) {
  $row = $wpdb->get_row($wpdb->prepare(
    "SELECT option_name, option_value, autoload FROM {$p}options WHERE option_name = %s", $name), ARRAY_A);
  if ($row) $out['options'][] = $row;
}
foreach ($req['terms'] as $id) {
  $id = (int) $id;
  $term = $wpdb->get_row($wpdb->prepare("SELECT * FROM {$p}terms WHERE term_id = %d", $id), ARRAY_A);
  if (!$term) continue;
  $tax = $wpdb->get_results($wpdb->prepare("SELECT * FROM {$p}term_taxonomy WHERE term_id = %d", $id), ARRAY_A);
  $out['terms'][] = array('term' => $term, 'taxonomy' => $tax);
}
echo "KSYNC_JSON" . json_encode($out);
`;

// Strip WP-CLI/WordPress chatter: everything before the marker is noise.
export function parseKsyncJson<T>(stdout: string): T {
  const idx = stdout.lastIndexOf('KSYNC_JSON');
  if (idx === -1) throw new Error(`WP-CLI snippet returned no JSON marker:\n${stdout.slice(-500)}`);
  return JSON.parse(stdout.slice(idx + 'KSYNC_JSON'.length)) as T;
}
```

- [ ] **Step 4: Add a `parseKsyncJson` test** in `dbMerge.test.ts`:

```ts
import { parseKsyncJson } from './dbMergePhp';

describe('parseKsyncJson', () => {
  it('skips chatter before the marker', () => {
    expect(parseKsyncJson<{ a: number }>('PHP Notice: x\nKSYNC_JSON{"a":1}')).toEqual({ a: 1 });
  });
  it('throws without marker', () => {
    expect(() => parseKsyncJson('no marker here')).toThrow(/no JSON marker/);
  });
});
```

Run: `npx vitest run` — all PASS. Also `npm run build:main` — compiles clean.

- [ ] **Step 5: Commit**

```bash
git add src/main/dbMerge.ts src/main/dbMergePhp.ts src/main/dbMerge.test.ts
git commit -m "Add baseline storage and WP-CLI PHP snippets for DB merge"
```

---

### Task 6: Extract reusable WP-CLI runners in `index.ts`

**Files:**

- Modify: `src/main/index.ts` (extract from the pull handler at :1133-1184; add helpers near `searchReplacePairs` at :569)

No new unit tests (integration glue) — `npm test` and `npm run build` must stay green,
and the pull flow is re-verified live in Task 11.

- [ ] **Step 1: Add `withSocketWpConfig` + `runLocalWpCli` + `runLocalSearchReplace` helpers**

Insert after `searchReplacePairs` (index.ts:575). This is the exact wp-config dance
currently inlined in the pull handler:

```ts
// Run fn with wp-config.php temporarily pointing DB_HOST at the site socket
// (WP-CLI can't reach Local's MySQL otherwise). Always restores, with crash
// recovery via the .kinsta-sync-bak copy.
async function withSocketWpConfig<T>(
  localPublicPath: string,
  socketPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const wpConfigPath = path.join(localPublicPath, 'wp-config.php');
  const wpConfigBackupPath = wpConfigPath + '.kinsta-sync-bak';

  if (fs.existsSync(wpConfigBackupPath)) {
    // previous crash — restore first
    fs.copyFileSync(wpConfigBackupPath, wpConfigPath);
    fs.unlinkSync(wpConfigBackupPath);
  }
  const wpConfigBackup = fs.readFileSync(wpConfigPath, 'utf8');
  fs.writeFileSync(wpConfigBackupPath, wpConfigBackup);
  try {
    fs.writeFileSync(
      wpConfigPath,
      wpConfigBackup.replace(
        /define\s*\(\s*['"]DB_HOST['"]\s*,\s*['"]([^'"]*)['"]\s*\)/,
        `define('DB_HOST', 'localhost:${socketPath}')`,
      ),
    );
    return await fn();
  } finally {
    fs.writeFileSync(wpConfigPath, wpConfigBackup);
    if (fs.existsSync(wpConfigBackupPath)) fs.unlinkSync(wpConfigBackupPath);
  }
}

interface LocalWpCli {
  phpBin: string;
  wpCliPhar: string;
  env: NodeJS.ProcessEnv;
}

function resolveLocalWpCli(): LocalWpCli {
  const phpBin = findServiceBinary(['php-'], 'php');
  const wpCliPhar = findWpCliPhar();
  const mysqlBin = findServiceBinary(['mysql-', 'mariadb-'], 'mysql');
  if (!phpBin) throw new Error("Could not find PHP binary in Local's lightning-services");
  if (!wpCliPhar) throw new Error('Could not find WP-CLI in the Local installation');
  if (!mysqlBin) throw new Error("Could not find MySQL binaries in Local's lightning-services");
  return {
    phpBin,
    wpCliPhar,
    env: { ...process.env, PATH: `${path.dirname(mysqlBin)}:${process.env.PATH || ''}` },
  };
}

// Run one local WP-CLI command (callers wrap in withSocketWpConfig themselves
// when the command touches the DB — i.e. always, in practice).
async function runLocalWpCli(
  sync: ActiveSync,
  cli: LocalWpCli,
  localPublicPath: string,
  wpArgs: string[],
  opts: RunOptions = {},
): Promise<{ code: number; stderr: string }> {
  return runCommand(
    sync,
    cli.phpBin,
    [
      cli.wpCliPhar,
      ...wpArgs,
      '--skip-plugins',
      '--skip-themes',
      `--path=${localPublicPath}`,
      '--allow-root',
    ],
    { env: cli.env, ...opts },
  );
}

// The three search-replace passes against the LOCAL database
async function runLocalSearchReplace(
  sync: ActiveSync,
  cli: LocalWpCli,
  localPublicPath: string,
  fromDomain: string,
  toDomain: string,
  networkArgs: string[],
  onPass?: (i: number, from: string, to: string) => void,
): Promise<void> {
  const pairs = searchReplacePairs(fromDomain, toDomain);
  for (let i = 0; i < pairs.length; i++) {
    const [from, to] = pairs[i];
    onPass?.(i, from, to);
    await runLocalWpCli(sync, cli, localPublicPath, [
      'search-replace',
      from,
      to,
      '--all-tables',
      '--skip-columns=guid',
      ...networkArgs,
    ]);
  }
}
```

- [ ] **Step 2: Replace the inlined dance in the pull handler**

In the pull handler, replace the block from `const phpBin = findServiceBinary...`
(index.ts:1133) through the end of the inner `try/finally` (index.ts:1184) with:

```ts
const cli = resolveLocalWpCli();
// MultiSite.No is the empty string, so truthiness is the correct check
const networkArgs = site.multiSite ? ['--network'] : [];
await withSocketWpConfig(localPublicPath, socketPath, () =>
  runLocalSearchReplace(
    sync,
    cli,
    localPublicPath,
    remoteDomain,
    localDomain,
    networkArgs,
    (i, from, to) =>
      sendProgress({
        stage: 'search-replace',
        progress: 84 + i * 4,
        message: `Replacing ${from} → ${to}`,
      }),
  ),
);
sendProgress({ stage: 'search-replace', progress: 96, message: 'Search-replace complete!' });
```

(The push handler has a remote search-replace loop — leave it; it runs over SSH, not locally.)

- [ ] **Step 3: Build + test**

Run: `npm run build && npm test`
Expected: clean compile, 35+ tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "Extract reusable local WP-CLI runners from the pull handler"
```

---

### Task 7: Snapshot runners + `kinsta:dbPreview` IPC handler

**Files:**

- Modify: `src/main/index.ts`

- [ ] **Step 1: Add imports and the snapshot runners**

At the top of `index.ts` add:

```ts
import {
  DbSnapshot,
  Baseline,
  classifySnapshots,
  buildMergeScript,
  buildAutoIncrementSql,
  baselineFilePath,
  loadBaseline,
  saveBaseline,
  snapshotToBaseline,
  FetchedUnits,
} from './dbMerge';
import { SNAPSHOT_PHP, FETCH_UNITS_PHP, parseKsyncJson } from './dbMergePhp';
```

Add near the other path constants (after `TEMP_DIR`):

```ts
const BASELINES_DIR = path.join(CONFIG_DIR, 'baselines');
```

Add the runners after `runLocalSearchReplace` (from Task 6):

```ts
// --- DB merge: snapshot + fetch runners --------------------------------------

// Both sides run the SAME PHP via `wp eval-file -` so hashes are comparable.
async function runLocalEvalFile<T>(
  sync: ActiveSync,
  cli: LocalWpCli,
  localPublicPath: string,
  socketPath: string,
  phpSource: string,
  phpArgs: string[],
): Promise<T> {
  const tmpPhp = path.join(TEMP_DIR, `ksync-eval-${Date.now()}.php`);
  fs.writeFileSync(tmpPhp, phpSource);
  try {
    const chunks: string[] = [];
    await withSocketWpConfig(localPublicPath, socketPath, () =>
      runLocalWpCli(sync, cli, localPublicPath, ['eval-file', tmpPhp, ...phpArgs], {
        onStdout: (c) => chunks.push(c),
      }),
    );
    return parseKsyncJson<T>(chunks.join(''));
  } finally {
    try {
      fs.unlinkSync(tmpPhp);
    } catch (e) {}
  }
}

async function runRemoteEvalFile<T>(
  sync: ActiveSync,
  envInfo: EnvironmentInfo,
  phpSource: string,
  phpArgs: string[],
): Promise<T> {
  const tmpPhp = path.join(TEMP_DIR, `ksync-eval-remote-${Date.now()}.php`);
  fs.writeFileSync(tmpPhp, phpSource);
  try {
    const chunks: string[] = [];
    // args are validated upstream: domain via validateEnvironmentInfo, the fetch
    // request is base64 ([A-Za-z0-9+/=]) — safe inside the remote command string
    const argStr = phpArgs.map((a) => `'${a}'`).join(' ');
    await runCommand(
      sync,
      'ssh',
      sshArgs(envInfo, `cd ~/public && wp eval-file - ${argStr} --skip-plugins --skip-themes`),
      { stdinFile: tmpPhp, onStdout: (c) => chunks.push(c) },
    );
    return parseKsyncJson<T>(chunks.join(''));
  } finally {
    try {
      fs.unlinkSync(tmpPhp);
    } catch (e) {}
  }
}

function stripDomain(d: string): string {
  return d.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
```

- [ ] **Step 2: Add the `kinsta:dbPreview` handler**

Insert after the `kinsta:pushPreview` handler (index.ts:1007). It reuses the
`activePreviews` map so a re-fired preview kills its predecessor:

```ts
// Database merge preview: snapshot both sides, three-way diff vs baseline
ipcMain.handle(
  'kinsta:dbPreview',
  async (
    _event: IpcMainInvokeEvent,
    localSiteId: string,
    site: SiteInfo,
    envInfo: EnvironmentInfo,
  ) => {
    if (activeSyncs.has(localSiteId)) {
      return { success: false, error: 'A sync is already running for this site' };
    }
    if (!validateEnvironmentInfo(envInfo)) {
      return { success: false, error: 'Invalid environment configuration.' };
    }
    const socketPath = getMysqlSocketPath(localSiteId);
    if (!fs.existsSync(socketPath)) {
      return {
        success: false,
        error:
          'The local site must be running for database preview. Start the site in Local and try again.',
      };
    }
    if (site.multiSite) {
      return {
        success: false,
        error: 'Database merge is not available for multisite — use "Overwrite everything".',
      };
    }

    activePreviews.get(`db:${localSiteId}`)?.child?.kill('SIGTERM');
    const preview: ActiveSync = { cancelled: false, child: null };
    activePreviews.set(`db:${localSiteId}`, preview);

    try {
      const localPublicPath = path.join(expandPath(site.path), 'app', 'public');
      const cli = resolveLocalWpCli();

      const localSnap = await runLocalEvalFile<DbSnapshot>(
        preview,
        cli,
        localPublicPath,
        socketPath,
        SNAPSHOT_PHP,
        [site.domain],
      );
      const remoteSnap = await runRemoteEvalFile<DbSnapshot>(preview, envInfo, SNAPSHOT_PHP, [
        stripDomain(envInfo.remoteDomain),
      ]);

      const baseline = loadBaseline(BASELINES_DIR, localSiteId, envInfo.envId);
      const link = loadSiteLinks()[localSiteId];
      const lastSyncAt = [link?.lastPullAt, link?.lastPushAt].filter(Boolean).sort().pop();

      const rows = classifySnapshots(localSnap, remoteSnap, baseline, lastSyncAt);
      return {
        success: true,
        rows,
        firstRun: !baseline,
        // term_taxonomy_ids needed when the user confirms term deletions
        remotePrefix: remoteSnap.prefix,
        localPrefix: localSnap.prefix,
      };
    } catch (error: any) {
      if (error instanceof CancelledError)
        return { success: false, cancelled: true, error: 'Cancelled' };
      return { success: false, error: error.message };
    } finally {
      if (activePreviews.get(`db:${localSiteId}`) === preview)
        activePreviews.delete(`db:${localSiteId}`);
    }
  },
);
```

- [ ] **Step 3: Build + test**

Run: `npm run build && npm test`
Expected: clean compile, all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts
git commit -m "Add kinsta:dbPreview IPC handler with two-sided snapshots"
```

---

### Task 8: Merge branch in the push pipeline

**Files:**

- Modify: `src/main/index.ts` (the `kinsta:push` handler, index.ts:1232+, and `SyncOptions`, index.ts:129)

- [ ] **Step 1: Extend `SyncOptions`**

```ts
// Renderer-computed selections for a database MERGE push. IDs are validated
// in buildMergeScript (numeric for posts/terms); option names are SQL-escaped.
export interface DbMergeSelections {
  pushPosts: string[];
  pushOptions: string[];
  pushTerms: string[];
  deletePostsRemote: string[];
  deleteOptionsRemote: string[];
  deleteTermsRemote: string[];
  // Convergence (local gets "their" version):
  pullPosts: string[];
  pullOptions: string[];
  pullTerms: string[];
  deletePostsLocal: string[];
  deleteOptionsLocal: string[];
  deleteTermsLocal: string[];
  converge: boolean;
}

interface SyncOptions {
  // ...existing fields unchanged...
  dbMode?: 'overwrite' | 'merge'; // default 'overwrite' (today's behavior)
  dbSelections?: DbMergeSelections;
}
```

- [ ] **Step 2: Add the merge function**

Insert before the `kinsta:push` handler:

```ts
// Apply a database merge: push selected local units to the remote, optionally
// converge "their" units back into the local DB, then rebuild the baseline.
// Caller has already taken the remote pre-push backup; we take the local one.
async function applyDbMerge(args: {
  sync: ActiveSync;
  site: SiteInfo;
  localSiteId: string;
  envInfo: EnvironmentInfo;
  sel: DbMergeSelections;
  sendProgress: (p: SyncProgress) => void;
  flags: { remoteImportStarted: boolean; localImportStarted: boolean };
}): Promise<void> {
  const { sync, site, localSiteId, envInfo, sel, sendProgress, flags } = args;
  const socketPath = getMysqlSocketPath(localSiteId);
  const localPublicPath = path.join(expandPath(site.path), 'app', 'public');
  const cli = resolveLocalWpCli();
  const db = getDbCredentials(site);
  const mysqlBin = findServiceBinary(['mysql-', 'mariadb-'], 'mysql');
  if (!mysqlBin) throw new Error("Could not find MySQL binaries in Local's lightning-services");
  const remoteDomain = stripDomain(envInfo.remoteDomain);

  // 1. Fetch the full LOCAL rows for everything we push
  sendProgress({ stage: 'database', progress: 40, message: 'Reading local changes...' });
  const pushReq = Buffer.from(
    JSON.stringify({
      posts: sel.pushPosts,
      options: sel.pushOptions,
      terms: sel.pushTerms,
    }),
  ).toString('base64');
  const pushUnits = await runLocalEvalFile<FetchedUnits>(
    sync,
    cli,
    localPublicPath,
    socketPath,
    FETCH_UNITS_PHP,
    [pushReq],
  );

  // Deleted terms' tt_ids come from the local taxonomy rows of those terms —
  // fetch them too so remote term_relationships are cleaned up.
  const delTermReq = Buffer.from(
    JSON.stringify({
      posts: [],
      options: [],
      terms: sel.deleteTermsRemote,
    }),
  ).toString('base64');
  const delTermUnits = sel.deleteTermsRemote.length
    ? await runRemoteEvalFile<FetchedUnits>(sync, envInfo, FETCH_UNITS_PHP, [delTermReq])
    : { prefix: pushUnits.prefix, posts: [], options: [], terms: [] };
  const deletedTermTtIds = delTermUnits.terms.flatMap((t) =>
    t.taxonomy.map((x) => Number(x.term_taxonomy_id)),
  );

  // 2. Build + upload + import the remote merge script (uses the REMOTE prefix)
  sendProgress({ stage: 'database', progress: 50, message: 'Applying changes on Kinsta...' });
  const remoteSql = buildMergeScript({
    units: { ...pushUnits },
    deletePosts: sel.deletePostsRemote,
    deleteOptions: sel.deleteOptionsRemote,
    deleteTerms: sel.deleteTermsRemote,
    deletedTermTtIds,
  });
  const localSqlPath = path.join(TEMP_DIR, `${localSiteId}-merge-push.sql`);
  const remoteSqlPath = '~/kinsta-sync-merge.sql';
  fs.writeFileSync(localSqlPath, remoteSql);
  await runCommand(sync, 'scp', [
    '-P',
    envInfo.sshPort,
    '-o',
    'StrictHostKeyChecking=accept-new',
    localSqlPath,
    `${envInfo.sshUser}@${envInfo.sshHost}:${remoteSqlPath}`,
  ]);
  flags.remoteImportStarted = true;
  await runCommand(
    sync,
    'ssh',
    sshArgs(envInfo, `cd ~/public && wp db import ${remoteSqlPath} && rm -f ${remoteSqlPath}`),
  );

  // 3. Remote search-replace: the local domain only exists in rows we just
  //    inserted, so the full pass is effectively row-scoped.
  const pairs = searchReplacePairs(site.domain, remoteDomain);
  for (let i = 0; i < pairs.length; i++) {
    const [from, to] = pairs[i];
    sendProgress({
      stage: 'search-replace',
      progress: 60 + i * 3,
      message: `Replacing ${from} → ${to} on Kinsta`,
    });
    await runCommand(
      sync,
      'ssh',
      sshArgs(
        envInfo,
        `cd ~/public && wp search-replace '${from}' '${to}' --all-tables --skip-columns=guid`,
      ),
    );
  }

  // 4. Convergence: local DB gets "their" rows
  if (sel.converge) {
    sendProgress({
      stage: 'database',
      progress: 72,
      message: 'Updating local database with their changes...',
    });
    const pullReq = Buffer.from(
      JSON.stringify({
        posts: sel.pullPosts,
        options: sel.pullOptions,
        terms: sel.pullTerms,
      }),
    ).toString('base64');
    const pullUnits = await runRemoteEvalFile<FetchedUnits>(sync, envInfo, FETCH_UNITS_PHP, [
      pullReq,
    ]);
    const localDelTermUnits = sel.deleteTermsLocal.length
      ? await runLocalEvalFile<FetchedUnits>(
          sync,
          cli,
          localPublicPath,
          socketPath,
          FETCH_UNITS_PHP,
          [
            Buffer.from(
              JSON.stringify({ posts: [], options: [], terms: sel.deleteTermsLocal }),
            ).toString('base64'),
          ],
        )
      : { prefix: pullUnits.prefix, posts: [], options: [], terms: [] };
    const localSql = buildMergeScript({
      units: pullUnits,
      deletePosts: sel.deletePostsLocal,
      deleteOptions: sel.deleteOptionsLocal,
      deleteTerms: sel.deleteTermsLocal,
      deletedTermTtIds: localDelTermUnits.terms.flatMap((t) =>
        t.taxonomy.map((x) => Number(x.term_taxonomy_id)),
      ),
    });
    const convergeSqlPath = path.join(TEMP_DIR, `${localSiteId}-merge-converge.sql`);
    fs.writeFileSync(convergeSqlPath, localSql);
    flags.localImportStarted = true;
    await runCommand(
      sync,
      mysqlBin,
      [`-u${db.user}`, `-p${db.password}`, `--socket=${socketPath}`, db.database],
      { stdinFile: convergeSqlPath },
    );
    // Their rows carry the remote domain — rewrite to local in the local DB
    await withSocketWpConfig(localPublicPath, socketPath, () =>
      runLocalSearchReplace(sync, cli, localPublicPath, remoteDomain, site.domain, []),
    );
    try {
      fs.unlinkSync(convergeSqlPath);
    } catch (e) {}
  }

  // 5. Rebuild the baseline from the merged REMOTE state (the merged truth
  //    whether or not convergence ran)
  sendProgress({ stage: 'database', progress: 85, message: 'Saving sync baseline...' });
  const newRemoteSnap = await runRemoteEvalFile<DbSnapshot>(sync, envInfo, SNAPSHOT_PHP, [
    remoteDomain,
  ]);
  saveBaseline(
    BASELINES_DIR,
    localSiteId,
    envInfo.envId,
    snapshotToBaseline(newRemoteSnap, envInfo.envId),
  );
  try {
    fs.unlinkSync(localSqlPath);
  } catch (e) {}
}
```

- [ ] **Step 3: Branch inside the push handler**

In `kinsta:push`, the database section currently does export-local → scp → remote
import → remote search-replace. Wrap it:

```ts
if (options.includeDatabase) {
  // ...existing pre-flight + remote pre-push backup stays UNCHANGED...

  if (options.dbMode === 'merge' && options.dbSelections) {
    // Local backup first: convergence writes to the local DB
    sendProgress({ stage: 'database', progress: 36, message: 'Backing up local database...' });
    const localBackupPath = path.join(TEMP_DIR, `${localSiteId}-pre-merge-backup.sql`);
    const mysqldumpBin = findServiceBinary(['mysql-', 'mariadb-'], 'mysqldump');
    if (!mysqldumpBin)
      throw new Error("Could not find MySQL binaries in Local's lightning-services");
    await runCommand(
      sync,
      mysqldumpBin,
      [`-u${db.user}`, `-p${db.password}`, `--socket=${socketPath}`, db.database],
      { stdoutFile: localBackupPath },
    );

    await applyDbMerge({
      sync,
      site,
      localSiteId,
      envInfo,
      sel: options.dbSelections,
      sendProgress,
      flags: mergeFlags,
    });
  } else {
    // ...existing overwrite path stays byte-for-byte UNCHANGED...
  }
}
```

Declare near the existing `remoteImportStarted` flag (the push handler already
tracks one — merge reuses the same catch-block contract):

```ts
const mergeFlags = { remoteImportStarted: false, localImportStarted: false };
```

In the push handler's **catch block**, extend the existing remote-restore logic:
restore remote if `mergeFlags.remoteImportStarted || remoteImportStarted` (existing
variable), and add a local restore mirroring the pull handler's (index.ts:1204-1218)
using `${localSiteId}-pre-merge-backup.sql` when `mergeFlags.localImportStarted`.

After a successful **overwrite** push with DB, and after a successful pull with DB,
save a baseline from a LOCAL snapshot (sides are identical then). In the pull
handler after search-replace completes:

```ts
// Baseline + ID-collision prevention (merge-push feature)
try {
  sendProgress({ stage: 'database', progress: 97, message: 'Saving sync baseline...' });
  const cliB = resolveLocalWpCli();
  const localSnapB = await runLocalEvalFile<DbSnapshot>(
    sync,
    cliB,
    localPublicPath,
    socketPath,
    SNAPSHOT_PHP,
    [site.domain],
  );
  saveBaseline(
    BASELINES_DIR,
    localSiteId,
    envInfo.envId,
    snapshotToBaseline(localSnapB, envInfo.envId),
  );
  const bumpSql = buildAutoIncrementSql(localSnapB.prefix, localSnapB).join('\n');
  const bumpPath = path.join(TEMP_DIR, `${localSiteId}-ai-bump.sql`);
  fs.writeFileSync(bumpPath, bumpSql);
  await runCommand(
    sync,
    findServiceBinary(['mysql-', 'mariadb-'], 'mysql')!,
    [`-u${db.user}`, `-p${db.password}`, `--socket=${socketPath}`, db.database],
    { stdinFile: bumpPath },
  );
  try {
    fs.unlinkSync(bumpPath);
  } catch (e) {}
} catch (e: any) {
  console.warn('[Kinsta] Baseline/auto-increment step failed (non-fatal):', e.message);
}
```

Same baseline block (minus the auto-increment bump) at the end of the overwrite-push
DB path.

- [ ] **Step 4: Build + test**

Run: `npm run build && npm test`
Expected: clean compile, all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts
git commit -m "Add merge branch to the push pipeline with convergence and rollback"
```

---

### Task 9: Renderer — sidebar mode select + tab switch

**Files:**

- Modify: `src/renderer/KinstaPushScreen.tsx`

- [ ] **Step 1: Add state + DB preview wiring**

In `KinstaPushScreen.tsx` add to the state block (after `kinstaBackup`, line ~135):

```tsx
type DbMode = 'merge' | 'overwrite';
const [dbMode, setDbMode] = useState<DbMode>('merge');
const [converge, setConverge] = useState(true);
const [activeTab, setActiveTab] = useState<'files' | 'database'>('files');

// Mirrors DbDiffRow in src/main/dbMerge.ts (+ renderer selection state)
interface DbRow {
  kind: 'post' | 'option' | 'term';
  id: string;
  label: string;
  subtype: string;
  change: 'push' | 'keep' | 'conflict' | 'delete-remote' | 'keep-deleted';
  conflictKind?: 'edit-edit' | 'edit-delete' | 'delete-edit' | 'id-collision';
  localModified?: string;
  remoteModified?: string;
  selected: boolean;
  resolution?: 'mine' | 'theirs';
}
const [dbRows, setDbRows] = useState<DbRow[]>([]);
const [dbLoading, setDbLoading] = useState(false);
const [dbError, setDbError] = useState<string | null>(null);
const [dbFirstRun, setDbFirstRun] = useState(false);
const dbPreviewSeq = useRef(0);
```

(Define the `DbRow` interface at module level next to `DiffRow`, not inside the
component — shown inline here for locality.)

Add the DB preview effect after the file-preview effect (line ~247):

```tsx
// DB merge preview — only when the database is included in merge mode
useEffect(() => {
  if (!isOpen || !selectedEnvId || isPushing || isComplete) return;
  if (!includeDatabase || dbMode !== 'merge') {
    setDbRows([]);
    setDbError(null);
    return;
  }
  const seq = ++dbPreviewSeq.current;
  setDbLoading(true);
  setDbError(null);
  const timer = setTimeout(async () => {
    const envInfo = getEnvInfo(selectedEnvId);
    if (!envInfo) {
      setDbLoading(false);
      return;
    }
    const result = await ipcRenderer.invoke('kinsta:dbPreview', site.id, site, envInfo);
    if (seq !== dbPreviewSeq.current) return;
    setDbLoading(false);
    if (result.success) {
      setDbFirstRun(!!result.firstRun);
      setDbRows(
        (result.rows || []).map((r: DbRow) => ({
          ...r,
          selected: r.change === 'push', // deletions + keep rows start unchecked
          resolution: undefined,
        })),
      );
    } else {
      setDbError(result.error || 'Database preview failed');
      setDbRows([]);
    }
  }, 250);
  return () => {
    clearTimeout(timer);
  };
}, [isOpen, selectedEnvId, includeDatabase, dbMode, environments]);
```

- [ ] **Step 2: Sidebar — DB mode select + convergence checkbox**

Right under the "Include database" checkbox (line ~450), insert:

```tsx
{
  includeDatabase && (
    <div style={{ paddingLeft: '26px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <FlySelect
        value={dbMode}
        options={{ merge: 'Merge changes', overwrite: 'Overwrite everything' }}
        onChange={(value: DbMode) => setDbMode(value)}
        disabled={isPushing}
      />
      {dbMode === 'merge' && (
        <Checkbox
          label="Update local with their changes"
          checked={converge}
          disabled={isPushing}
          onChange={(checked: boolean) => setConverge(checked)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Tab switch above the toolbar**

In the right pane (before the toolbar div, line ~512), add the tab bar — shown only
when a DB merge preview participates:

```tsx
{
  includeDatabase && dbMode === 'merge' && (
    <div style={{ display: 'flex', borderBottom: border, flexShrink: 0 }}>
      {(
        [
          ['files', `Files (${rows.length})`],
          ['database', `Database (${dbRows.length})`],
        ] as const
      ).map(([key, label]) => (
        <button
          key={key}
          onClick={() => setActiveTab(key)}
          style={{
            padding: '10px 20px',
            fontSize: '13px',
            fontWeight: 600,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'inherit',
            opacity: activeTab === key ? 1 : 0.55,
            borderBottom: activeTab === key ? '2px solid currentColor' : '2px solid transparent',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
```

Wrap the existing toolbar + degraded banner + table region in
`{activeTab === 'files' ? (<>…existing…</>) : (<PushDatabaseTab …/>)}` —
`PushDatabaseTab` is created in Task 10; for THIS commit render a placeholder
`<div style={{ flex: 1 }} />` for the database branch so the build stays green.

- [ ] **Step 4: Build + verify via CDP (read-only)**

Run: `npm run build:renderer`. Per CLAUDE.md, relaunch Local with
`--remote-debugging-port=9222`, open the push screen for GBD Shop (`heaKB3eQ3`) via
the `kinsta:action` CustomEvent, screenshot: tabs render, mode select renders,
toggling "Include database" hides/shows them. **No pushes — preview only.**

- [ ] **Step 5: Commit**

```bash
git add src/renderer/KinstaPushScreen.tsx
git commit -m "Add database mode select and Files/Database tabs to push screen"
```

---

### Task 10: Renderer — the database tab

**Files:**

- Create: `src/renderer/PushDatabaseTab.tsx`
- Modify: `src/renderer/KinstaPushScreen.tsx`

- [ ] **Step 1: Create the component**

```tsx
// src/renderer/PushDatabaseTab.tsx
import * as React from 'react';
import {
  Checkbox,
  FlySelect,
  Spinner,
  VirtualTable,
  IVirtualTableCellRendererDataArgs,
} from '@getflywheel/local-components';

// Mirrors DbDiffRow in src/main/dbMerge.ts (+ renderer selection state)
export interface DbRow {
  kind: 'post' | 'option' | 'term';
  id: string;
  label: string;
  subtype: string;
  change: 'push' | 'keep' | 'conflict' | 'delete-remote' | 'keep-deleted';
  conflictKind?: 'edit-edit' | 'edit-delete' | 'delete-edit' | 'id-collision';
  localModified?: string;
  remoteModified?: string;
  selected: boolean;
  resolution?: 'mine' | 'theirs';
}

const CHANGE_LABEL: Record<DbRow['change'], string> = {
  push: 'Will be pushed',
  keep: 'Their change — kept',
  conflict: 'Conflict',
  'delete-remote': 'Will be deleted on Kinsta',
  'keep-deleted': 'Deleted on Kinsta — kept',
};
const SUBTYPE_LABEL = (r: DbRow): string => {
  if (r.kind === 'option') return 'Option';
  if (r.kind === 'term')
    return r.subtype === 'category' ? 'Category' : r.subtype === 'post_tag' ? 'Tag' : 'Term';
  return r.subtype === 'page' ? 'Page' : r.subtype === 'post' ? 'Post' : r.subtype;
};
const fmtWpDate = (s?: string): string => {
  if (!s) return '';
  const d = new Date(s + 'Z');
  return isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString() +
        ' ' +
        d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};
const rowKey = (r: DbRow): string => `${r.kind}:${r.id}`;

interface Props {
  rows: DbRow[];
  loading: boolean;
  error: string | null;
  firstRun: boolean;
  border: string;
  onToggle: (key: string, checked: boolean) => void;
  onResolve: (key: string, resolution: 'mine' | 'theirs') => void;
}

const PushDatabaseTab: React.FC<Props> = ({
  rows,
  loading,
  error,
  firstRun,
  border,
  onToggle,
  onResolve,
}) => {
  const pushCount = rows.filter(
    (r) =>
      ((r.change === 'push' || r.change === 'delete-remote') && r.selected) ||
      (r.change === 'conflict' && r.resolution === 'mine'),
  ).length;
  const keepCount = rows.filter(
    (r) =>
      r.change === 'keep' ||
      r.change === 'keep-deleted' ||
      (r.change === 'conflict' && r.resolution === 'theirs'),
  ).length;
  const unresolved = rows.filter((r) => r.change === 'conflict' && !r.resolution).length;

  const cellRenderer = (args: IVirtualTableCellRendererDataArgs): React.ReactNode => {
    const { colKey, isHeader, rowData } = args;
    if (isHeader) return args.children;
    const row = rowData as DbRow;
    switch (colKey) {
      case 'selected':
        if (row.change === 'conflict') {
          return (
            <FlySelect
              value={row.resolution || ''}
              options={{ '': 'Choose…', mine: 'Mine', theirs: 'Theirs' }}
              onChange={(v: string) => v && onResolve(rowKey(row), v as 'mine' | 'theirs')}
            />
          );
        }
        if (row.change === 'keep' || row.change === 'keep-deleted') {
          return <span style={{ opacity: 0.45, fontSize: '11px' }}>kept</span>;
        }
        return (
          <Checkbox
            checked={row.selected}
            onChange={(checked: boolean) => onToggle(rowKey(row), checked)}
          />
        );
      case 'label':
        return (
          <span
            style={{
              fontFamily: row.kind === 'option' ? 'monospace' : undefined,
              fontSize: '12px',
            }}
          >
            {row.change === 'conflict' ? '⚠ ' : ''}
            {row.label}
          </span>
        );
      case 'subtype':
        return <span style={{ opacity: 0.7 }}>{SUBTYPE_LABEL(row)}</span>;
      case 'change': {
        const color =
          row.change === 'conflict'
            ? '#fcc419'
            : row.change === 'delete-remote'
              ? '#d04d5c'
              : row.change === 'push'
                ? '#50c083'
                : undefined;
        return <span style={{ color }}>{CHANGE_LABEL[row.change]}</span>;
      }
      case 'localModified':
        return <span style={{ opacity: 0.7 }}>{fmtWpDate(row.localModified)}</span>;
      case 'remoteModified':
        return <span style={{ opacity: 0.7 }}>{fmtWpDate(row.remoteModified)}</span>;
    }
    return args.children;
  };

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 20px',
          borderBottom: border,
          flexShrink: 0,
          fontSize: '13px',
        }}
      >
        <span style={{ fontWeight: 600 }}>Database changes</span>
        <div style={{ display: 'flex', gap: '14px', opacity: 0.85 }}>
          <span>
            ↑ <strong>{pushCount}</strong> push
          </span>
          <span style={{ opacity: 0.3 }}>|</span>
          <span>🔒 {keepCount} kept</span>
          <span style={{ opacity: 0.3 }}>|</span>
          <span style={{ color: unresolved ? '#fcc419' : undefined }}>
            ⚠ {unresolved} unresolved
          </span>
        </div>
      </div>
      {firstRun && (
        <div
          style={{
            padding: '8px 20px',
            fontSize: '12px',
            color: '#fcc419',
            backgroundColor: 'rgba(252,196,25,0.08)',
            borderBottom: border,
            flexShrink: 0,
          }}
        >
          First merge for this environment — classification uses modification dates until a sync
          baseline exists (created automatically after this push or the next pull).
        </div>
      )}
      {loading ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '10px',
            opacity: 0.65,
          }}
        >
          <Spinner /> Comparing databases…
        </div>
      ) : error ? (
        <div
          style={{
            flex: 1,
            padding: '24px',
            color: '#d04d5c',
            fontSize: '13px',
            whiteSpace: 'pre-wrap',
          }}
        >
          {error}
        </div>
      ) : rows.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: 0.65,
            fontSize: '14px',
          }}
        >
          Databases are in sync — nothing to merge.
        </div>
      ) : (
        <VirtualTable
          data={rows}
          headers={[
            { key: 'selected', value: '', flex: '0 0 110px' },
            { key: 'label', value: 'Item', flex: '1 1 auto' },
            { key: 'subtype', value: 'Type', flex: '0 0 90px' },
            { key: 'change', value: 'Change', flex: '0 0 190px' },
            { key: 'localModified', value: 'Local', flex: '0 0 150px' },
            { key: 'remoteModified', value: 'Kinsta', flex: '0 0 150px' },
          ]}
          rowKeyPropName="id"
          cellClassName="KinstaPushCell"
          rowClassName="KinstaPushRow"
          cellRenderer={cellRenderer}
          rowHeightSize="s"
          rowHeaderHeightSize="m"
          headersWeight={500}
          headersCapitalize="none"
          overscan={20}
          striped
        />
      )}
    </>
  );
};

export default PushDatabaseTab;
```

NOTE: `rowKeyPropName="id"` can collide across kinds (post 7 vs term 7). Before
passing data, map rows to include a `key` field and use `rowKeyPropName="key"`:
in the parent, pass `dbRows.map(r => ({ ...r, key: `${r.kind}:${r.id}` }))`.

- [ ] **Step 2: Wire into `KinstaPushScreen.tsx`**

Replace the Task 9 placeholder with:

```tsx
<PushDatabaseTab
  rows={dbRows.map((r) => ({ ...r, key: `${r.kind}:${r.id}` })) as any}
  loading={dbLoading}
  error={dbError}
  firstRun={dbFirstRun}
  border={border}
  onToggle={(key, checked) =>
    setDbRows((rs) =>
      rs.map((r) => (`${r.kind}:${r.id}` === key ? { ...r, selected: checked } : r)),
    )
  }
  onResolve={(key, resolution) =>
    setDbRows((rs) => rs.map((r) => (`${r.kind}:${r.id}` === key ? { ...r, resolution } : r)))
  }
/>
```

Import at top: `import PushDatabaseTab, { DbRow } from './PushDatabaseTab';`
(delete the local `DbRow` interface from Task 9 and use the imported one).

- [ ] **Step 3: Gate the push button on unresolved conflicts**

Update the `PrimaryButton` disabled expression (line ~473):

```tsx
              disabled={
                isPushing || previewLoading || isComplete ||
                (selectedRows.length === 0 && !includeDatabase) ||
                (includeDatabase && dbMode === 'merge' && (
                  dbLoading ||
                  dbRows.some(r => r.change === 'conflict' && !r.resolution)
                ))
              }
```

- [ ] **Step 4: Build + CDP verification (read-only)**

`npm run build:renderer`, hot-reload, screenshot the Database tab against GBD Shop:
counters, conflict selector, first-run banner. Iterate on screenshots until the
layout matches the Files tab quality. **No pushes.**

- [ ] **Step 5: Commit**

```bash
git add src/renderer/PushDatabaseTab.tsx src/renderer/KinstaPushScreen.tsx
git commit -m "Add database diff tab with conflict resolution to push preview"
```

---

### Task 11: Renderer — wire executePush + confirm modal

**Files:**

- Modify: `src/renderer/KinstaPushScreen.tsx`

- [ ] **Step 1: Compute selections and extend the push invoke**

In `executePush` (line ~269), build the selections and pass them:

```tsx
const sel = {
  pushPosts: [] as string[],
  pushOptions: [] as string[],
  pushTerms: [] as string[],
  deletePostsRemote: [] as string[],
  deleteOptionsRemote: [] as string[],
  deleteTermsRemote: [] as string[],
  pullPosts: [] as string[],
  pullOptions: [] as string[],
  pullTerms: [] as string[],
  deletePostsLocal: [] as string[],
  deleteOptionsLocal: [] as string[],
  deleteTermsLocal: [] as string[],
  converge,
};
const pushList = (r: DbRow) =>
  r.kind === 'post' ? sel.pushPosts : r.kind === 'option' ? sel.pushOptions : sel.pushTerms;
const delRemote = (r: DbRow) =>
  r.kind === 'post'
    ? sel.deletePostsRemote
    : r.kind === 'option'
      ? sel.deleteOptionsRemote
      : sel.deleteTermsRemote;
const pullList = (r: DbRow) =>
  r.kind === 'post' ? sel.pullPosts : r.kind === 'option' ? sel.pullOptions : sel.pullTerms;
const delLocal = (r: DbRow) =>
  r.kind === 'post'
    ? sel.deletePostsLocal
    : r.kind === 'option'
      ? sel.deleteOptionsLocal
      : sel.deleteTermsLocal;
for (const r of dbRows) {
  if (r.change === 'push' && r.selected) pushList(r).push(r.id);
  else if (r.change === 'delete-remote' && r.selected) delRemote(r).push(r.id);
  else if (r.change === 'keep') pullList(r).push(r.id);
  else if (r.change === 'keep-deleted') delLocal(r).push(r.id);
  else if (r.change === 'conflict' && r.resolution === 'mine') {
    // mine wins: my edit (or my new row) goes up; my deletion deletes remotely
    if (r.conflictKind === 'delete-edit') delRemote(r).push(r.id);
    else pushList(r).push(r.id);
  } else if (r.change === 'conflict' && r.resolution === 'theirs') {
    // theirs wins: local converges to their version (or their deletion)
    if (r.conflictKind === 'edit-delete') delLocal(r).push(r.id);
    else pullList(r).push(r.id);
  }
}

const result = await ipcRenderer.invoke('kinsta:push', site.id, site, envInfo, {
  includeDatabase,
  includeUploads,
  kinstaBackup,
  mode,
  ...(includeDatabase ? { dbMode, ...(dbMode === 'merge' ? { dbSelections: sel } : {}) } : {}),
  ...(allSelected && mode === 'all'
    ? {}
    : {
        files: selectedRows.filter((r) => r.op !== 'delete').map((r) => r.path),
        deletions: selectedRows.filter((r) => r.op === 'delete').map((r) => r.path),
      }),
});
```

- [ ] **Step 2: Update the confirm modal copy**

Replace the `includeDatabase && …database will be replaced…` sentence (line ~607):

```tsx
{
  includeDatabase && dbMode === 'overwrite' && (
    <>
      The {isLive ? 'production' : 'staging'} database will be replaced with your local
      database.{' '}
    </>
  );
}
{
  includeDatabase && dbMode === 'merge' && (
    <>
      Database: {sel === undefined ? '' : ''}
      {
        dbRows.filter(
          (r) =>
            (r.change === 'push' && r.selected) ||
            (r.change === 'conflict' && r.resolution === 'mine'),
        ).length
      }{' '}
      change(s) will be merged into the {isLive ? 'production' : 'staging'} database — their other
      changes are kept.{' '}
    </>
  );
}
```

(Compute the counts from `dbRows` directly — `sel` only exists inside `executePush`.)

- [ ] **Step 3: Build + full verification via CDP (read-only)**

`npm run build`, restart Local with the debug port (main-process changes!). Against
GBD Shop staging: open push screen → Database tab shows real classified rows (the
dry-run preview is read-only and allowed) → resolve a fake conflict in the UI →
verify the confirm modal copy. **Do NOT press the final push button.**

- [ ] **Step 4: Run the full test suite**

Run: `npm test` — all PASS. Run `npm run build` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/KinstaPushScreen.tsx
git commit -m "Wire database merge selections into the push flow"
```

---

### Task 12: Docs + finish

**Files:**

- Modify: `CLAUDE.md` (architecture section: dbMerge.ts, dbMergePhp.ts, dbPreview handler, baseline storage, merge pipeline, convergence, auto-increment offset)
- Modify: `README.md` (Features bullet, "What a sync does" merge paragraph, Safety nets: baseline + local backup + rollback, Troubleshooting: first-run banner)

- [ ] **Step 1: Update CLAUDE.md** — add to Data Storage: `baselines/` dir; add to Main Process: the merge pipeline summary (snapshot PHP via `wp eval-file -`, three-way classifier, convergence, baseline-from-remote-after-merge, auto-increment +100000 after pull); renderer: PushDatabaseTab.

- [ ] **Step 2: Update README.md** — Features: "**Database merge on push** — three-way diff of pages, options and categories against the last sync; their changes survive, conflicts are resolved per row, and your local database converges with theirs." Plus What-a-sync-does and Safety-nets updates.

- [ ] **Step 3: Full verification**

```bash
npm run build && npm test
```

All green. CDP screenshot pass over both tabs.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "Document the database merge push"
```

---

## Self-review notes (already applied)

- Classifier skip-cases (`identical hashes`, `deleted/deleted`) covered by tests.
- `rowKeyPropName` collision between kinds fixed via composite `key` field (Task 10).
- Remote search-replace quoting: domains pass `validateEnvironmentInfo`/`isValidDomain`
  before reaching the ssh command string (same trust level as existing push code).
- `cleanupTempFiles()` only touches `TEMP_DIR/*.sql` — baselines live in
  `CONFIG_DIR/baselines/*.json`, safe. Note the local backup `*-pre-merge-backup.sql`
  IS in TEMP_DIR and is deleted on app restart — same policy as the pre-pull backup.
- Multisite guarded in `kinsta:dbPreview` (error) and never offered selections.
