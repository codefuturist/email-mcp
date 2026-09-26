import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  configExists,
  generateTemplate,
  loadConfig,
  loadRawConfig,
  saveConfig,
  saveConfigValidated,
} from './loader.js';

const MINIMAL_TOML = `
[[accounts]]
name = "test"
email = "test@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

const MCP_ENV_KEYS = Object.keys(process.env).filter((k) => k.startsWith('MCP_EMAIL_'));

describe('Config Loader', () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-test-'));

    // Save and clear all MCP_EMAIL_* env vars
    for (const key of MCP_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Also clear the standard ones we set in tests
    for (const key of [
      'MCP_EMAIL_ADDRESS',
      'MCP_EMAIL_PASSWORD',
      'MCP_EMAIL_IMAP_HOST',
      'MCP_EMAIL_SMTP_HOST',
      'MCP_EMAIL_READ_ONLY',
      'MCP_EMAIL_ACCOUNT_NAME',
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });

    // Restore env vars
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // -------------------------------------------------------------------------
  // loadConfig from TOML file
  // -------------------------------------------------------------------------

  describe('loadConfig from TOML file', () => {
    it('loads a valid TOML config file', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');

      const config = await loadConfig(configPath);

      expect(config.accounts).toHaveLength(1);
      expect(config.accounts[0].name).toBe('test');
      expect(config.accounts[0].email).toBe('test@example.com');
      expect(config.accounts[0].imap.host).toBe('imap.example.com');
      expect(config.accounts[0].smtp.host).toBe('smtp.example.com');
    });

    it('throws when config file does not exist', async () => {
      const badPath = path.join(tmpDir, 'nonexistent.toml');
      await expect(loadConfig(badPath)).rejects.toThrow('No configuration found');
    });

    it('normalizes snake_case to camelCase', async () => {
      const toml = `
[[accounts]]
name = "test"
email = "test@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"
verify_ssl = false

[accounts.smtp]
host = "smtp.example.com"
verify_ssl = false

[settings]
rate_limit = 5
read_only = true
`;
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, toml, 'utf-8');

      const config = await loadConfig(configPath);

      expect(config.accounts[0].imap.verifySsl).toBe(false);
      expect(config.accounts[0].smtp.verifySsl).toBe(false);
      expect(config.settings.rateLimit).toBe(5);
      expect(config.settings.readOnly).toBe(true);
    });

    it('applies default values for optional fields', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');

      const config = await loadConfig(configPath);

      // Account defaults
      expect(config.accounts[0].imap.port).toBe(993);
      expect(config.accounts[0].imap.tls).toBe(true);
      expect(config.accounts[0].imap.verifySsl).toBe(true);
      expect(config.accounts[0].smtp.port).toBe(465);
      expect(config.accounts[0].smtp.pool?.enabled).toBe(true);
      expect(config.accounts[0].smtp.pool?.maxConnections).toBe(1);

      // Settings defaults
      expect(config.settings.rateLimit).toBe(10);
      expect(config.settings.readOnly).toBe(false);
      expect(config.settings.watcher.enabled).toBe(false);
      expect(config.settings.watcher.folders).toEqual(['INBOX']);
      expect(config.settings.hooks.onNewEmail).toBe('notify');
      expect(config.settings.hooks.preset).toBe('priority-focus');
    });
  });

  // -------------------------------------------------------------------------
  // loadConfig from environment variables
  // -------------------------------------------------------------------------

  describe('loadConfig from environment variables', () => {
    it('loads config from env vars when set', async () => {
      process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
      process.env.MCP_EMAIL_PASSWORD = 'env-pass';
      process.env.MCP_EMAIL_IMAP_HOST = 'imap.env.com';
      process.env.MCP_EMAIL_SMTP_HOST = 'smtp.env.com';

      const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

      expect(config.accounts).toHaveLength(1);
      expect(config.accounts[0].email).toBe('env@example.com');
      expect(config.accounts[0].imap.host).toBe('imap.env.com');
      expect(config.accounts[0].smtp.host).toBe('smtp.env.com');
    });

    it('reads read_only from MCP_EMAIL_READ_ONLY', async () => {
      process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
      process.env.MCP_EMAIL_PASSWORD = 'env-pass';
      process.env.MCP_EMAIL_IMAP_HOST = 'imap.env.com';
      process.env.MCP_EMAIL_SMTP_HOST = 'smtp.env.com';
      process.env.MCP_EMAIL_READ_ONLY = 'true';

      const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

      expect(config.settings.readOnly).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // verification settings
  // -------------------------------------------------------------------------

  describe('verification settings', () => {
    it('normalizes [settings.verification] to camelCase', async () => {
      const toml = `${MINIMAL_TOML}
[settings.verification]
auto_copy = false
clear_after_seconds = 30
sender_allowlist = ["*@github.com"]
`;
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, toml, 'utf-8');

      const config = await loadConfig(configPath);

      expect(config.settings.verification.autoCopy).toBe(false);
      expect(config.settings.verification.clearAfterSeconds).toBe(30);
      expect(config.settings.verification.senderAllowlist).toEqual(['*@github.com']);
      expect(config.settings.verification.enabled).toBe(true);
    });

    it('normalizes [settings.server] and applies its defaults', async () => {
      const toml = `${MINIMAL_TOML}
[settings.server]
port = 3199
allowed_hosts = ["mail.example.com"]
`;
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, toml, 'utf-8');

      const config = await loadConfig(configPath);

      expect(config.settings.server.port).toBe(3199);
      expect(config.settings.server.allowedHosts).toEqual(['mail.example.com']);
      expect(config.settings.server.host).toBe('127.0.0.1');
      expect(config.settings.server.path).toBe('/mcp');
      expect(config.settings.server.token).toBe('');
    });

    it('normalizes confirm_copy and link_action', async () => {
      const toml = `${MINIMAL_TOML}
[settings.verification]
confirm_copy = true
link_action = "copy"
`;
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, toml, 'utf-8');

      const config = await loadConfig(configPath);

      expect(config.settings.verification.confirmCopy).toBe(true);
      expect(config.settings.verification.linkAction).toBe('copy');
    });

    it('applies verification defaults when the section is absent', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');

      const config = await loadConfig(configPath);

      expect(config.settings.verification.enabled).toBe(true);
      expect(config.settings.verification.autoCopy).toBe(true);
      expect(config.settings.verification.confirmCopy).toBe(false);
      expect(config.settings.verification.copyLinks).toBe(true);
      expect(config.settings.verification.linkAction).toBe('open');
      expect(config.settings.verification.maxAgeMinutes).toBe(10);
      expect(config.settings.verification.accounts).toEqual([]);
    });

    it('treats MCP_EMAIL_VERIFICATION_ENABLED=false as an opt-out', async () => {
      process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
      process.env.MCP_EMAIL_PASSWORD = 'env-pass';
      process.env.MCP_EMAIL_IMAP_HOST = 'imap.env.com';
      process.env.MCP_EMAIL_SMTP_HOST = 'smtp.env.com';
      process.env.MCP_EMAIL_VERIFICATION_ENABLED = 'false';
      process.env.MCP_EMAIL_VERIFICATION_CLEAR_AFTER_SECONDS = '90';
      process.env.MCP_EMAIL_VERIFICATION_CONFIRM_COPY = 'true';
      process.env.MCP_EMAIL_VERIFICATION_LINK_ACTION = 'copy';

      const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

      expect(config.settings.verification.enabled).toBe(false);
      expect(config.settings.verification.clearAfterSeconds).toBe(90);
      expect(config.settings.verification.confirmCopy).toBe(true);
      expect(config.settings.verification.linkAction).toBe('copy');
    });
  });

  // -------------------------------------------------------------------------
  // saveConfig
  // -------------------------------------------------------------------------

  describe('saveConfig', () => {
    it('saves config as TOML and can be re-read', async () => {
      const configPath = path.join(tmpDir, 'saved.toml');

      // Write minimal TOML first, load it as raw, then save and re-load
      const srcPath = path.join(tmpDir, 'source.toml');
      await fs.writeFile(srcPath, MINIMAL_TOML, 'utf-8');
      await loadConfig(srcPath);

      // Build a RawAppConfig to save
      const rawConfig = {
        accounts: [
          {
            name: 'saved-test',
            email: 'saved@example.com',
            password: 'saved-pass',
            imap: { host: 'imap.saved.com' },
            smtp: { host: 'smtp.saved.com' },
          },
        ],
      };

      await saveConfig(rawConfig as unknown as Parameters<typeof saveConfig>[0], configPath);

      const reloaded = await loadConfig(configPath);
      expect(reloaded.accounts[0].name).toBe('saved-test');
      expect(reloaded.accounts[0].email).toBe('saved@example.com');
      expect(reloaded.accounts[0].imap.host).toBe('imap.saved.com');
    });
  });

  // -------------------------------------------------------------------------
  // saveConfigValidated
  // -------------------------------------------------------------------------

  describe('saveConfigValidated', () => {
    it('rejects an invalid config and leaves the existing file untouched', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');
      const originalBytes = await fs.readFile(configPath, 'utf-8');

      const invalid = { accounts: [] } as never;
      await expect(saveConfigValidated(invalid, configPath)).rejects.toThrow();

      expect(await fs.readFile(configPath, 'utf-8')).toBe(originalBytes);
      expect(await configExists(`${configPath}.bak`)).toBe(false);
    });

    it('backs up the previous file bytes before writing', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      const original = `# my precious comment\n${MINIMAL_TOML}`;
      await fs.writeFile(configPath, original, 'utf-8');
      const raw = await loadRawConfig(configPath);
      raw.settings.watcher.enabled = true;

      const result = await saveConfigValidated(raw, configPath);

      expect(result.backupPath).toBe(`${configPath}.bak`);
      expect(await fs.readFile(`${configPath}.bak`, 'utf-8')).toBe(original);
      const reloaded = await loadRawConfig(configPath);
      expect(reloaded.settings.watcher.enabled).toBe(true);
    });

    it('handles the very first save without a backup', async () => {
      const configPath = path.join(tmpDir, 'fresh.toml');
      const srcPath = path.join(tmpDir, 'src.toml');
      await fs.writeFile(srcPath, MINIMAL_TOML, 'utf-8');
      const raw = await loadRawConfig(srcPath);

      const result = await saveConfigValidated(raw, configPath);

      expect(result.backupPath).toBeUndefined();
      expect(result.commentsLost).toBe(false);
      expect(await configExists(configPath)).toBe(true);
    });

    it('flags comment loss only on the first overwrite of a commented file', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, `# documented\n${MINIMAL_TOML}`, 'utf-8');
      const raw = await loadRawConfig(configPath);

      const first = await saveConfigValidated(raw, configPath);
      const second = await saveConfigValidated(await loadRawConfig(configPath), configPath);

      expect(first.commentsLost).toBe(true);
      expect(second.commentsLost).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // configExists
  // -------------------------------------------------------------------------

  describe('configExists', () => {
    it('returns true for existing file', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');

      expect(await configExists(configPath)).toBe(true);
    });

    it('returns false for non-existing file', async () => {
      const badPath = path.join(tmpDir, 'nope.toml');

      expect(await configExists(badPath)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // generateTemplate
  // -------------------------------------------------------------------------

  describe('generateTemplate', () => {
    it('returns valid TOML template string', () => {
      const template = generateTemplate();

      expect(typeof template).toBe('string');
      expect(template).toContain('[[accounts]]');
      expect(template).toContain('[accounts.imap]');
      expect(template).toContain('[accounts.smtp]');
      expect(template).toContain('[settings]');
      expect(template).toContain('rate_limit');
      expect(template).toContain('[settings.verification]');
    });
  });
});
