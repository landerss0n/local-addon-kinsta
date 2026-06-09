import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  executePull,
  executePush,
  CancelledError,
  EnvironmentInfo,
  SiteInfo,
  SyncOptions,
  SyncParams,
  PullPushDeps,
  ActiveSync,
  RunOptions,
  RsyncInfo,
} from './index';

// ---------------------------------------------------------------------------
// Integration test net around executePull / executePush.
//
// The orchestration is exercised end-to-end with injected seams: a fake command
// runner that matches on the command name/args (no real spawn), an in-memory
// site-link store, fake binary paths, a fake Kinsta API client, and a real `fs`
// pointed at an os.tmpdir() sandbox. No network, no spawned processes.
//
// The fake runner can simulate rsync progress, write the SQL dump files the
// orchestration size-checks, and fail or cancel at a chosen step — which lets us
// assert the rollback/abort paths that are otherwise impossible to reach in CI.
// ---------------------------------------------------------------------------

const SITE_ID = 'site-1';

// Classify a runCommand call into a stable step label used for assertions and
// for failAt/cancelAt matching. Mirrors the actual commands the code issues.
function describeStep(cmd: string, args: string[], opts: RunOptions): string {
  const base = cmd.split('/').pop() || cmd;
  if (base === 'rsync') return 'rsync';
  if (base === 'mysqldump') return 'mysqldump';
  if (base === 'mysql') {
    return (opts.stdinFile || '').includes('pre-pull-backup') ? 'mysql-restore' : 'mysql-import';
  }
  if (base === 'php') return args.includes('search-replace') ? 'local-search-replace' : 'php';
  if (base === 'scp') return 'scp';
  if (base === 'ssh') {
    const remote = args[args.length - 1] || '';
    if (remote.includes('wp db export') && remote.includes('pre-push-backup'))
      return 'remote-backup-export';
    if (remote.includes('wp db export')) return 'remote-db-export';
    if (remote.includes('wc -c')) return 'remote-backup-wc';
    if (remote.includes('wp db import') && remote.includes('pre-push-backup'))
      return 'remote-db-restore';
    if (remote.includes('wp db import')) return 'remote-db-import';
    if (remote.includes('wp search-replace')) return 'remote-search-replace';
    if (remote.includes('rm -rf')) return 'remote-rm';
    if (remote.includes('rm -f')) return 'remote-cleanup';
    return 'ssh';
  }
  return base;
}

interface FakeRunnerConfig {
  failAt?: string;
  cancelAt?: string;
  // Bytes written for any stdoutFile (mysqldump). <200 makes a backup "invalid".
  stdoutBytes?: number;
  // What `wc -c < backup` reports on the remote (push backup size check).
  remoteBackupWc?: string;
}

interface RecordedCall {
  step: string;
  cmd: string;
  args: string[];
  opts: RunOptions;
}

function makeFakeRunner(cfg: FakeRunnerConfig = {}) {
  const calls: RecordedCall[] = [];
  const run = async (sync: ActiveSync, cmd: string, args: string[], opts: RunOptions = {}) => {
    // Faithful to runCommand's contract: a cancelled sync rejects everything.
    if (sync.cancelled) throw new CancelledError();
    const step = describeStep(cmd, args, opts);
    calls.push({ step, cmd, args, opts });

    if (cfg.cancelAt === step) {
      sync.cancelled = true;
      throw new CancelledError();
    }
    if (cfg.failAt === step) {
      throw new Error(`fake failure at ${step}`);
    }

    // Simulate rsync --info=progress2 output so the parser advances progress.
    if (step === 'rsync' && opts.onStdout) {
      opts.onStdout('   1,234,567  42%   1.00MB/s    0:00:01');
    }
    // Remote backup size check reads `wc -c` over stdout.
    if (step === 'remote-backup-wc' && opts.onStdout) {
      opts.onStdout(`${cfg.remoteBackupWc ?? '5000'}\n`);
    }
    // mysqldump / wp db export to a local file → materialize a dump so the
    // size-check (isLikelyValidSqlDump) sees a real file.
    if (opts.stdoutFile) {
      fs.writeFileSync(opts.stdoutFile, 'x'.repeat(cfg.stdoutBytes ?? 500));
    }
    return { code: 0, stderr: '' };
  };
  return { run, calls };
}

const steps = (calls: RecordedCall[]) => calls.map((c) => c.step);

// --- sandbox + deps wiring ---------------------------------------------------

let sandbox: string;
let tempDir: string;
let socketPath: string;
let sitePath: string;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'kinsta-sync-it-'));
  tempDir = path.join(sandbox, 'tmp');
  fs.mkdirSync(tempDir, { recursive: true });

  // MySQL socket file — its mere existence satisfies the pre-flight check.
  socketPath = path.join(sandbox, 'mysqld.sock');
  fs.writeFileSync(socketPath, '');

  // Local site with a wp-config.php containing a DB_HOST define (the pull
  // search-replace step rewrites it temporarily, then restores it).
  sitePath = path.join(sandbox, 'site');
  const publicPath = path.join(sitePath, 'app', 'public');
  fs.mkdirSync(publicPath, { recursive: true });
  fs.writeFileSync(
    path.join(publicPath, 'wp-config.php'),
    "<?php\ndefine('DB_HOST', 'localhost');\n",
  );
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const FAKE_RSYNC: RsyncInfo = {
  bin: 'rsync',
  supportsProgress2: true,
  supportsProgress: true,
  supportsItemizeChanges: true,
  supportsOutFormat: true,
};

const envInfo = (overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo => ({
  envId: 'env-1',
  envType: 'live',
  sshHost: '35.1.2.3',
  sshPort: '12345',
  sshUser: 'gbdbutik',
  remoteDomain: 'gbdbutik.se',
  ...overrides,
});

const site = (): SiteInfo => ({
  id: SITE_ID,
  name: 'GBD Shop',
  path: sitePath,
  domain: 'gbdshop.local',
  mysql: { database: 'local', user: 'root', password: 'root' },
});

const fakeClient = {} as any;

interface DepsOverrides extends Partial<PullPushDeps> {
  runner?: { run: PullPushDeps['runCommand']; calls: RecordedCall[] };
}

function makeDeps(overrides: DepsOverrides = {}): {
  deps: PullPushDeps;
  calls: RecordedCall[];
  progress: any[];
  notify: ReturnType<typeof vi.fn>;
  recordSync: ReturnType<typeof vi.fn>;
} {
  const runner = overrides.runner ?? makeFakeRunner();
  const progress: any[] = [];
  const notify = vi.fn();
  const recordSync = vi.fn();

  const deps: PullPushDeps = {
    fs,
    runCommand: runner.run,
    activeSyncs: new Map(),
    activePreviews: new Map(),
    loadSiteLinks: () => ({
      [SITE_ID]: {
        localSiteId: SITE_ID,
        kinstaSiteId: 'ksite-1',
        kinstaSiteName: 'GBD Shop',
        kinstaSiteSlug: 'gbdbutik',
      },
    }),
    validateEnvironmentInfo: () => true,
    getMysqlSocketPath: () => socketPath,
    preflightRemote: async () => null,
    resolveRsync: () => FAKE_RSYNC,
    findServiceBinary: (_prefixes, bin) => `/fake/bin/${bin}`,
    findWpCliPhar: () => '/fake/wp-cli.phar',
    getApiKey: () => 'fake-key',
    getKinstaClient: () => fakeClient,
    createKinstaBackup: async () => true,
    clearKinstaCaches: async () => ['page'],
    recordSync,
    notify,
    ensureConfigDir: () => fs.mkdirSync(tempDir, { recursive: true }),
    tempDir,
    sendProgress: (p) => progress.push(p),
    ...overrides,
  };

  return { deps, calls: runner.calls, progress, notify, recordSync };
}

const pullParams = (options: SyncOptions = { includeDatabase: true }): SyncParams => ({
  localSiteId: SITE_ID,
  site: site(),
  envInfo: envInfo(),
  options,
});

const pushParams = (
  options: SyncOptions = { includeDatabase: true, kinstaBackup: true },
): SyncParams => ({
  localSiteId: SITE_ID,
  site: site(),
  envInfo: envInfo(),
  options,
});

// ---------------------------------------------------------------------------

describe('executePull', () => {
  it('happy path: files + DB + search-replace, records + notifies success', async () => {
    const { deps, calls, progress, notify, recordSync } = makeDeps();
    const result = await executePull(pullParams(), deps);

    expect(result).toEqual({ success: true, warning: null });

    const labels = steps(calls);
    expect(labels).toContain('rsync');
    expect(labels).toContain('mysqldump'); // pre-pull local backup
    expect(labels).toContain('remote-db-export');
    expect(labels).toContain('scp');
    expect(labels).toContain('mysql-import');
    expect(labels).toContain('local-search-replace');
    expect(labels).not.toContain('mysql-restore'); // no rollback on success

    // rsync progress was parsed and surfaced
    expect(progress.some((p) => p.stage === 'files' && /42%/.test(p.message))).toBe(true);
    expect(progress.some((p) => p.stage === 'done' && p.progress === 100)).toBe(true);

    expect(recordSync).toHaveBeenCalledWith(SITE_ID, 'pull', 'live', expect.any(Number));
    expect(notify).toHaveBeenCalledWith('Kinsta Sync', expect.stringContaining('Pull complete'));

    // wp-config.php restored to its original content
    const wpConfig = fs.readFileSync(path.join(sitePath, 'app', 'public', 'wp-config.php'), 'utf8');
    expect(wpConfig).toContain("define('DB_HOST', 'localhost')");
    expect(wpConfig).not.toContain(socketPath);
    expect(deps.activeSyncs.size).toBe(0); // unregistered in finally
  });

  it('import failure rolls back the local DB from the pre-pull backup', async () => {
    const { deps, calls, notify } = makeDeps({
      runner: makeFakeRunner({ failAt: 'mysql-import' }),
    });
    const result = await executePull(pullParams(), deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('fake failure at mysql-import');
    expect(steps(calls)).toContain('mysql-restore'); // local DB restored
    expect(notify).toHaveBeenCalledWith(
      'Kinsta Sync',
      expect.stringContaining('was restored from backup'),
    );
    expect(deps.activeSyncs.size).toBe(0);
  });

  it('cancel during import triggers rollback and reports cancelled', async () => {
    const { deps, calls } = makeDeps({ runner: makeFakeRunner({ cancelAt: 'mysql-import' }) });
    const result = await executePull(pullParams(), deps);

    expect(result).toMatchObject({ success: false, cancelled: true });
    // Restore runs on a FRESH ActiveSync even though the original was cancelled
    expect(steps(calls)).toContain('mysql-restore');
  });

  it('aborts before import when the local backup looks empty/truncated', async () => {
    const { deps, calls } = makeDeps({ runner: makeFakeRunner({ stdoutBytes: 10 }) });
    const result = await executePull(pullParams(), deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('backup looks invalid');
    const labels = steps(calls);
    expect(labels).toContain('mysqldump');
    expect(labels).not.toContain('mysql-import'); // never overwrote the DB
    expect(labels).not.toContain('mysql-restore'); // nothing to roll back
  });

  it('aborts when the remote pre-flight fails, before registering a sync', async () => {
    const { deps, calls } = makeDeps({
      preflightRemote: async () => 'Could not reach Kinsta over SSH',
    });
    const result = await executePull(pullParams(), deps);

    expect(result).toEqual({ success: false, error: 'Could not reach Kinsta over SSH' });
    expect(calls).toHaveLength(0); // nothing ran
    expect(deps.activeSyncs.size).toBe(0);
  });

  it('refuses to start when a sync is already running for the site', async () => {
    const { deps, calls } = makeDeps();
    deps.activeSyncs.set(SITE_ID, { cancelled: false, child: null });

    const result = await executePull(pullParams(), deps);

    expect(result).toEqual({ success: false, error: 'A sync is already running for this site' });
    expect(calls).toHaveLength(0);
  });
});

describe('executePush', () => {
  it('happy path: Kinsta backup + files + DB + search-replace + cache clear', async () => {
    const createKinstaBackup = vi.fn(async () => true);
    const clearKinstaCaches = vi.fn(async () => ['page', 'edge']);
    const { deps, calls, progress, notify, recordSync } = makeDeps({
      createKinstaBackup,
      clearKinstaCaches,
    });
    const result = await executePush(pushParams(), deps);

    expect(result).toEqual({ success: true, warning: null });

    const labels = steps(calls);
    expect(labels).toContain('remote-backup-export'); // remote DB backup
    expect(labels).toContain('remote-backup-wc'); // size verified
    expect(labels).toContain('rsync');
    expect(labels).toContain('mysqldump'); // local export
    expect(labels).toContain('scp');
    expect(labels).toContain('remote-db-import');
    expect(labels).toContain('remote-search-replace');
    expect(labels).not.toContain('remote-db-restore'); // no rollback on success

    expect(createKinstaBackup).toHaveBeenCalledOnce();
    expect(clearKinstaCaches).toHaveBeenCalledOnce();
    expect(recordSync).toHaveBeenCalledWith(SITE_ID, 'push', 'live', expect.any(Number));
    expect(notify).toHaveBeenCalledWith('Kinsta Sync', expect.stringContaining('Push complete'));
    expect(progress.some((p) => p.stage === 'done' && p.progress === 100)).toBe(true);
    expect(deps.activeSyncs.size).toBe(0);
  });

  it('import failure rolls back the remote DB from the pre-push backup', async () => {
    const { deps, calls, notify } = makeDeps({
      runner: makeFakeRunner({ failAt: 'remote-db-import' }),
    });
    const result = await executePush(pushParams(), deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('fake failure at remote-db-import');
    expect(steps(calls)).toContain('remote-db-restore'); // remote DB restored
    expect(notify).toHaveBeenCalledWith(
      'Kinsta Sync',
      expect.stringContaining('was restored from backup'),
    );
  });

  it('aborts the push (no destructive step) when the Kinsta backup fails', async () => {
    const createKinstaBackup = vi.fn(async () => {
      throw new Error('Kinsta API 500');
    });
    const { deps, calls } = makeDeps({ createKinstaBackup });
    const result = await executePush(pushParams(), deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Kinsta backup failed — push aborted');
    const labels = steps(calls);
    expect(labels).not.toContain('rsync'); // never touched files
    expect(labels).not.toContain('remote-db-import');
    expect(labels).not.toContain('remote-db-restore');
  });

  it('aborts before any change when the remote backup looks empty/truncated', async () => {
    const { deps, calls } = makeDeps({ runner: makeFakeRunner({ remoteBackupWc: '0' }) });
    const result = await executePush(pushParams(), deps);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Remote database backup looks invalid');
    const labels = steps(calls);
    expect(labels).toContain('remote-backup-wc');
    expect(labels).not.toContain('rsync'); // server untouched
    expect(labels).not.toContain('remote-db-import');
  });

  it('refuses to start when a sync is already running for the site', async () => {
    const { deps, calls } = makeDeps();
    deps.activeSyncs.set(SITE_ID, { cancelled: false, child: null });

    const result = await executePush(pushParams(), deps);

    expect(result).toEqual({ success: false, error: 'A sync is already running for this site' });
    expect(calls).toHaveLength(0);
  });
});
