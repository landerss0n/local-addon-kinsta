import * as React from 'react';
import { useState, useEffect } from 'react';
// Resolves to Local's shared react-router-dom instance at runtime
// (module-alias in Local's renderer + webpack external), so we get
// the Router context of Local's own tree.
import { useHistory } from 'react-router-dom';
import KinstaSyncDrawer from './KinstaSyncDrawer';
import KinstaLinkDrawer from './KinstaLinkDrawer';

const { ipcRenderer } = window.require('electron');

interface SiteLink {
  localSiteId: string;
  kinstaSiteId: string;
  kinstaSiteName: string;
  kinstaSiteSlug?: string;
}

export type KinstaMenuAction = 'link' | 'pull' | 'push' | 'unlink';

// Module-level cache so the synchronous siteInfoMoreMenu filter can read
// link state when Local renders the More menu. Populated by KinstaDrawerHost
// (mounted via SiteInfo_TabNav_Items, so it exists on every site tab).
const linkCache = new Map<string, SiteLink | null>();
let apiConnected = false;

export const getLinkState = (siteId: string): { connected: boolean; link: SiteLink | null } => ({
  connected: apiConnected,
  link: linkCache.get(siteId) ?? null,
});

export const dispatchKinstaAction = (action: KinstaMenuAction, siteId: string): void => {
  window.dispatchEvent(new CustomEvent('kinsta:action', { detail: { action, siteId } }));
};

interface Props {
  site: any;
}

// Invisible component mounted in the site tab nav. Renders no toolbar UI —
// all entry points live in Local's native More menu (siteInfoMoreMenu filter).
// Owns the drawers and keeps the link-state cache fresh.
export const KinstaDrawerHost: React.FC<Props> = ({ site }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [siteLink, setSiteLink] = useState<SiteLink | null>(null);
  const [drawerMode, setDrawerMode] = useState<'pull' | 'push' | null>(null);
  const [showLinkDrawer, setShowLinkDrawer] = useState(false);
  const history = useHistory();

  // The siteInfoMoreMenu filter result is computed in Local's render — we can't
  // re-render Local's site view from a child component. Re-pushing the current
  // route makes the Router emit a new location, which re-renders the site view
  // and re-applies the filter with fresh link state.
  const nudgeRerender = () => {
    const { pathname, search } = history.location;
    history.replace(pathname + (search || ''));
  };

  const refresh = async () => {
    const prev = linkCache.get(site.id); // undefined = never fetched
    const config = await ipcRenderer.invoke('kinsta:getConfig');
    apiConnected = !!config.apiKey;
    setIsConnected(apiConnected);
    const link = (await ipcRenderer.invoke('kinsta:getSiteLink', site.id)) ?? null;
    linkCache.set(site.id, link);
    setSiteLink(link);
    // The menu rendered before this fetch resolved — nudge if it's now wrong.
    // (First fetch of an unlinked site needs no nudge: the menu already
    // defaults to "Link to Kinsta" when the cache is cold.)
    const changed = prev === undefined
      ? !!link
      : (prev?.kinstaSiteId !== link?.kinstaSiteId);
    if (changed) {
      nudgeRerender();
    }
  };

  useEffect(() => {
    refresh();
  }, [site.id]);

  // Triggered from the More menu items (see siteInfoMoreMenu filter in index.tsx)
  useEffect(() => {
    const handler = async (e: Event) => {
      const { action, siteId } = (e as CustomEvent).detail || {};
      if (siteId && siteId !== site.id) return;
      switch (action as KinstaMenuAction) {
        case 'pull':
        case 'push':
          if (apiConnected && linkCache.get(site.id)) {
            setDrawerMode(action);
          } else {
            setShowLinkDrawer(true);
          }
          break;
        case 'link':
          setShowLinkDrawer(true);
          break;
        case 'unlink':
          await ipcRenderer.invoke('kinsta:unlinkSite', site.id);
          linkCache.set(site.id, null);
          setSiteLink(null);
          nudgeRerender();
          break;
      }
    };
    window.addEventListener('kinsta:action', handler);
    return () => window.removeEventListener('kinsta:action', handler);
  }, [site.id]);

  const handleLinkComplete = (link: SiteLink) => {
    // Linking implies the API is connected (the link flow sets it up),
    // so update the module flag too — refresh() only runs on mount.
    apiConnected = true;
    setIsConnected(true);
    linkCache.set(site.id, link);
    setSiteLink(link);
    setShowLinkDrawer(false);
    nudgeRerender();
  };

  return (
    <>
      <KinstaLinkDrawer
        isOpen={showLinkDrawer}
        onClose={() => setShowLinkDrawer(false)}
        onLinkComplete={handleLinkComplete}
        site={site}
        isConnected={isConnected}
      />

      {drawerMode && siteLink && (
        <KinstaSyncDrawer
          isOpen={true}
          onClose={() => setDrawerMode(null)}
          mode={drawerMode}
          site={site}
          siteLink={siteLink}
        />
      )}
    </>
  );
};

export default KinstaDrawerHost;
