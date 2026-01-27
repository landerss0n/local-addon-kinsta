import * as React from 'react';
import { useState, useEffect } from 'react';

const { ipcRenderer } = window.require('electron');

// Simple settings component without Local components to debug
const KinstaSettings: React.FC = () => {
  const [apiKey, setApiKey] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    loadConfig();
  }, []);

  const loadConfig = async () => {
    const config = await ipcRenderer.invoke('kinsta:getConfig');
    if (config.apiKey) {
      setApiKey('••••••••••••••••');
      setCompanyId(config.companyId || '');
      setIsConnected(true);
    }
  };

  const handleConnect = async () => {
    if (!apiKey || apiKey.startsWith('••')) {
      setError('Please enter a valid API key');
      return;
    }
    if (!companyId) {
      setError('Please enter your Company ID');
      return;
    }

    setIsConnecting(true);
    setError(null);
    setSuccess(null);

    const result = await ipcRenderer.invoke('kinsta:testConnection', apiKey, companyId);

    if (result.success) {
      setIsConnected(true);
      setApiKey('••••••••••••••••');
      setSuccess('Connected to Kinsta!');
    } else {
      setError(result.error || 'Could not connect to Kinsta');
    }

    setIsConnecting(false);
  };

  const handleDisconnect = async () => {
    await ipcRenderer.invoke('kinsta:disconnect');
    setIsConnected(false);
    setApiKey('');
    setCompanyId('');
    setSuccess(null);
  };

  const containerStyle: React.CSSProperties = {
    padding: '20px',
    maxWidth: '500px',
    color: '#fff',
  };

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px',
    marginBottom: '10px',
    borderRadius: '4px',
    border: '1px solid #444',
    backgroundColor: '#2d2d2d',
    color: '#fff',
    fontSize: '14px',
  };

  const buttonStyle: React.CSSProperties = {
    padding: '10px 20px',
    borderRadius: '4px',
    border: 'none',
    cursor: 'pointer',
    fontWeight: 500,
    backgroundColor: '#51cf66',
    color: '#000',
    marginRight: '10px',
  };

  const disconnectStyle: React.CSSProperties = {
    ...buttonStyle,
    backgroundColor: '#ff6b6b',
    color: '#fff',
  };

  return (
    <div style={containerStyle}>
      <h2 style={{ marginBottom: '20px' }}>Kinsta Sync</h2>

      <div style={{
        padding: '10px 15px',
        backgroundColor: isConnected ? 'rgba(81, 207, 102, 0.2)' : 'rgba(255,255,255,0.1)',
        borderRadius: '4px',
        marginBottom: '20px',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
      }}>
        <span style={{
          width: '10px',
          height: '10px',
          borderRadius: '50%',
          backgroundColor: isConnected ? '#51cf66' : '#666',
        }} />
        {isConnected ? 'Connected to Kinsta' : 'Not connected'}
      </div>

      {error && (
        <div style={{ padding: '10px', backgroundColor: 'rgba(255,107,107,0.2)', borderRadius: '4px', marginBottom: '15px', color: '#ff6b6b' }}>
          {error}
        </div>
      )}

      {success && (
        <div style={{ padding: '10px', backgroundColor: 'rgba(81,207,102,0.2)', borderRadius: '4px', marginBottom: '15px', color: '#51cf66' }}>
          {success}
        </div>
      )}

      {!isConnected ? (
        <>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px' }}>API Key</label>
            <input
              type="password"
              style={inputStyle}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="Enter your Kinsta API key"
            />
            <small style={{ color: '#888' }}>
              Create at <a href="https://my.kinsta.com/account/api-keys" target="_blank" rel="noopener noreferrer" style={{ color: '#51cf66' }}>MyKinsta</a>
            </small>
          </div>

          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '5px' }}>Company ID</label>
            <input
              type="text"
              style={inputStyle}
              value={companyId}
              onChange={(e) => setCompanyId(e.target.value)}
              placeholder="e.g. abc123def456"
            />
          </div>

          <button style={buttonStyle} onClick={handleConnect} disabled={isConnecting}>
            {isConnecting ? 'Connecting...' : 'Connect to Kinsta'}
          </button>
        </>
      ) : (
        <>
          <div style={{ marginBottom: '20px' }}>
            <label style={{ display: 'block', marginBottom: '5px' }}>Company ID</label>
            <input type="text" style={{ ...inputStyle, backgroundColor: '#1a1a1a' }} value={companyId} disabled />
          </div>
          <button style={disconnectStyle} onClick={handleDisconnect}>
            Disconnect from Kinsta
          </button>
        </>
      )}
    </div>
  );
};

export default KinstaSettings;
