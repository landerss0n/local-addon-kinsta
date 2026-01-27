import * as React from 'react';
import { useState, useEffect, useRef } from 'react';
import KinstaSyncDrawer from './KinstaSyncDrawer';
import KinstaLinkDrawer from './KinstaLinkDrawer';

const { ipcRenderer } = window.require('electron');

// Kinsta icon - light background (for dark theme)
const KinstaIconLight = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g clipPath="url(#clip0_btn_light)">
      <path d="M0 24C0 10.7452 10.7452 0 24 0H96C109.254 0 120 10.7452 120 24V96C120 109.254 109.254 120 96 120H24C10.7452 120 0 109.254 0 96V24Z" fill="#F9F5F3"/>
      <mask id="mask0_btn_light" style={{ maskType: 'luminance' }} maskUnits="userSpaceOnUse" x="4" y="26" width="45" height="68">
        <path d="M38.3632 26.0246C44.0636 26.0246 48.6843 30.6453 48.6843 36.3456V83.6548C48.6843 89.3551 44.0636 93.9755 38.3632 93.9755C27.2161 93.9755 16.069 93.9755 4.92188 93.9755V26.0252C16.069 26.0237 27.2161 26.0246 38.3632 26.0246Z" fill="white"/>
      </mask>
      <g mask="url(#mask0_btn_light)">
        <path d="M30.4688 9.84363H147.721V110.279H30.4688V9.84363Z" fill="url(#paint0_btn_light)"/>
      </g>
      <mask id="mask1_btn_light" style={{ maskType: 'luminance' }} maskUnits="userSpaceOnUse" x="48" y="26" width="48" height="68">
        <path d="M85.3079 26.0252C91.0083 26.0252 95.629 30.646 95.629 36.3463V83.6554C95.629 89.3557 91.0083 93.9762 85.3079 93.9762L48.8301 93.9844L48.8301 26.0156L85.3079 26.0252Z" fill="white"/>
      </mask>
      <g mask="url(#mask1_btn_light)">
        <path d="M60 9.84375H177.252V110.279H60V9.84375Z" fill="url(#paint1_btn_light)"/>
      </g>
    </g>
    <defs>
      <linearGradient id="paint0_btn_light" x1="26.8484" y1="69.0531" x2="106.313" y2="43.7697" gradientUnits="userSpaceOnUse">
        <stop offset="0.182692" stopColor="#FE5A00"/>
        <stop offset="0.598914" stopColor="#FF0000"/>
      </linearGradient>
      <linearGradient id="paint1_btn_light" x1="56.3797" y1="69.0532" x2="135.844" y2="43.7698" gradientUnits="userSpaceOnUse">
        <stop offset="0.211538" stopColor="#FE5A00"/>
        <stop offset="0.634615" stopColor="#FF0000"/>
      </linearGradient>
      <clipPath id="clip0_btn_light">
        <rect width="120" height="120" fill="white"/>
      </clipPath>
    </defs>
  </svg>
);

// Kinsta icon - dark background (for light theme)
const KinstaIconDark = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g clipPath="url(#clip0_btn_dark)">
      <path d="M0 24C0 10.7452 10.7452 0 24 0H96C109.254 0 120 10.7452 120 24V96C120 109.254 109.254 120 96 120H24C10.7452 120 0 109.254 0 96V24Z" fill="#181516"/>
      <mask id="mask0_btn_dark" style={{ maskType: 'luminance' }} maskUnits="userSpaceOnUse" x="4" y="26" width="45" height="68">
        <path d="M38.3632 26.0246C44.0636 26.0246 48.6843 30.6453 48.6843 36.3456V83.6548C48.6843 89.3551 44.0636 93.9755 38.3632 93.9755C27.2161 93.9755 16.069 93.9755 4.92188 93.9755V26.0252C16.069 26.0237 27.2161 26.0246 38.3632 26.0246Z" fill="white"/>
      </mask>
      <g mask="url(#mask0_btn_dark)">
        <path d="M30.4688 9.84363H147.721V110.279H30.4688V9.84363Z" fill="url(#paint0_btn_dark)"/>
      </g>
      <mask id="mask1_btn_dark" style={{ maskType: 'luminance' }} maskUnits="userSpaceOnUse" x="48" y="26" width="48" height="68">
        <path d="M85.3079 26.0252C91.0083 26.0252 95.629 30.646 95.629 36.3463V83.6554C95.629 89.3557 91.0083 93.9762 85.3079 93.9762L48.8301 93.9844L48.8301 26.0156L85.3079 26.0252Z" fill="white"/>
      </mask>
      <g mask="url(#mask1_btn_dark)">
        <path d="M60 9.84375H177.252V110.279H60V9.84375Z" fill="url(#paint1_btn_dark)"/>
      </g>
    </g>
    <defs>
      <linearGradient id="paint0_btn_dark" x1="26.8484" y1="69.0531" x2="106.313" y2="43.7697" gradientUnits="userSpaceOnUse">
        <stop offset="0.182692" stopColor="#FE5A00"/>
        <stop offset="0.598914" stopColor="#FF0000"/>
      </linearGradient>
      <linearGradient id="paint1_btn_dark" x1="56.3797" y1="69.0532" x2="135.844" y2="43.7698" gradientUnits="userSpaceOnUse">
        <stop offset="0.211538" stopColor="#FE5A00"/>
        <stop offset="0.634615" stopColor="#FF0000"/>
      </linearGradient>
      <clipPath id="clip0_btn_dark">
        <rect width="120" height="120" fill="white"/>
      </clipPath>
    </defs>
  </svg>
);

// Theme-aware icon
const KinstaIcon = ({ size = 14 }: { size?: number }) => {
  const isDarkMode = typeof document !== 'undefined' &&
    (document.body.classList.contains('theme-dark') ||
     getComputedStyle(document.body).backgroundColor.includes('rgb(') &&
     parseInt(getComputedStyle(document.body).backgroundColor.split(',')[0].replace(/\D/g, '')) < 128);
  return isDarkMode !== false ? <KinstaIconLight size={size} /> : <KinstaIconDark size={size} />;
};

interface SiteLink {
  localSiteId: string;
  kinstaSiteId: string;
  kinstaSiteName: string;
  kinstaSiteSlug?: string;
}

interface Props {
  site: any;
}

// Toolbar button component with drawer
export const KinstaToolbarButton: React.FC<Props> = ({ site }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [siteLink, setSiteLink] = useState<SiteLink | null>(null);
  const [drawerMode, setDrawerMode] = useState<'pull' | 'push' | null>(null);
  const [showLinkDrawer, setShowLinkDrawer] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    checkConnection();
    loadSiteLink();
  }, [site.id]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };

    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMenu]);

  const checkConnection = async () => {
    const config = await ipcRenderer.invoke('kinsta:getConfig');
    setIsConnected(!!config.apiKey);
  };

  const loadSiteLink = async () => {
    const link = await ipcRenderer.invoke('kinsta:getSiteLink', site.id);
    setSiteLink(link);
  };

  const handleUnlink = async () => {
    await ipcRenderer.invoke('kinsta:unlinkSite', site.id);
    setSiteLink(null);
    setShowMenu(false);
  };

  const handleLinkComplete = (link: SiteLink) => {
    setSiteLink(link);
    setShowLinkDrawer(false);
  };

  const menuItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 14px',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: '4px',
    color: '#fff',
    fontSize: '13px',
    cursor: 'pointer',
    width: '100%',
    textAlign: 'left',
    fontFamily: 'inherit',
  };

  const buttonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '5px 14px 5px 10px',
    backgroundColor: 'transparent',
    border: '1px solid #51bb7b',
    borderRadius: '50px',
    color: '#51bb7b',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: '"Museo Sans Rounded", -apple-system, BlinkMacSystemFont, sans-serif',
    transition: 'background-color 0.15s ease',
    height: '32px',
    boxSizing: 'border-box',
    lineHeight: 1,
  };

  // Not connected or not linked - show simple button
  if (!isConnected || !siteLink) {
    return (
      <>
        <button
          style={buttonStyle}
          onClick={() => setShowLinkDrawer(true)}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(81, 207, 102, 0.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
        >
          <KinstaIcon size={20} />
          <span>{isConnected ? 'Link to Kinsta' : 'Kinsta'}</span>
        </button>

        <KinstaLinkDrawer
          isOpen={showLinkDrawer}
          onClose={() => setShowLinkDrawer(false)}
          onLinkComplete={handleLinkComplete}
          site={site}
          isConnected={isConnected}
        />
      </>
    );
  }

  // Connected and linked - show button with dropdown menu
  return (
    <>
      <div ref={menuRef} style={{ position: 'relative' }}>
        <button
          style={buttonStyle}
          onClick={() => setShowMenu(!showMenu)}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = 'rgba(81, 207, 102, 0.1)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = 'transparent';
          }}
        >
          <KinstaIcon size={20} />
          <span>Kinsta</span>
          <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor" style={{ marginLeft: '-2px' }}>
            <path d="M1 1l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {showMenu && (
          <div style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: '8px',
            backgroundColor: '#2b2b2b',
            border: '1px solid #3e3e3e',
            borderRadius: '6px',
            padding: '4px',
            minWidth: '160px',
            zIndex: 1000,
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          }}>
            <button
              style={menuItemStyle}
              onClick={() => {
                setDrawerMode('pull');
                setShowMenu(false);
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#51cf66" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Pull from Kinsta
            </button>
            <button
              style={menuItemStyle}
              onClick={() => {
                setDrawerMode('push');
                setShowMenu(false);
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.1)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#51cf66" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              Push to Kinsta
            </button>
            <div style={{ height: '1px', backgroundColor: '#3e3e3e', margin: '4px 0' }} />
            <button
              style={{ ...menuItemStyle, color: '#888' }}
              onClick={handleUnlink}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = 'transparent';
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
              Unlink Site
            </button>
          </div>
        )}
      </div>

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

// Empty component - linking is now in drawer
const KinstaSitePanel: React.FC<Props> = () => {
  return null;
};

export default KinstaSitePanel;
