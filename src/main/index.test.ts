import { describe, it, expect, vi } from 'vitest';
import {
  isValidHostname,
  isValidPort,
  isValidUsername,
  isValidDomain,
  validateEnvironmentInfo,
  expandPath,
  describePartialTransfer,
  sshArgs,
  rsyncProgressArgs,
  makeRsyncProgressParser,
  getDbCredentials,
  searchReplacePairs,
  EXCLUDE_PATTERNS,
  EnvironmentInfo,
  RsyncInfo,
} from './index';

const env = (overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo => ({
  envId: 'env-1',
  envType: 'live',
  sshHost: '35.1.2.3',
  sshPort: '12345',
  sshUser: 'gbdbutik',
  remoteDomain: 'gbdbutik.se',
  ...overrides,
});

describe('injection guards (validators)', () => {
  it('accepts normal hosts', () => {
    expect(isValidHostname('35.1.2.3')).toBe(true);
    expect(isValidHostname('ssh.kinsta.cloud')).toBe(true);
  });

  it('rejects shell metacharacters in hostnames', () => {
    for (const bad of ['host;rm -rf /', 'host$(id)', 'host`id`', 'host name', '-oProxyCommand=evil', '']) {
      expect(isValidHostname(bad)).toBe(false);
    }
  });

  it('validates ports as 1-65535', () => {
    expect(isValidPort('22')).toBe(true);
    expect(isValidPort('65535')).toBe(true);
    expect(isValidPort('0')).toBe(false);
    expect(isValidPort('65536')).toBe(false);
    expect(isValidPort('22; rm')).toBe(false);
    expect(isValidPort('abc')).toBe(false);
  });

  it('rejects dangerous usernames and domains', () => {
    expect(isValidUsername('gbdbutik')).toBe(true);
    expect(isValidUsername('user name')).toBe(false);
    expect(isValidUsername('user;id')).toBe(false);
    expect(isValidDomain('gbdbutik.se')).toBe(true);
    expect(isValidDomain("dom'ain.se")).toBe(false);
  });

  it('validateEnvironmentInfo requires every field to pass', () => {
    expect(validateEnvironmentInfo(env())).toBe(true);
    expect(validateEnvironmentInfo(env({ sshHost: 'host;evil' }))).toBe(false);
    expect(validateEnvironmentInfo(env({ sshPort: '99999' }))).toBe(false);
    expect(validateEnvironmentInfo(env({ sshUser: 'a b' }))).toBe(false);
    expect(validateEnvironmentInfo(env({ remoteDomain: '$(x).se' }))).toBe(false);
  });
});

describe('sshArgs', () => {
  it('builds args as an array (no shell string)', () => {
    expect(sshArgs(env(), 'wp db export /tmp/x.sql')).toEqual([
      '-p', '12345',
      '-o', 'StrictHostKeyChecking=accept-new',
      'gbdbutik@35.1.2.3',
      'wp db export /tmp/x.sql',
    ]);
  });
});

describe('expandPath', () => {
  it('expands ~ to the home directory', () => {
    expect(expandPath('~/Local Sites/x')).not.toContain('~');
    expect(expandPath('~/x').startsWith('/')).toBe(true);
  });

  it('leaves absolute paths alone', () => {
    expect(expandPath('/var/www')).toBe('/var/www');
  });
});

describe('describePartialTransfer', () => {
  it('returns null for a clean run', () => {
    expect(describePartialTransfer({ code: 0, stderr: '' })).toBeNull();
  });

  it('describes skipped files on exit 23 (legacy filename encoding)', () => {
    const stderr = [
      'rsync: [receiver] mkstemp ".../uploads/2019/12/.Planetv\\#344xel.jpg.1YsZBf" failed: Illegal byte sequence (92)',
      'rsync: [receiver] mkstemp ".../uploads/2019/12/.Planetv\\#344xel-768x540.jpg.sJCw4G" failed: Illegal byte sequence (92)',
      'rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1867)',
    ].join('\n');
    const warning = describePartialTransfer({ code: 23, stderr });
    expect(warning).toMatch(/^2 file/);
    expect(warning).toContain('skipped');
    expect(warning).toContain('Everything else synced');
  });

  it('still warns when no per-file lines were captured', () => {
    const warning = describePartialTransfer({ code: 24, stderr: '' });
    expect(warning).toContain('Some');
  });
});

describe('rsync progress', () => {
  const gnu: RsyncInfo = { bin: 'rsync', supportsProgress2: true, supportsProgress: true };
  const openrsync: RsyncInfo = { bin: '/usr/bin/rsync', supportsProgress2: false, supportsProgress: true };
  const ancient: RsyncInfo = { bin: 'rsync', supportsProgress2: false, supportsProgress: false };

  it('picks the best progress flag per rsync flavor', () => {
    expect(rsyncProgressArgs(gnu)).toEqual(['--info=progress2']);
    expect(rsyncProgressArgs(openrsync)).toEqual(['--progress']);
    expect(rsyncProgressArgs(ancient)).toEqual([]);
  });

  it('parses overall % from --info=progress2 output', () => {
    const onPercent = vi.fn();
    const parse = makeRsyncProgressParser(gnu, onPercent);
    parse('  1,234,567  42%  1.2MB/s  0:00:10');
    expect(onPercent).toHaveBeenLastCalledWith(42);
    parse('  9,999,999  100%  2MB/s  0:00:00');
    expect(onPercent).toHaveBeenLastCalledWith(100);
  });

  it('derives overall % from to-check counts (rsync 2.6.9)', () => {
    const onPercent = vi.fn();
    const parse = makeRsyncProgressParser(ancient, onPercent);
    parse('somefile.jpg\n  123 100%  0.5MB/s (xfer#1, to-check=75/100)');
    expect(onPercent).toHaveBeenLastCalledWith(25);
  });

  it('ignores bouncing per-file % when progress2 is unavailable', () => {
    const onPercent = vi.fn();
    const parse = makeRsyncProgressParser(openrsync, onPercent);
    parse('somefile.jpg 95%'); // per-file, would bounce
    expect(onPercent).not.toHaveBeenCalled();
  });
});

describe('getDbCredentials', () => {
  const site = { id: 'x', path: '/x', domain: 'x.local' };

  it('uses the site mysql config when present', () => {
    expect(getDbCredentials({ ...site, mysql: { database: 'db1', user: 'u1', password: 'p1' } }))
      .toEqual({ database: 'db1', user: 'u1', password: 'p1' });
  });

  it("falls back to Local's defaults", () => {
    expect(getDbCredentials(site)).toEqual({ database: 'local', user: 'root', password: 'root' });
  });
});

describe('searchReplacePairs', () => {
  it('covers https, http and protocol-relative URLs', () => {
    expect(searchReplacePairs('gbdbutik.se', 'gbd-shop.local')).toEqual([
      ['https://gbdbutik.se', 'https://gbd-shop.local'],
      ['http://gbdbutik.se', 'http://gbd-shop.local'],
      ['//gbdbutik.se', '//gbd-shop.local'],
    ]);
  });
});

describe('EXCLUDE_PATTERNS', () => {
  it('protects host-specific and dangerous files', () => {
    for (const required of ['wp-config.php', '.htaccess', '*.sql', 'node_modules/', 'wp-content/mu-plugins/kinsta-mu-plugins/']) {
      expect(EXCLUDE_PATTERNS).toContain(required);
    }
  });

  it('does NOT exclude uploads (that is a per-sync option)', () => {
    expect(EXCLUDE_PATTERNS.some(p => p.includes('uploads'))).toBe(false);
  });
});
