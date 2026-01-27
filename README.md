# Kinsta Sync for Local

A Local by WP Engine addon that enables seamless synchronization between your local WordPress sites and Kinsta hosting.

## Features

- **Pull from Kinsta** - Download files and database from your Kinsta site to Local
- **Push to Kinsta** - Upload files and database from Local to your Kinsta site
- **Smart Search-Replace** - Automatically handles URL replacements with proper serialized data support
- **Secure API Storage** - API keys are encrypted using Electron's safeStorage
- **Environment Support** - Works with both Production and Staging environments
- **Site Search** - Quickly find sites with search (useful for accounts with 100+ sites)

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

1. Click the **Kinsta** button on any site in Local
2. Enter your Kinsta API key (create one at [MyKinsta](https://my.kinsta.com/account/api-keys))
3. Enter your Company ID (found in MyKinsta → Company → Company Details)
4. Click **Connect**

## Usage

### Linking a Site

1. Open a site in Local
2. Click the **Kinsta** button in the toolbar
3. Search and select your Kinsta site from the list
4. Click **Link Site**

### Syncing

Once linked, click the **Kinsta** dropdown button to:

- **Pull from Kinsta** - Downloads from Kinsta to Local
- **Push to Kinsta** - Uploads from Local to Kinsta
- **Unlink Site** - Remove the connection

Sync options:
- **Include database** - Sync database with automatic search-replace
- **Include uploads folder** - Sync wp-content/uploads

Environment selection:
- Choose **Production** or **Staging** for each sync operation

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
- Push to Production requires confirmation dialog

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

## Documentation

- [Local Components Library](https://getflywheel.github.io/local-components/?path=/docs/alerts-alert--docs)
- [Local Addon Development](https://build.localwp.com/)

## License

MIT
