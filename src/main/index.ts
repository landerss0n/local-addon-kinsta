// Type-only imports — keeps this module importable outside Electron (tests)
import type { AddonMainContext } from '@getflywheel/local/main';
import type * as Local from '@getflywheel/local';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import axios, { AxiosInstance } from 'axios';
import type { IpcMainInvokeEvent, SafeStorage } from 'electron';

const KINSTA_API_BASE = 'https://api.kinsta.com/v2';

// Legacy config location (pre userDataPath migration)
const LEGACY_CONFIG_DIR = path.join(os.homedir(), '.kinsta-sync');

// Set from context in the exported entry point
let safeStorage: SafeStorage | null = null;
let notifier: AddonMainContext['notifier'] | null = null;
let userDataPath = '';
let appPath = '';

// Config paths — resolved once userDataPath is known
let CONFIG_DIR = LEGACY_CONFIG_DIR;
let CONFIG_FILE = '';
let KEY_FILE = '';
let SITES_FILE = '';
let TEMP_DIR = '';

function resolveConfigPaths(): void {
  // Store under Local's own user data dir (idiomatic per the Context API)
  CONFIG_DIR = userDataPath
    ? path.join(userDataPath, 'addons-data', 'kinsta-sync')
    : LEGACY_CONFIG_DIR;
  CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
  KEY_FILE = path.join(CONFIG_DIR, '.api-key.enc');
  SITES_FILE = path.join(CONFIG_DIR, 'sites.json');
  TEMP_DIR = path.join(CONFIG_DIR, 'tmp');
}

// One-time migration from ~/.kinsta-sync to userDataPath.
// IMPORTANT: the legacy dir is renamed away afterwards — if it stays, every
// startup would re-copy "missing" files and resurrect deleted credentials
// (e.g. the API key after a disconnect).
function migrateLegacyConfig(): void {
  if (CONFIG_DIR === LEGACY_CONFIG_DIR) return;
  if (!fs.existsSync(LEGACY_CONFIG_DIR)) return;
  ensureConfigDir();
  for (const file of ['config.json', '.api-key.enc', 'sites.json']) {
    const from = path.join(LEGACY_CONFIG_DIR, file);
    const to = path.join(CONFIG_DIR, file);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.copyFileSync(from, to);
      console.log(`[Kinsta] Migrated ${file} to ${CONFIG_DIR}`);
    }
  }
  // Keep the old dir as a backup, but make sure migration never runs again
  try {
    fs.renameSync(LEGACY_CONFIG_DIR, `${LEGACY_CONFIG_DIR}.migrated`);
    console.log('[Kinsta] Legacy config dir renamed to ~/.kinsta-sync.migrated');
  } catch (e) {
    console.error('[Kinsta] Could not rename legacy config dir:', e);
  }
}

// Files/folders to exclude during sync
export const EXCLUDE_PATTERNS = [
  '.git',
  '.git/',
  'node_modules/',
  '.DS_Store',
  '*.log',
  '.env',
  '.sass-cache/',
  'cache/',
  '.cache/',
  '/vendor/',
  '*.sql',
  '*.sql.gz',
  '.idea/',
  '.vscode/',
  'Thumbs.db',
  'wp-config.php',
  '.htaccess',
  'php.ini',
  '.user.ini',
  'wp-content/mu-plugins/kinsta-mu-plugins/',
  'wp-content/mu-plugins/kinsta-mu-plugins.php'
];

interface KinstaConfig {
  companyId?: string;
}

interface SyncHistoryEntry {
  mode: 'pull' | 'push';
  envType: string;             // 'live' | 'staging'
  at: string;                  // ISO timestamp
  durationMs: number;
}

interface SiteLink {
  localSiteId: string;
  kinstaSiteId: string;
  kinstaSiteName: string;      // Display name for UI
  kinstaSiteSlug: string;      // Actual site name for SSH username
  lastPullAt?: string;         // ISO timestamp of last successful pull
  lastPushAt?: string;         // ISO timestamp of last successful push
  history?: SyncHistoryEntry[]; // Most recent first, capped
}

const HISTORY_LIMIT = 10;

export interface EnvironmentInfo {
  envId: string;
  envType: 'staging' | 'live';
  sshHost: string;
  sshPort: string;
  sshUser: string;
  remoteDomain: string;
  cdnCacheId?: string;  // needed for CDN cache clearing (from env.cdn_cache_id)
}

interface SyncProgress {
  stage: string;
  progress: number;
  message: string;
}

interface SyncOptions {
  includeUploads?: boolean;
  includeDatabase?: boolean;
  // Push only: create a native Kinsta backup (files + DB) before pushing
  kinstaBackup?: boolean;
  // Push only (from the preview screen): sync mode + selective file lists.
  // When `files` is present the rsync runs with --files-from and WITHOUT
  // --delete; `deletions` are executed separately so unchecked deletions
  // are preserved on the remote.
  mode?: 'newer' | 'all';
  files?: string[];
  deletions?: string[];
}

// The subset of Local.SiteJSON we actually use (full object arrives over IPC)
export interface SiteInfo {
  id: string;
  name?: string;
  path: string;
  domain: string;
  multiSite?: Local.SiteJSON['multiSite'];
  mysql?: { database?: string; user?: string; password?: string };
}

// Config helpers
function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function loadConfig(): KinstaConfig {
  ensureConfigDir();
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  }
  return {};
}

function saveConfig(config: KinstaConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// Secure API key storage using Electron's safeStorage
function getApiKey(): string | null {
  if (!fs.existsSync(KEY_FILE)) {
    return null;
  }
  try {
    const encryptedData = fs.readFileSync(KEY_FILE);
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(encryptedData);
    }
    // Security: Don't read unencrypted keys
    console.error('Cannot read API key: encryption not available');
    return null;
  } catch (e) {
    return null;
  }
}

function saveApiKey(apiKey: string): boolean {
  ensureConfigDir();
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(apiKey);
      fs.writeFileSync(KEY_FILE, encrypted);
      // Set restrictive permissions
      fs.chmodSync(KEY_FILE, 0o600);
      return true;
    } else {
      // Security: Refuse to save if encryption is not available
      console.error('Cannot save API key: encryption not available');
      return false;
    }
  } catch (e) {
    console.error('Failed to save API key:', e);
    return false;
  }
}

function deleteApiKey(): void {
  if (fs.existsSync(KEY_FILE)) {
    fs.unlinkSync(KEY_FILE);
  }
}

function loadSiteLinks(): Record<string, SiteLink> {
  ensureConfigDir();
  if (fs.existsSync(SITES_FILE)) {
    return JSON.parse(fs.readFileSync(SITES_FILE, 'utf8'));
  }
  return {};
}

function saveSiteLinks(links: Record<string, SiteLink>): void {
  ensureConfigDir();
  fs.writeFileSync(SITES_FILE, JSON.stringify(links, null, 2));
}

function recordSync(localSiteId: string, mode: 'pull' | 'push', envType: string, durationMs: number): void {
  const links = loadSiteLinks();
  const link = links[localSiteId];
  if (!link) return;
  const at = new Date().toISOString();
  if (mode === 'pull') {
    link.lastPullAt = at;
  } else {
    link.lastPushAt = at;
  }
  link.history = [
    { mode, envType, at, durationMs },
    ...(link.history || []),
  ].slice(0, HISTORY_LIMIT);
  saveSiteLinks(links);
}

// Security: Validate SSH/shell values to prevent command injection
export function isValidHostname(host: string): boolean {
  // Allow IP addresses and hostnames
  const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  return hostnameRegex.test(host) || ipRegex.test(host);
}

export function isValidPort(port: string): boolean {
  // Digits only — parseInt alone would accept "22 -oProxyCommand=..." which
  // gets word-split inside rsync's -e "ssh -p <port> ..." remote shell string
  if (!/^\d{1,5}$/.test(port)) return false;
  const portNum = parseInt(port, 10);
  return portNum > 0 && portNum <= 65535;
}

export function isValidUsername(user: string): boolean {
  // SSH usernames: alphanumeric, underscores, hyphens
  return /^[a-zA-Z0-9_-]+$/.test(user);
}

export function isValidDomain(domain: string): boolean {
  // Domain names: alphanumeric, dots, hyphens (allow single char and be more lenient)
  if (!domain || domain.length === 0) return false;
  // Just check for dangerous shell characters
  return !/[;&|`$"'\\<>(){}[\]!#*?]/.test(domain);
}

export function validateEnvironmentInfo(env: EnvironmentInfo): boolean {
  return (
    isValidHostname(env.sshHost) &&
    isValidPort(env.sshPort) &&
    isValidUsername(env.sshUser) &&
    isValidDomain(env.remoteDomain)
  );
}

// Expand ~ to home directory
export function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

// Security: Clean up old temp files on startup
function cleanupTempFiles(): void {
  if (!fs.existsSync(TEMP_DIR)) return;

  try {
    const files = fs.readdirSync(TEMP_DIR);
    for (const file of files) {
      if (file.endsWith('.sql')) {
        const filePath = path.join(TEMP_DIR, file);
        try {
          fs.unlinkSync(filePath);
          console.log(`[Kinsta] Cleaned up temp file: ${file}`);
        } catch (e) {
          // Ignore cleanup errors
        }
      }
    }
  } catch (e) {
    // Ignore errors
  }
}

// ---------------------------------------------------------------------------
// Local-installation paths (derived from the Context API, not hardcoded)
// ---------------------------------------------------------------------------

function getServicesPath(): string {
  return path.join(userDataPath, 'lightning-services');
}

function getMysqlSocketPath(localSiteId: string): string {
  return path.join(userDataPath, 'run', localSiteId, 'mysql', 'mysqld.sock');
}

// Find a binary (mysql/mysqldump/php) inside Local's lightning-services
function findServiceBinary(prefixes: string[], binName: string): string | null {
  const servicesPath = getServicesPath();
  if (!fs.existsSync(servicesPath)) return null;
  const dirs = fs.readdirSync(servicesPath)
    .filter(d => prefixes.some(p => d.startsWith(p)))
    .sort()
    .reverse();
  const archDirs = process.arch === 'arm64'
    ? [`${process.platform}-arm64`, `${process.platform}-x64`]
    : [`${process.platform}-x64`, `${process.platform}-arm64`];
  for (const dir of dirs) {
    for (const archDir of archDirs) {
      const candidate = path.join(servicesPath, dir, 'bin', archDir, 'bin', binName);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function findWpCliPhar(): string | null {
  const candidates = [
    // appPath is typically <App>/Contents/Resources/app.asar
    appPath && path.resolve(appPath, '..', 'extraResources', 'bin', 'wp-cli', 'wp-cli.phar'),
    appPath && path.resolve(appPath, '..', '..', 'extraResources', 'bin', 'wp-cli', 'wp-cli.phar'),
    (process as any).resourcesPath && path.join((process as any).resourcesPath, 'extraResources', 'bin', 'wp-cli', 'wp-cli.phar'),
    '/Applications/Local.app/Contents/Resources/extraResources/bin/wp-cli/wp-cli.phar',
  ].filter(Boolean) as string[];
  return candidates.find(c => fs.existsSync(c)) || null;
}

// ---------------------------------------------------------------------------
// Async command runner with cancellation support
// ---------------------------------------------------------------------------

class CancelledError extends Error {
  constructor() {
    super('Sync cancelled');
    this.name = 'CancelledError';
  }
}

interface ActiveSync {
  cancelled: boolean;
  child: ChildProcess | null;
}

// One active sync per Local site
const activeSyncs = new Map<string, ActiveSync>();
// In-flight push-preview dry-runs (kept separate: previews never block syncs,
// but a re-fired preview kills its predecessor)
const activePreviews = new Map<string, ActiveSync>();

interface RunOptions {
  // Pipe this file into the process' stdin (e.g. mysql < dump.sql)
  stdinFile?: string;
  // Pipe the process' stdout into this file (e.g. mysqldump > dump.sql)
  stdoutFile?: string;
  // Called for every stdout chunk (e.g. rsync progress parsing)
  onStdout?: (chunk: string) => void;
  env?: NodeJS.ProcessEnv;
  // Extra exit codes to treat as success (e.g. rsync 23/24 = partial transfer).
  // The caller can inspect the resolved { code, stderr } to warn about them.
  okCodes?: number[];
}

// Spawn without a shell (no injection surface), collect stderr for real error
// messages, and register the child so the sync can be cancelled.
function runCommand(sync: ActiveSync, cmd: string, args: string[], opts: RunOptions = {}): Promise<{ code: number; stderr: string }> {
  if (sync.cancelled) return Promise.reject(new CancelledError());

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: opts.env || process.env,
      stdio: [opts.stdinFile ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    sync.child = child;

    let stderrTail = '';
    let settled = false;

    if (opts.stdinFile) {
      const input = fs.createReadStream(opts.stdinFile);
      input.on('error', (err) => { if (!settled) { settled = true; child.kill(); reject(err); } });
      input.pipe(child.stdin!);
    }

    let output: fs.WriteStream | null = null;
    if (opts.stdoutFile) {
      output = fs.createWriteStream(opts.stdoutFile);
      output.on('error', (err) => { if (!settled) { settled = true; child.kill(); reject(err); } });
      child.stdout!.pipe(output);
    } else {
      child.stdout!.on('data', (d: Buffer) => {
        opts.onStdout?.(d.toString());
      });
    }

    child.stderr!.on('data', (d: Buffer) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });

    child.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });

    child.on('close', (code) => {
      sync.child = null;
      output?.end();
      if (settled) return;
      settled = true;
      if (sync.cancelled) {
        reject(new CancelledError());
      } else if (code === 0 || (code !== null && opts.okCodes?.includes(code))) {
        resolve({ code: code ?? 0, stderr: stderrTail });
      } else {
        const detail = stderrTail.trim().split('\n').slice(-5).join('\n');
        reject(new Error(`${path.basename(cmd)} exited with code ${code}${detail ? `:\n${detail}` : ''}`));
      }
    });
  });
}

// Human-readable warning for an rsync partial transfer (exit 23/24), or null
// for a clean run. Typical cause: filenames in a legacy encoding (Latin-1 åäö)
// that macOS refuses ("Illegal byte sequence") — fixable only by renaming the
// files on the server.
export function describePartialTransfer(result: { code: number; stderr: string }): string | null {
  if (result.code === 0) return null;
  const failed = (result.stderr.match(/failed:|cannot /g) || []).length;
  console.warn('[Kinsta] rsync partial transfer (code', result.code, '):', result.stderr.slice(-2000));
  return `${failed || 'Some'} file(s) were skipped — usually filenames in a legacy encoding (e.g. Latin-1 åäö) that macOS cannot store. Rename those files on the server to fix. Everything else synced.`;
}

export function sshArgs(envInfo: EnvironmentInfo, remoteCmd: string): string[] {
  return [
    '-p', envInfo.sshPort,
    '-o', 'StrictHostKeyChecking=accept-new',
    `${envInfo.sshUser}@${envInfo.sshHost}`,
    remoteCmd,
  ];
}

// macOS no longer ships GNU rsync: newer versions bundle openrsync, older ones
// rsync 2.6.9 — neither supports --info=progress2 (GNU >= 3.1). Version sniffing
// is unreliable across implementations, so we capability-probe each flag:
// `rsync <flag> --version` exits 0 only if the flag is recognized.
// Prefer a Homebrew/GNU rsync when installed.
export interface RsyncInfo {
  bin: string;
  supportsProgress2: boolean;
  supportsProgress: boolean;
  // Needed for the push preview (dry-run diff). openrsync lacks both —
  // the preview then degrades to a name-only list.
  supportsItemizeChanges: boolean;
  supportsOutFormat: boolean;
}

let cachedRsync: RsyncInfo | null = null;

function probeRsyncFlag(bin: string, flag: string): boolean {
  try {
    return spawnSync(bin, [flag, '--version'], { stdio: 'ignore' }).status === 0;
  } catch (e) {
    return false;
  }
}

export function resolveRsync(): RsyncInfo {
  if (cachedRsync) return cachedRsync;

  const candidates = ['/opt/homebrew/bin/rsync', '/usr/local/bin/rsync', '/usr/bin/rsync', 'rsync'];
  let fallback: RsyncInfo | null = null;

  for (const bin of candidates) {
    if (bin.startsWith('/') && !fs.existsSync(bin)) continue;
    try {
      if (spawnSync(bin, ['--version'], { stdio: 'ignore' }).status !== 0) continue;
    } catch (e) {
      continue;
    }
    const info: RsyncInfo = {
      bin,
      supportsProgress2: probeRsyncFlag(bin, '--info=progress2'),
      supportsProgress: probeRsyncFlag(bin, '--progress'),
      supportsItemizeChanges: probeRsyncFlag(bin, '--itemize-changes'),
      supportsOutFormat: probeRsyncFlag(bin, '--out-format=%n'),
    };
    if (info.supportsProgress2) {
      cachedRsync = info;
      return info;
    }
    fallback = fallback || info;
  }

  cachedRsync = fallback || {
    bin: 'rsync',
    supportsProgress2: false,
    supportsProgress: false,
    supportsItemizeChanges: false,
    supportsOutFormat: false,
  };
  return cachedRsync;
}

export function rsyncProgressArgs(rsync: RsyncInfo): string[] {
  if (rsync.supportsProgress2) return ['--info=progress2'];
  if (rsync.supportsProgress) return ['--progress'];
  return [];
}

// Parse rsync progress output into an overall percentage.
// - rsync >= 3.1 (--info=progress2): "  1,234,567  42%  ..." is overall — use directly.
// - rsync 2.6.9 (--progress): per-file % bounces, but "to-check=remaining/total"
//   after each file gives a stable overall estimate.
export function makeRsyncProgressParser(rsync: RsyncInfo, onPercent: (pct: number) => void): (chunk: string) => void {
  return (chunk: string) => {
    const toCheck = chunk.match(/to-check=(\d+)\/(\d+)/g);
    if (toCheck && toCheck.length) {
      const m = toCheck[toCheck.length - 1].match(/to-check=(\d+)\/(\d+)/)!;
      const remaining = parseInt(m[1], 10);
      const total = parseInt(m[2], 10);
      if (total > 0) onPercent(Math.round(((total - remaining) / total) * 100));
      return;
    }
    if (!rsync.supportsProgress2) return; // per-file % would bounce — skip
    const matches = chunk.match(/(\d{1,3})%/g);
    if (matches && matches.length) {
      const pct = parseInt(matches[matches.length - 1], 10);
      if (!isNaN(pct) && pct >= 0 && pct <= 100) onPercent(pct);
    }
  };
}

// Resolve DB credentials from the site object (with Local's defaults)
export function getDbCredentials(site: SiteInfo): { database: string; user: string; password: string } {
  return {
    database: site.mysql?.database || 'local',
    user: site.mysql?.user || 'root',
    password: site.mysql?.password || 'root',
  };
}

// WP-CLI search-replace passes covering https, http, and protocol-relative URLs
export function searchReplacePairs(fromDomain: string, toDomain: string): Array<[string, string]> {
  return [
    [`https://${fromDomain}`, `https://${toDomain}`],
    [`http://${fromDomain}`, `http://${toDomain}`],
    [`//${fromDomain}`, `//${toDomain}`],
  ];
}

// ---------------------------------------------------------------------------
// Push preview (rsync dry-run diff)
// ---------------------------------------------------------------------------

export interface PushDiffRow {
  path: string;          // relative to ~/public
  op: 'add' | 'update' | 'delete';
  isDir: boolean;
  sizeBytes: number;     // rsync %l; 0 for deletes/dirs/unknown
  localMtime?: number;   // epoch ms from rsync %M (add/update only)
}

// rsync %M prints the source file's mtime as "YYYY/MM/DD-HH:MM:SS" (local TZ)
function parseRsyncMtime(s: string): number | undefined {
  if (!s || !s.includes('/')) return undefined;
  const t = new Date(s.replace('-', ' ')).getTime();
  return Number.isNaN(t) ? undefined : t;
}

// Parse one line of `rsync -n --itemize-changes --out-format='%i|%l|%M|%n'`.
// The mtime comes from rsync itself (%M) — statting thousands of files in the
// Electron main process would block Local's whole UI.
// %i is the YXcstpoguax flag string:
//   *deleting        — file will be removed on the receiver (--delete)
//   <f+++++++++      — new file transferred to remote (push direction)
//   <f.st......      — existing file, size/time changed → update
//   cd+++++++++      — new directory
//   .f / .d ...      — attrs only, no transfer → skip
export function parseItemizeLine(line: string): PushDiffRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  // Deletions: with --out-format the line is "*deleting|<len>|<mtime>|<path>";
  // without it rsync prints "*deleting   path". Handle both.
  if (trimmed.startsWith('*deleting')) {
    const rest = trimmed.includes('|')
      ? trimmed.split('|').slice(3).join('|')               // %i|%l|%M|%n form
      : trimmed.slice('*deleting'.length).replace(/^\s+/, ''); // plain form
    if (!rest || rest === './') return null;
    const isDir = rest.endsWith('/');
    return { path: rest.replace(/\/$/, ''), op: 'delete', isDir, sizeBytes: 0 };
  }

  const parts = trimmed.split('|');
  if (parts.length < 4) return null; // rsync chatter ("sending incremental file list", totals, ...)
  const flags = parts[0];
  const sizeBytes = parseInt(parts[1], 10) || 0;
  const localMtime = parseRsyncMtime(parts[2]);
  const filePath = parts.slice(3).join('|'); // paths may legitimately contain '|'

  if (!filePath || filePath === './') return null;
  if (!/^[<>ch.*]/.test(flags) || flags.length < 2) return null;

  const changeType = flags[0];   // < > transfer, c create (dirs), . attrs-only, h hardlink
  const fileType = flags[1];     // f file, d dir, L symlink

  if (changeType === '.') return null; // attribute-only change — not content
  const isDir = fileType === 'd';
  const isNew = flags.slice(2).split('').every(c => c === '+');

  return {
    path: filePath.replace(/\/$/, ''),
    op: isNew ? 'add' : 'update',
    isDir,
    sizeBytes: isDir ? 0 : sizeBytes,
    ...(isDir ? {} : { localMtime }),
  };
}

export function parseItemizeOutput(stdout: string): PushDiffRow[] {
  return stdout.split('\n').map(parseItemizeLine).filter((r): r is PushDiffRow => r !== null);
}

// Degraded fallback for rsync builds without --itemize-changes/--out-format
// (openrsync): `rsync -n -v` prints one path per line plus "deleting X" lines.
// Cannot distinguish add vs update, has no sizes or mtimes.
export function parseVerboseDryRun(stdout: string): PushDiffRow[] {
  const rows: PushDiffRow[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line || line === './') continue;
    if (/^(sending|building|sent |total |created directory|receiving)/.test(line)) continue;
    if (line.startsWith('deleting ')) {
      const p = line.slice('deleting '.length);
      rows.push({ path: p.replace(/\/$/, ''), op: 'delete', isDir: p.endsWith('/'), sizeBytes: 0 });
    } else {
      rows.push({ path: line.replace(/\/$/, ''), op: 'update', isDir: line.endsWith('/'), sizeBytes: 0 });
    }
  }
  return rows;
}

// Security: the selective-push remote `rm` is the only place a file path enters
// an ssh remote-command STRING (everything else is spawn arg arrays). Strictly
// validate, then single-quote. Returns null when the path must be rejected.
export function safeRemoteRelPath(p: string): string | null {
  if (!p || p.length > 4096) return null;
  if (p.includes("'") || p.includes('\\')) return null;       // would escape the quoting
  if (p.includes('\n') || p.includes('\r') || p.includes('\0')) return null;
  if (p.startsWith('/') || p.startsWith('~')) return null;     // must stay relative
  if (p.split('/').some(seg => seg === '..' || seg === '')) return null; // no traversal, no '//'
  if (/[`$!;&<>(){}*?#]/.test(p)) return null;                 // defense in depth inside single quotes
  return `'${p}'`;
}

// Pure builder for the push rsync invocation so the flag logic is unit-testable.
// Selective pushes (files list) drop --delete: deletions are executed separately
// (per checked row) so unchecked deletions are preserved on the remote.
export function buildPushRsyncArgs(opts: {
  rsync: RsyncInfo;
  excludeArgs: string[];
  sshCommand: string;
  localPublicPath: string;
  remoteHost: string;
  mode?: 'newer' | 'all';
  filesFromPath?: string;
}): string[] {
  const args = ['-az'];
  if (opts.filesFromPath) {
    args.push(`--files-from=${opts.filesFromPath}`);
  } else {
    args.push('--delete');
  }
  if (opts.mode === 'newer') args.push('--update');
  args.push(...rsyncProgressArgs(opts.rsync), ...opts.excludeArgs);
  args.push('-e', opts.sshCommand, `${opts.localPublicPath}/`, `${opts.remoteHost}:~/public/`);
  return args;
}

// ---------------------------------------------------------------------------
// Kinsta native backups (max 5 manual slots per environment)
// ---------------------------------------------------------------------------

const KINSTA_BACKUP_TAG = 'kinsta-sync-pre-push';
const MANUAL_BACKUP_LIMIT = 5;

// Poll GET /operations/{id} until it reports 200 (done) — 202 means in progress
async function waitForKinstaOperation(client: AxiosInstance, operationId: string, sync: ActiveSync, timeoutMs = 10 * 60_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (sync.cancelled) throw new CancelledError();
    await new Promise(resolve => setTimeout(resolve, 3000));
    try {
      const res = await client.get(`/operations/${operationId}`);
      if ((res.data?.status ?? res.status) === 200) return;
      // 202 in body → keep polling
    } catch (e: any) {
      const httpStatus = e.response?.status;
      if (httpStatus === 500) {
        throw new Error(`Kinsta operation failed: ${e.response?.data?.message || 'unknown error'}`);
      }
      // 404 can appear briefly right after creation — keep polling
      if (!httpStatus) throw e;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for Kinsta backup operation');
    }
  }
}

// Create a native Kinsta backup (files + DB). Frees a slot by deleting the
// oldest backup WE created if all manual slots are taken — never touches the
// user's own backups. Returns false if no slot could be freed.
async function createKinstaBackup(client: AxiosInstance, envId: string, sync: ActiveSync, onMessage: (msg: string) => void): Promise<boolean> {
  const list = await client.get(`/sites/environments/${envId}/backups`);
  const backups: Array<{ id: number; name?: string; note?: string | null; type: string; created_at: number }> =
    list.data?.environment?.backups || [];
  const manual = backups.filter(b => b.type === 'manual');

  if (manual.length >= MANUAL_BACKUP_LIMIT) {
    const ours = manual
      .filter(b => (b.note || '').includes('kinsta-sync') || (b.name || '').includes('kinsta-sync'))
      .sort((a, b) => a.created_at - b.created_at);
    if (!ours.length) {
      // All slots hold the user's own backups — do not delete those
      return false;
    }
    onMessage('Freeing a Kinsta backup slot (removing our oldest)...');
    const del = await client.delete(`/sites/environments/backups/${ours[0].id}`);
    await waitForKinstaOperation(client, del.data.operation_id, sync);
  }

  onMessage('Creating Kinsta backup (files + database)...');
  const created = await client.post(`/sites/environments/${envId}/manual-backups`, { tag: KINSTA_BACKUP_TAG });
  await waitForKinstaOperation(client, created.data.operation_id, sync);
  return true;
}

function notify(title: string, message: string): void {
  try {
    notifier?.notify({ title, message });
  } catch (e) {
    // Notifications are best-effort
  }
}

// Dev convenience: Local only loads add-on bundles at app start, so watch the
// compiled renderer bundle and reload Local's windows when webpack rewrites it.
// Renderer changes hot-reload this way; main-process changes still need a full
// app restart (Electron cannot swap the main process at runtime).
function watchRendererBundle(electron: AddonMainContext['electron']): void {
  // __dirname is lib/main at runtime
  const rendererDir = path.resolve(__dirname, '..', 'renderer');
  if (!fs.existsSync(rendererDir)) return;

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    // Watch the directory (not the file) — webpack replaces the file inode
    fs.watch(rendererDir, (_event, filename) => {
      if (filename !== 'index.js') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          for (const win of electron.BrowserWindow.getAllWindows()) {
            win.webContents.reloadIgnoringCache();
          }
          console.log('[Kinsta] Renderer bundle changed — reloaded Local windows');
        } catch (e) {
          console.error('[Kinsta] Renderer reload failed:', e);
        }
      }, 400);
    });
  } catch (e) {
    console.error('[Kinsta] Could not watch renderer bundle:', e);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default function (context: AddonMainContext): void {
  const { electron, hooks } = context;
  const { ipcMain } = electron;

  // Initialize from the Context API
  safeStorage = electron.safeStorage;
  notifier = context.notifier;
  userDataPath = String(context.environment.userDataPath || '');
  appPath = String(context.environment.appPath || '');
  resolveConfigPaths();
  migrateLegacyConfig();

  // Security: Clean up any leftover temp files from previous sessions
  cleanupTempFiles();

  // Hot-reload Local's renderer when the compiled renderer bundle changes
  watchRendererBundle(electron);

  // Clean up stale links when a site is deleted in Local
  try {
    hooks.addAction('siteDeleted', (siteId: string) => {
      const links = loadSiteLinks();
      if (links[siteId]) {
        delete links[siteId];
        saveSiteLinks(links);
        console.log(`[Kinsta] Removed link for deleted site ${siteId}`);
      }
    });
  } catch (e) {
    console.error('[Kinsta] Could not register siteDeleted action:', e);
  }

  // Test API connection
  ipcMain.handle('kinsta:testConnection', async (_event: IpcMainInvokeEvent, apiKey: string, companyId: string) => {
    try {
      const client = getKinstaClient(apiKey);
      const response = await client.get(`/sites?company=${companyId}`);

      if (response.data.company) {
        // Save credentials securely
        const saved = saveApiKey(apiKey);
        if (!saved) {
          return { success: false, error: 'Could not save API key securely. Encryption not available.' };
        }
        // Note: the /sites response's `company` object only contains `sites` —
        // the Kinsta API has no endpoint that exposes the company name.
        saveConfig({ companyId });
        return { success: true, company: response.data.company };
      }
      return { success: false, error: 'Invalid response from Kinsta API' };
    } catch (error: any) {
      return { success: false, error: error.message || 'Connection failed' };
    }
  });

  // Get stored config (returns masked apiKey if exists)
  ipcMain.handle('kinsta:getConfig', async () => {
    const config = loadConfig();
    const hasApiKey = getApiKey() !== null;
    return { ...config, apiKey: hasApiKey ? '••••••••' : undefined };
  });

  // Get Kinsta sites
  ipcMain.handle('kinsta:getSites', async () => {
    const config = loadConfig();
    const apiKey = getApiKey();
    if (!apiKey || !config.companyId) {
      return { success: false, error: 'Not connected to Kinsta' };
    }

    try {
      const client = getKinstaClient(apiKey);
      const response = await client.get(`/sites?company=${config.companyId}`);
      return { success: true, sites: response.data.company?.sites || [] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Get environments for a site
  ipcMain.handle('kinsta:getEnvironments', async (_event: IpcMainInvokeEvent, siteId: string) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      return { success: false, error: 'Not connected' };
    }

    try {
      const client = getKinstaClient(apiKey);
      const response = await client.get(`/sites/${siteId}/environments`);
      return { success: true, environments: response.data.site?.environments || [] };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Link Local site to Kinsta (only stores site info, not environment)
  ipcMain.handle('kinsta:linkSite', async (_event: IpcMainInvokeEvent, localSiteId: string, kinstaSite: any) => {
    const links = loadSiteLinks();

    const link: SiteLink = {
      localSiteId,
      kinstaSiteId: kinstaSite.id,
      kinstaSiteName: kinstaSite.display_name || kinstaSite.name,
      kinstaSiteSlug: kinstaSite.name,  // The actual site name used for SSH
    };

    links[localSiteId] = link;
    saveSiteLinks(links);

    return { success: true, link };
  });

  // Get link for a Local site
  ipcMain.handle('kinsta:getSiteLink', async (_event: IpcMainInvokeEvent, localSiteId: string) => {
    const links = loadSiteLinks();
    return links[localSiteId] || null;
  });

  // Unlink site
  ipcMain.handle('kinsta:unlinkSite', async (_event: IpcMainInvokeEvent, localSiteId: string) => {
    const links = loadSiteLinks();
    delete links[localSiteId];
    saveSiteLinks(links);
    return { success: true };
  });

  // Clear all Kinsta caches for an environment (also used standalone from the page)
  ipcMain.handle('kinsta:clearCache', async (_event: IpcMainInvokeEvent, envId: string, cdnCacheId?: string) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      return { success: false, error: 'Not connected' };
    }
    try {
      const client = getKinstaClient(apiKey);
      const cleared = await clearKinstaCaches(client, envId, cdnCacheId);
      return { success: true, cleared };
    } catch (error: any) {
      return { success: false, error: error.response?.data?.message || error.message };
    }
  });

  // Push preview: rsync dry-run diff of what a push would change on Kinsta.
  // Read-only — no files are touched on either side.
  ipcMain.handle('kinsta:pushPreview', async (
    _event: IpcMainInvokeEvent,
    localSiteId: string,
    site: SiteInfo,
    envInfo: EnvironmentInfo,
    options: { mode?: 'newer' | 'all'; includeUploads?: boolean } = {}
  ) => {
    const mode = options.mode || 'newer';
    if (activeSyncs.has(localSiteId)) {
      return { success: false, error: 'A sync is already running for this site', mode };
    }
    if (!validateEnvironmentInfo(envInfo)) {
      return { success: false, error: 'Invalid environment configuration.', mode };
    }

    const localPublicPath = path.join(expandPath(site.path), 'app', 'public');
    const sshCommandForRsync = `ssh -p ${envInfo.sshPort} -o StrictHostKeyChecking=accept-new`;
    const remoteHost = `${envInfo.sshUser}@${envInfo.sshHost}`;

    const excludeArgs = EXCLUDE_PATTERNS.map(p => `--exclude=${p}`);
    if (!options.includeUploads) {
      excludeArgs.push('--exclude=wp-content/uploads/');
    }

    const rsync = resolveRsync();
    const degraded = !(rsync.supportsItemizeChanges && rsync.supportsOutFormat);

    // %M carries the local file's mtime so we never stat thousands of files
    // in the main process (which would block Local's entire UI)
    const args = ['-az', '--delete', '-n'];
    if (mode === 'newer') args.push('--update');
    args.push(...(degraded ? ['-v'] : ['--itemize-changes', '--out-format=%i|%l|%M|%n']));
    args.push(...excludeArgs, '-e', sshCommandForRsync, `${localPublicPath}/`, `${remoteHost}:~/public/`);

    // One preview at a time per site: kill the previous dry-run if the
    // renderer re-fires (mode/env/uploads toggles) so orphaned SSH sessions
    // don't pile up against Kinsta's connection limit.
    activePreviews.get(localSiteId)?.child?.kill('SIGTERM');
    const preview: ActiveSync = { cancelled: false, child: null };
    activePreviews.set(localSiteId, preview);

    try {
      const chunks: string[] = [];
      await runCommand(preview, rsync.bin, args, {
        okCodes: [23, 24],
        onStdout: (chunk) => { chunks.push(chunk); },
      });
      const stdout = chunks.join('');

      const rows = degraded ? parseVerboseDryRun(stdout) : parseItemizeOutput(stdout);
      return { success: true, rows, degraded, mode };
    } catch (error: any) {
      return { success: false, error: error.message, mode };
    } finally {
      if (activePreviews.get(localSiteId) === preview) activePreviews.delete(localSiteId);
    }
  });

  // Cancel a running sync for a site
  ipcMain.handle('kinsta:cancelSync', async (_event: IpcMainInvokeEvent, localSiteId: string) => {
    const sync = activeSyncs.get(localSiteId);
    if (sync) {
      sync.cancelled = true;
      sync.child?.kill('SIGTERM');
    }
    return { success: true };
  });

  // Pull from Kinsta
  ipcMain.handle('kinsta:pull', async (event: IpcMainInvokeEvent, localSiteId: string, site: SiteInfo, envInfo: EnvironmentInfo, options: SyncOptions) => {
    const links = loadSiteLinks();
    const link = links[localSiteId];

    if (!link) {
      return { success: false, error: 'Site not linked to Kinsta' };
    }
    if (activeSyncs.has(localSiteId)) {
      return { success: false, error: 'A sync is already running for this site' };
    }

    // Security: Validate environment data before using in shell commands
    if (!validateEnvironmentInfo(envInfo)) {
      console.error('[Kinsta] Pull validation failed for:', envInfo);
      return { success: false, error: 'Invalid environment configuration.' };
    }

    // Pre-flight: database sync needs the local site running (MySQL socket)
    const socketPath = getMysqlSocketPath(localSiteId);
    if (options.includeDatabase && !fs.existsSync(socketPath)) {
      return { success: false, error: 'The local site must be running for database sync. Start the site in Local and try again.' };
    }

    // siteId + mode let listeners (status badge, drawer) filter events
    const sendProgress = (progress: SyncProgress) => {
      event.sender.send('kinsta:syncProgress', { ...progress, siteId: localSiteId, mode: 'pull' });
    };

    const sync: ActiveSync = { cancelled: false, child: null };
    activeSyncs.set(localSiteId, sync);
    const startedAt = Date.now();

    const localPublicPath = path.join(expandPath(site.path), 'app', 'public');
    const sshCommandForRsync = `ssh -p ${envInfo.sshPort} -o StrictHostKeyChecking=accept-new`;
    const remoteHost = `${envInfo.sshUser}@${envInfo.sshHost}`;

    // Once the local DB import starts, a cancel/crash leaves the database
    // half-written — these let the catch block restore the pre-pull backup.
    let dbImportStarted = false;
    const localBackupPath = path.join(TEMP_DIR, `${localSiteId}-pre-pull-backup.sql`);
    const db = getDbCredentials(site);

    try {
      // Build exclude args (no shell — patterns are passed verbatim)
      const excludeArgs = EXCLUDE_PATTERNS.map(p => `--exclude=${p}`);
      if (!options.includeUploads) {
        excludeArgs.push('--exclude=wp-content/uploads/');
      }

      // 1. Sync files (live progress, flags adapted to the rsync version)
      sendProgress({ stage: 'files', progress: 5, message: 'Syncing files from Kinsta...' });

      const rsync = resolveRsync();
      const rsyncResult = await runCommand(sync, rsync.bin, [
        '-az', ...rsyncProgressArgs(rsync), ...excludeArgs,
        '-e', sshCommandForRsync,
        `${remoteHost}:~/public/`,
        `${localPublicPath}/`,
      ], {
        // 23/24 = partial transfer (e.g. legacy non-UTF-8 filenames that
        // macOS can't store, or files vanishing on a live server) — warn
        // instead of failing the whole sync.
        okCodes: [23, 24],
        onStdout: makeRsyncProgressParser(rsync, (pct) => {
          // Files = 5–50% of the overall pull
          const overall = 5 + Math.round(pct * 0.45);
          sendProgress({ stage: 'files', progress: overall, message: `Syncing files from Kinsta... ${pct}%` });
        }),
      });
      const fileWarning = describePartialTransfer(rsyncResult);

      sendProgress({ stage: 'files', progress: 50, message: fileWarning ? 'Files synced (some skipped)' : 'Files synced!' });

      // 2. Database (if requested)
      if (options.includeDatabase) {
        const dbDumpPath = path.join(TEMP_DIR, `${localSiteId}-remote.sql`);
        const remoteDbPath = '/tmp/kinsta-local-export.sql';

        const mysqlBin = findServiceBinary(['mysql-', 'mariadb-'], 'mysql');
        const mysqldumpBin = findServiceBinary(['mysql-', 'mariadb-'], 'mysqldump');
        if (!mysqlBin || !mysqldumpBin) {
          throw new Error('Could not find MySQL binaries in Local\'s lightning-services');
        }

        // Safety net: back up the local database before overwriting it
        sendProgress({ stage: 'database', progress: 52, message: 'Backing up local database...' });
        await runCommand(sync, mysqldumpBin, [
          `-u${db.user}`, `-p${db.password}`, `--socket=${socketPath}`, db.database,
        ], { stdoutFile: localBackupPath });

        sendProgress({ stage: 'database', progress: 58, message: 'Exporting database from Kinsta...' });
        await runCommand(sync, 'ssh', sshArgs(envInfo, `cd ~/public && wp db export ${remoteDbPath}`));

        sendProgress({ stage: 'database', progress: 65, message: 'Downloading database...' });
        await runCommand(sync, 'scp', [
          '-P', envInfo.sshPort,
          '-o', 'StrictHostKeyChecking=accept-new',
          `${remoteHost}:${remoteDbPath}`,
          dbDumpPath,
        ]);

        sendProgress({ stage: 'database', progress: 75, message: 'Importing database locally...' });
        dbImportStarted = true;
        await runCommand(sync, mysqlBin, [
          `-u${db.user}`, `-p${db.password}`, `--socket=${socketPath}`, db.database,
        ], { stdinFile: dbDumpPath });

        sendProgress({ stage: 'search-replace', progress: 82, message: 'Running search-replace...' });

        // Search-replace URLs using WP-CLI (handles serialized data correctly)
        const remoteDomain = envInfo.remoteDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const localDomain = site.domain;

        const phpBin = findServiceBinary(['php-'], 'php');
        const wpCliPhar = findWpCliPhar();
        if (!phpBin) throw new Error('Could not find PHP binary in Local\'s lightning-services');
        if (!wpCliPhar) throw new Error('Could not find WP-CLI in the Local installation');
        const mysqlBinDir = path.dirname(mysqlBin);

        // Temporarily modify wp-config.php to include socket path
        const wpConfigPath = path.join(localPublicPath, 'wp-config.php');
        const wpConfigBackupPath = wpConfigPath + '.kinsta-sync-bak';
        let wpConfigBackup: string | null = null;

        try {
          // Restore from backup if exists (previous crash)
          if (fs.existsSync(wpConfigBackupPath)) {
            fs.copyFileSync(wpConfigBackupPath, wpConfigPath);
            fs.unlinkSync(wpConfigBackupPath);
          }

          wpConfigBackup = fs.readFileSync(wpConfigPath, 'utf8');
          fs.writeFileSync(wpConfigBackupPath, wpConfigBackup);

          const wpConfigModified = wpConfigBackup.replace(
            /define\s*\(\s*['"]DB_HOST['"]\s*,\s*['"]([^'"]*)['"]\s*\)/,
            `define('DB_HOST', 'localhost:${socketPath}')`
          );
          fs.writeFileSync(wpConfigPath, wpConfigModified);

          const wpEnv = { ...process.env, PATH: `${mysqlBinDir}:${process.env.PATH || ''}` };
          // MultiSite.No is the empty string, so truthiness is the correct check
          const networkArgs = site.multiSite ? ['--network'] : [];
          const pairs = searchReplacePairs(remoteDomain, localDomain);

          for (let i = 0; i < pairs.length; i++) {
            const [from, to] = pairs[i];
            sendProgress({ stage: 'search-replace', progress: 84 + i * 4, message: `Replacing ${from} → ${to}` });
            await runCommand(sync, phpBin, [
              wpCliPhar, 'search-replace', from, to,
              '--all-tables', '--skip-columns=guid', '--skip-plugins', '--skip-themes',
              `--path=${localPublicPath}`, '--allow-root', ...networkArgs,
            ], { env: wpEnv });
          }

          sendProgress({ stage: 'search-replace', progress: 96, message: 'Search-replace complete!' });
        } finally {
          // Always restore wp-config.php
          if (wpConfigBackup) {
            fs.writeFileSync(wpConfigPath, wpConfigBackup);
          }
          if (fs.existsSync(wpConfigBackupPath)) {
            fs.unlinkSync(wpConfigBackupPath);
          }
        }

        // Cleanup (keep the pre-pull backup until the next pull)
        try {
          fs.unlinkSync(dbDumpPath);
          await runCommand(sync, 'ssh', sshArgs(envInfo, `rm -f ${remoteDbPath}`));
        } catch (e) {}
      }

      recordSync(localSiteId, 'pull', envInfo.envType, Date.now() - startedAt);
      sendProgress({ stage: 'done', progress: 100, message: fileWarning ? `Pull complete — ${fileWarning}` : 'Pull complete!' });
      notify('Kinsta Sync', fileWarning
        ? `Pull complete for ${site.name || site.domain} — some files were skipped (legacy filenames)`
        : `Pull complete for ${site.name || site.domain}`);
      return { success: true, warning: fileWarning };

    } catch (error: any) {
      // The local DB was (partially) overwritten — a half-imported or
      // half-search-replaced database is unusable, so roll back to the
      // backup taken right before the import.
      if (dbImportStarted && fs.existsSync(localBackupPath)) {
        try {
          sendProgress({ stage: 'database', progress: 0, message: 'Restoring local database from backup...' });
          const mysqlBinRestore = findServiceBinary(['mysql-', 'mariadb-'], 'mysql');
          if (!mysqlBinRestore) throw new Error('mysql binary not found');
          // Fresh ActiveSync — the cancelled one rejects every command
          await runCommand({ cancelled: false, child: null }, mysqlBinRestore, [
            `-u${db.user}`, `-p${db.password}`, `--socket=${socketPath}`, db.database,
          ], { stdinFile: localBackupPath });
          notify('Kinsta Sync', `Pull aborted — local database for ${site.name || site.domain} was restored from backup`);
        } catch (restoreError: any) {
          console.error('[Kinsta] DB restore after aborted pull failed:', restoreError.message);
          notify('Kinsta Sync', `Pull aborted — automatic DB restore FAILED. Backup: ${localBackupPath}`);
        }
      }
      if (error instanceof CancelledError) {
        sendProgress({ stage: 'cancelled', progress: 0, message: 'Sync cancelled' });
        return { success: false, cancelled: true, error: 'Sync cancelled' };
      }
      sendProgress({ stage: 'error', progress: 0, message: error.message });
      notify('Kinsta Sync', `Pull failed for ${site.name || site.domain}`);
      return { success: false, error: error.message };
    } finally {
      activeSyncs.delete(localSiteId);
    }
  });

  // Push to Kinsta
  ipcMain.handle('kinsta:push', async (event: IpcMainInvokeEvent, localSiteId: string, site: SiteInfo, envInfo: EnvironmentInfo, options: SyncOptions) => {
    const links = loadSiteLinks();
    const link = links[localSiteId];

    if (!link) {
      return { success: false, error: 'Site not linked to Kinsta' };
    }
    if (activeSyncs.has(localSiteId)) {
      return { success: false, error: 'A sync is already running for this site' };
    }

    // Security: Validate environment data before using in shell commands
    if (!validateEnvironmentInfo(envInfo)) {
      return { success: false, error: 'Invalid environment configuration.' };
    }

    // Pre-flight: database sync needs the local site running (MySQL socket)
    const socketPath = getMysqlSocketPath(localSiteId);
    if (options.includeDatabase && !fs.existsSync(socketPath)) {
      return { success: false, error: 'The local site must be running for database sync. Start the site in Local and try again.' };
    }

    // siteId + mode let listeners (status badge, drawer) filter events
    const sendProgress = (progress: SyncProgress) => {
      event.sender.send('kinsta:syncProgress', { ...progress, siteId: localSiteId, mode: 'push' });
    };

    // A leftover preview dry-run must not compete with the real push
    activePreviews.get(localSiteId)?.child?.kill('SIGTERM');

    const sync: ActiveSync = { cancelled: false, child: null };
    activeSyncs.set(localSiteId, sync);
    const startedAt = Date.now();

    const localPublicPath = path.join(expandPath(site.path), 'app', 'public');
    const sshCommandForRsync = `ssh -p ${envInfo.sshPort} -o StrictHostKeyChecking=accept-new`;
    const remoteHost = `${envInfo.sshUser}@${envInfo.sshHost}`;

    // Once the remote DB import starts, a cancel/crash leaves the remote
    // database half-written — lets the catch block restore the remote backup.
    let remoteImportStarted = false;

    try {
      const excludeArgs = EXCLUDE_PATTERNS.map(p => `--exclude=${p}`);
      if (!options.includeUploads) {
        excludeArgs.push('--exclude=wp-content/uploads/');
      }

      // 1a. Native Kinsta backup (files + DB) — restorable from MyKinsta.
      //     If enabled and it fails, abort the push: the user opted into the
      //     safety net, so don't proceed without it.
      if (options.kinstaBackup !== false) {
        const apiKeyForBackup = getApiKey();
        if (apiKeyForBackup) {
          sendProgress({ stage: 'backup', progress: 2, message: 'Creating Kinsta backup...' });
          try {
            const client = getKinstaClient(apiKeyForBackup);
            const created = await createKinstaBackup(client, envInfo.envId, sync, (msg) => {
              sendProgress({ stage: 'backup', progress: 3, message: msg });
            });
            if (created) {
              sendProgress({ stage: 'backup', progress: 5, message: 'Kinsta backup created!' });
            } else {
              sendProgress({ stage: 'backup', progress: 5, message: 'All 5 manual backup slots are yours — skipping Kinsta backup' });
              notify('Kinsta Sync', 'Kinsta backup skipped: all 5 manual slots hold your own backups');
            }
          } catch (backupError: any) {
            if (backupError instanceof CancelledError) throw backupError;
            throw new Error(`Kinsta backup failed — push aborted: ${backupError.message}`);
          }
        }
      }

      // 1b. Safety net for the automatic rollback: export the remote database.
      //     Stored in the remote home dir (outside ~/public, not web-accessible).
      sendProgress({ stage: 'backup', progress: 6, message: 'Backing up remote database...' });
      await runCommand(sync, 'ssh', sshArgs(envInfo, 'cd ~/public && wp db export ~/kinsta-sync-pre-push-backup.sql'));

      // 2. Sync files (live progress, flags adapted to the rsync version)
      sendProgress({ stage: 'files', progress: 8, message: 'Syncing files to Kinsta...' });

      const rsync = resolveRsync();

      // Selective push (from the preview screen): only the checked files
      const selective = Array.isArray(options.files);
      let filesFromPath: string | undefined;
      if (selective) {
        filesFromPath = path.join(TEMP_DIR, `${localSiteId}-push-files.txt`);
        ensureConfigDir();
        // One path per line, relative to the rsync source root (~/public)
        fs.writeFileSync(filesFromPath, (options.files || []).join('\n') + '\n');
      }

      let fileWarning: string | null = null;
      try {
        if (!selective || (options.files && options.files.length > 0)) {
          const rsyncResult = await runCommand(sync, rsync.bin, buildPushRsyncArgs({
            rsync,
            excludeArgs,
            sshCommand: sshCommandForRsync,
            localPublicPath,
            remoteHost,
            mode: options.mode,
            filesFromPath,
          }), {
            // 23/24 = partial transfer — warn instead of failing the whole sync
            okCodes: [23, 24],
            onStdout: makeRsyncProgressParser(rsync, (pct) => {
              // Files = 8–50% of the overall push
              const overall = 8 + Math.round(pct * 0.42);
              sendProgress({ stage: 'files', progress: overall, message: `Syncing files to Kinsta... ${pct}%` });
            }),
          });
          fileWarning = describePartialTransfer(rsyncResult);
        }
      } finally {
        if (filesFromPath) { try { fs.unlinkSync(filesFromPath); } catch (e) {} }
      }

      // Checked deletions from the preview — executed explicitly (instead of
      // rsync --delete) so unchecked deletions survive. Paths are strictly
      // validated + single-quoted (the one place a path enters a shell string).
      if (options.deletions && options.deletions.length > 0) {
        sendProgress({ stage: 'files', progress: 48, message: `Deleting ${options.deletions.length} file(s) on Kinsta...` });
        const quoted = options.deletions.map((p) => {
          const q = safeRemoteRelPath(p);
          if (!q) throw new Error(`Unsafe path refused for remote deletion: ${p}`);
          return q;
        });
        for (let i = 0; i < quoted.length; i += 200) {
          const batch = quoted.slice(i, i + 200);
          await runCommand(sync, 'ssh', sshArgs(envInfo, `cd ~/public && rm -rf -- ${batch.join(' ')}`));
        }
      }

      sendProgress({ stage: 'files', progress: 50, message: fileWarning ? 'Files synced (some skipped)' : 'Files synced!' });

      // 3. Database (if requested)
      if (options.includeDatabase) {
        const db = getDbCredentials(site);
        const dbDumpPath = path.join(TEMP_DIR, `${localSiteId}-local.sql`);
        const remoteDbPath = '/tmp/kinsta-local-import.sql';

        const mysqldumpBin = findServiceBinary(['mysql-', 'mariadb-'], 'mysqldump');
        if (!mysqldumpBin) {
          throw new Error('Could not find mysqldump in Local\'s lightning-services');
        }

        sendProgress({ stage: 'database', progress: 55, message: 'Exporting local database...' });
        await runCommand(sync, mysqldumpBin, [
          `-u${db.user}`, `-p${db.password}`, `--socket=${socketPath}`, db.database,
        ], { stdoutFile: dbDumpPath });

        sendProgress({ stage: 'database', progress: 65, message: 'Uploading database...' });
        await runCommand(sync, 'scp', [
          '-P', envInfo.sshPort,
          '-o', 'StrictHostKeyChecking=accept-new',
          dbDumpPath,
          `${remoteHost}:${remoteDbPath}`,
        ]);

        sendProgress({ stage: 'database', progress: 75, message: 'Importing database on Kinsta...' });
        remoteImportStarted = true;
        await runCommand(sync, 'ssh', sshArgs(envInfo, `cd ~/public && wp db import ${remoteDbPath}`));

        sendProgress({ stage: 'search-replace', progress: 82, message: 'Running search-replace...' });

        const localDomain = site.domain;
        const remoteDomain = envInfo.remoteDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
        // MultiSite.No is the empty string, so truthiness is the correct check
        const networkFlag = site.multiSite ? ' --network' : '';
        const pairs = searchReplacePairs(localDomain, remoteDomain);

        for (let i = 0; i < pairs.length; i++) {
          const [from, to] = pairs[i];
          sendProgress({ stage: 'search-replace', progress: 84 + i * 4, message: `Replacing ${from} → ${to}` });
          await runCommand(sync, 'ssh', sshArgs(envInfo,
            `cd ~/public && wp search-replace '${from}' '${to}' --all-tables --skip-columns=guid${networkFlag}`
          ));
        }

        // Clear all Kinsta caches (page + edge + CDN) via API
        const apiKeyForCache = getApiKey();
        if (apiKeyForCache) {
          sendProgress({ stage: 'cache', progress: 97, message: 'Clearing Kinsta caches...' });
          try {
            const client = getKinstaClient(apiKeyForCache);
            await clearKinstaCaches(client, envInfo.envId, envInfo.cdnCacheId);
          } catch (e: any) {
            // Non-fatal, but at least leave a trace this time
            console.error('[Kinsta] Cache clear after push failed:', e.response?.data?.message || e.message);
          }
        }

        // Cleanup
        try {
          fs.unlinkSync(dbDumpPath);
          await runCommand(sync, 'ssh', sshArgs(envInfo, `rm -f ${remoteDbPath}`));
        } catch (e) {}
      }

      recordSync(localSiteId, 'push', envInfo.envType, Date.now() - startedAt);
      sendProgress({ stage: 'done', progress: 100, message: fileWarning ? `Push complete — ${fileWarning}` : 'Push complete!' });
      notify('Kinsta Sync', fileWarning
        ? `Push complete for ${site.name || site.domain} — some files were skipped (legacy filenames)`
        : `Push complete for ${site.name || site.domain}`);
      return { success: true, warning: fileWarning };

    } catch (error: any) {
      // The remote DB was (partially) overwritten — restore the backup we
      // exported on the remote before the import.
      if (remoteImportStarted) {
        try {
          sendProgress({ stage: 'database', progress: 0, message: 'Restoring remote database from backup...' });
          // Fresh ActiveSync — the cancelled one rejects every command
          await runCommand({ cancelled: false, child: null }, 'ssh', sshArgs(envInfo,
            'cd ~/public && wp db import ~/kinsta-sync-pre-push-backup.sql'));
          notify('Kinsta Sync', `Push aborted — remote database for ${site.name || site.domain} was restored from backup`);
        } catch (restoreError: any) {
          console.error('[Kinsta] Remote DB restore after aborted push failed:', restoreError.message);
          notify('Kinsta Sync', 'Push aborted — automatic remote DB restore FAILED. Backup on server: ~/kinsta-sync-pre-push-backup.sql');
        }
      }
      if (error instanceof CancelledError) {
        sendProgress({ stage: 'cancelled', progress: 0, message: 'Sync cancelled' });
        return { success: false, cancelled: true, error: 'Sync cancelled' };
      }
      sendProgress({ stage: 'error', progress: 0, message: error.message });
      notify('Kinsta Sync', `Push failed for ${site.name || site.domain}`);
      return { success: false, error: error.message };
    } finally {
      activeSyncs.delete(localSiteId);
    }
  });

  // Disconnect from Kinsta
  ipcMain.handle('kinsta:disconnect', async () => {
    deleteApiKey();
    saveConfig({});
    return { success: true };
  });
}

// Kinsta API client
// Kinsta has three separately cleared caches (object cache/Redis has no API):
//   page  — POST /sites/tools/clear-cache   (the only one we cleared before)
//   edge  — POST /sites/edge-caching/clear
//   CDN   — POST /sites/cdn/clear-cache     (needs the env's cdn_cache_id)
// Page cache is required and propagates failure; edge/CDN are best-effort
// since they can be disabled per environment.
async function clearKinstaCaches(client: AxiosInstance, envId: string, cdnCacheId?: string): Promise<string[]> {
  const cleared: string[] = [];
  await client.post('/sites/tools/clear-cache', { environment_id: envId });
  cleared.push('page');
  try {
    await client.post('/sites/edge-caching/clear', { environment_id: envId });
    cleared.push('edge');
  } catch (e: any) {
    console.log('[Kinsta] Edge cache clear skipped:', e.response?.data?.message || e.message);
  }
  if (cdnCacheId) {
    try {
      await client.post('/sites/cdn/clear-cache', { environment_id: envId, cdn_cache_id: cdnCacheId });
      cleared.push('CDN');
    } catch (e: any) {
      console.log('[Kinsta] CDN cache clear skipped:', e.response?.data?.message || e.message);
    }
  }
  return cleared;
}

function getKinstaClient(apiKey: string): AxiosInstance {
  return axios.create({
    baseURL: KINSTA_API_BASE,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });
}
