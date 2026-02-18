/**
 * Configuration loader.
 *
 * Precedence: environment variables → TOML config file → defaults.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { parse as parseTOML, stringify as stringifyTOML } from 'smol-toml';
import type { AccountConfig, AppConfig, OAuth2Config } from '../types/index.js';
import type { RawAccountConfig, RawAppConfig } from './schema.js';
import { AppConfigFileSchema } from './schema.js';
import { CONFIG_FILE, xdg } from './xdg.js';

// ---------------------------------------------------------------------------
// Environment variable loader (single-account quick setup)
// ---------------------------------------------------------------------------

function loadFromEnv(): RawAppConfig | null {
  const email = process.env.MCP_EMAIL_ADDRESS;
  const password = process.env.MCP_EMAIL_PASSWORD;
  const imapHost = process.env.MCP_EMAIL_IMAP_HOST;
  const smtpHost = process.env.MCP_EMAIL_SMTP_HOST;

  if (!email || !imapHost || !smtpHost) {
    return null;
  }

  // Need either password or OAuth2 env vars
  const oauth2Provider = process.env.MCP_EMAIL_OAUTH2_PROVIDER;
  if (!password && !oauth2Provider) {
    return null;
  }

  const oauth2 = oauth2Provider
    ? {
        provider: oauth2Provider as 'google' | 'microsoft' | 'custom',
        client_id: process.env.MCP_EMAIL_OAUTH2_CLIENT_ID ?? '',
        client_secret: process.env.MCP_EMAIL_OAUTH2_CLIENT_SECRET ?? '',
        refresh_token: process.env.MCP_EMAIL_OAUTH2_REFRESH_TOKEN ?? '',
      }
    : undefined;

  return {
    settings: {
      rate_limit: parseInt(process.env.MCP_EMAIL_RATE_LIMIT ?? '10', 10),
      read_only: process.env.MCP_EMAIL_READ_ONLY === 'true',
    },
    accounts: [
      {
        name: process.env.MCP_EMAIL_ACCOUNT_NAME ?? 'default',
        email,
        full_name: process.env.MCP_EMAIL_FULL_NAME,
        username: process.env.MCP_EMAIL_USERNAME,
        password,
        oauth2,
        imap: {
          host: imapHost,
          port: parseInt(process.env.MCP_EMAIL_IMAP_PORT ?? '993', 10),
          tls: process.env.MCP_EMAIL_IMAP_TLS !== 'false',
          starttls: process.env.MCP_EMAIL_IMAP_STARTTLS === 'true',
          verify_ssl: process.env.MCP_EMAIL_IMAP_VERIFY_SSL !== 'false',
        },
        smtp: {
          host: smtpHost,
          port: parseInt(process.env.MCP_EMAIL_SMTP_PORT ?? '465', 10),
          tls: process.env.MCP_EMAIL_SMTP_TLS !== 'false',
          starttls: process.env.MCP_EMAIL_SMTP_STARTTLS === 'true',
          verify_ssl: process.env.MCP_EMAIL_SMTP_VERIFY_SSL !== 'false',
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// TOML file loader
// ---------------------------------------------------------------------------

async function loadFromFile(filePath: string = CONFIG_FILE): Promise<RawAppConfig | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseTOML(content);
    return parsed as unknown as RawAppConfig;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Normalize raw config → typed AppConfig
// ---------------------------------------------------------------------------

function normalizeOAuth2(raw: NonNullable<RawAccountConfig['oauth2']>): OAuth2Config {
  return {
    provider: raw.provider,
    clientId: raw.client_id,
    clientSecret: raw.client_secret,
    refreshToken: raw.refresh_token,
    tokenUrl: raw.token_url,
    authUrl: raw.auth_url,
    scopes: raw.scopes,
  };
}

function normalizeAccount(raw: RawAccountConfig): AccountConfig {
  return {
    name: raw.name,
    email: raw.email,
    fullName: raw.full_name,
    username: raw.username ?? raw.email,
    password: raw.password,
    oauth2: raw.oauth2 ? normalizeOAuth2(raw.oauth2) : undefined,
    imap: {
      host: raw.imap.host,
      port: raw.imap.port,
      tls: raw.imap.tls,
      starttls: raw.imap.starttls,
      verifySsl: raw.imap.verify_ssl,
    },
    smtp: {
      host: raw.smtp.host,
      port: raw.smtp.port,
      tls: raw.smtp.tls,
      starttls: raw.smtp.starttls,
      verifySsl: raw.smtp.verify_ssl,
    },
  };
}

function normalizeConfig(raw: RawAppConfig): AppConfig {
  return {
    settings: {
      rateLimit: raw.settings.rate_limit,
      readOnly: raw.settings.read_only,
    },
    accounts: raw.accounts.map(normalizeAccount),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load raw (snake_case) config from TOML file without normalization.
 * Useful for read-modify-write operations in CLI commands.
 * Throws if no config file exists or validation fails.
 */
export async function loadRawConfig(configPath?: string): Promise<RawAppConfig> {
  const filePath = configPath ?? CONFIG_FILE;
  const fileConfig = await loadFromFile(filePath);
  if (!fileConfig) {
    throw new Error(`No config file found at: ${filePath}`);
  }
  return AppConfigFileSchema.parse(fileConfig);
}

/**
 * Load and validate configuration from env vars or TOML file.
 * Throws on validation errors.
 */
export async function loadConfig(configPath?: string): Promise<AppConfig> {
  // 1. Try environment variables first
  const envConfig = loadFromEnv();
  if (envConfig) {
    const validated = AppConfigFileSchema.parse(envConfig);
    return normalizeConfig(validated);
  }

  // 2. Fall back to TOML config file
  const fileConfig = await loadFromFile(configPath);
  if (fileConfig) {
    const validated = AppConfigFileSchema.parse(fileConfig);
    return normalizeConfig(validated);
  }

  throw new Error(
    `No configuration found.\n\n` +
      `Set environment variables (MCP_EMAIL_ADDRESS, MCP_EMAIL_PASSWORD, etc.)\n` +
      `or create a config file at: ${configPath ?? CONFIG_FILE}\n\n` +
      `Run 'email-mcp setup' for interactive configuration.`,
  );
}

/**
 * Save configuration to a TOML file.
 */
export async function saveConfig(
  config: RawAppConfig,
  filePath: string = CONFIG_FILE,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const toml = stringifyTOML(config as Record<string, unknown>);
  await fs.writeFile(filePath, toml, 'utf-8');
}

/**
 * Generate a template TOML config string.
 */
export function generateTemplate(): string {
  return `# Email MCP Server Configuration
# Location: ${CONFIG_FILE}

[settings]
rate_limit = 10  # max emails per minute per account
read_only = false  # set to true to disable all write operations

[[accounts]]
name = "personal"
email = "you@example.com"
full_name = "Your Name"
# username defaults to email if omitted
# username = "you@example.com"
password = "your-app-password"

[accounts.imap]
host = "imap.example.com"
port = 993
tls = true
starttls = false
verify_ssl = true

[accounts.smtp]
host = "smtp.example.com"
port = 465
tls = true
starttls = false
verify_ssl = true
`;
}

/**
 * Check if a config file exists at the default XDG path.
 */
export async function configExists(filePath: string = CONFIG_FILE): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Re-export for convenience */
export { CONFIG_FILE, xdg };
