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
  writeConfigTemplate,
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
      expect(config.accounts[0]!.name).toBe('test');
      expect(config.accounts[0]!.email).toBe('test@example.com');
      expect(config.accounts[0]!.imap.host).toBe('imap.example.com');
      expect(config.accounts[0]!.smtp.host).toBe('smtp.example.com');
    });

    it('throws when config file does not exist', async () => {
      const badPath = path.join(tmpDir, 'nonexistent.toml');
      await expect(loadConfig(badPath)).rejects.toThrow('No configuration found');
    });

    it('reports a TOML syntax error instead of claiming no config exists', async () => {
      const configPath = path.join(tmpDir, 'broken.toml');
      // Unclosed string — a realistic one-character slip.
      await fs.writeFile(configPath, '[[accounts]]\nname = "test\n', 'utf-8');

      const attempt = loadConfig(configPath);
      await expect(attempt).rejects.toThrow('TOML syntax error');
      await expect(attempt).rejects.toThrow(configPath);
      await expect(attempt).rejects.not.toThrow('No configuration found');
    });

    it('names the offending field when the schema rejects the config', async () => {
      const configPath = path.join(tmpDir, 'invalid.toml');
      // Valid TOML, but port must be a number and name is missing.
      await fs.writeFile(
        configPath,
        `[[accounts]]
email = "test@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"
port = "not-a-number"

[accounts.smtp]
host = "smtp.example.com"
port = 587
`,
        'utf-8',
      );

      const attempt = loadConfig(configPath);
      await expect(attempt).rejects.toThrow('Invalid configuration');
      await expect(attempt).rejects.toThrow('accounts.0.imap.port');
      await expect(attempt).rejects.toThrow('config validate');
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

      expect(config.accounts[0]!.imap.verifySsl).toBe(false);
      expect(config.accounts[0]!.smtp.verifySsl).toBe(false);
      expect(config.settings.rateLimit).toBe(5);
      expect(config.settings.readOnly).toBe(true);
    });

    it('applies default values for optional fields', async () => {
      const configPath = path.join(tmpDir, 'config.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');

      const config = await loadConfig(configPath);

      // Account defaults
      expect(config.accounts[0]!.imap.port).toBe(993);
      expect(config.accounts[0]!.imap.tls).toBe(true);
      expect(config.accounts[0]!.imap.verifySsl).toBe(true);
      expect(config.accounts[0]!.smtp.port).toBe(465);
      expect(config.accounts[0]!.smtp.pool?.enabled).toBe(true);
      expect(config.accounts[0]!.smtp.pool?.maxConnections).toBe(1);

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
      expect(config.accounts[0]!.email).toBe('env@example.com');
      expect(config.accounts[0]!.imap.host).toBe('imap.env.com');
      expect(config.accounts[0]!.smtp.host).toBe('smtp.env.com');
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
      expect(reloaded.accounts[0]!.name).toBe('saved-test');
      expect(reloaded.accounts[0]!.email).toBe('saved@example.com');
      expect(reloaded.accounts[0]!.imap.host).toBe('imap.saved.com');
    });

    // `config init` used to write the template with plain writeFile, so it
    // landed at the process umask (commonly 0644) — and the very next step the
    // command prints is "edit the file to add your email accounts", i.e. put
    // a password in a world-readable file.
    it('writes the template with owner-only (0600) permissions', async () => {
      const configPath = path.join(tmpDir, 'init', 'template.toml');

      await writeConfigTemplate(configPath);

      const mode = (await fs.stat(configPath)).mode & 0o777;
      expect(mode).toBe(0o600);
      const dirMode = (await fs.stat(path.dirname(configPath))).mode & 0o777;
      expect(dirMode).toBe(0o700);
    });

    it('tightens an already-loose template file', async () => {
      const configPath = path.join(tmpDir, 'loose.toml');
      await fs.writeFile(configPath, 'stale', { mode: 0o644 });

      await writeConfigTemplate(configPath);

      expect((await fs.stat(configPath)).mode & 0o777).toBe(0o600);
    });

    it('writes the generated template content', async () => {
      const configPath = path.join(tmpDir, 'content.toml');
      await writeConfigTemplate(configPath);
      expect(await fs.readFile(configPath, 'utf-8')).toBe(generateTemplate());
    });

    it('writes the config file with owner-only (0600) permissions', async () => {
      const configPath = path.join(tmpDir, 'perms.toml');
      const rawConfig = {
        accounts: [
          {
            name: 'perm-test',
            email: 'perm@example.com',
            password: 'super-secret',
            imap: { host: 'imap.perm.com' },
            smtp: { host: 'smtp.perm.com' },
          },
        ],
      };

      await saveConfig(rawConfig as unknown as Parameters<typeof saveConfig>[0], configPath);

      const mode = (await fs.stat(configPath)).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('tightens an already-loose existing config to 0600 on save', async () => {
      const configPath = path.join(tmpDir, 'loose.toml');
      await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');
      await fs.chmod(configPath, 0o644);

      const rawConfig = {
        accounts: [
          {
            name: 'loose-test',
            email: 'loose@example.com',
            password: 'secret',
            imap: { host: 'imap.loose.com' },
            smtp: { host: 'smtp.loose.com' },
          },
        ],
      };
      await saveConfig(rawConfig as unknown as Parameters<typeof saveConfig>[0], configPath);

      const mode = (await fs.stat(configPath)).mode & 0o777;
      expect(mode).toBe(0o600);
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

describe('send settings mapping', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'send-cfg-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    for (const k of [
      'MCP_EMAIL_ADDRESS',
      'MCP_EMAIL_PASSWORD',
      'MCP_EMAIL_IMAP_HOST',
      'MCP_EMAIL_SMTP_HOST',
      'MCP_EMAIL_SEND_MAX_ATTACHMENT_MB',
    ]) {
      delete process.env[k];
    }
  });

  it('maps [settings.send] max_attachment_mb to camelCase and defaults to 25', async () => {
    const configPath = path.join(tmpDir, 'config.toml');
    await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');
    const config = await loadConfig(configPath);
    // save_to_sent defaults off: Gmail/Outlook file sent mail themselves, so
    // enabling it by default would show those users two copies.
    expect(config.settings.send).toEqual({ maxAttachmentMb: 25, saveToSent: false });

    await fs.writeFile(
      configPath,
      `${MINIMAL_TOML}\n[settings.send]\nmax_attachment_mb = 10\n`,
      'utf-8',
    );
    const custom = await loadConfig(configPath);
    expect(custom.settings.send.maxAttachmentMb).toBe(10);
  });

  it('maps a per-account max_attachment_mb to camelCase', async () => {
    const configPath = path.join(tmpDir, 'config.toml');
    await fs.writeFile(
      configPath,
      MINIMAL_TOML.replace('[accounts.imap]', 'max_attachment_mb = 40\n[accounts.imap]'),
      'utf-8',
    );
    const config = await loadConfig(configPath);
    expect(config.accounts[0]!.maxAttachmentMb).toBe(40);
  });

  it('maps [settings.attachments] auto_download to camelCase and defaults to true', async () => {
    const configPath = path.join(tmpDir, 'config.toml');
    await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');
    const config = await loadConfig(configPath);
    expect(config.settings.attachments).toEqual({ autoDownload: true });

    await fs.writeFile(
      configPath,
      `${MINIMAL_TOML}\n[settings.attachments]\nauto_download = false\n`,
      'utf-8',
    );
    const custom = await loadConfig(configPath);
    expect(custom.settings.attachments.autoDownload).toBe(false);
  });

  it('reads MCP_EMAIL_ATTACHMENTS_AUTO_DOWNLOAD in env mode', async () => {
    process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
    process.env.MCP_EMAIL_PASSWORD = 'env-pass';
    process.env.MCP_EMAIL_IMAP_HOST = 'imap.env.com';
    process.env.MCP_EMAIL_SMTP_HOST = 'smtp.env.com';
    process.env.MCP_EMAIL_ATTACHMENTS_AUTO_DOWNLOAD = 'false';

    const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

    expect(config.settings.attachments.autoDownload).toBe(false);
  });

  it('reads MCP_EMAIL_SEND_MAX_ATTACHMENT_MB in env mode', async () => {
    process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
    process.env.MCP_EMAIL_PASSWORD = 'env-pass';
    process.env.MCP_EMAIL_IMAP_HOST = 'imap.env.com';
    process.env.MCP_EMAIL_SMTP_HOST = 'smtp.env.com';
    process.env.MCP_EMAIL_SEND_MAX_ATTACHMENT_MB = '5';

    const config = await loadConfig(path.join(tmpDir, 'nonexistent.toml'));

    expect(config.settings.send.maxAttachmentMb).toBe(5);
  });
});

describe('secret resolution on load', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sec-'));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    delete process.env.EMAIL_SECRET_TEST_PW;
  });

  it('resolves an env: password reference when loading a TOML config', async () => {
    process.env.EMAIL_SECRET_TEST_PW = 'resolved-from-env';
    const toml = `
[[accounts]]
name = "acct"
email = "a@example.com"
username = "a"
password = "env:EMAIL_SECRET_TEST_PW"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;
    const configPath = path.join(tmpDir, 'config.toml');
    await fs.writeFile(configPath, toml, 'utf-8');

    const config = await loadConfig(configPath);
    expect(config.accounts[0]!.password).toBe('resolved-from-env');
  });

  it('leaves a plaintext password untouched (backward compatible)', async () => {
    const configPath = path.join(tmpDir, 'plain.toml');
    await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');
    const config = await loadConfig(configPath);
    expect(config.accounts[0]!.password).toBe('secret');
  });
});

describe('credential alerts mapping', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-alerts-cfg-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('normalizes [settings.credential_alerts] and the per-account override to camelCase', async () => {
    const toml = `${MINIMAL_TOML}
[settings.credential_alerts]
sound = false
remind_every_minutes = 360
webhook = true
`.replace('[[accounts]]', '[[accounts]]\ncredential_alerts = false');
    const configPath = path.join(tmpDir, 'config.toml');
    await fs.writeFile(configPath, toml, 'utf-8');

    const config = await loadConfig(configPath);

    expect(config.settings.credentialAlerts).toEqual({
      enabled: true,
      sound: false,
      remindEveryMinutes: 360,
      webhook: true,
    });
    expect(config.accounts[0]?.credentialAlerts).toBe(false);
  });

  it('defaults credential alerts on, once per failure, no webhook', async () => {
    const configPath = path.join(tmpDir, 'config.toml');
    await fs.writeFile(configPath, MINIMAL_TOML, 'utf-8');

    const config = await loadConfig(configPath);

    expect(config.settings.credentialAlerts).toEqual({
      enabled: true,
      sound: true,
      remindEveryMinutes: 0,
      webhook: false,
    });
    expect(config.accounts[0]?.credentialAlerts).toBeUndefined();
  });
});
