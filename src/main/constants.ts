import * as path from 'path';
import * as os from 'os';

export const KINSTA_API_BASE = 'https://api.kinsta.com/v2';

// Legacy config location (pre userDataPath migration)
export const LEGACY_CONFIG_DIR = path.join(os.homedir(), '.kinsta-sync');

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
  'wp-content/mu-plugins/kinsta-mu-plugins.php',
  // Local-generated helper file in the webroot — never part of the WP site
  'local-xdebuginfo.php',
];

export const HISTORY_LIMIT = 10;

// A valid WP database dump (mysqldump / `wp db export`) always carries the
// header/footer boilerplate, so it is comfortably larger than this. A 0-byte or
// truncated file means the backup failed — restoring from it would be worse than
// useless, so we refuse to proceed with the destructive import.
export const MIN_DUMP_BYTES = 200;

export const KINSTA_BACKUP_TAG = 'kinsta-sync-pre-push';
export const MANUAL_BACKUP_LIMIT = 5;

// Remote pre-push DB dump (home dir, outside ~/public). The automatic rollback
// restores from this exact path — keep the export, size-check, and restore in
// lockstep so a typo can't silently break the rollback net.
export const REMOTE_PUSH_BACKUP = '~/kinsta-sync-pre-push-backup.sql';
