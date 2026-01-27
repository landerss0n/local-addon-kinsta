# Kinsta Sync Local Addon

## Documentation Links (ALWAYS READ FIRST)

- **Local Components Library**: https://getflywheel.github.io/local-components/?path=/docs/alerts-alert--docs
- **Local Addon Development**: https://build.localwp.com/

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
- `KinstaSitePanel.tsx` - Toolbar button with dropdown menu
- `KinstaLinkDrawer.tsx` - Drawer for connecting API and linking sites
- `KinstaSyncDrawer.tsx` - Drawer for pull/push sync operations
- `KinstaSettings.tsx` - Preferences panel for API configuration

## UI Components

### Kinsta Icons
Two versions of the official Kinsta icon are embedded as React components:
- `KinstaIconLight` - Light/beige background (#F9F5F3) - for dark theme
- `KinstaIconDark` - Dark background (#181516) - for light theme
- `KinstaIcon` - Theme-aware wrapper that auto-selects based on Local's theme

### Drawers (Custom Implementation)
Custom sliding drawer overlays from the right side. Used instead of FlyModal for:
- Site linking flow (KinstaLinkDrawer)
- Pull/Push operations (KinstaSyncDrawer)

### Button Styling
Toolbar button styled to match Local's pill-shaped buttons:
```css
border-radius: 50px;
border: 1px solid #51bb7b;
color: #51bb7b;
font-family: "Museo Sans Rounded";
font-size: 14px;
font-weight: 500;
height: 32px;
```

### Local Components Used
- `PrimaryButton`, `TextButton` - Action buttons
- `FlyModal` - Confirmation dialogs only (push to production)
- `InputSearch` - Search input with icon
- `RadioBlock` - Environment selection (Production/Staging)
- `Checkbox` - Sync options
- `ProgressBar` - Sync progress
- `Spinner` - Loading states
- `Title` - Headers

## Key Hooks Used

- `SiteInfo_TabNav_Items` - Adds Kinsta button to toolbar
- `preferencesMenuItems` - Adds Kinsta settings to preferences

## Data Storage

Config stored in `~/.kinsta-sync/`:
- `config.json` - Company ID
- `.api-key.enc` - Encrypted API key
- `sites.json` - Site links (Local site ID -> Kinsta site, not environment)
- `tmp/` - Temporary SQL dumps

## Site Linking

Sites are linked at the Kinsta site level (not environment level). When syncing, users select the target environment (Production or Staging) from a dropdown. This allows syncing to different environments without relinking.

The link drawer includes:
- Search functionality for sites (important for accounts with many sites)
- Alphabetical sorting
- Kinsta icons for each site

## Sync Process

### Pull
1. rsync files from Kinsta (excluding system files)
2. Export database on Kinsta via SSH + WP-CLI
3. Download SQL dump via SCP
4. Import to Local's MySQL via socket
5. Run WP-CLI search-replace (modifies wp-config.php temporarily for socket)
6. Cleanup temp files

### Push
1. Confirmation modal for production pushes
2. rsync files to Kinsta (with --delete)
3. Export Local database via mysqldump
4. Upload SQL dump via SCP
5. Import on Kinsta via SSH + WP-CLI
6. Run search-replace on Kinsta
7. Clear Kinsta cache via API
8. Cleanup temp files

## Important Notes

- Local uses MySQL socket at `~/Library/Application Support/Local/run/{siteId}/mysql/mysqld.sock`
- PHP/MySQL binaries are in `~/Library/Application Support/Local/lightning-services/`
- WP-CLI phar is at `/Applications/Local.app/Contents/Resources/extraResources/bin/wp-cli/wp-cli.phar`
- Search-replace must use `--skip-columns=guid` to avoid breaking WordPress
- wp-config.php is temporarily modified to use socket path, then restored
- "Live" environment renamed to "Production" throughout UI

## Build Commands

```bash
npm run build:main    # Compile TypeScript
npm run build:renderer # Bundle React with webpack
npm run build         # Both
```

## Known Issues / Workarounds

- `Button` component from local-components with `privateOptions` causes React error #130
- `FlySelect` with `optionsLoader` doesn't work reliably - use static `options` instead
- `<style>` tags in JSX render as text - use inline styles instead
- `InputSearch` onChange receives event object, not value: `(e) => setValue(e.target.value)`
