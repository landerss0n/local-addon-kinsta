import * as React from 'react';
import { useState, useEffect } from 'react';

const { ipcRenderer } = window.require('electron');

interface SiteLink {
  localSiteId: string;
  kinstaSiteId: string;
  kinstaSiteName: string;      // Display name for UI
  kinstaSiteSlug?: string;     // Actual site name for SSH username (optional for backwards compat)
}

interface EnvironmentInfo {
  envId: string;
  envType: 'staging' | 'live';
  sshHost: string;
  sshPort: string;
  sshUser: string;
  remoteDomain: string;
}

interface KinstaSite {
  id: string;
  name: string;
  display_name: string;
}

interface Environment {
  id: string;
  name: string;
  display_name: string;
  is_premium: boolean;
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

interface Props {
  site: any;
}

// Compact toolbar button component
export const KinstaToolbarButton: React.FC<Props> = ({ site }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [siteLink, setSiteLink] = useState<SiteLink | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [includeDatabase, setIncludeDatabase] = useState(true);
  const [includeUploads, setIncludeUploads] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmPush, setConfirmPush] = useState(false);
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedEnvId, setSelectedEnvId] = useState<string>('');

  useEffect(() => {
    checkConnection();
    loadSiteLink();

    const progressHandler = (_event: any, progress: SyncProgress) => {
      setSyncProgress(progress);
      if (progress.stage === 'done') {
        // Keep dropdown open so user sees completion, just reset syncing state after a moment
        setTimeout(() => {
          setIsSyncing(false);
          // Keep syncProgress to show "done" state until user closes dropdown
        }, 1500);
      }
    };

    ipcRenderer.on('kinsta:syncProgress', progressHandler);
    return () => {
      ipcRenderer.removeListener('kinsta:syncProgress', progressHandler);
    };
  }, [site.id]);

  const checkConnection = async () => {
    const config = await ipcRenderer.invoke('kinsta:getConfig');
    setIsConnected(!!config.apiKey);
  };

  const loadSiteLink = async () => {
    const link = await ipcRenderer.invoke('kinsta:getSiteLink', site.id);
    setSiteLink(link);
  };

  const loadEnvironments = async () => {
    if (!siteLink) return;
    const result = await ipcRenderer.invoke('kinsta:getEnvironments', siteLink.kinstaSiteId);
    if (result.success) {
      setEnvironments(result.environments);
      // Auto-select first environment if none selected
      if (!selectedEnvId && result.environments.length > 0) {
        setSelectedEnvId(result.environments[0].id);
      }
    }
  };

  const getSelectedEnvInfo = (): EnvironmentInfo | null => {
    const env = environments.find(e => e.id === selectedEnvId);
    if (!env || !siteLink) return null;

    // Use site slug for SSH username, fallback to name for backwards compatibility
    const siteName = siteLink.kinstaSiteSlug || siteLink.kinstaSiteName;
    const sshUser = siteName.toLowerCase().replace(/[^a-z0-9]/g, '');

    return {
      envId: env.id,
      envType: env.is_premium ? 'live' : 'staging',
      sshHost: env.ssh_connection?.ssh_ip?.external_ip || '',
      sshPort: String(env.ssh_connection?.ssh_port || '22'),
      sshUser,
      remoteDomain: env.primaryDomain?.name || env.domains?.[0]?.name || ''
    };
  };

  const handlePull = async () => {
    const envInfo = getSelectedEnvInfo();
    if (!envInfo) {
      setError('Please select an environment');
      return;
    }
    setIsSyncing(true);
    setError(null);
    setSyncProgress({ stage: 'starting', progress: 0, message: 'Starting pull...' });

    const result = await ipcRenderer.invoke('kinsta:pull', site.id, site, envInfo, {
      includeUploads,
      includeDatabase
    });

    if (!result.success) {
      setError(result.error);
      setIsSyncing(false);
      setSyncProgress(null);
    }
  };

  const handlePushClick = () => {
    setConfirmPush(true);
  };

  const handlePushConfirm = async () => {
    const envInfo = getSelectedEnvInfo();
    if (!envInfo) {
      setError('Please select an environment');
      return;
    }
    setConfirmPush(false);
    setIsSyncing(true);
    setError(null);
    setSyncProgress({ stage: 'starting', progress: 0, message: 'Starting push...' });

    const result = await ipcRenderer.invoke('kinsta:push', site.id, site, envInfo, {
      includeUploads,
      includeDatabase
    });

    if (!result.success) {
      setError(result.error);
      setIsSyncing(false);
      setSyncProgress(null);
    }
  };

  const handlePushCancel = () => {
    setConfirmPush(false);
  };

  // Not connected or not linked - don't show button
  if (!isConnected || !siteLink) {
    return null;
  }

  // Match WP Admin / Open site button style exactly
  const buttonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 15px',
    backgroundColor: 'transparent',
    border: '2px solid #50c083',
    borderRadius: '100px',
    color: '#50c083',
    fontSize: '14px',
    fontWeight: 700,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    position: 'relative',
    fontFamily: 'inherit',
    lineHeight: 1,
    marginLeft: '10px',
  };

  const dropdownStyle: React.CSSProperties = {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: '8px',
    backgroundColor: '#2b2b2b',
    border: '1px solid #3e3e3e',
    borderRadius: '6px',
    padding: '12px',
    minWidth: '220px',
    zIndex: 1000,
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
  };

  // Match outline button style for Pull/Push
  const actionButtonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    padding: '6px 15px',
    borderRadius: '100px',
    border: '2px solid #50c083',
    backgroundColor: 'transparent',
    color: '#50c083',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 700,
    flex: 1,
    transition: 'all 0.15s ease',
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        style={buttonStyle}
        onClick={() => {
          if (!showDropdown) {
            loadEnvironments();
          }
          setShowDropdown(!showDropdown);
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = 'rgba(80, 192, 131, 0.1)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <svg width="15" height="15" viewBox="0 0 40 40" fill="currentColor">
          <path d="M20 0C8.954 0 0 8.954 0 20s8.954 20 20 20 20-8.954 20-20S31.046 0 20 0zm0 36c-8.837 0-16-7.163-16-16S11.163 4 20 4s16 7.163 16 16-7.163 16-16 16z"/>
          <circle cx="20" cy="20" r="6" />
        </svg>
        Kinsta
      </button>

      {showDropdown && (
        <>
          <div
            style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }}
            onClick={() => {
              setShowDropdown(false);
              setSyncProgress(null);
            }}
          />
          <div style={dropdownStyle}>
            {isSyncing && syncProgress ? (
              <div>
                <div style={{
                  height: '4px',
                  backgroundColor: '#3e3e3e',
                  borderRadius: '2px',
                  overflow: 'hidden',
                  marginBottom: '8px',
                }}>
                  <div style={{
                    height: '100%',
                    width: `${syncProgress.progress}%`,
                    backgroundColor: '#51cf66',
                    transition: 'width 0.3s ease',
                  }} />
                </div>
                <span style={{ fontSize: '12px', color: '#9b9b9b' }}>{syncProgress.message}</span>
              </div>
            ) : syncProgress?.stage === 'done' ? (
              <div style={{ textAlign: 'center', padding: '20px 0' }}>
                <div style={{
                  width: '48px',
                  height: '48px',
                  borderRadius: '50%',
                  backgroundColor: 'rgba(81, 207, 102, 0.2)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  margin: '0 auto 12px',
                }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#51cf66" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <div style={{ fontSize: '14px', fontWeight: 600, color: '#51cf66', marginBottom: '4px' }}>
                  Sync Complete!
                </div>
                <div style={{ fontSize: '12px', color: '#888' }}>
                  {syncProgress.message}
                </div>
                <button
                  style={{
                    marginTop: '16px',
                    padding: '6px 20px',
                    backgroundColor: 'transparent',
                    border: '2px solid #3e3e3e',
                    borderRadius: '100px',
                    color: '#888',
                    fontSize: '12px',
                    cursor: 'pointer',
                  }}
                  onClick={() => {
                    setSyncProgress(null);
                    setShowDropdown(false);
                  }}
                >
                  Close
                </button>
              </div>
            ) : (
              <>
                <div style={{ marginBottom: '12px', paddingBottom: '10px', borderBottom: '1px solid #3e3e3e' }}>
                  <div style={{ fontSize: '11px', color: '#888', marginBottom: '6px' }}>{siteLink.kinstaSiteName}</div>
                  <select
                    value={selectedEnvId}
                    onChange={(e) => setSelectedEnvId(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '6px 10px',
                      backgroundColor: '#1e1e1e',
                      border: '2px solid #3e3e3e',
                      borderRadius: '100px',
                      color: '#fff',
                      fontSize: '12px',
                      fontWeight: 500,
                      outline: 'none',
                      cursor: 'pointer',
                      appearance: 'none',
                      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2350c083' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
                      backgroundRepeat: 'no-repeat',
                      backgroundPosition: 'right 10px center',
                      paddingRight: '28px',
                    }}
                  >
                    {environments.length === 0 && <option value="">Loading...</option>}
                    {environments.map(env => (
                      <option key={env.id} value={env.id}>
                        {env.is_premium ? '🟢 Live' : '🟡 Staging'} - {env.primaryDomain?.name || env.domains?.[0]?.name || env.display_name}
                      </option>
                    ))}
                  </select>
                </div>

                {error && (
                  <div style={{
                    fontSize: '11px',
                    color: '#ff6b6b',
                    padding: '8px',
                    backgroundColor: 'rgba(255,107,107,0.1)',
                    borderRadius: '4px',
                    marginBottom: '10px',
                    maxHeight: '60px',
                    overflow: 'auto',
                  }}>
                    {error}
                  </div>
                )}

                <div style={{ marginBottom: '12px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#ccc', cursor: 'pointer', marginBottom: '6px' }}>
                    <input
                      type="checkbox"
                      checked={includeDatabase}
                      onChange={(e) => setIncludeDatabase(e.target.checked)}
                      style={{ accentColor: '#51cf66' }}
                    />
                    Database
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#ccc', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={includeUploads}
                      onChange={(e) => setIncludeUploads(e.target.checked)}
                      style={{ accentColor: '#51cf66' }}
                    />
                    Uploads
                  </label>
                </div>

                {confirmPush ? (() => {
                  const selectedEnv = environments.find(e => e.id === selectedEnvId);
                  const isLive = selectedEnv?.is_premium;
                  return (
                    <div>
                      <div style={{
                        padding: '12px',
                        backgroundColor: 'rgba(255, 107, 107, 0.1)',
                        borderRadius: '6px',
                        marginBottom: '12px',
                        border: '1px solid rgba(255, 107, 107, 0.3)',
                      }}>
                        <div style={{ fontSize: '13px', color: '#ff6b6b', fontWeight: 600, marginBottom: '4px' }}>
                          Push to {isLive ? 'Live' : 'Staging'}?
                        </div>
                        <div style={{ fontSize: '12px', color: '#888' }}>
                          This will overwrite the remote site with your local changes.
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '10px' }}>
                        <button
                          style={{
                            ...actionButtonStyle,
                            border: '2px solid #666',
                            color: '#888',
                          }}
                          onClick={handlePushCancel}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = 'rgba(102, 102, 102, 0.1)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = 'transparent';
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          style={{
                            ...actionButtonStyle,
                            border: '2px solid #ff6b6b',
                            color: '#ff6b6b',
                          }}
                          onClick={handlePushConfirm}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.backgroundColor = 'rgba(255, 107, 107, 0.1)';
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.backgroundColor = 'transparent';
                          }}
                        >
                          Confirm Push
                        </button>
                      </div>
                    </div>
                  );
                })() : (() => {
                  const selectedEnv = environments.find(e => e.id === selectedEnvId);
                  const isLive = selectedEnv?.is_premium;
                  return (
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <button
                        style={actionButtonStyle}
                        onClick={handlePull}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = 'rgba(80, 192, 131, 0.1)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = 'transparent';
                        }}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M8 17.929H6a4 4 0 0 1-1.5-7.714A6 6 0 0 1 16.5 8.5h.5a4 4 0 0 1 1 7.857" />
                          <path d="M12 13v8" />
                          <path d="M8 17l4 4 4-4" />
                        </svg>
                        Pull
                      </button>
                      <button
                        style={{
                          ...actionButtonStyle,
                          border: `2px solid ${isLive ? '#ff6b6b' : '#50c083'}`,
                          color: isLive ? '#ff6b6b' : '#50c083',
                        }}
                        onClick={handlePushClick}
                        onMouseEnter={(e) => {
                          const color = isLive ? 'rgba(255, 107, 107, 0.1)' : 'rgba(80, 192, 131, 0.1)';
                          e.currentTarget.style.backgroundColor = color;
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = 'transparent';
                        }}
                      >
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M8 17.929H6a4 4 0 0 1-1.5-7.714A6 6 0 0 1 16.5 8.5h.5a4 4 0 0 1 1 7.857" />
                          <path d="M12 21v-8" />
                          <path d="M8 17l4-4 4 4" />
                        </svg>
                        Push
                      </button>
                    </div>
                  );
                })()}

                <button
                  style={{
                    width: '100%',
                    marginTop: '10px',
                    padding: '6px',
                    backgroundColor: 'transparent',
                    border: 'none',
                    color: '#666',
                    fontSize: '11px',
                    cursor: 'pointer',
                  }}
                  onClick={async () => {
                    await ipcRenderer.invoke('kinsta:unlinkSite', site.id);
                    setSiteLink(null);
                    setShowDropdown(false);
                  }}
                >
                  Unlink
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
};

// Compact overview panel for linking
const KinstaSitePanel: React.FC<Props> = ({ site }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [siteLink, setSiteLink] = useState<SiteLink | null>(null);
  const [kinstaSites, setKinstaSites] = useState<KinstaSite[]>([]);
  const [selectedSite, setSelectedSite] = useState<string>('');
  const [isLinking, setIsLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkConnection();
    loadSiteLink();
  }, [site.id]);

  const checkConnection = async () => {
    const config = await ipcRenderer.invoke('kinsta:getConfig');
    setIsConnected(!!config.apiKey);
  };

  const loadSiteLink = async () => {
    const link = await ipcRenderer.invoke('kinsta:getSiteLink', site.id);
    setSiteLink(link);
  };

  const loadKinstaSites = async () => {
    const result = await ipcRenderer.invoke('kinsta:getSites');
    if (result.success) {
      setKinstaSites(result.sites);
    } else {
      setError(result.error);
    }
  };

  const handleLink = async () => {
    if (!selectedSite) return;

    setIsLinking(true);
    setError(null);

    const kinstaSite = kinstaSites.find(s => s.id === selectedSite);

    const result = await ipcRenderer.invoke('kinsta:linkSite', site.id, kinstaSite);

    if (result.success) {
      setSiteLink(result.link);
    } else {
      setError(result.error);
    }

    setIsLinking(false);
  };

  // Already linked - toolbar button handles it
  if (siteLink) {
    return null;
  }

  // Shared styles matching the toolbar buttons
  const panelStyle: React.CSSProperties = {
    padding: '20px',
    backgroundColor: '#292929',
    borderRadius: '8px',
    marginTop: '20px',
    border: '2px solid #3e3e3e',
  };

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    marginBottom: '16px',
  };

  const selectStyle: React.CSSProperties = {
    flex: 1,
    padding: '8px 12px',
    backgroundColor: '#1e1e1e',
    border: '2px solid #3e3e3e',
    borderRadius: '100px',
    color: '#fff',
    fontSize: '14px',
    fontWeight: 500,
    outline: 'none',
    cursor: 'pointer',
    appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2350c083' d='M6 8L1 3h10z'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 12px center',
    paddingRight: '32px',
  };

  const linkButtonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 15px',
    backgroundColor: 'transparent',
    border: '2px solid #50c083',
    borderRadius: '100px',
    color: '#50c083',
    fontSize: '14px',
    fontWeight: 700,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  };

  // Not connected
  if (!isConnected) {
    return (
      <div style={panelStyle}>
        <div style={headerStyle}>
          <svg width="18" height="18" viewBox="0 0 40 40" fill="#50c083">
            <path d="M20 0C8.954 0 0 8.954 0 20s8.954 20 20 20 20-8.954 20-20S31.046 0 20 0zm0 36c-8.837 0-16-7.163-16-16S11.163 4 20 4s16 7.163 16 16-7.163 16-16 16z"/>
            <circle cx="20" cy="20" r="6" />
          </svg>
          <span style={{ color: '#fff', fontWeight: 700, fontSize: '15px' }}>Kinsta</span>
        </div>
        <p style={{ color: '#888', fontSize: '14px', margin: '0 0 16px 0' }}>
          Connect to Kinsta in Preferences to sync this site.
        </p>
        <button
          style={linkButtonStyle}
          onClick={() => {
            // Open preferences - this would need to be implemented
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(80, 192, 131, 0.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          Open Preferences
        </button>
      </div>
    );
  }

  // Show link form
  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <svg width="18" height="18" viewBox="0 0 40 40" fill="#50c083">
          <path d="M20 0C8.954 0 0 8.954 0 20s8.954 20 20 20 20-8.954 20-20S31.046 0 20 0zm0 36c-8.837 0-16-7.163-16-16S11.163 4 20 4s16 7.163 16 16-7.163 16-16 16z"/>
          <circle cx="20" cy="20" r="6" />
        </svg>
        <span style={{ color: '#fff', fontWeight: 700, fontSize: '15px' }}>Link to Kinsta</span>
      </div>

      {error && (
        <div style={{
          color: '#ff6b6b',
          fontSize: '13px',
          marginBottom: '12px',
          padding: '10px 12px',
          backgroundColor: 'rgba(255, 107, 107, 0.1)',
          borderRadius: '6px',
          border: '1px solid rgba(255, 107, 107, 0.3)',
        }}>
          {error}
        </div>
      )}

      <div style={{ marginBottom: '16px' }}>
        <select
          style={selectStyle}
          value={selectedSite}
          onChange={(e) => setSelectedSite(e.target.value)}
          onFocus={() => { if (kinstaSites.length === 0) loadKinstaSites(); }}
        >
          <option value="">Select Kinsta site...</option>
          {kinstaSites.map(s => (
            <option key={s.id} value={s.id}>{s.display_name || s.name}</option>
          ))}
        </select>
      </div>

      <button
        style={{
          ...linkButtonStyle,
          opacity: (!selectedSite || isLinking) ? 0.5 : 1,
          cursor: (!selectedSite || isLinking) ? 'not-allowed' : 'pointer',
        }}
        onClick={handleLink}
        disabled={!selectedSite || isLinking}
        onMouseEnter={(e) => {
          if (selectedSite && !isLinking) {
            e.currentTarget.style.backgroundColor = 'rgba(80, 192, 131, 0.1)';
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = 'transparent';
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
        {isLinking ? 'Linking...' : 'Link Site'}
      </button>
    </div>
  );
};

export default KinstaSitePanel;
