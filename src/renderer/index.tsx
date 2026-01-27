import * as React from 'react';
import { AddonRendererContext, AddonSettingsItem } from '@getflywheel/local/renderer';
import KinstaSitePanel, { KinstaToolbarButton } from './KinstaSitePanel';
import KinstaSettings from './KinstaSettings';

export default function (context: AddonRendererContext): void {
  const { hooks } = context;

  // Add Kinsta button to tab nav (near WP Admin / Open site)
  hooks.addContent('SiteInfo_TabNav_Items', (site: any) => {
    return <KinstaToolbarButton key="kinsta-toolbar-btn" site={site} />;
  });

  // Add link panel to site overview (only shows when not linked)
  hooks.addContent('SiteInfoOverview', (site: any) => {
    return <KinstaSitePanel key="kinsta-site-panel" site={site} />;
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
