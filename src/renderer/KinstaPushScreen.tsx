import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import {
  FlyModal,
  PrimaryButton,
  TextButton,
  Checkbox,
  FlySelect,
  VirtualTable,
  IVirtualTableCellRendererDataArgs,
  ProgressBar,
  Spinner,
  Title,
  ConnectPushIcon,
  FileAddedIcon,
  FileRightArrowIcon,
} from '@getflywheel/local-components';
import KinstaIcon from './KinstaIcon';

const { ipcRenderer } = window.require('electron');

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

interface EnvironmentInfo {
  envId: string;
  envType: 'staging' | 'live';
  sshHost: string;
  sshPort: string;
  sshUser: string;
  remoteDomain: string;
  cdnCacheId?: string;
}

interface SyncProgress {
  stage: string;
  progress: number;
  message: string;
}

// Mirrors PushDiffRow in src/main/index.ts (+ renderer-side selection state)
interface DiffRow {
  path: string;
  op: 'add' | 'update' | 'delete';
  isDir: boolean;
  sizeBytes: number;
  localMtime?: number;
  selected: boolean;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  site: any;
  siteLink: {
    kinstaSiteId: string;
    kinstaSiteName: string;
    kinstaSiteSlug?: string;
  };
}

type SyncMode = 'newer' | 'all';

// Fullscreen sizing for the FlyModal (react-modal) — injected while mounted.
// <style> tags in JSX render as text inside Local, so we inject a real element.
const FULLSCREEN_CSS = `
.KinstaPushModalOverlay {
  padding: 0 !important;
}
.KinstaPushModalContent {
  position: absolute !important;
  inset: 0 !important;
  width: 100% !important;
  height: 100% !important;
  max-width: none !important;
  max-height: none !important;
  border-radius: 0 !important;
  transform: none !important;
  display: flex;
  flex-direction: column;
}
.KinstaPushCell {
  display: flex;
  align-items: center;
  padding: 0 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.KinstaPushRow {
  border-bottom: 1px solid rgba(127, 127, 127, 0.12);
}
`;

const formatMb = (bytes: number): string => {
  if (!bytes) return '0 mb';
  const mb = bytes / 1048576;
  return `${mb < 0.1 ? '<0.1' : mb.toFixed(1)} mb`;
};

const formatMtime = (ms?: number): string => {
  if (!ms) return '';
  const d = new Date(ms);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const KinstaPushScreen: React.FC<Props> = ({ isOpen, onClose, site, siteLink }) => {
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [selectedEnvId, setSelectedEnvId] = useState<string>('');
  const [mode, setMode] = useState<SyncMode>('newer');
  const [includeDatabase, setIncludeDatabase] = useState(true);
  const [includeUploads, setIncludeUploads] = useState(false);
  const [kinstaBackup, setKinstaBackup] = useState(true);

  const [rows, setRows] = useState<DiffRow[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [isPushing, setIsPushing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [isComplete, setIsComplete] = useState(false);
  const [completionWarning, setCompletionWarning] = useState<string | null>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);

  const previewSeq = useRef(0);

  // Theme — same heuristic as KinstaIcon
  const isDark = typeof document !== 'undefined' &&
    parseInt((getComputedStyle(document.body).backgroundColor.match(/\d+/) || ['255'])[0], 10) < 128;
  const bg = isDark ? '#1d1d1d' : '#ffffff';
  const fg = isDark ? '#fff' : '#2a3132';
  const subtle = isDark ? 'rgba(255,255,255,0.6)' : 'rgba(42,49,50,0.6)';
  const border = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)';

  // Inject the fullscreen/table CSS while the screen exists
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = FULLSCREEN_CSS;
    document.head.appendChild(style);
    return () => { document.head.removeChild(style); };
  }, []);

  useEffect(() => {
    if (isOpen && siteLink) {
      setIsComplete(false);
      setError(null);
      setCompletionWarning(null);
      loadEnvironments();
    }
  }, [isOpen, siteLink]);

  // Live progress (events carry siteId + mode so other sites/pulls are ignored)
  useEffect(() => {
    const handler = (_e: any, p: SyncProgress & { siteId?: string; mode?: string }) => {
      if (p.siteId !== site.id || p.mode !== 'push') return;
      if (p.stage === 'error' || p.stage === 'cancelled') return; // handled via invoke result
      setProgress(p);
      if (p.stage === 'done') {
        setIsComplete(true);
        setIsPushing(false);
      }
    };
    ipcRenderer.on('kinsta:syncProgress', handler);
    return () => { ipcRenderer.removeListener('kinsta:syncProgress', handler); };
  }, [site.id]);

  const loadEnvironments = async () => {
    const result = await ipcRenderer.invoke('kinsta:getEnvironments', siteLink.kinstaSiteId);
    if (result.success && result.environments.length > 0) {
      const envs = [...result.environments].sort((a: Environment, b: Environment) =>
        Number(b.is_premium) - Number(a.is_premium));
      setEnvironments(envs);
      setSelectedEnvId(envs[0].id);
    } else if (!result.success) {
      setError(result.error || 'Could not load environments');
    }
  };

  const getEnvInfo = (envId: string): EnvironmentInfo | null => {
    const env = environments.find(e => e.id === envId);
    if (!env || !siteLink) return null;
    const siteName = siteLink.kinstaSiteSlug || siteLink.kinstaSiteName;
    return {
      envId: env.id,
      envType: env.is_premium ? 'live' : 'staging',
      sshHost: env.ssh_connection?.ssh_ip?.external_ip || '',
      sshPort: String(env.ssh_connection?.ssh_port || '22'),
      sshUser: siteName.toLowerCase().replace(/[^a-z0-9]/g, ''),
      remoteDomain: env.primaryDomain?.name || env.domains?.[0]?.name || '',
      cdnCacheId: env.cdn_cache_id,
    };
  };

  // Re-run the dry-run preview whenever its inputs change (debounced)
  useEffect(() => {
    if (!isOpen || !selectedEnvId || isPushing || isComplete) return;
    const seq = ++previewSeq.current;
    setPreviewLoading(true);
    setError(null);
    const timer = setTimeout(async () => {
      const envInfo = getEnvInfo(selectedEnvId);
      if (!envInfo) { setPreviewLoading(false); return; }
      const result = await ipcRenderer.invoke('kinsta:pushPreview', site.id, site, envInfo, {
        mode,
        includeUploads,
      });
      if (seq !== previewSeq.current) return; // stale response — newer preview in flight
      setPreviewLoading(false);
      if (result.success) {
        setDegraded(!!result.degraded);
        // Hide add/update directory rows (implied by their files); keep folder deletions
        const visible = (result.rows || []).filter((r: DiffRow) => !(r.isDir && r.op !== 'delete'));
        setRows(visible.map((r: DiffRow) => ({ ...r, selected: true })));
      } else {
        setError(result.error || 'Preview failed');
        setRows([]);
      }
    }, 250);
    return () => { clearTimeout(timer); };
  }, [isOpen, selectedEnvId, mode, includeUploads, environments]);

  const selectedRows = rows.filter(r => r.selected);
  const addUpdateCount = selectedRows.filter(r => r.op !== 'delete').length;
  const deleteCount = selectedRows.filter(r => r.op === 'delete').length;
  const totalBytes = selectedRows.reduce((sum, r) => sum + (r.op === 'delete' ? 0 : r.sizeBytes), 0);
  const allSelected = rows.length > 0 && rows.every(r => r.selected);
  const someSelected = rows.some(r => r.selected);

  const env = environments.find(e => e.id === selectedEnvId);
  const isLive = !!env?.is_premium;
  const envLabel = env ? (env.is_premium ? 'Production' : 'Staging') : '';

  const toggleAll = (checked: boolean) => {
    setRows(rs => rs.map(r => ({ ...r, selected: checked })));
  };
  const toggleRow = (rowPath: string, checked: boolean) => {
    setRows(rs => rs.map(r => (r.path === rowPath ? { ...r, selected: checked } : r)));
  };

  const handlePushClick = () => setShowConfirmModal(true);

  const executePush = async () => {
    setShowConfirmModal(false);
    const envInfo = getEnvInfo(selectedEnvId);
    if (!envInfo) { setError('Please select an environment'); return; }

    setIsPushing(true);
    setError(null);
    setProgress({ stage: 'starting', progress: 0, message: 'Starting push...' });

    const everythingSelected = allSelected && rows.length > 0;
    const result = await ipcRenderer.invoke('kinsta:push', site.id, site, envInfo, {
      includeDatabase,
      includeUploads,
      kinstaBackup,
      mode,
      // Full selection + "all modified" = the plain rsync --delete fast path
      ...(everythingSelected && mode === 'all' ? {} : {
        files: selectedRows.filter(r => r.op !== 'delete').map(r => r.path),
        deletions: selectedRows.filter(r => r.op === 'delete').map(r => r.path),
      }),
    });

    if (result.success) {
      setCompletionWarning(result.warning || null);
    } else {
      setError(result.cancelled ? null : result.error);
      setIsPushing(false);
      setIsCancelling(false);
      setProgress(null);
    }
  };

  const handleCancel = async () => {
    setIsCancelling(true);
    await ipcRenderer.invoke('kinsta:cancelSync', site.id);
  };

  const handleRequestClose = () => {
    if (isPushing) return; // no closing mid-push — cancel first
    onClose();
  };

  const cellRenderer = (args: IVirtualTableCellRendererDataArgs): React.ReactNode => {
    const { colKey, isHeader, rowData, extraData } = args;
    if (isHeader) {
      if (colKey === 'selected') {
        return (
          <Checkbox
            checked={extraData?.allSelected ? true : extraData?.someSelected ? 'mixed' : false}
            onChange={(checked: boolean) => toggleAll(checked)}
          />
        );
      }
      return false; // default header text
    }
    const row = rowData as DiffRow;
    switch (colKey) {
      case 'selected':
        return (
          <Checkbox
            checked={row.selected}
            onChange={(checked: boolean) => toggleRow(row.path, checked)}
          />
        );
      case 'path':
        return (
          <span style={{ fontFamily: 'monospace', fontSize: '12px', opacity: row.selected ? 1 : 0.4 }}>
            {row.path}{row.isDir ? '/' : ''}
          </span>
        );
      case 'localMtime':
        return (
          <span style={{ opacity: row.selected ? 0.8 : 0.4 }}>
            {row.op === 'delete' ? '---' : formatMtime(row.localMtime)}
          </span>
        );
      case 'op':
        if (row.op === 'add') return <FileAddedIcon aria-hidden />;
        if (row.op === 'update') return <FileRightArrowIcon aria-hidden />;
        return <span style={{ color: '#d04d5c', fontWeight: 700 }}>✕</span>;
      case 'remote': {
        const color = row.op === 'add' ? '#50c083' : row.op === 'delete' ? '#d04d5c' : undefined;
        const text = row.op === 'add' ? 'Will be added' : row.op === 'delete' ? 'Will be deleted' : 'Will be updated';
        return <span style={{ color, opacity: row.selected ? 1 : 0.4 }}>{text}</span>;
      }
    }
    return false;
  };

  const sectionTitle: React.CSSProperties = {
    fontSize: '15px',
    fontWeight: 600,
    textAlign: 'center',
    marginBottom: '14px',
  };

  if (!isOpen) return null;

  return (
    <FlyModal
      isOpen={isOpen}
      onRequestClose={handleRequestClose}
      contentLabel={`Push ${site.name || ''} to Kinsta`}
      shouldCloseOnOverlayClick={false}
      className="KinstaPushModalContent"
      overlayClassName="KinstaPushModalOverlay"
      hideCloseIcon={isPushing}
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: bg, color: fg }}>
        {/* Header — centered title, FlyModal supplies the X */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '10px',
          padding: '18px 60px',
          borderBottom: `1px solid ${border}`,
          flexShrink: 0,
        }}>
          <ConnectPushIcon aria-hidden />
          <Title size="s" style={{ margin: 0 }}>
            Push {site.name || site.domain} to Kinsta
          </Title>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Left sidebar */}
          <div style={{
            width: '320px',
            flexShrink: 0,
            borderRight: `1px solid ${border}`,
            padding: '40px 32px',
            display: 'flex',
            flexDirection: 'column',
            gap: '28px',
            overflowY: 'auto',
          }}>
            <div>
              <div style={sectionTitle}>Push site to</div>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px 16px',
                border: `1px solid ${border}`,
                borderRadius: '8px',
              }}>
                <KinstaIcon size={28} />
                <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {siteLink.kinstaSiteName}
                </span>
              </div>
            </div>

            <div>
              <div style={sectionTitle}>Select environment</div>
              <FlySelect
                value={selectedEnvId}
                options={Object.fromEntries(environments.map(e => [
                  e.id,
                  e.is_premium ? 'Production' : `Staging (${e.display_name})`,
                ]))}
                onChange={(value: string) => setSelectedEnvId(value)}
                disabled={isPushing}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {/* local-components Checkbox passes the new boolean to onChange */}
              <Checkbox
                label="Include database"
                checked={includeDatabase}
                disabled={isPushing}
                onChange={(checked: boolean) => setIncludeDatabase(checked)}
              />
              <Checkbox
                label="Include uploads folder"
                checked={includeUploads}
                disabled={isPushing}
                onChange={(checked: boolean) => setIncludeUploads(checked)}
              />
              <Checkbox
                label="Create Kinsta backup first"
                checked={kinstaBackup}
                disabled={isPushing}
                onChange={(checked: boolean) => setKinstaBackup(checked)}
              />
            </div>

            <div style={{ textAlign: 'center', marginTop: 'auto' }}>
              {isLive && !isPushing && !isComplete && (
                <p style={{ fontSize: '12px', color: '#d04d5c', marginBottom: '10px' }}>
                  This will modify your production site.
                </p>
              )}
              <PrimaryButton
                onClick={handlePushClick}
                disabled={isPushing || previewLoading || isComplete || (selectedRows.length === 0 && !includeDatabase)}
              >
                Push to Kinsta
              </PrimaryButton>
            </div>
          </div>

          {/* Right pane */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            {isPushing || isComplete ? (
              /* Progress / completion view */
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 60px', gap: '18px' }}>
                {isComplete ? (
                  <>
                    <div style={{ fontSize: '42px' }}>✓</div>
                    <Title size="m" style={{ margin: 0 }}>Push complete!</Title>
                    {completionWarning && (
                      <p style={{ fontSize: '13px', color: '#fcc419', textAlign: 'center', maxWidth: '460px' }}>
                        {completionWarning}
                      </p>
                    )}
                    <PrimaryButton onClick={onClose}>Done</PrimaryButton>
                  </>
                ) : (
                  <>
                    <Spinner />
                    <div style={{ width: '100%', maxWidth: '420px' }}>
                      <ProgressBar progress={progress?.progress || 0} />
                    </div>
                    <p style={{ fontSize: '13px', color: subtle, margin: 0 }}>{progress?.message}</p>
                    <TextButton onClick={handleCancel} disabled={isCancelling}>
                      {isCancelling ? 'Cancelling…' : 'Cancel'}
                    </TextButton>
                  </>
                )}
              </div>
            ) : (
              <>
                {/* Toolbar: mode select + counts */}
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '12px 20px',
                  borderBottom: `1px solid ${border}`,
                  flexShrink: 0,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontWeight: 600, fontSize: '14px' }}>Push</span>
                    <FlySelect
                      value={mode}
                      options={{ newer: 'only newer files', all: 'all modified files' }}
                      onChange={(value: SyncMode) => setMode(value)}
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px', fontSize: '13px', color: subtle }}>
                    <span title="Files to sync">⟳ <strong style={{ color: fg }}>{addUpdateCount}</strong></span>
                    <span style={{ opacity: 0.3 }}>|</span>
                    <span title="Files to delete" style={{ color: deleteCount ? '#d04d5c' : undefined }}>✕ {deleteCount}</span>
                    <span style={{ opacity: 0.3 }}>|</span>
                    <span>{formatMb(totalBytes)}</span>
                  </div>
                </div>

                {degraded && (
                  <div style={{
                    padding: '8px 20px',
                    fontSize: '12px',
                    color: '#fcc419',
                    backgroundColor: 'rgba(252,196,25,0.08)',
                    borderBottom: `1px solid ${border}`,
                    flexShrink: 0,
                  }}>
                    Limited preview (no sizes / change detail) — run <code>brew install rsync</code> for the full diff.
                  </div>
                )}

                {/* File diff table */}
                <div style={{ flex: 1, minHeight: 0, overflow: 'auto', position: 'relative' }}>
                  {previewLoading ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '10px', color: subtle }}>
                      <Spinner /> Comparing with Kinsta…
                    </div>
                  ) : error ? (
                    <div style={{ padding: '24px', color: '#d04d5c', fontSize: '13px', whiteSpace: 'pre-wrap' }}>
                      {error}
                    </div>
                  ) : rows.length === 0 ? (
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: subtle, fontSize: '14px' }}>
                      Everything is in sync — no file changes to push.
                    </div>
                  ) : (
                    <VirtualTable
                      data={rows}
                      headers={[
                        { key: 'selected', value: '', flex: '0 0 44px' },
                        { key: 'path', value: 'Filename', flex: '1 1 auto' },
                        { key: 'localMtime', value: 'Local', flex: '0 0 160px' },
                        { key: 'op', value: '→', flex: '0 0 44px' },
                        { key: 'remote', value: `Kinsta (${envLabel})`, flex: '0 0 150px' },
                      ]}
                      rowKeyPropName="path"
                      cellClassName="KinstaPushCell"
                      rowClassName="KinstaPushRow"
                      cellRenderer={cellRenderer}
                      rowHeightSize="s"
                      striped
                      extraData={{ allSelected, someSelected }}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation modal (same pattern as the sync drawer) */}
      <FlyModal
        isOpen={showConfirmModal}
        onRequestClose={() => setShowConfirmModal(false)}
        contentLabel="Confirm Push"
      >
        <div style={{ padding: '30px', maxWidth: '420px', textAlign: 'center' }}>
          <Title size="l" style={{ marginBottom: '12px' }}>
            Push to {isLive ? 'Production' : 'Staging'}?
          </Title>
          <p style={{ color: '#888', fontSize: '14px', marginBottom: '10px', lineHeight: 1.5 }}>
            {addUpdateCount > 0 && <>{addUpdateCount} file(s) will be synced. </>}
            {deleteCount > 0 && <strong style={{ color: '#d04d5c' }}>{deleteCount} file(s) will be deleted on Kinsta. </strong>}
            {includeDatabase && <>The {isLive ? 'production' : 'staging'} database will be replaced with your local database. </>}
          </p>
          {isLive && (
            <p style={{ color: '#d04d5c', fontSize: '13px', marginBottom: '24px' }}>
              This will overwrite your production site. This action cannot be undone.
            </p>
          )}
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center' }}>
            <TextButton onClick={() => setShowConfirmModal(false)}>Cancel</TextButton>
            <PrimaryButton
              onClick={executePush}
              style={isLive ? { backgroundColor: '#d04d5c', borderColor: '#d04d5c' } : undefined}
            >
              Yes, Push to {isLive ? 'Production' : 'Staging'}
            </PrimaryButton>
          </div>
        </div>
      </FlyModal>
    </FlyModal>
  );
};

export default KinstaPushScreen;
