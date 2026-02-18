/**
 * Configuration loader.
 *
 * Precedence: environment variables → TOML config file → defaults.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { parse as parseTOML, stringify as stringifyTOML } from 'smol-toml';
import type { AccountConfig, AppConfig, HookRule, OAuth2Config } from '../types/index.js';
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
      watcher: {
        enabled: process.env.MCP_EMAIL_WATCHER_ENABLED === 'true',
        folders: (process.env.MCP_EMAIL_WATCHER_FOLDERS ?? 'INBOX')
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean),
        idle_timeout: parseInt(process.env.MCP_EMAIL_WATCHER_IDLE_TIMEOUT ?? '1740', 10),
      },
      hooks: {
        on_new_email:
          (process.env.MCP_EMAIL_HOOK_ON_NEW_EMAIL as 'triage' | 'notify' | 'none') ?? 'notify',
        preset:
          (process.env.MCP_EMAIL_HOOK_PRESET as
            | 'inbox-zero'
            | 'gtd'
            | 'priority-focus'
            | 'notification-only'
            | 'custom') ?? 'priority-focus',
        auto_label: process.env.MCP_EMAIL_HOOK_AUTO_LABEL === 'true',
        auto_flag: process.env.MCP_EMAIL_HOOK_AUTO_FLAG === 'true',
        batch_delay: parseInt(process.env.MCP_EMAIL_HOOK_BATCH_DELAY ?? '5', 10),
        custom_instructions: process.env.MCP_EMAIL_HOOK_CUSTOM_INSTRUCTIONS,
        rules: [],
        alerts: {
          desktop: process.env.MCP_EMAIL_ALERT_DESKTOP === 'true',
          sound: process.env.MCP_EMAIL_ALERT_SOUND === 'true',
          urgency_threshold:
            (process.env.MCP_EMAIL_ALERT_URGENCY_THRESHOLD as
              | 'urgent'
              | 'high'
              | 'normal'
              | 'low') ?? 'high',
          webhook_url: process.env.MCP_EMAIL_ALERT_WEBHOOK_URL ?? '',
          webhook_events: ['urgent', 'high'],
        },
        auto_calendar: process.env.MCP_EMAIL_HOOK_AUTO_CALENDAR === 'true',
        calendar_name: process.env.MCP_EMAIL_HOOK_CALENDAR_NAME ?? '',
        calendar_alarm_minutes: parseInt(
          process.env.MCP_EMAIL_HOOK_CALENDAR_ALARM_MINUTES ?? '15',
          10,
        ),
        calendar_confirm: process.env.MCP_EMAIL_HOOK_CALENDAR_CONFIRM !== 'false',
      },
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
          pool: {
            enabled: process.env.MCP_EMAIL_SMTP_POOL_ENABLED !== 'false',
            max_connections: parseInt(process.env.MCP_EMAIL_SMTP_POOL_MAX_CONNECTIONS ?? '1', 10),
            max_messages: parseInt(process.env.MCP_EMAIL_SMTP_POOL_MAX_MESSAGES ?? '100', 10),
          },
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
      pool: {
        enabled: raw.smtp.pool.enabled,
        maxConnections: raw.smtp.pool.max_connections,
        maxMessages: raw.smtp.pool.max_messages,
      },
    },
  };
}

function normalizeHookRule(raw: {
  name: string;
  match: Record<string, string | undefined>;
  actions: Record<string, unknown>;
}): HookRule {
  return {
    name: raw.name,
    match: {
      from: raw.match.from,
      to: raw.match.to,
      subject: raw.match.subject,
    },
    actions: {
      labels: Array.isArray(raw.actions.labels) ? (raw.actions.labels as string[]) : undefined,
      flag: typeof raw.actions.flag === 'boolean' ? raw.actions.flag : undefined,
      markRead: typeof raw.actions.mark_read === 'boolean' ? raw.actions.mark_read : undefined,
      alert: typeof raw.actions.alert === 'boolean' ? raw.actions.alert : undefined,
      addToCalendar:
        typeof raw.actions.add_to_calendar === 'boolean'
          ? raw.actions.add_to_calendar
          : undefined,
    },
  };
}

function normalizeConfig(raw: RawAppConfig): AppConfig {
  return {
    settings: {
      rateLimit: raw.settings.rate_limit,
      readOnly: raw.settings.read_only,
      watcher: {
        enabled: raw.settings.watcher.enabled,
        folders: raw.settings.watcher.folders,
        idleTimeout: raw.settings.watcher.idle_timeout,
      },
      hooks: {
        onNewEmail: raw.settings.hooks.on_new_email,
        preset: raw.settings.hooks.preset,
        autoLabel: raw.settings.hooks.auto_label,
        autoFlag: raw.settings.hooks.auto_flag,
        batchDelay: raw.settings.hooks.batch_delay,
        customInstructions: raw.settings.hooks.custom_instructions,
        systemPrompt: raw.settings.hooks.system_prompt,
        rules: (raw.settings.hooks.rules ?? []).map(normalizeHookRule),
        alerts: {
          desktop: raw.settings.hooks.alerts?.desktop ?? false,
          sound: raw.settings.hooks.alerts?.sound ?? false,
          urgencyThreshold: raw.settings.hooks.alerts?.urgency_threshold ?? 'high',
          webhookUrl: raw.settings.hooks.alerts?.webhook_url ?? '',
          webhookEvents: raw.settings.hooks.alerts?.webhook_events ?? ['urgent', 'high'],
        },
        autoCalendar: raw.settings.hooks.auto_calendar ?? false,
        calendarName: raw.settings.hooks.calendar_name ?? '',
        calendarAlarmMinutes: raw.settings.hooks.calendar_alarm_minutes ?? 15,
        calendarConfirm: raw.settings.hooks.calendar_confirm ?? true,
      },
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

# [settings.watcher]
# enabled = false        # enable IMAP IDLE real-time monitoring
# folders = ["INBOX"]    # folders to watch per account
# idle_timeout = 1740    # seconds (29 min, IMAP max is 30)

# [settings.hooks]
# on_new_email = "notify"  # "triage" (AI) | "notify" (log) | "none"
# preset = "priority-focus" # "inbox-zero" | "gtd" | "priority-focus" | "notification-only" | "custom"
# auto_label = false       # auto-apply AI-suggested labels
# auto_flag = false        # auto-flag urgent emails
# batch_delay = 5          # seconds to batch before processing
# custom_instructions = "I'm a software engineer. Emails from @company.com are high priority."
# system_prompt = ""       # full override (only when preset = "custom")

# Static rules — run BEFORE AI triage, skip AI if matched
# [[settings.hooks.rules]]
# name = "GitHub Notifications"
# match = { from = "*@github.com" }
# actions = { labels = ["Dev"], mark_read = true }
#
# [[settings.hooks.rules]]
# name = "VIP Contacts"
# match = { from = "ceo@company.com" }
# actions = { flag = true, alert = true, labels = ["VIP"] }

# [settings.hooks.alerts]
# desktop = false         # enable OS-level desktop notifications
# sound = false           # play sound for urgent emails
# urgency_threshold = "high" # minimum priority: "urgent" | "high" | "normal" | "low"
# webhook_url = ""        # HTTP POST to Slack/Discord/ntfy.sh/etc.
# webhook_events = ["urgent", "high"]  # which priorities trigger webhook

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

[accounts.smtp.pool]
enabled = true
max_connections = 1
max_messages = 100
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
