/**
 * Zod schemas for configuration validation.
 */

import { z } from 'zod';
import {
  DEFAULT_ATTACHMENT_DOWNLOAD_ALLOWED_EXTENSIONS,
  DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES,
} from '../safety/attachment-download.js';

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
    .default(() => ({
      enabled: true,
      max_connections: 1,
      max_messages: 100,
    })),
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
    /**
     * Optional per-account attachment cap (MB, base64-encoded total).
     * Overrides both the global `[settings.send]` cap and the provider's
     * documented limit for this account.
     */
    max_attachment_mb: z.number().int().min(1).optional(),
    /** Settles which folder appendToSent files into when a mailbox has several candidates. */
    sent_mailbox: z.string().optional(),
    /** Per-account override of the Sent-copy default (see appendToSent). */
    save_to_sent: z.boolean().optional(),
  })
  .refine((data) => data.password ?? data.oauth2, {
    message: 'Either password or oauth2 config is required',
  });

export const WatcherConfigSchema = z.object({
  enabled: z.boolean().default(false),
  folders: z.array(z.string()).default(() => ['INBOX']),
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
  /** Extra HTTP headers for the webhook POST, e.g. `{ Authorization = "Bearer …" }`. */
  webhook_headers: z.record(z.string(), z.string()).optional(),
  webhook_events: z
    .array(z.enum(['urgent', 'high', 'normal', 'low']))
    .default((): ('urgent' | 'high' | 'normal' | 'low')[] => ['urgent', 'high']),
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
  rules: z.array(HookRuleSchema).default(() => []),
  alerts: AlertsConfigSchema.default(
    () =>
      ({
        desktop: false,
        sound: false,
        urgency_threshold: 'high',
        webhook_url: '',
        webhook_events: ['urgent', 'high'],
      }) as z.infer<typeof AlertsConfigSchema>,
  ),
  auto_calendar: z.boolean().default(false),
  calendar_name: z.string().default(''),
  calendar_alarm_minutes: z.number().int().min(0).max(1440).default(15),
  calendar_confirm: z.boolean().default(true),
});

/**
 * Local mirror settings.
 *
 * Defaults are deliberately conservative: mirroring INBOX only, 90 days back.
 * Measured against a real 170-message mailbox this costs well under a
 * megabyte, so `max_size_mb` is a backstop rather than an expected limit.
 *
 * Inspect and reclaim what this holds with `email-mcp cache status|clear`.
 */
export const CacheConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /**
   * Mailboxes synced in the background. A mailbox read but not listed here is
   * mirrored lazily from that point on — the first read is served live.
   */
  mailboxes: z.array(z.string()).default(() => ['INBOX']),
  /**
   * How far back the FIRST sync of a mailbox reaches. 0 (the default) means no
   * limit. Later syncs are incremental, so this only bounds the initial
   * transfer; it also marks which envelopes may be dropped if the size budget
   * is ever exhausted.
   *
   * Defaulting to 0 is deliberate: a bounded window leaves the mirror holding
   * a slice, and a slice cannot answer "how many messages are in this
   * mailbox", so every listing has to go live — the cache would cost disk and
   * buy nothing. Envelopes are about a kilobyte each, so a complete mirror of
   * a 9,000-message mailbox is roughly 9 MB of the 500 MB budget. Set a window
   * only for mailboxes too large to mirror; reads then stay correct by falling
   * back to the live path.
   */
  window_days: z.number().int().min(0).default(0),
  /**
   * How many message bodies to keep per mailbox. The newest are prefetched in
   * the background; anything read beyond this is cached on demand. 0 keeps
   * the mirror metadata-only — the privacy-conscious setting, since bodies
   * are stored unencrypted (owner-only) on disk.
   */
  body_messages: z.number().int().min(0).default(500),
  /**
   * Budget across the whole cache — index plus attachment files. Past it,
   * attachments are evicted first, then message bodies, then (only if still
   * over) envelopes older than `window_days`.
   */
  max_size_mb: z.number().int().min(1).default(500),
  /** Seconds between background reconciles. */
  sync_interval: z.number().int().min(30).default(300),
});

/**
 * Verification-code / magic-link catching.
 *
 * The feature itself defaults on, but the ambient auto-copy path only runs
 * while the IMAP IDLE watcher is enabled (`[settings.watcher]`), which
 * defaults off — enabling the watcher is the consent moment.
 */
export const VerificationConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Copy a caught code/link to the clipboard automatically. */
  auto_copy: z.boolean().default(true),
  /** Ask with a native dialog before touching the clipboard (macOS). */
  confirm_copy: z.boolean().default(false),
  /** Show a desktop notification when something is caught. */
  notify: z.boolean().default(true),
  /** Also catch sign-in magic links (used only when no code is found). */
  copy_links: z.boolean().default(true),
  /** What to do with a caught link: offer to open it, or copy like a code. */
  link_action: z.enum(['open', 'copy']).default('open'),
  /** Clear the clipboard after N seconds if it still holds our value. 0 = never. */
  clear_after_seconds: z.number().int().min(0).max(3600).default(60),
  /** Ignore messages older than this when they surface (IDLE replays, reconnects). */
  max_age_minutes: z.number().int().min(1).max(1440).default(10),
  /** Accounts to watch (empty = all). */
  accounts: z.array(z.string()).default(() => []),
  /** Sender globs (hooks syntax). Empty allowlist = all senders. */
  sender_allowlist: z.array(z.string()).default(() => []),
  sender_denylist: z.array(z.string()).default(() => []),
});

/**
 * Streamable HTTP server binding, used by `email-mcp http` and the
 * `email-mcp server` daemon commands. Precedence at runtime:
 * CLI flags → EMAIL_MCP_HTTP_* env → this section → built-in defaults.
 * `--insecure` is deliberately flag-only and cannot be persisted here.
 */
export const ServerConfigSchema = z.object({
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8080),
  path: z.string().min(1).default('/mcp'),
  /** Bearer token; empty = no auth (safe on loopback only). */
  token: z.string().default(''),
  /** Host-header allowlist for reverse-proxy setups (empty = loopback defaults). */
  allowed_hosts: z.array(z.string()).default(() => []),
});

/**
 * Outbound send settings. `max_attachment_mb` caps the base64-encoded total
 * of all attachments on one message (25 MB ~= the Gmail/common-provider
 * ceiling) so an oversized send fails locally with a per-file listing
 * instead of a provider-side 552.
 */
export const SendConfigSchema = z.object({
  max_attachment_mb: z.number().int().min(1).default(25),
  /**
   * APPEND a copy of every sent message to the IMAP Sent folder.
   *
   * Off by default and deliberately so: Gmail and Outlook file sent mail
   * server-side, so enabling it there shows two copies of everything. Turn it
   * on for an IMAP host that does not capture sends itself. The filed copy
   * omits Bcc, which nodemailer's composer strips unconditionally.
   */
  save_to_sent: z.boolean().default(false),
});

/**
 * Scheduler settings. `sent_retention_days` bounds the send history kept in
 * the scheduler's sent directory, which previously grew one file per sent
 * email forever. Age-based because the question is how far back a user can
 * look; 0 keeps everything.
 */
export const SchedulerConfigSchema = z.object({
  sent_retention_days: z.number().int().min(0).default(90),
});

/**
 * Inbound attachment handling. `auto_download` controls whether attachments
 * are saved locally as a side effect of other actions — calendar events
 * created from emails (tools and watcher hooks) link saved copies in their
 * notes. Explicit `download_attachment` calls are never affected.
 */
export const AttachmentsConfigSchema = z.object({
  auto_download: z.boolean().default(true),
});

export const AttachmentDownloadConfigSchema = z.object({
  dir: z.string().min(1).optional(),
  allowed_extensions: z
    .array(z.string().min(1))
    .default(() => [...DEFAULT_ATTACHMENT_DOWNLOAD_ALLOWED_EXTENSIONS]),
  max_bytes: z.number().int().min(1).default(DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES),
});

export const SettingsSchema = z.object({
  rate_limit: z.number().int().min(1).default(10),
  read_only: z.boolean().default(false),
  server: ServerConfigSchema.default(
    () =>
      ({
        host: '127.0.0.1',
        port: 8080,
        path: '/mcp',
        token: '',
        allowed_hosts: [],
      }) as z.infer<typeof ServerConfigSchema>,
  ),
  verification: VerificationConfigSchema.default(
    () =>
      ({
        enabled: true,
        auto_copy: true,
        confirm_copy: false,
        notify: true,
        copy_links: true,
        link_action: 'open',
        clear_after_seconds: 60,
        max_age_minutes: 10,
        accounts: [],
        sender_allowlist: [],
        sender_denylist: [],
      }) as z.infer<typeof VerificationConfigSchema>,
  ),
  send: SendConfigSchema.default(
    () => ({ max_attachment_mb: 25, save_to_sent: false }) as z.infer<typeof SendConfigSchema>,
  ),
  attachments: AttachmentsConfigSchema.default(
    () => ({ auto_download: true }) as z.infer<typeof AttachmentsConfigSchema>,
  ),
  attachment_download: AttachmentDownloadConfigSchema.default(
    () =>
      ({
        allowed_extensions: [...DEFAULT_ATTACHMENT_DOWNLOAD_ALLOWED_EXTENSIONS],
        max_bytes: DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES,
      }) as z.infer<typeof AttachmentDownloadConfigSchema>,
  ),
  scheduler: SchedulerConfigSchema.default(
    () => ({ sent_retention_days: 90 }) as z.infer<typeof SchedulerConfigSchema>,
  ),
  cache: CacheConfigSchema.default(
    () =>
      ({
        enabled: true,
        mailboxes: ['INBOX'],
        window_days: 0,
        body_messages: 500,
        max_size_mb: 500,
        sync_interval: 300,
      }) as z.infer<typeof CacheConfigSchema>,
  ),
  watcher: WatcherConfigSchema.default(
    () =>
      ({
        enabled: false,
        folders: ['INBOX'],
        idle_timeout: 1740,
      }) as z.infer<typeof WatcherConfigSchema>,
  ),
  hooks: HooksConfigSchema.default(
    () =>
      ({
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
      }) as z.infer<typeof HooksConfigSchema>,
  ),
});

export const AppConfigFileSchema = z.object({
  settings: SettingsSchema.default(
    () =>
      ({
        rate_limit: 10,
        read_only: false,
        server: {
          host: '127.0.0.1',
          port: 8080,
          path: '/mcp',
          token: '',
          allowed_hosts: [],
        },
        verification: {
          enabled: true,
          auto_copy: true,
          confirm_copy: false,
          notify: true,
          copy_links: true,
          link_action: 'open' as const,
          clear_after_seconds: 60,
          max_age_minutes: 10,
          accounts: [],
          sender_allowlist: [],
          sender_denylist: [],
        },
        send: { max_attachment_mb: 25, save_to_sent: false },
        attachments: { auto_download: true },
        attachment_download: {
          allowed_extensions: [...DEFAULT_ATTACHMENT_DOWNLOAD_ALLOWED_EXTENSIONS],
          max_bytes: DEFAULT_ATTACHMENT_DOWNLOAD_MAX_BYTES,
        },
        scheduler: { sent_retention_days: 90 },
        cache: {
          enabled: true,
          mailboxes: ['INBOX'],
          window_days: 0,
          body_messages: 500,
          max_size_mb: 500,
          sync_interval: 300,
        },
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
      }) as z.infer<typeof SettingsSchema>,
  ),
  accounts: z.array(AccountConfigSchema).min(1, 'At least one account is required'),
});

export type RawAccountConfig = z.infer<typeof AccountConfigSchema>;
export type RawAppConfig = z.infer<typeof AppConfigFileSchema>;
