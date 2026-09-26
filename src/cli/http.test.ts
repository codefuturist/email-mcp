import type { ServerConfig } from '../types/index.js';
import { parseOptions } from './http.js';

const serverConfig: ServerConfig = {
  host: '10.0.0.5',
  port: 3299,
  path: '/email',
  token: 'config-token',
  allowedHosts: ['mail.example.com'],
};

describe('parseOptions precedence', () => {
  it('uses hardcoded defaults when nothing else is provided', () => {
    const opts = parseOptions([], {});
    expect(opts.host).toBe('127.0.0.1');
    expect(opts.port).toBe(8080);
    expect(opts.path).toBe('/mcp');
    expect(opts.token).toBeUndefined();
  });

  it('reads the [settings.server] layer', () => {
    const opts = parseOptions([], {}, serverConfig);
    expect(opts.host).toBe('10.0.0.5');
    expect(opts.port).toBe(3299);
    expect(opts.path).toBe('/email');
    expect(opts.token).toBe('config-token');
    expect(opts.allowedHosts).toEqual(['mail.example.com']);
  });

  it('lets env override config and flags override env', () => {
    const env = { EMAIL_MCP_HTTP_PORT: '9001', EMAIL_MCP_HTTP_TOKEN: 'env-token' };
    const envOpts = parseOptions([], env, serverConfig);
    expect(envOpts.port).toBe(9001);
    expect(envOpts.token).toBe('env-token');

    const flagOpts = parseOptions(['--port', '3199', '--token', 'flag-token'], env, serverConfig);
    expect(flagOpts.port).toBe(3199);
    expect(flagOpts.token).toBe('flag-token');
  });

  it('treats an empty config token as no auth', () => {
    const opts = parseOptions([], {}, { ...serverConfig, token: '' });
    expect(opts.token).toBeUndefined();
  });
});
