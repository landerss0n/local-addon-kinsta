import * as React from 'react';
import { useState, useEffect } from 'react';
import {
  FlyModal,
  PrimaryButton,
  TextButton,
  Checkbox,
  RadioBlock,
  ProgressBar,
  Spinner,
  Title,
} from '@getflywheel/local-components';

const { ipcRenderer } = window.require('electron');

// Kinsta icon - light background (for dark theme)
const KinstaIconLight = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g clipPath="url(#clip0_sync_light)">
      <path d="M0 24C0 10.7452 10.7452 0 24 0H96C109.254 0 120 10.7452 120 24V96C120 109.254 109.254 120 96 120H24C10.7452 120 0 109.254 0 96V24Z" fill="#F9F5F3"/>
      <mask id="mask0_sync_light" style={{ maskType: 'luminance' }} maskUnits="userSpaceOnUse" x="4" y="26" width="45" height="68">
        <path d="M38.3632 26.0246C44.0636 26.0246 48.6843 30.6453 48.6843 36.3456V83.6548C48.6843 89.3551 44.0636 93.9755 38.3632 93.9755C27.2161 93.9755 16.069 93.9755 4.92188 93.9755V26.0252C16.069 26.0237 27.2161 26.0246 38.3632 26.0246Z" fill="white"/>
      </mask>
      <g mask="url(#mask0_sync_light)">
        <path d="M30.4688 9.84363H147.721V110.279H30.4688V9.84363Z" fill="url(#paint0_sync_light)"/>
      </g>
      <mask id="mask1_sync_light" style={{ maskType: 'luminance' }} maskUnits="userSpaceOnUse" x="48" y="26" width="48" height="68">
        <path d="M85.3079 26.0252C91.0083 26.0252 95.629 30.646 95.629 36.3463V83.6554C95.629 89.3557 91.0083 93.9762 85.3079 93.9762L48.8301 93.9844L48.8301 26.0156L85.3079 26.0252Z" fill="white"/>
      </mask>
      <g mask="url(#mask1_sync_light)">
        <path d="M60 9.84375H177.252V110.279H60V9.84375Z" fill="url(#paint1_sync_light)"/>
      </g>
    </g>
    <defs>
      <linearGradient id="paint0_sync_light" x1="26.8484" y1="69.0531" x2="106.313" y2="43.7697" gradientUnits="userSpaceOnUse">
        <stop offset="0.182692" stopColor="#FE5A00"/>
        <stop offset="0.598914" stopColor="#FF0000"/>
      </linearGradient>
      <linearGradient id="paint1_sync_light" x1="56.3797" y1="69.0532" x2="135.844" y2="43.7698" gradientUnits="userSpaceOnUse">
        <stop offset="0.211538" stopColor="#FE5A00"/>
        <stop offset="0.634615" stopColor="#FF0000"/>
      </linearGradient>
      <clipPath id="clip0_sync_light">
        <rect width="120" height="120" fill="white"/>
      </clipPath>
    </defs>
  </svg>
);

// Kinsta icon - dark background (for light theme)
const KinstaIconDark = ({ size = 24 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g clipPath="url(#clip0_sync_dark)">
      <path d="M0 24C0 10.7452 10.7452 0 24 0H96C109.254 0 120 10.7452 120 24V96C120 109.254 109.254 120 96 120H24C10.7452 120 0 109.254 0 96V24Z" fill="#181516"/>
      <mask id="mask0_sync_dark" style={{ maskType: 'luminance' }} maskUnits="userSpaceOnUse" x="4" y="26" width="45" height="68">
        <path d="M38.3632 26.0246C44.0636 26.0246 48.6843 30.6453 48.6843 36.3456V83.6548C48.6843 89.3551 44.0636 93.9755 38.3632 93.9755C27.2161 93.9755 16.069 93.9755 4.92188 93.9755V26.0252C16.069 26.0237 27.2161 26.0246 38.3632 26.0246Z" fill="white"/>
      </mask>
      <g mask="url(#mask0_sync_dark)">
        <path d="M30.4688 9.84363H147.721V110.279H30.4688V9.84363Z" fill="url(#paint0_sync_dark)"/>
      </g>
      <mask id="mask1_sync_dark" style={{ maskType: 'luminance' }} maskUnits="userSpaceOnUse" x="48" y="26" width="48" height="68">
        <path d="M85.3079 26.0252C91.0083 26.0252 95.629 30.646 95.629 36.3463V83.6554C95.629 89.3557 91.0083 93.9762 85.3079 93.9762L48.8301 93.9844L48.8301 26.0156L85.3079 26.0252Z" fill="white"/>
      </mask>
      <g mask="url(#mask1_sync_dark)">
        <path d="M60 9.84375H177.252V110.279H60V9.84375Z" fill="url(#paint1_sync_dark)"/>
      </g>
    </g>
    <defs>
      <linearGradient id="paint0_sync_dark" x1="26.8484" y1="69.0531" x2="106.313" y2="43.7697" gradientUnits="userSpaceOnUse">
        <stop offset="0.182692" stopColor="#FE5A00"/>
        <stop offset="0.598914" stopColor="#FF0000"/>
      </linearGradient>
      <linearGradient id="paint1_sync_dark" x1="56.3797" y1="69.0532" x2="135.844" y2="43.7698" gradientUnits="userSpaceOnUse">
        <stop offset="0.211538" stopColor="#FE5A00"/>
        <stop offset="0.634615" stopColor="#FF0000"/>
      </linearGradient>
      <clipPath id="clip0_sync_dark">
        <rect width="120" height="120" fill="white"/>
      </clipPath>
    </defs>
  </svg>
);

// Theme-aware icon
const KinstaIcon = ({ size = 24 }: { size?: number }) => {
  const isDarkMode = typeof document !== 'undefined' &&
    (document.body.classList.contains('theme-dark') ||
     getComputedStyle(document.body).backgroundColor.includes('rgb(') &&
     parseInt(getComputedStyle(document.body).backgroundColor.split(',')[0].replace(/\D/g, '')) < 128);
  return isDarkMode !== false ? <KinstaIconLight size={size} /> : <KinstaIconDark size={size} />;
};

interface Environment {
  id: string;
  name: string;
  display_name: string;
  is_premium: boolean;
  cdn_cache_id?: string;
  primaryDomain?: { name: string };
  domains?: Array<{ name: string }>;
  ssh_connection?: {
    ssh_ip?: { external_ip: string };
    ssh_port?: string;
  };
}

interface SyncProgress {
  stage: string;
  progress: number;
  message: string;
}

interface EnvironmentInfo {
  envId: string;
  envType: 'staging' | 'live';
  sshHost: string;
  sshPort: string;
  sshUser: string;
  remoteDomain: string;
  cdnCacheId?: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  mode: 'pull' | 'push';
  site: any;
  siteLink: {
    kinstaSiteId: string;
    kinstaSiteName: string;
    kinstaSiteSlug?: string;
  };
}

const KinstaSyncDrawer: React.FC<Props> = ({ isOpen, onClose, mode, site, siteLink }) => {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedEnvId, setSelectedEnvId] = useState<string>('');
  const [includeDatabase, setIncludeDatabase] = useState(true);
  const [includeUploads, setIncludeUploads] = useState(false);
  const [kinstaBackup, setKinstaBackup] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && siteLink) {
      loadEnvironments();
      loadLastSynced();
    }
  }, [isOpen, siteLink]);

  useEffect(() => {
    const progressHandler = (_event: any, progress: SyncProgress & { siteId?: string }) => {
      // Events carry siteId — ignore other sites' syncs
      if (progress.siteId && progress.siteId !== site.id) return;
      if (progress.stage === 'error' || progress.stage === 'cancelled') return; // handled via invoke result
      setSyncProgress(progress);
      if (progress.stage === 'done') {
        setIsComplete(true);
        setIsSyncing(false);
      }
    };

    ipcRenderer.on('kinsta:syncProgress', progressHandler);
    return () => {
      ipcRenderer.removeListener('kinsta:syncProgress', progressHandler);
    };
  }, [site.id]);

  const loadEnvironments = async () => {
    const result = await ipcRenderer.invoke('kinsta:getEnvironments', siteLink.kinstaSiteId);
    if (result.success) {
      setEnvironments(result.environments);
      if (result.environments.length > 0) {
        setSelectedEnvId(result.environments[0].id);
      }
    }
  };

  // The stored link carries lastPullAt/lastPushAt timestamps
  const loadLastSynced = async () => {
    const link = await ipcRenderer.invoke('kinsta:getSiteLink', site.id);
    const ts = mode === 'pull' ? link?.lastPullAt : link?.lastPushAt;
    setLastSyncedAt(ts || null);
  };

  const handleCancel = async () => {
    setIsCancelling(true);
    await ipcRenderer.invoke('kinsta:cancelSync', site.id);
  };

  const getSelectedEnvInfo = (): EnvironmentInfo | null => {
    const env = environments.find(e => e.id === selectedEnvId);
    if (!env || !siteLink) return null;

    const siteName = siteLink.kinstaSiteSlug || siteLink.kinstaSiteName;
    const sshUser = siteName.toLowerCase().replace(/[^a-z0-9]/g, '');

    return {
      envId: env.id,
      envType: env.is_premium ? 'live' : 'staging',
      sshHost: env.ssh_connection?.ssh_ip?.external_ip || '',
      sshPort: String(env.ssh_connection?.ssh_port || '22'),
      sshUser,
      remoteDomain: env.primaryDomain?.name || env.domains?.[0]?.name || '',
      cdnCacheId: env.cdn_cache_id
    };
  };

  const handleSyncClick = () => {
    if (mode === 'push') {
      setShowConfirmModal(true);
    } else {
      executeSync();
    }
  };

  const executeSync = async () => {
    setShowConfirmModal(false);
    const envInfo = getSelectedEnvInfo();
    if (!envInfo) {
      setError('Please select an environment');
      return;
    }

    setIsSyncing(true);
    setError(null);
    setIsComplete(false);
    setSyncProgress({ stage: 'starting', progress: 0, message: 'Starting ' + mode + '...' });

    const action = mode === 'pull' ? 'kinsta:pull' : 'kinsta:push';
    const result = await ipcRenderer.invoke(action, site.id, site, envInfo, {
      includeUploads,
      includeDatabase,
      kinstaBackup
    });

    if (result.success) {
      loadLastSynced();
    } else {
      // Cancelled syncs return to the form without an error banner
      setError(result.cancelled ? null : result.error);
      setIsSyncing(false);
      setIsCancelling(false);
      setSyncProgress(null);
    }
  };

  const handleClose = () => {
    if (!isSyncing) {
      setError(null);
      setIsComplete(false);
      setIsCancelling(false);
      setSyncProgress(null);
      setShowConfirmModal(false);
      onClose();
    }
  };

  const selectedEnv = environments.find(e => e.id === selectedEnvId);
  const isPush = mode === 'push';
  const isLive = selectedEnv?.is_premium;

  // Build radio options
  const envOptions: { [key: string]: any } = {};
  environments.forEach(env => {
    const envLabel = env.is_premium ? 'Production' : 'Staging';
    const domain = env.primaryDomain?.name || env.domains?.[0]?.name || env.display_name;
    envOptions[env.id] = {
      label: (
        <div style={{ textAlign: 'left' }}>
          <div style={{ fontWeight: 600 }}>{envLabel}</div>
          <div style={{ fontSize: '12px', opacity: 0.7 }}>
            {domain}
          </div>
        </div>
      )
    };
  });

  // Drawer overlay styles
  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    zIndex: 9998,
    opacity: isOpen ? 1 : 0,
    visibility: isOpen ? 'visible' : 'hidden',
    transition: 'opacity 0.3s ease, visibility 0.3s ease',
  };

  const drawerStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: '480px',
    backgroundColor: '#292929',
    zIndex: 9999,
    transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
    transition: 'transform 0.3s ease',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '-4px 0 20px rgba(0, 0, 0, 0.3)',
  };

  const headerStyle: React.CSSProperties = {
    padding: '20px 24px',
    borderBottom: '1px solid #3e3e3e',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  };

  const contentStyle: React.CSSProperties = {
    flex: 1,
    padding: '24px',
    overflowY: 'auto',
  };

  const footerStyle: React.CSSProperties = {
    padding: '20px 24px',
    borderTop: '1px solid #3e3e3e',
  };

  return (
    <>
      {/* Drawer Overlay */}
      <div style={overlayStyle} onClick={handleClose} />

      {/* Drawer Panel */}
      <div style={drawerStyle}>
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <KinstaIcon size={28} />
            <div>
              <Title size="s" style={{ margin: 0 }}>
                {isPush ? 'Push to' : 'Pull from'} Kinsta
              </Title>
              <span style={{ fontSize: '13px', opacity: 0.7 }}>
                {siteLink.kinstaSiteName}
              </span>
            </div>
          </div>
          <button
            onClick={handleClose}
            disabled={isSyncing}
            style={{
              background: 'none',
              border: 'none',
              cursor: isSyncing ? 'not-allowed' : 'pointer',
              padding: '8px',
              opacity: isSyncing ? 0.5 : 1,
            }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div style={contentStyle}>
          {!isSyncing && !isComplete && (
            <>
              {/* Environment Selection */}
              <div style={{ marginBottom: '24px' }}>
                <span style={{
                  display: 'block',
                  marginBottom: '12px',
                  fontWeight: 600,
                  fontSize: '14px',
                }}>
                  Select environment
                </span>

                {environments.length > 0 ? (
                  <RadioBlock
                    options={envOptions}
                    default={selectedEnvId}
                    onChange={(value: string) => setSelectedEnvId(value)}
                    direction="vert"
                  />
                ) : (
                  <div style={{ padding: '20px', textAlign: 'center' }}>
                    <Spinner />
                  </div>
                )}
              </div>

              {/* Options */}
              <div style={{ marginBottom: '24px' }}>
                <span style={{
                  display: 'block',
                  marginBottom: '12px',
                  fontWeight: 600,
                  fontSize: '14px',
                }}>
                  Options
                </span>
                <div style={{
                  backgroundColor: '#1e1e1e',
                  borderRadius: '8px',
                  padding: '16px',
                }}>
                  <Checkbox
                    label="Include database"
                    checked={includeDatabase}
                    onChange={(e: any) => setIncludeDatabase(e.target.checked)}
                  />
                  <div style={{ height: '12px' }} />
                  <Checkbox
                    label="Include uploads folder"
                    checked={includeUploads}
                    onChange={(e: any) => setIncludeUploads(e.target.checked)}
                  />
                  {isPush && (
                    <>
                      <div style={{ height: '12px' }} />
                      <Checkbox
                        label="Create Kinsta backup first (files + database)"
                        checked={kinstaBackup}
                        onChange={(e: any) => setKinstaBackup(e.target.checked)}
                      />
                    </>
                  )}
                </div>
              </div>

              {/* Info box */}
              <div style={{
                backgroundColor: isPush ? 'rgba(252, 196, 25, 0.1)' : 'rgba(80, 192, 131, 0.1)',
                border: `1px solid ${isPush ? 'rgba(252, 196, 25, 0.3)' : 'rgba(80, 192, 131, 0.3)'}`,
                borderRadius: '8px',
                padding: '16px',
              }}>
                <div style={{ display: 'flex', gap: '12px' }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={isPush ? '#fcc419' : '#50c083'} strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4M12 8h.01" />
                  </svg>
                  <div style={{ fontSize: '13px', opacity: 0.9 }}>
                    {isPush ? (
                      <>
                        Your local files will be uploaded to <strong>{selectedEnv?.is_premium ? 'Production' : 'Staging'}</strong>.
                        {includeDatabase && ' The remote database will be replaced with your local database.'}
                      </>
                    ) : (
                      <>
                        Remote files will be downloaded from <strong>{selectedEnv?.is_premium ? 'Production' : 'Staging'}</strong>.
                        {includeDatabase && ' Your local database will be replaced.'}
                      </>
                    )}
                  </div>
                </div>
              </div>

              {lastSyncedAt && (
                <div style={{
                  marginTop: '12px',
                  fontSize: '12px',
                  opacity: 0.6,
                }}>
                  Last {isPush ? 'pushed' : 'pulled'}: {new Date(lastSyncedAt).toLocaleString()}
                </div>
              )}

              {error && (
                <div style={{
                  marginTop: '16px',
                  padding: '12px 16px',
                  backgroundColor: 'rgba(208, 77, 92, 0.1)',
                  border: '1px solid rgba(208, 77, 92, 0.3)',
                  borderRadius: '8px',
                  color: '#d04d5c',
                  fontSize: '13px',
                  whiteSpace: 'pre-wrap',
                  fontFamily: 'monospace',
                  maxHeight: '160px',
                  overflowY: 'auto',
                }}>
                  {error}
                </div>
              )}
            </>
          )}

          {/* Syncing State */}
          {isSyncing && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              textAlign: 'center',
            }}>
              <div style={{
                width: '80px',
                height: '80px',
                borderRadius: '50%',
                backgroundColor: 'rgba(80, 192, 131, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: '24px',
              }}>
                <Spinner />
              </div>
              <Title size="m" style={{ marginBottom: '8px' }}>
                {isPush ? 'Pushing' : 'Pulling'}...
              </Title>
              <span style={{ opacity: 0.7, marginBottom: '24px', display: 'block' }}>
                {syncProgress?.message || 'Please wait...'}
              </span>
              <div style={{ width: '100%', maxWidth: '300px' }}>
                <ProgressBar progress={syncProgress?.progress || 0} />
              </div>
              <div style={{ marginTop: '24px' }}>
                <TextButton onClick={handleCancel} disabled={isCancelling}>
                  {isCancelling ? 'Cancelling...' : 'Cancel'}
                </TextButton>
              </div>
            </div>
          )}

          {/* Complete State */}
          {isComplete && (
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              textAlign: 'center',
            }}>
              <div style={{
                width: '80px',
                height: '80px',
                borderRadius: '50%',
                backgroundColor: 'rgba(80, 192, 131, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: '24px',
              }}>
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#50c083" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <Title size="m" style={{ marginBottom: '8px', color: '#50c083' }}>
                {isPush ? 'Push' : 'Pull'} Complete!
              </Title>
              <span style={{ opacity: 0.7, marginBottom: '24px', display: 'block' }}>
                Your site has been synced successfully.
              </span>
              <TextButton onClick={handleClose}>
                Close
              </TextButton>
            </div>
          )}
        </div>

        {/* Footer */}
        {!isSyncing && !isComplete && (
          <div style={footerStyle}>
            {isPush && isLive && (
              <div style={{
                marginBottom: '12px',
                color: '#fcc419',
                fontSize: '12px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
                Warning: This will overwrite the production site
              </div>
            )}
            <PrimaryButton
              onClick={handleSyncClick}
              disabled={!selectedEnvId || environments.length === 0}
              style={{ width: '100%' }}
            >
              {isPush ? 'Push to ' : 'Pull from '}{isLive ? 'Production' : 'Staging'}
            </PrimaryButton>
          </div>
        )}
      </div>

      {/* Confirmation Modal for Push */}
      <FlyModal
        isOpen={showConfirmModal}
        onRequestClose={() => setShowConfirmModal(false)}
        contentLabel="Confirm Push"
      >
        <div style={{ padding: '30px', maxWidth: '400px', textAlign: 'center' }}>
          <div style={{
            width: '64px',
            height: '64px',
            borderRadius: '50%',
            backgroundColor: isLive ? 'rgba(208, 77, 92, 0.15)' : 'rgba(252, 196, 25, 0.15)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 20px',
          }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke={isLive ? '#d04d5c' : '#fcc419'} strokeWidth="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>

          <Title size="l" style={{ marginBottom: '12px' }}>
            Push to {isLive ? 'Production' : 'Staging'}?
          </Title>

          <p style={{
            color: '#888',
            fontSize: '14px',
            marginBottom: '24px',
            lineHeight: 1.5,
          }}>
            {isLive ? (
              <>
                This will overwrite your <strong style={{ color: '#d04d5c' }}>production site</strong>.
                {includeDatabase && ' The production database will be replaced with your local database.'}
                {' '}This action cannot be undone.
              </>
            ) : (
              <>
                This will overwrite your staging site.
                {includeDatabase && ' The staging database will be replaced with your local database.'}
              </>
            )}
          </p>

          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            <TextButton onClick={() => setShowConfirmModal(false)}>
              Cancel
            </TextButton>
            <PrimaryButton
              onClick={executeSync}
              style={isLive ? {
                backgroundColor: '#d04d5c',
                borderColor: '#d04d5c'
              } : undefined}
            >
              Yes, Push to {isLive ? 'Production' : 'Staging'}
            </PrimaryButton>
          </div>
        </div>
      </FlyModal>
    </>
  );
};

export default KinstaSyncDrawer;
