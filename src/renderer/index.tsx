import * as React from 'react';
// Resolves to Local's shared react-router-dom at runtime (module-alias +
// webpack external) — required so our Route works inside Local's <Switch>.
import { Route } from 'react-router-dom';
import { AddonRendererContext, AddonSettingsItem } from '@getflywheel/local/renderer';
import { KinstaDrawerHost } from './KinstaSitePanel';
import KinstaPage from './KinstaPage';
import KinstaSettings from './KinstaSettings';

export default function (context: AddonRendererContext): void {
  const { hooks, events } = context;

  // Invisible host for the link/sync drawers.
  // Mounted in the tab nav so it exists on every site tab (renders no toolbar UI).
  hooks.addContent('SiteInfo_TabNav_Items', (site: any) => {
    return <KinstaDrawerHost key="kinsta-drawer-host" site={site} />;
  });

  // The add-on's home: a dedicated page rendered inside Local's site-info
  // <Switch>. Local passes { routeChildrenProps } (site, siteStatus, ...).
  hooks.addContent('routes[site-info]', ({ routeChildrenProps }: any) => {
    return (
      <Route
        key="kinsta-route"
        path="/main/site-info/:siteId/kinsta"
        render={() => (
          <KinstaPage
            site={routeChildrenProps.site}
            siteStatus={routeChildrenProps.siteStatus}
          />
        )}
      />
    );
  });

  // Native More-menu item navigating to the Kinsta page (the documented
  // pattern — More holds navigation to add-on tabs, not raw actions).
  hooks.addFilter('siteInfoMoreMenu', (menu: any[], site: any) => {
    menu.push({
      label: 'Kinsta',
      click: () => events.send('goToRoute', `/main/site-info/${site.id}/kinsta`),
    });
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
