import { classifyInstall, compareVersions, parseChecksums, pickAssetName } from './update.js';

describe('compareVersions', () => {
  it('orders plain semver numerically, not lexicographically', () => {
    expect(compareVersions('0.5.1', '0.5.1')).toBe(0);
    expect(compareVersions('0.5.0', '0.5.1')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });

  it('tolerates a leading v and missing parts', () => {
    expect(compareVersions('v0.5.1', '0.5.1')).toBe(0);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });

  it('ranks a prerelease below its release', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
  });
});

describe('pickAssetName', () => {
  it('maps the five primary platforms to goreleaser asset names', () => {
    expect(pickAssetName('0.5.1', 'darwin', 'arm64', false)).toBe(
      'email-mcp_0.5.1_darwin_arm64.tar.gz',
    );
    expect(pickAssetName('0.5.1', 'darwin', 'x64', false)).toBe(
      'email-mcp_0.5.1_darwin_amd64.tar.gz',
    );
    expect(pickAssetName('0.5.1', 'linux', 'x64', false)).toBe(
      'email-mcp_0.5.1_linux_amd64.tar.gz',
    );
    expect(pickAssetName('0.5.1', 'linux', 'arm64', false)).toBe(
      'email-mcp_0.5.1_linux_arm64.tar.gz',
    );
    expect(pickAssetName('0.5.1', 'win32', 'x64', false)).toBe('email-mcp_0.5.1_windows_amd64.zip');
  });

  it('selects the musl variant on musl linux only', () => {
    expect(pickAssetName('0.5.1', 'linux', 'x64', true)).toBe(
      'email-mcp_0.5.1_linux_amd64_musl.tar.gz',
    );
    expect(pickAssetName('0.5.1', 'linux', 'arm64', true)).toBe(
      'email-mcp_0.5.1_linux_arm64_musl.tar.gz',
    );
    // musl is meaningless off linux and must not leak into the name
    expect(pickAssetName('0.5.1', 'darwin', 'arm64', true)).toBe(
      'email-mcp_0.5.1_darwin_arm64.tar.gz',
    );
  });

  it('falls back to amd64 on windows-arm64 (no native asset published)', () => {
    expect(pickAssetName('0.5.1', 'win32', 'arm64', false)).toBe(
      'email-mcp_0.5.1_windows_amd64.zip',
    );
  });

  it('rejects platforms without published binaries', () => {
    expect(() => pickAssetName('0.5.1', 'freebsd', 'x64', false)).toThrow(/freebsd/);
    expect(() => pickAssetName('0.5.1', 'linux', 'ia32', false)).toThrow(/ia32/);
  });
});

describe('parseChecksums', () => {
  // Verbatim lines from the published email-mcp_0.5.1_checksums.txt.
  const fixture = [
    '7df14d55c024b6046718f76e3328b8ff045b81887efc013a7bd7b394b5b832a2  email-mcp_0.5.1_darwin_amd64.tar.gz',
    '5b7539f43d8de132e2954386c8417a769c7ca51d98ee9c1104a909a84adaebc7  email-mcp_0.5.1_darwin_arm64.tar.gz',
    '5f2810f93711fbea106e433cdafd9e63f6458b4e42ad7b15716406c386aced92  email-mcp_0.5.1_linux_amd64_musl.tar.gz',
    '1e6c4eade638ff83a9a06c840ddda296ee0831168538e9ea314131951e7dafb0  email-mcp_0.5.1_windows_amd64.zip',
  ].join('\n');

  it('maps file names to hashes from sha256sum-format lines', () => {
    const sums = parseChecksums(`${fixture}\n`);
    expect(sums.get('email-mcp_0.5.1_darwin_arm64.tar.gz')).toBe(
      '5b7539f43d8de132e2954386c8417a769c7ca51d98ee9c1104a909a84adaebc7',
    );
    expect(sums.size).toBe(4);
  });

  it('ignores malformed lines instead of throwing', () => {
    const sums = parseChecksums(`not a checksum line\n${fixture}`);
    expect(sums.size).toBe(4);
  });
});

describe('classifyInstall', () => {
  const bin = '/usr/local/bin/email-mcp';

  it('treats a bunfs or absent entry as the compiled binary', () => {
    expect(classifyInstall(bin, '/$bunfs/root/main', bin)).toEqual({
      kind: 'binary',
      target: bin,
    });
    expect(classifyInstall(bin, undefined, bin)).toEqual({ kind: 'binary', target: bin });
  });

  it('classifies a .js entry as a package-manager install', () => {
    const entry = '/usr/local/lib/node_modules/@codefuturist/email-mcp/dist/main.js';
    expect(classifyInstall('/usr/bin/node', entry, '/usr/bin/node')).toEqual({ kind: 'npm' });
  });

  it('classifies a TypeScript entry as a dev checkout', () => {
    expect(classifyInstall('/usr/bin/node', '/repo/src/main.ts', '/usr/bin/node')).toEqual({
      kind: 'dev',
    });
  });

  it('flags mise-managed binaries so mise stays the owner', () => {
    const miseBin = '/Users/u/.local/share/mise/installs/email-mcp/0.5.1/email-mcp';
    expect(classifyInstall(miseBin, undefined, miseBin)).toEqual({
      kind: 'mise',
      target: miseBin,
    });
  });

  it('sees through a symlink to a mise-managed binary', () => {
    const link = '/usr/local/bin/email-mcp';
    const real = '/Users/u/.local/share/mise/installs/email-mcp/0.5.1/email-mcp';
    expect(classifyInstall(link, undefined, real)).toEqual({ kind: 'mise', target: link });
  });
});
