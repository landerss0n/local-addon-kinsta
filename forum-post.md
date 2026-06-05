Hi all!

I wanted this badly enough that I ended up building it myself — a free, open-source add-on that syncs sites between Local and Kinsta:

**https://github.com/landerss0n/local-addon-kinsta**

What it does:

- **Pull and push** files + database between Local and Kinsta (Production or Staging)
- Automatic URL search-replace (https/http/protocol-relative, multisite-aware, skips `guid`)
- Safety nets everywhere: local + remote DB backups before every destructive step, an optional native Kinsta backup before push (on by default), and automatic rollback if a sync fails or is cancelled mid-import
- Live progress, cancellable syncs, and it clears Kinsta's page/edge/CDN caches after a push
- Your Kinsta API key is encrypted at rest (Electron safeStorage) and never leaves your machine except to api.kinsta.com; transfers run over SSH with your own keys

Install: grab the `.tgz` from the [latest release](https://github.com/landerss0n/local-addon-kinsta/releases) and use **Add-ons → Install from disk** in Local. macOS/Linux only (it shells out to rsync/ssh). You'll need a Kinsta API key and your SSH key added in MyKinsta.

Fun fact: I built the whole thing with [Claude Code](https://claude.com/claude-code) — including digging through Local's add-on API to find the most native way to integrate (spoiler: the Connect tab is hardcoded to WP Engine/Flywheel, so this lives as its own page under the site's More menu, which is the documented pattern for third-party integrations).

It's a community project — not affiliated with Kinsta or WP Engine. Issues and PRs welcome on GitHub. Would love feedback if anyone tries it!
