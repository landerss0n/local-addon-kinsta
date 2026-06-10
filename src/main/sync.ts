import * as path from 'path';

import { EXCLUDE_PATTERNS, REMOTE_PUSH_BACKUP } from './constants';
import { CancelledError, ActiveSync, SyncParams, SyncResult, PullPushDeps } from './types';
import {
  getDbCredentials,
  isLikelyValidSqlDump,
  isValidDomain,
  searchReplacePairs,
} from './validators';
import {
  sshArgs,
  describePartialTransfer,
  rsyncProgressArgs,
  makeRsyncProgressParser,
  safeRemoteRelPath,
  buildPushRsyncArgs,
  rsyncSshContext,
} from './rsync';

// ---------------------------------------------------------------------------
// Pull / push orchestration (extracted from the IPC handlers so it can be
// integration-tested with injected seams — no real processes, network, or
// Local installation lookups). The handlers are thin wrappers around these.
// ---------------------------------------------------------------------------

export async function executePull(params: SyncParams, deps: PullPushDeps): Promise<SyncResult> {
  const { localSiteId, site, envInfo, options } = params;
  const dfs = deps.fs;
  const run = deps.runCommand;
  const sendProgress = deps.sendProgress;

  const links = deps.loadSiteLinks();
  const link = links[localSiteId];

  if (!link) {
    return { success: false, error: 'Site not linked to Kinsta' };
  }
  if (deps.activeSyncs.has(localSiteId)) {
    return { success: false, error: 'A sync is already running for this site' };
  }

  // Security: Validate environment data before using in shell commands
  if (!deps.validateEnvironmentInfo(envInfo)) {
    console.error('[Kinsta] Pull validation failed for:', envInfo);
    return { success: false, error: 'Invalid environment configuration.' };
  }

  // Pre-flight: database sync needs the local site running (MySQL socket)
  const socketPath = deps.getMysqlSocketPath(localSiteId);
  if (options.includeDatabase && !dfs.existsSync(socketPath)) {
    return {
      success: false,
      error:
        'The local site must be running for database sync. Start the site in Local and try again.',
    };
  }

  // Register the sync BEFORE the first await so a second concurrent call can't
  // slip past the "already running" guard during pre-flight (TOCTOU race).
  const sync: ActiveSync = { cancelled: false, child: null };
  deps.activeSyncs.set(localSiteId, sync);

  // Fail-fast: confirm the remote is reachable before any backup/transfer
  const pullPreflightError = await deps.preflightRemote(envInfo);
  if (pullPreflightError) {
    deps.activeSyncs.delete(localSiteId);
    return { success: false, error: pullPreflightError };
  }

  const startedAt = Date.now();

  // Once the local DB import starts, a cancel/crash leaves the database
  // half-written — these let the catch block restore the pre-pull backup.
  let dbImportStarted = false;
  const localBackupPath = path.join(deps.tempDir, `${localSiteId}-pre-pull-backup.sql`);
  const db = getDbCredentials(site);

  try {
    // Derive paths/SSH target inside the try so a throw here can't leak the
    // activeSyncs registration — the finally always unregisters.
    const { localPublicPath, sshCommandForRsync, remoteHost } = rsyncSshContext(site, envInfo);

    // Build exclude args (no shell — patterns are passed verbatim)
    const excludeArgs = EXCLUDE_PATTERNS.map((p) => `--exclude=${p}`);
    if (!options.includeUploads) {
      excludeArgs.push('--exclude=wp-content/uploads/');
    }

    // 1. Sync files (live progress, flags adapted to the rsync version)
    sendProgress({ stage: 'files', progress: 5, message: 'Syncing files from Kinsta...' });

    const rsync = deps.resolveRsync();
    const rsyncResult = await run(
      sync,
      rsync.bin,
      [
        '-az',
        ...rsyncProgressArgs(rsync),
        ...excludeArgs,
        '-e',
        sshCommandForRsync,
        `${remoteHost}:~/public/`,
        `${localPublicPath}/`,
      ],
      {
        // 23/24 = partial transfer (e.g. legacy non-UTF-8 filenames that
        // macOS can't store, or files vanishing on a live server) — warn
        // instead of failing the whole sync.
        okCodes: [23, 24],
        onStdout: makeRsyncProgressParser(rsync, (pct) => {
          // Files = 5–50% of the overall pull
          const overall = 5 + Math.round(pct * 0.45);
          sendProgress({
            stage: 'files',
            progress: overall,
            message: `Syncing files from Kinsta... ${pct}%`,
          });
        }),
      },
    );
    const fileWarning = describePartialTransfer(rsyncResult);

    sendProgress({
      stage: 'files',
      progress: 50,
      message: fileWarning ? 'Files synced (some skipped)' : 'Files synced!',
    });

    // 2. Database (if requested)
    if (options.includeDatabase) {
      const dbDumpPath = path.join(deps.tempDir, `${localSiteId}-remote.sql`);
      const remoteDbPath = '/tmp/kinsta-local-export.sql';

      const mysqlBin = deps.findServiceBinary(['mysql-', 'mariadb-'], 'mysql');
      const mysqldumpBin = deps.findServiceBinary(['mysql-', 'mariadb-'], 'mysqldump');
      if (!mysqlBin || !mysqldumpBin) {
        throw new Error("Could not find MySQL binaries in Local's lightning-services");
      }

      // Safety net: back up the local database before overwriting it
      sendProgress({
        stage: 'database',
        progress: 52,
        message: 'Backing up local database...',
      });
      await run(
        sync,
        mysqldumpBin,
        [`-u${db.user}`, `-p${db.password}`, `--socket=${socketPath}`, db.database],
        { stdoutFile: localBackupPath },
      );

      // The rollback safety net is only as good as this backup — refuse to
      // overwrite the local DB if the dump came out empty/truncated.
      const localBackupSize = dfs.existsSync(localBackupPath)
        ? dfs.statSync(localBackupPath).size
        : 0;
      if (!isLikelyValidSqlDump(localBackupSize)) {
        throw new Error(
          `Local database backup looks invalid (${localBackupSize} bytes) — aborting before overwriting the local database.`,
        );
      }

      sendProgress({
        stage: 'database',
        progress: 58,
        message: 'Exporting database from Kinsta...',
      });
      await run(sync, 'ssh', sshArgs(envInfo, `cd ~/public && wp db export ${remoteDbPath}`));

      sendProgress({ stage: 'database', progress: 65, message: 'Downloading database...' });
      await run(sync, 'scp', [
        '-P',
        envInfo.sshPort,
        '-o',
        'StrictHostKeyChecking=accept-new',
        `${remoteHost}:${remoteDbPath}`,
        dbDumpPath,
      ]);

      sendProgress({
        stage: 'database',
        progress: 75,
        message: 'Importing database locally...',
      });
      dbImportStarted = true;
      await run(
        sync,
        mysqlBin,
        [`-u${db.user}`, `-p${db.password}`, `--socket=${socketPath}`, db.database],
        { stdinFile: dbDumpPath },
      );

      sendProgress({
        stage: 'search-replace',
        progress: 82,
        message: 'Running search-replace...',
      });

      // Search-replace URLs using WP-CLI (handles serialized data correctly)
      const remoteDomain = envInfo.remoteDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const localDomain = site.domain;

      const phpBin = deps.findServiceBinary(['php-'], 'php');
      const wpCliPhar = deps.findWpCliPhar();
      if (!phpBin) throw new Error("Could not find PHP binary in Local's lightning-services");
      if (!wpCliPhar) throw new Error('Could not find WP-CLI in the Local installation');
      const mysqlBinDir = path.dirname(mysqlBin);

      // Temporarily modify wp-config.php to include socket path
      const wpConfigPath = path.join(localPublicPath, 'wp-config.php');
      const wpConfigBackupPath = wpConfigPath + '.kinsta-sync-bak';
      let wpConfigBackup: string | null = null;

      try {
        // Restore from backup if exists (previous crash)
        if (dfs.existsSync(wpConfigBackupPath)) {
          dfs.copyFileSync(wpConfigBackupPath, wpConfigPath);
          dfs.unlinkSync(wpConfigBackupPath);
        }

        wpConfigBackup = dfs.readFileSync(wpConfigPath, 'utf8');
        dfs.writeFileSync(wpConfigBackupPath, wpConfigBackup);

        const wpConfigModified = wpConfigBackup.replace(
          /define\s*\(\s*['"]DB_HOST['"]\s*,\s*['"]([^'"]*)['"]\s*\)/,
          `define('DB_HOST', 'localhost:${socketPath}')`,
        );
        dfs.writeFileSync(wpConfigPath, wpConfigModified);

        const wpEnv = { ...process.env, PATH: `${mysqlBinDir}:${process.env.PATH || ''}` };
        // MultiSite.No is the empty string, so truthiness is the correct check
        const networkArgs = site.multiSite ? ['--network'] : [];
        const pairs = searchReplacePairs(remoteDomain, localDomain);

        for (let i = 0; i < pairs.length; i++) {
          const [from, to] = pairs[i];
          sendProgress({
            stage: 'search-replace',
            progress: 84 + i * 4,
            message: `Replacing ${from} → ${to}`,
          });
          await run(
            sync,
            phpBin,
            [
              wpCliPhar,
              'search-replace',
              from,
              to,
              '--all-tables',
              '--skip-columns=guid',
              '--skip-plugins',
              '--skip-themes',
              `--path=${localPublicPath}`,
              '--allow-root',
              ...networkArgs,
            ],
            { env: wpEnv },
          );
        }

        sendProgress({
          stage: 'search-replace',
          progress: 96,
          message: 'Search-replace complete!',
        });
      } finally {
        // Always restore wp-config.php — but never let a restore failure mask the
        // original sync error (it gates the DB-rollback decision in the catch).
        try {
          if (wpConfigBackup) {
            dfs.writeFileSync(wpConfigPath, wpConfigBackup);
          }
          if (dfs.existsSync(wpConfigBackupPath)) {
            dfs.unlinkSync(wpConfigBackupPath);
          }
        } catch (e: any) {
          console.warn('[Kinsta] wp-config.php restore failed (non-fatal):', e?.message);
        }
      }

      // Cleanup (keep the pre-pull backup until the next pull)
      try {
        dfs.unlinkSync(dbDumpPath);
        await run(sync, 'ssh', sshArgs(envInfo, `rm -f ${remoteDbPath}`));
      } catch (e: any) {
        console.warn('[Kinsta] Temp dump cleanup failed (non-fatal):', e?.message);
      }
    }

    deps.recordSync(localSiteId, 'pull', envInfo.envType, Date.now() - startedAt);
    sendProgress({
      stage: 'done',
      progress: 100,
      message: fileWarning ? `Pull complete — ${fileWarning}` : 'Pull complete!',
    });
    deps.notify(
      'Kinsta Sync',
      fileWarning
        ? `Pull complete for ${site.name || site.domain} — some files were skipped (legacy filenames)`
        : `Pull complete for ${site.name || site.domain}`,
    );
    return { success: true, warning: fileWarning };
  } catch (error: any) {
    // The local DB was (partially) overwritten — a half-imported or
    // half-search-replaced database is unusable, so roll back to the
    // backup taken right before the import.
    if (dbImportStarted && dfs.existsSync(localBackupPath)) {
      try {
        sendProgress({
          stage: 'database',
          progress: 0,
          message: 'Restoring local database from backup...',
        });
        const mysqlBinRestore = deps.findServiceBinary(['mysql-', 'mariadb-'], 'mysql');
        if (!mysqlBinRestore) throw new Error('mysql binary not found');
        // Fresh ActiveSync — the cancelled one rejects every command
        await run(
          { cancelled: false, child: null },
          mysqlBinRestore,
          [`-u${db.user}`, `-p${db.password}`, `--socket=${socketPath}`, db.database],
          { stdinFile: localBackupPath },
        );
        deps.notify(
          'Kinsta Sync',
          `Pull aborted — local database for ${site.name || site.domain} was restored from backup`,
        );
      } catch (restoreError: any) {
        console.error('[Kinsta] DB restore after aborted pull failed:', restoreError.message);
        deps.notify(
          'Kinsta Sync',
          `Pull aborted — automatic DB restore FAILED. Backup: ${localBackupPath}`,
        );
      }
    }
    if (error instanceof CancelledError) {
      sendProgress({ stage: 'cancelled', progress: 0, message: 'Sync cancelled' });
      return { success: false, cancelled: true, error: 'Sync cancelled' };
    }
    sendProgress({ stage: 'error', progress: 0, message: error.message });
    deps.notify('Kinsta Sync', `Pull failed for ${site.name || site.domain}`);
    return { success: false, error: error.message };
  } finally {
    deps.activeSyncs.delete(localSiteId);
  }
}

export async function executePush(params: SyncParams, deps: PullPushDeps): Promise<SyncResult> {
  const { localSiteId, site, envInfo, options } = params;
  const dfs = deps.fs;
  const run = deps.runCommand;
  const sendProgress = deps.sendProgress;

  const links = deps.loadSiteLinks();
  const link = links[localSiteId];

  if (!link) {
    return { success: false, error: 'Site not linked to Kinsta' };
  }
  if (deps.activeSyncs.has(localSiteId)) {
    return { success: false, error: 'A sync is already running for this site' };
  }

  // Security: Validate environment data before using in shell commands
  if (!deps.validateEnvironmentInfo(envInfo)) {
    return { success: false, error: 'Invalid environment configuration.' };
  }

  // The local domain is interpolated into the remote search-replace shell
  // command (unlike pull, which passes it as a spawn arg) — reject shell-unsafe
  // domains before any destructive step.
  if (options.includeDatabase && !isValidDomain(site.domain)) {
    return { success: false, error: 'Invalid local site domain.' };
  }

  // Pre-flight: database sync needs the local site running (MySQL socket)
  const socketPath = deps.getMysqlSocketPath(localSiteId);
  if (options.includeDatabase && !dfs.existsSync(socketPath)) {
    return {
      success: false,
      error:
        'The local site must be running for database sync. Start the site in Local and try again.',
    };
  }

  // Register the sync BEFORE the first await so a second concurrent call can't
  // slip past the "already running" guard during pre-flight (TOCTOU race).
  const sync: ActiveSync = { cancelled: false, child: null };
  deps.activeSyncs.set(localSiteId, sync);

  // Fail-fast: confirm the remote is reachable before any backup/transfer
  const pushPreflightError = await deps.preflightRemote(envInfo);
  if (pushPreflightError) {
    deps.activeSyncs.delete(localSiteId);
    return { success: false, error: pushPreflightError };
  }

  // A leftover preview dry-run must not compete with the real push
  deps.activePreviews.get(localSiteId)?.child?.kill('SIGTERM');

  const startedAt = Date.now();

  // Once the remote DB import starts, a cancel/crash leaves the remote
  // database half-written — lets the catch block restore the remote backup.
  let remoteImportStarted = false;

  try {
    // Derive paths/SSH target inside the try so a throw here can't leak the
    // activeSyncs registration — the finally always unregisters.
    const { localPublicPath, sshCommandForRsync, remoteHost } = rsyncSshContext(site, envInfo);

    const excludeArgs = EXCLUDE_PATTERNS.map((p) => `--exclude=${p}`);
    if (!options.includeUploads) {
      excludeArgs.push('--exclude=wp-content/uploads/');
    }

    // 1a. Native Kinsta backup (files + DB) — restorable from MyKinsta.
    //     If enabled and it fails, abort the push: the user opted into the
    //     safety net, so don't proceed without it.
    if (options.kinstaBackup !== false) {
      const apiKeyForBackup = deps.getApiKey();
      if (apiKeyForBackup) {
        sendProgress({ stage: 'backup', progress: 2, message: 'Creating Kinsta backup...' });
        try {
          const client = deps.getKinstaClient(apiKeyForBackup);
          const created = await deps.createKinstaBackup(client, envInfo.envId, sync, (msg) => {
            sendProgress({ stage: 'backup', progress: 3, message: msg });
          });
          if (created) {
            sendProgress({ stage: 'backup', progress: 5, message: 'Kinsta backup created!' });
          } else {
            sendProgress({
              stage: 'backup',
              progress: 5,
              message: 'All 5 manual backup slots are yours — skipping Kinsta backup',
            });
            deps.notify(
              'Kinsta Sync',
              'Kinsta backup skipped: all 5 manual slots hold your own backups',
            );
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
    await run(sync, 'ssh', sshArgs(envInfo, `cd ~/public && wp db export ${REMOTE_PUSH_BACKUP}`));

    // Verify the remote backup is non-empty before touching anything — the
    // automatic rollback restores from this exact file. Abort if it looks bad
    // (server data is still untouched at this point).
    let remoteBackupWc = '';
    await run(sync, 'ssh', sshArgs(envInfo, `wc -c < ${REMOTE_PUSH_BACKUP}`), {
      onStdout: (c: string) => (remoteBackupWc += c),
    });
    const remoteBackupSize = parseInt(remoteBackupWc.trim(), 10) || 0;
    if (!isLikelyValidSqlDump(remoteBackupSize)) {
      throw new Error(
        `Remote database backup looks invalid (${remoteBackupSize} bytes) — aborting the push before any change. Your server was not modified.`,
      );
    }

    // 2. Sync files (live progress, flags adapted to the rsync version)
    sendProgress({ stage: 'files', progress: 8, message: 'Syncing files to Kinsta...' });

    const rsync = deps.resolveRsync();

    // Selective push (from the preview screen): only the checked files
    const selective = Array.isArray(options.files);
    let filesFromPath: string | undefined;
    if (selective) {
      filesFromPath = path.join(deps.tempDir, `${localSiteId}-push-files.txt`);
      deps.ensureConfigDir();
      // One path per line, relative to the rsync source root (~/public)
      dfs.writeFileSync(filesFromPath, (options.files || []).join('\n') + '\n');
    }

    let fileWarning: string | null = null;
    try {
      if (!selective || (options.files && options.files.length > 0)) {
        const rsyncResult = await run(
          sync,
          rsync.bin,
          buildPushRsyncArgs({
            rsync,
            excludeArgs,
            sshCommand: sshCommandForRsync,
            localPublicPath,
            remoteHost,
            mode: options.mode,
            filesFromPath,
          }),
          {
            // 23/24 = partial transfer — warn instead of failing the whole sync
            okCodes: [23, 24],
            onStdout: makeRsyncProgressParser(rsync, (pct) => {
              // Files = 8–50% of the overall push
              const overall = 8 + Math.round(pct * 0.42);
              sendProgress({
                stage: 'files',
                progress: overall,
                message: `Syncing files to Kinsta... ${pct}%`,
              });
            }),
          },
        );
        fileWarning = describePartialTransfer(rsyncResult);
      }
    } finally {
      if (filesFromPath) {
        try {
          dfs.unlinkSync(filesFromPath);
        } catch {}
      }
    }

    // Checked deletions from the preview — executed explicitly (instead of
    // rsync --delete) so unchecked deletions survive. Paths are strictly
    // validated + single-quoted (the one place a path enters a shell string).
    if (options.deletions && options.deletions.length > 0) {
      sendProgress({
        stage: 'files',
        progress: 48,
        message: `Deleting ${options.deletions.length} file(s) on Kinsta...`,
      });
      const quoted = options.deletions.map((p) => {
        const q = safeRemoteRelPath(p);
        if (!q) throw new Error(`Unsafe path refused for remote deletion: ${p}`);
        return q;
      });
      for (let i = 0; i < quoted.length; i += 200) {
        const batch = quoted.slice(i, i + 200);
        await run(sync, 'ssh', sshArgs(envInfo, `cd ~/public && rm -rf -- ${batch.join(' ')}`));
      }
    }

    sendProgress({
      stage: 'files',
      progress: 50,
      message: fileWarning ? 'Files synced (some skipped)' : 'Files synced!',
    });

    // 3. Database (if requested)
    if (options.includeDatabase) {
      const db = getDbCredentials(site);
      const dbDumpPath = path.join(deps.tempDir, `${localSiteId}-local.sql`);
      const remoteDbPath = '/tmp/kinsta-local-import.sql';

      const mysqldumpBin = deps.findServiceBinary(['mysql-', 'mariadb-'], 'mysqldump');
      if (!mysqldumpBin) {
        throw new Error("Could not find mysqldump in Local's lightning-services");
      }

      sendProgress({ stage: 'database', progress: 55, message: 'Exporting local database...' });
      await run(
        sync,
        mysqldumpBin,
        [`-u${db.user}`, `-p${db.password}`, `--socket=${socketPath}`, db.database],
        { stdoutFile: dbDumpPath },
      );

      sendProgress({ stage: 'database', progress: 65, message: 'Uploading database...' });
      await run(sync, 'scp', [
        '-P',
        envInfo.sshPort,
        '-o',
        'StrictHostKeyChecking=accept-new',
        dbDumpPath,
        `${remoteHost}:${remoteDbPath}`,
      ]);

      sendProgress({
        stage: 'database',
        progress: 75,
        message: 'Importing database on Kinsta...',
      });
      remoteImportStarted = true;
      await run(sync, 'ssh', sshArgs(envInfo, `cd ~/public && wp db import ${remoteDbPath}`));

      sendProgress({
        stage: 'search-replace',
        progress: 82,
        message: 'Running search-replace...',
      });

      const localDomain = site.domain;
      const remoteDomain = envInfo.remoteDomain.replace(/^https?:\/\//, '').replace(/\/$/, '');
      // MultiSite.No is the empty string, so truthiness is the correct check
      const networkFlag = site.multiSite ? ' --network' : '';
      const pairs = searchReplacePairs(localDomain, remoteDomain);

      for (let i = 0; i < pairs.length; i++) {
        const [from, to] = pairs[i];
        sendProgress({
          stage: 'search-replace',
          progress: 84 + i * 4,
          message: `Replacing ${from} → ${to}`,
        });
        await run(
          sync,
          'ssh',
          sshArgs(
            envInfo,
            `cd ~/public && wp search-replace '${from}' '${to}' --all-tables --skip-columns=guid${networkFlag}`,
          ),
        );
      }

      // Clear all Kinsta caches (page + edge + CDN) via API
      const apiKeyForCache = deps.getApiKey();
      if (apiKeyForCache) {
        sendProgress({ stage: 'cache', progress: 97, message: 'Clearing Kinsta caches...' });
        try {
          const client = deps.getKinstaClient(apiKeyForCache);
          await deps.clearKinstaCaches(client, envInfo.envId, envInfo.cdnCacheId);
        } catch (e: any) {
          // Non-fatal, but at least leave a trace this time
          console.error(
            '[Kinsta] Cache clear after push failed:',
            e.response?.data?.message || e.message,
          );
        }
      }

      // Cleanup
      try {
        dfs.unlinkSync(dbDumpPath);
        await run(sync, 'ssh', sshArgs(envInfo, `rm -f ${remoteDbPath}`));
      } catch (e: any) {
        console.warn('[Kinsta] Temp dump cleanup failed (non-fatal):', e?.message);
      }
    }

    deps.recordSync(localSiteId, 'push', envInfo.envType, Date.now() - startedAt);
    sendProgress({
      stage: 'done',
      progress: 100,
      message: fileWarning ? `Push complete — ${fileWarning}` : 'Push complete!',
    });
    deps.notify(
      'Kinsta Sync',
      fileWarning
        ? `Push complete for ${site.name || site.domain} — some files were skipped (legacy filenames)`
        : `Push complete for ${site.name || site.domain}`,
    );
    return { success: true, warning: fileWarning };
  } catch (error: any) {
    // The remote DB was (partially) overwritten — restore the backup we
    // exported on the remote before the import.
    if (remoteImportStarted) {
      try {
        sendProgress({
          stage: 'database',
          progress: 0,
          message: 'Restoring remote database from backup...',
        });
        // Fresh ActiveSync — the cancelled one rejects every command
        await run(
          { cancelled: false, child: null },
          'ssh',
          sshArgs(envInfo, `cd ~/public && wp db import ${REMOTE_PUSH_BACKUP}`),
        );
        deps.notify(
          'Kinsta Sync',
          `Push aborted — remote database for ${site.name || site.domain} was restored from backup`,
        );
      } catch (restoreError: any) {
        console.error(
          '[Kinsta] Remote DB restore after aborted push failed:',
          restoreError.message,
        );
        deps.notify(
          'Kinsta Sync',
          `Push aborted — automatic remote DB restore FAILED. Backup on server: ${REMOTE_PUSH_BACKUP}`,
        );
      }
    }
    if (error instanceof CancelledError) {
      sendProgress({ stage: 'cancelled', progress: 0, message: 'Sync cancelled' });
      return { success: false, cancelled: true, error: 'Sync cancelled' };
    }
    sendProgress({ stage: 'error', progress: 0, message: error.message });
    deps.notify('Kinsta Sync', `Push failed for ${site.name || site.domain}`);
    return { success: false, error: error.message };
  } finally {
    deps.activeSyncs.delete(localSiteId);
  }
}
