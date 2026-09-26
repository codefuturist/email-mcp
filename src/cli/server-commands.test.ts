import {
  buildLaunchdPlist,
  looksLikeOurServer,
  parseServerArgs,
  selfCommand,
  tailLines,
} from './server-commands.js';

describe('selfCommand', () => {
  it('re-invokes node + entry when running as a script', () => {
    expect(selfCommand('/usr/local/bin/node', '/x/dist/main.js')).toEqual([
      '/usr/local/bin/node',
      '/x/dist/main.js',
    ]);
  });

  it('re-invokes the binary alone when compiled (bun/SEA — no .js entry)', () => {
    expect(selfCommand('/Users/x/.local/bin/email-mcp', '/$bunfs/root/main')).toEqual([
      '/Users/x/.local/bin/email-mcp',
    ]);
    expect(selfCommand('/opt/email-mcp', undefined)).toEqual(['/opt/email-mcp']);
  });

  it('refuses in a TS dev checkout (a spawned copy could not run .ts)', () => {
    expect(selfCommand('/usr/local/bin/node', '/repo/src/main.ts')).toBeUndefined();
  });
});

describe('parseServerArgs', () => {
  it('applies defaults (detached, loopback, port 8080)', () => {
    const args = parseServerArgs([], {});
    expect(args.attach).toBe(false);
    expect(args.force).toBe(false);
    expect(args.host).toBe('127.0.0.1');
    expect(args.port).toBe(8080);
    expect(args.passthrough).toEqual([]);
  });

  it('consumes server-level flags and forwards http flags', () => {
    const args = parseServerArgs(
      ['--attach', '--port', '3199', '--token', 'secret', '--force', '-n', '10'],
      {},
    );
    expect(args.attach).toBe(true);
    expect(args.force).toBe(true);
    expect(args.lines).toBe(10);
    expect(args.port).toBe(3199);
    expect(args.passthrough).toEqual(['--port', '3199', '--token', 'secret']);
  });

  it('falls back to EMAIL_MCP_HTTP_* env like the http command', () => {
    const args = parseServerArgs([], {
      EMAIL_MCP_HTTP_HOST: '0.0.0.0',
      EMAIL_MCP_HTTP_PORT: '9001',
    });
    expect(args.host).toBe('0.0.0.0');
    expect(args.port).toBe(9001);
  });

  it('layers precedence: flags over env over [settings.server] over defaults', () => {
    const serverConfig = {
      host: '10.0.0.5',
      port: 3299,
      path: '/mcp',
      token: '',
      allowedHosts: [],
    };
    // config layer alone
    expect(parseServerArgs([], {}, serverConfig).port).toBe(3299);
    expect(parseServerArgs([], {}, serverConfig).host).toBe('10.0.0.5');
    // env beats config
    expect(parseServerArgs([], { EMAIL_MCP_HTTP_PORT: '9001' }, serverConfig).port).toBe(9001);
    // flags beat env
    expect(
      parseServerArgs(['--port', '3199'], { EMAIL_MCP_HTTP_PORT: '9001' }, serverConfig).port,
    ).toBe(3199);
  });

  it('flags win over env', () => {
    const args = parseServerArgs(['--port', '3199'], { EMAIL_MCP_HTTP_PORT: '9001' });
    expect(args.port).toBe(3199);
  });

  it('rejects invalid ports', () => {
    expect(() => parseServerArgs(['--port', '0'], {})).toThrow('Invalid --port');
    expect(() => parseServerArgs(['--port', 'abc'], {})).toThrow('Invalid --port');
  });
});

describe('looksLikeOurServer', () => {
  it('accepts the built entry and the installed binary', () => {
    expect(
      looksLikeOurServer('/usr/local/bin/node /x/email-mcp/dist/main.js http --port 8080'),
    ).toBe(true);
    expect(looksLikeOurServer('node /path/to/email-mcp http')).toBe(true);
  });

  it('rejects unrelated processes (pid reuse safety)', () => {
    expect(looksLikeOurServer('/usr/bin/python3 some-script.py')).toBe(false);
    expect(looksLikeOurServer('')).toBe(false);
  });
});

describe('buildLaunchdPlist', () => {
  it('produces a KeepAlive login item running the http entry', () => {
    const plist = buildLaunchdPlist(['/usr/local/bin/node', '/x/dist/main.js'], ['--port', '3199']);

    expect(plist).toContain('<string>com.email-mcp.server</string>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    const argOrder = ['/usr/local/bin/node', '/x/dist/main.js', 'http', '--port', '3199'];
    let lastIndex = -1;
    for (const arg of argOrder) {
      const idx = plist.indexOf(`<string>${arg}</string>`);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
    expect(plist).toContain('server.log</string>');
  });

  it('supports a compiled single binary (no separate entry)', () => {
    const plist = buildLaunchdPlist(['/Users/x/.local/bin/email-mcp'], []);
    expect(plist).toContain('<string>/Users/x/.local/bin/email-mcp</string>');
    expect(plist).toContain('<string>http</string>');
    expect(plist).not.toContain('main.js');
  });
});

describe('tailLines', () => {
  it('returns the last N lines', () => {
    const text = ['a', 'b', 'c', 'd', ''].join('\n');
    expect(tailLines(text, 2)).toBe('c\nd');
  });

  it('returns everything when the file is shorter than N', () => {
    expect(tailLines('only\nlines', 40)).toBe('only\nlines');
  });
});
