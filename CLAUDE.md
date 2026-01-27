# Kinsta Sync Local Addon

## Project Overview

This is a Local by WP Engine addon that provides Kinsta hosting integration. It allows users to sync files and databases between their local WordPress sites and Kinsta environments.

## Architecture

### Main Process (`src/main/index.ts`)
- Handles IPC communication with renderer
- Manages Kinsta API calls
- Executes rsync/SSH commands for file sync
- Handles database export/import via MySQL
- Runs WP-CLI search-replace for URL replacements
- Stores API keys securely using Electron safeStorage

### Renderer Process (`src/renderer/`)
- `index.tsx` - Registers hooks with Local
- `KinstaSitePanel.tsx` - Toolbar button and link panel components
- `KinstaSettings.tsx` - Preferences panel for API configuration

## Key Hooks Used

- `SiteInfo_TabNav_Items` - Adds Kinsta button to toolbar
- `SiteInfoOverview` - Adds link panel for unlinked sites
- `preferencesMenuItems` - Adds Kinsta settings to preferences

## Data Storage

Config stored in `~/.kinsta-sync/`:
- `config.json` - Company ID
- `.api-key.enc` - Encrypted API key
- `sites.json` - Site links (Local site ID -> Kinsta environment)
- `tmp/` - Temporary SQL dumps

## Sync Process

### Pull
1. rsync files from Kinsta (excluding system files)
2. Export database on Kinsta via SSH + WP-CLI
3. Download SQL dump via SCP
4. Import to Local's MySQL via socket
5. Run WP-CLI search-replace (modifies wp-config.php temporarily for socket)
6. Cleanup temp files

### Push
1. rsync files to Kinsta (with --delete)
2. Export Local database via mysqldump
3. Upload SQL dump via SCP
4. Import on Kinsta via SSH + WP-CLI
5. Run search-replace on Kinsta
6. Clear Kinsta cache via API
7. Cleanup temp files

## Important Notes

- Local uses MySQL socket at `~/Library/Application Support/Local/run/{siteId}/mysql/mysqld.sock`
- PHP/MySQL binaries are in `~/Library/Application Support/Local/lightning-services/`
- WP-CLI phar is at `/Applications/Local.app/Contents/Resources/extraResources/bin/wp-cli/wp-cli.phar`
- Search-replace must use `--skip-columns=guid` to avoid breaking WordPress
- wp-config.php is temporarily modified to use socket path, then restored

## Build Commands

```bash
npm run build:main    # Compile TypeScript
npm run build:renderer # Bundle React with webpack
npm run build         # Both
```
