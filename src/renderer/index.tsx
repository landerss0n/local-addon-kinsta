import * as React from 'react';
import { AddonRendererContext, AddonSettingsItem } from '@getflywheel/local/renderer';
import { KinstaDrawerHost, getLinkState, dispatchKinstaAction } from './KinstaSitePanel';
import KinstaSettings from './KinstaSettings';

export default function (context: AddonRendererContext): void {
  const { hooks } = context;

  // Invisible host for the link/sync drawers + link-state cache.
  // Mounted in the tab nav so it exists on every site tab (renders no toolbar UI).
  hooks.addContent('SiteInfo_TabNav_Items', (site: any) => {
    return <KinstaDrawerHost key="kinsta-drawer-host" site={site} />;
  });

  // All Kinsta entry points live in Local's native More menu.
  // Local only reads `label` and `click` from each item. Items reflect the
  // cached link state; the cache is refreshed by KinstaDrawerHost on mount,
  // so it's warm by the time the menu can be opened.
  hooks.addFilter('siteInfoMoreMenu', (menu: any[], site: any) => {
    const { connected, link } = getLinkState(site.id);

    if (connected && link) {
      menu.push(
        { label: 'Pull from Kinsta', click: () => dispatchKinstaAction('pull', site.id) },
        { label: 'Push to Kinsta', click: () => dispatchKinstaAction('push', site.id) },
        { label: 'Unlink from Kinsta', click: () => dispatchKinstaAction('unlink', site.id) },
      );
    } else {
      menu.push(
        { label: 'Link to Kinsta', click: () => dispatchKinstaAction('link', site.id) },
      );
    }

    return menu;
  });

  // Add Kinsta settings to preferences
  hooks.addFilter('preferencesMenuItems', (items: AddonSettingsItem[]) => {
    const kinstaItem: AddonSettingsItem = {
      path: 'kinsta',
      displayName: 'Kinsta',
      sections: KinstaSettings,
      onApply: () => {},
    };
    return [...items, kinstaItem];
  }, 10);
}
