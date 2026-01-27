import { AddonMainContext } from '@getflywheel/local/main';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import axios, { AxiosInstance } from 'axios';
import type { IpcMainInvokeEvent, SafeStorage } from 'electron';

const KINSTA_API_BASE = 'https://api.kinsta.com/v2';
const CONFIG_DIR = path.join(os.homedir(), '.kinsta-sync');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const KEY_FILE = path.join(CONFIG_DIR, '.api-key.enc'); // Encrypted API key
const SITES_FILE = path.join(CONFIG_DIR, 'sites.json');
const TEMP_DIR = path.join(CONFIG_DIR, 'tmp');

// Will be set from context.electron.safeStorage
let safeStorage: SafeStorage | null = null;

// Files/folders to exclude during sync
const EXCLUDE_PATTERNS = [
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

interface KinstaConfigWithKey extends KinstaConfig {
  apiKey?: string;
}

interface SiteLink {
  localSiteId: string;
  kinstaSiteId: string;
  kinstaSiteName: string;
  envId: string;
  envType: 'staging' | 'live';
  sshHost: string;
  sshPort: string;
  sshUser: string;
  remoteDomain: string;
}

interface SyncProgress {
  stage: string;
  progress: number;
  message: string;
}

// Config helpers
function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
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

function getConfigWithKey(): KinstaConfigWithKey {
  const config = loadConfig();
  const apiKey = getApiKey();
  return { ...config, apiKey: apiKey || undefined };
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

// Security: Validate SSH/shell values to prevent command injection
function isValidHostname(host: string): boolean {
  // Allow IP addresses and hostnames
  const hostnameRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  return hostnameRegex.test(host) || ipRegex.test(host);
}

function isValidPort(port: string): boolean {
  const portNum = parseInt(port, 10);
  return !isNaN(portNum) && portNum > 0 && portNum <= 65535;
}

function isValidUsername(user: string): boolean {
  // SSH usernames: alphanumeric, underscores, hyphens
  return /^[a-zA-Z0-9_-]+$/.test(user);
}

function isValidDomain(domain: string): boolean {
  // Domain names: alphanumeric, dots, hyphens
  return /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(domain);
}

function validateSiteLink(link: SiteLink): boolean {
  return (
    isValidHostname(link.sshHost) &&
    isValidPort(link.sshPort) &&
    isValidUsername(link.sshUser) &&
    isValidDomain(link.remoteDomain)
  );
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

// Kinsta API client
function getKinstaClient(apiKey: string): AxiosInstance {
  return axios.create({
    baseURL: KINSTA_API_BASE,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    }
  });
}

export default function (context: AddonMainContext): void {
  const { electron } = context;
  const { ipcMain } = electron;

  // Initialize safeStorage for secure API key storage
  safeStorage = electron.safeStorage;

  // Security: Clean up any leftover temp files from previous sessions
  cleanupTempFiles();

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

  // Link Local site to Kinsta
  ipcMain.handle('kinsta:linkSite', async (_event: IpcMainInvokeEvent, localSiteId: string, kinstaSite: any, environment: any) => {
    const links = loadSiteLinks();

    const link: SiteLink = {
      localSiteId,
      kinstaSiteId: kinstaSite.id,
      kinstaSiteName: kinstaSite.name,
      envId: environment.id,
      envType: environment.is_premium ? 'live' : 'staging',
      sshHost: environment.ssh_connection?.ssh_ip?.external_ip || '',
      sshPort: String(environment.ssh_connection?.ssh_port || '22'),
      sshUser: kinstaSite.name.toLowerCase().replace(/[^a-z0-9]/g, ''),
      remoteDomain: environment.primaryDomain?.name || environment.domains?.[0]?.name || ''
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

  // Pull from Kinsta
  ipcMain.handle('kinsta:pull', async (event: IpcMainInvokeEvent, localSiteId: string, site: any, options: { includeUploads?: boolean; includeDatabase?: boolean }) => {
    const links = loadSiteLinks();
    const link = links[localSiteId];

    if (!link) {
      return { success: false, error: 'Site not linked to Kinsta' };
    }

    // Security: Validate site link data before using in shell commands
    if (!validateSiteLink(link)) {
      return { success: false, error: 'Invalid site link configuration. Please unlink and relink the site.' };
    }

    const sendProgress = (progress: SyncProgress) => {
      event.sender.send('kinsta:syncProgress', progress);
    };

    try {
      const localPublicPath = path.join(site.path, 'app', 'public');
      const sshCmd = `ssh -p ${link.sshPort} -o StrictHostKeyChecking=accept-new`;
      const remotePath = `${link.sshUser}@${link.sshHost}:~/public`;

      // Build exclude args
      let excludeArgs = EXCLUDE_PATTERNS.map(p => `--exclude='${p}'`).join(' ');
      if (!options.includeUploads) {
        excludeArgs += ` --exclude='wp-content/uploads/'`;
      }

      // 1. Sync files
      sendProgress({ stage: 'files', progress: 10, message: 'Syncing files from Kinsta...' });

      // Escape spaces in local path for shell
      const escapedLocalPath = localPublicPath.replace(/ /g, '\\ ');
      const rsyncCmd = `rsync -az ${excludeArgs} -e "${sshCmd}" ${link.sshUser}@${link.sshHost}:~/public/ ${escapedLocalPath}/`;
      execSync(rsyncCmd, { encoding: 'utf8', shell: '/bin/bash', stdio: 'pipe' });

      sendProgress({ stage: 'files', progress: 50, message: 'Files synced!' });

      // 2. Database (if requested)
      if (options.includeDatabase) {
        sendProgress({ stage: 'database', progress: 60, message: 'Exporting database from Kinsta...' });

        const dbDumpPath = path.join(TEMP_DIR, `${localSiteId}-remote.sql`);
        const remoteDbPath = '/tmp/kinsta-local-export.sql';

        // Export from Kinsta
        execSync(`${sshCmd} ${link.sshUser}@${link.sshHost} "cd ~/public && wp db export ${remoteDbPath}"`, { encoding: 'utf8', stdio: 'pipe' });

        // Download
        execSync(`scp -P ${link.sshPort} -o StrictHostKeyChecking=accept-new ${link.sshUser}@${link.sshHost}:${remoteDbPath} "${dbDumpPath}"`, { encoding: 'utf8', stdio: 'pipe' });

        sendProgress({ stage: 'database', progress: 75, message: 'Importing database locally...' });

        // Import locally using Local's MySQL
        const localAppSupport = path.join(os.homedir(), 'Library', 'Application Support', 'Local');
        const socketPath = path.join(localAppSupport, 'run', localSiteId, 'mysql', 'mysqld.sock');

        if (fs.existsSync(socketPath)) {
          const localServicesPath = path.join(localAppSupport, 'lightning-services');
          const mysqlDirs = fs.readdirSync(localServicesPath).filter(d => d.startsWith('mysql-') || d.startsWith('mariadb-')).sort().reverse();
          const arch = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
          let mysqlBin = path.join(localServicesPath, mysqlDirs[0], 'bin', arch, 'bin', 'mysql');

          if (!fs.existsSync(mysqlBin)) {
            mysqlBin = path.join(localServicesPath, mysqlDirs[0], 'bin', 'darwin-arm64', 'bin', 'mysql');
          }

          const importCmd = `"${mysqlBin}" -uroot -proot --socket="${socketPath}" local < "${dbDumpPath}"`;
          execSync(importCmd, { encoding: 'utf8', shell: '/bin/bash', stdio: 'pipe' });
        }

        sendProgress({ stage: 'search-replace', progress: 85, message: 'Running search-replace...' });

        // Search-replace URLs using WP-CLI (handles serialized data correctly)
        const remoteDomain = link.remoteDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
        const localDomain = site.domain;

        // Find PHP and MySQL binaries
        const localServicesPath = path.join(localAppSupport, 'lightning-services');
        const phpDirs = fs.readdirSync(localServicesPath).filter(d => d.startsWith('php-')).sort().reverse();
        const mysqlDirs2 = fs.readdirSync(localServicesPath).filter(d => d.startsWith('mysql-') || d.startsWith('mariadb-')).sort().reverse();

        const arch2 = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
        let phpBin = path.join(localServicesPath, phpDirs[0], 'bin', arch2, 'bin', 'php');
        if (!fs.existsSync(phpBin)) {
          phpBin = path.join(localServicesPath, phpDirs[0], 'bin', 'darwin-arm64', 'bin', 'php');
        }

        const mysqlBinDir = path.join(localServicesPath, mysqlDirs2[0], 'bin', arch2, 'bin');
        const wpCliPhar = '/Applications/Local.app/Contents/Resources/extraResources/bin/wp-cli/wp-cli.phar';

        // Temporarily modify wp-config.php to include socket path (same approach as CLI)
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

          // Save backup before modifying
          fs.writeFileSync(wpConfigBackupPath, wpConfigBackup);

          // Replace DB_HOST with socket path
          const wpConfigModified = wpConfigBackup.replace(
            /define\s*\(\s*['"]DB_HOST['"]\s*,\s*['"]([^'"]*)['"]\s*\)/,
            `define('DB_HOST', 'localhost:${socketPath}')`
          );
          fs.writeFileSync(wpConfigPath, wpConfigModified);

          // Run WP-CLI search-replace with proper options:
          // --all-tables: search all tables
          // --skip-columns=guid: don't touch guid column (breaks WP)
          // --skip-plugins --skip-themes: faster execution
          const envPath = `PATH="${mysqlBinDir}:$PATH"`;
          const srCmd = `${envPath} "${phpBin}" "${wpCliPhar}" search-replace 'https://${remoteDomain}' 'https://${localDomain}' --all-tables --skip-columns=guid --skip-plugins --skip-themes --path="${localPublicPath}" --allow-root`;

          execSync(srCmd, { encoding: 'utf8', shell: '/bin/bash', stdio: 'pipe' });

          // Also replace protocol-relative URLs (//example.com -> //example.local)
          const srCmd2 = `${envPath} "${phpBin}" "${wpCliPhar}" search-replace '//${remoteDomain}' '//${localDomain}' --all-tables --skip-columns=guid --skip-plugins --skip-themes --path="${localPublicPath}" --allow-root 2>/dev/null || true`;
          execSync(srCmd2, { encoding: 'utf8', shell: '/bin/bash', stdio: 'pipe' });

          sendProgress({ stage: 'search-replace', progress: 95, message: 'Search-replace complete!' });
        } catch (srError: any) {
          console.error('Search-replace error:', srError.message);
          // Continue anyway - files are synced
        } finally {
          // Always restore wp-config.php
          if (wpConfigBackup) {
            fs.writeFileSync(wpConfigPath, wpConfigBackup);
          }
          // Remove backup file
          if (fs.existsSync(wpConfigBackupPath)) {
            fs.unlinkSync(wpConfigBackupPath);
          }
        }

        // Cleanup
        try {
          fs.unlinkSync(dbDumpPath);
          execSync(`${sshCmd} ${link.sshUser}@${link.sshHost} "rm -f ${remoteDbPath}"`, { stdio: 'pipe' });
        } catch (e) {}
      }

      sendProgress({ stage: 'done', progress: 100, message: 'Pull complete!' });
      return { success: true };

    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Push to Kinsta
  ipcMain.handle('kinsta:push', async (event: IpcMainInvokeEvent, localSiteId: string, site: any, options: { includeUploads?: boolean; includeDatabase?: boolean }) => {
    const links = loadSiteLinks();
    const link = links[localSiteId];
    const config = loadConfig();

    if (!link) {
      return { success: false, error: 'Site not linked to Kinsta' };
    }

    // Security: Validate site link data before using in shell commands
    if (!validateSiteLink(link)) {
      return { success: false, error: 'Invalid site link configuration. Please unlink and relink the site.' };
    }

    const sendProgress = (progress: SyncProgress) => {
      event.sender.send('kinsta:syncProgress', progress);
    };

    try {
      const localPublicPath = path.join(site.path, 'app', 'public');
      const sshCmd = `ssh -p ${link.sshPort} -o StrictHostKeyChecking=accept-new`;
      const remotePath = `${link.sshUser}@${link.sshHost}:~/public`;

      // Build exclude args
      let excludeArgs = EXCLUDE_PATTERNS.map(p => `--exclude='${p}'`).join(' ');
      if (!options.includeUploads) {
        excludeArgs += ` --exclude='wp-content/uploads/'`;
      }

      // 1. Sync files
      sendProgress({ stage: 'files', progress: 10, message: 'Syncing files to Kinsta...' });

      // Escape spaces in local path for shell
      const escapedLocalPath = localPublicPath.replace(/ /g, '\\ ');
      const rsyncCmd = `rsync -az --delete ${excludeArgs} -e "${sshCmd}" ${escapedLocalPath}/ ${link.sshUser}@${link.sshHost}:~/public/`;
      execSync(rsyncCmd, { encoding: 'utf8', shell: '/bin/bash', stdio: 'pipe' });

      sendProgress({ stage: 'files', progress: 50, message: 'Files synced!' });

      // 2. Database (if requested)
      if (options.includeDatabase) {
        sendProgress({ stage: 'database', progress: 60, message: 'Exporting local database...' });

        const dbDumpPath = path.join(TEMP_DIR, `${localSiteId}-local.sql`);
        const remoteDbPath = '/tmp/kinsta-local-import.sql';

        // Export local DB
        const localAppSupport = path.join(os.homedir(), 'Library', 'Application Support', 'Local');
        const socketPath = path.join(localAppSupport, 'run', localSiteId, 'mysql', 'mysqld.sock');

        if (fs.existsSync(socketPath)) {
          const localServicesPath = path.join(localAppSupport, 'lightning-services');
          const mysqlDirs = fs.readdirSync(localServicesPath).filter(d => d.startsWith('mysql-') || d.startsWith('mariadb-')).sort().reverse();
          const arch = process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
          let mysqldumpBin = path.join(localServicesPath, mysqlDirs[0], 'bin', arch, 'bin', 'mysqldump');

          if (!fs.existsSync(mysqldumpBin)) {
            mysqldumpBin = path.join(localServicesPath, mysqlDirs[0], 'bin', 'darwin-arm64', 'bin', 'mysqldump');
          }

          const exportCmd = `"${mysqldumpBin}" -uroot -proot --socket="${socketPath}" local > "${dbDumpPath}"`;
          execSync(exportCmd, { encoding: 'utf8', shell: '/bin/bash', stdio: 'pipe' });
        }

        sendProgress({ stage: 'database', progress: 75, message: 'Importing database on Kinsta...' });

        // Upload and import
        execSync(`scp -P ${link.sshPort} -o StrictHostKeyChecking=accept-new "${dbDumpPath}" ${link.sshUser}@${link.sshHost}:${remoteDbPath}`, { encoding: 'utf8', stdio: 'pipe' });
        execSync(`${sshCmd} ${link.sshUser}@${link.sshHost} "cd ~/public && wp db import ${remoteDbPath}"`, { encoding: 'utf8', stdio: 'pipe' });

        sendProgress({ stage: 'search-replace', progress: 85, message: 'Running search-replace...' });

        // Search-replace URLs
        const localDomain = site.domain;
        const remoteDomain = link.remoteDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');

        const srCmd = `${sshCmd} ${link.sshUser}@${link.sshHost} "cd ~/public && wp search-replace 'https://${localDomain}' 'https://${remoteDomain}' --all-tables --skip-columns=guid"`;
        execSync(srCmd, { encoding: 'utf8', stdio: 'pipe' });

        // Clear cache via API
        const apiKeyForCache = getApiKey();
        if (apiKeyForCache) {
          try {
            const client = getKinstaClient(apiKeyForCache);
            await client.post(`/sites/environments/${link.envId}/clear-cache`);
          } catch (e) {}
        }

        // Cleanup
        try {
          fs.unlinkSync(dbDumpPath);
          execSync(`${sshCmd} ${link.sshUser}@${link.sshHost} "rm -f ${remoteDbPath}"`, { stdio: 'pipe' });
        } catch (e) {}
      }

      sendProgress({ stage: 'done', progress: 100, message: 'Push complete!' });
      return { success: true };

    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  // Disconnect from Kinsta
  ipcMain.handle('kinsta:disconnect', async () => {
    deleteApiKey();
    saveConfig({});
    return { success: true };
  });
}
