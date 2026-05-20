/**
 * Zod schemas for configuration validation.
 */

import { z } from 'zod';

export const ImapConfigSchema = z.object({
  host: z.string().min(1, 'IMAP host is required'),
  port: z.number().int().min(1).max(65535).default(993),
  tls: z.boolean().default(true),
  starttls: z.boolean().default(false),
  verify_ssl: z.boolean().default(true),
});

export const SmtpConfigSchema = z.object({
  host: z.string().min(1, 'SMTP host is required'),
  port: z.number().int().min(1).max(65535).default(465),
  tls: z.boolean().default(true),
  starttls: z.boolean().default(false),
  verify_ssl: z.boolean().default(true),
  pool: z
    .object({
      enabled: z.boolean().default(true),
      max_connections: z.number().int().min(1).default(1),
      max_messages: z.number().int().min(1).default(100),
    })
    .default({
      enabled: true,
      max_connections: 1,
      max_messages: 100,
    }),
});

export const OAuth2ConfigSchema = z.object({
  provider: z.enum(['google', 'microsoft', 'custom']),
  client_id: z.string().min(1, 'OAuth2 client_id is required'),
  client_secret: z.string().min(1, 'OAuth2 client_secret is required'),
  refresh_token: z.string().min(1, 'OAuth2 refresh_token is required'),
  // Custom provider endpoints (only when provider = "custom")
  token_url: z.string().url().optional(),
  auth_url: z.string().url().optional(),
  scopes: z.array(z.string()).optional(),
});

export const AccountConfigSchema = z
  .object({
    name: z.string().min(1, 'Account name is required'),
    email: z.string().email('Invalid email address'),
    full_name: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    oauth2: OAuth2ConfigSchema.optional(),
    imap: ImapConfigSchema,
    smtp: SmtpConfigSchema,
  })
  .refine((data) => Boolean(data.password) || data.oauth2 != null, {
    message: 'Either password (or "keychain" on macOS) or oauth2 config is required',
  });

export const WatcherConfigSchema = z.object({
  enabled: z.boolean().default(false),
  folders: z.array(z.string()).default(['INBOX']),
  idle_timeout: z.number().int().min(60).max(1740).default(1740),
});

export const HookRuleMatchSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
});

export const HookRuleActionsSchema = z.object({
  labels: z.array(z.string()).optional(),
  flag: z.boolean().optional(),
  mark_read: z.boolean().optional(),
  alert: z.boolean().optional(),
  add_to_calendar: z.boolean().optional(),
});

export const HookRuleSchema = z.object({
  name: z.string().min(1, 'Rule name is required'),
  match: HookRuleMatchSchema,
  actions: HookRuleActionsSchema,
});

export const AlertsConfigSchema = z.object({
  desktop: z.boolean().default(false),
  sound: z.boolean().default(false),
  urgency_threshold: z.enum(['urgent', 'high', 'normal', 'low']).default('high'),
  webhook_url: z.string().default(''),
  webhook_events: z.array(z.enum(['urgent', 'high', 'normal', 'low'])).default(['urgent', 'high']),
});

export const HooksConfigSchema = z.object({
  on_new_email: z.enum(['triage', 'notify', 'none']).default('notify'),
  preset: z
    .enum(['inbox-zero', 'gtd', 'priority-focus', 'notification-only', 'custom'])
    .default('priority-focus'),
  auto_label: z.boolean().default(false),
  auto_flag: z.boolean().default(false),
  batch_delay: z.number().int().min(1).max(60).default(5),
  custom_instructions: z.string().optional(),
  system_prompt: z.string().optional(),
  rules: z.array(HookRuleSchema).default([]),
  alerts: AlertsConfigSchema.default({
    desktop: false,
    sound: false,
    urgency_threshold: 'high',
    webhook_url: '',
    webhook_events: ['urgent', 'high'],
  }),
  auto_calendar: z.boolean().default(false),
  calendar_name: z.string().default(''),
  calendar_alarm_minutes: z.number().int().min(0).max(1440).default(15),
  calendar_confirm: z.boolean().default(true),
});

export const SettingsSchema = z.object({
  rate_limit: z.number().int().min(1).default(10),
  read_only: z.boolean().default(false),
  watcher: WatcherConfigSchema.default({
    enabled: false,
    folders: ['INBOX'],
    idle_timeout: 1740,
  }),
  hooks: HooksConfigSchema.default({
    on_new_email: 'notify',
    preset: 'priority-focus',
    auto_label: false,
    auto_flag: false,
    batch_delay: 5,
    rules: [],
    alerts: {
      desktop: false,
      sound: false,
      urgency_threshold: 'high',
      webhook_url: '',
      webhook_events: ['urgent', 'high'],
    },
    auto_calendar: false,
    calendar_name: '',
    calendar_alarm_minutes: 15,
    calendar_confirm: true,
  }),
});

export const AppConfigFileSchema = z.object({
  settings: SettingsSchema.default({
    rate_limit: 10,
    read_only: false,
    watcher: {
      enabled: false,
      folders: ['INBOX'],
      idle_timeout: 1740,
    },
    hooks: {
      on_new_email: 'notify',
      preset: 'priority-focus',
      auto_label: false,
      auto_flag: false,
      batch_delay: 5,
      rules: [],
      alerts: {
        desktop: false,
        sound: false,
        urgency_threshold: 'high',
        webhook_url: '',
        webhook_events: ['urgent', 'high'],
      },
      auto_calendar: false,
      calendar_name: '',
      calendar_alarm_minutes: 15,
      calendar_confirm: true,
    },
  }),
  accounts: z.array(AccountConfigSchema).min(1, 'At least one account is required'),
});

export type RawAccountConfig = z.infer<typeof AccountConfigSchema>;
export type RawAppConfig = z.infer<typeof AppConfigFileSchema>;
