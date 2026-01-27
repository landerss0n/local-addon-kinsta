# Kinsta Sync for Local

A Local by WP Engine addon that enables seamless synchronization between your local WordPress sites and Kinsta hosting.

## Features

- **Pull from Kinsta** - Download files and database from your Kinsta site to Local
- **Push to Kinsta** - Upload files and database from Local to your Kinsta site
- **Smart Search-Replace** - Automatically handles URL replacements with proper serialized data support
- **Secure API Storage** - API keys are encrypted using Electron's safeStorage
- **Environment Support** - Works with both Live and Staging environments

## Installation

1. Clone or copy this addon to your Local addons directory:
   - macOS: `~/Library/Application Support/Local/addons/local-addon-kinsta`
   - Windows: `%APPDATA%\Local\addons\local-addon-kinsta`
   - Linux: `~/.config/Local/addons/local-addon-kinsta`

2. Install dependencies and build:
   ```bash
   npm install
   npm run build
   ```

3. Restart Local

## Configuration

1. Open Local and go to **Preferences > Kinsta**
2. Enter your Kinsta API key (create one at [MyKinsta](https://my.kinsta.com/account/api-keys))
3. Enter your Company ID
4. Click **Connect to Kinsta**

## Usage

### Linking a Site

1. Open a site in Local that you want to link to Kinsta
2. In the site overview, find the "Link to Kinsta" panel
3. Select your Kinsta site and environment (Live/Staging)
4. Click **Link Site**

### Syncing

Once linked, a **Kinsta** button appears in the site toolbar (next to WP Admin / Open Site):

- **Pull** - Downloads files and optionally database from Kinsta to Local
- **Push** - Uploads files and optionally database from Local to Kinsta
- Options:
  - **Database** - Include database in sync (with automatic search-replace)
  - **Uploads** - Include wp-content/uploads folder

## Requirements

- Local by WP Engine
- SSH key added to your Kinsta account
- Kinsta API key with appropriate permissions

## Excluded Files

The following files/folders are excluded from sync:
- `.git`, `node_modules`, `.DS_Store`
- `wp-config.php`, `.htaccess`, `php.ini`
- Kinsta mu-plugins (not needed locally)
- Cache directories
- SQL dump files

## Security

- API keys are stored encrypted using Electron's safeStorage API
- SSH connections use your existing SSH keys
- Push to production requires confirmation

## Development

```bash
# Install dependencies
npm install

# Build main process
npm run build:main

# Build renderer (UI)
npm run build:renderer

# Build both
npm run build

# Watch mode for renderer
npm run watch
```

## License

MIT
