/**
 * Field catalog for the interactive settings editor (`config edit`) and the
 * full `config show` rendering. Pure module: no TTY, no fs.
 *
 * Validation is NOT duplicated here — every field points at its zod schema
 * from src/config/schema.ts (`SectionSchema.shape.<key>`), so ranges and
 * enums live exactly once. The drift-guard tests assert catalog keys match
 * the schema shapes in both directions.
 */

import type { z } from 'zod';
import type { RawAppConfig } from '../config/schema.js';
import {
  AlertsConfigSchema,
  CacheConfigSchema,
  HooksConfigSchema,
  ServerConfigSchema,
  SettingsSchema,
  VerificationConfigSchema,
  WatcherConfigSchema,
} from '../config/schema.js';

export type SectionId =
  | 'general'
  | 'server'
  | 'watcher'
  | 'verification'
  | 'cache'
  | 'hooks'
  | 'alerts';
export type FieldKind = 'boolean' | 'int' | 'string' | 'enum' | 'string-array' | 'enum-array';

export interface FieldDescriptor {
  /** snake_case key, exactly as in config.toml. */
  key: string;
  /** Prompt label, includes the valid range for ints. */
  label: string;
  kind: FieldKind;
  /** The field's zod schema — the single source of validation truth. */
  schema: z.ZodType;
  /** Choices for enum / enum-array fields. */
  options?: readonly string[];
  /** Empty input deletes the key instead of storing ''. */
  optional?: boolean;
  /** Rendering for an empty array / unset value, e.g. '(all)'. */
  emptyLabel?: string;
  /** Never render the value (menus, diffs, config show) — mask it. */
  secret?: boolean;
}

export interface SectionDescriptor {
  id: SectionId;
  label: string;
  fields: FieldDescriptor[];
  /** The mutable snake_case section object inside a raw config. */
  resolve(raw: RawAppConfig): Record<string, unknown>;
  /** One-line current-state summary for the section picker. */
  summarize(raw: RawAppConfig): string;
}

export interface FieldChange {
  key: string;
  before: string;
  after: string;
}

const MAX_RENDER_LENGTH = 60;

function onOff(value: unknown): string {
  return value ? 'on' : 'off';
}

const generalShape = SettingsSchema.shape;
const serverShape = ServerConfigSchema.shape;
const watcherShape = WatcherConfigSchema.shape;
const verificationShape = VerificationConfigSchema.shape;
const cacheShape = CacheConfigSchema.shape;
const hooksShape = HooksConfigSchema.shape;
const alertsShape = AlertsConfigSchema.shape;

export const SETTINGS_SECTIONS: SectionDescriptor[] = [
  {
    id: 'general',
    label: 'General (rate limit, read-only)',
    resolve: (raw) => raw.settings as unknown as Record<string, unknown>,
    summarize: (raw) =>
      `rate_limit=${raw.settings.rate_limit}, read_only=${onOff(raw.settings.read_only)}`,
    fields: [
      {
        key: 'rate_limit',
        label: 'Rate limit (max emails per minute per account, ≥1)',
        kind: 'int',
        schema: generalShape.rate_limit,
      },
      {
        key: 'read_only',
        label: 'Read-only mode (disables all write tools)',
        kind: 'boolean',
        schema: generalShape.read_only,
      },
    ],
  },
  {
    id: 'server',
    label: 'Server (Streamable HTTP daemon)',
    resolve: (raw) => raw.settings.server as unknown as Record<string, unknown>,
    summarize: (raw) => {
      const s = raw.settings.server;
      return `${s.host}:${s.port}${s.path} | auth ${s.token ? 'on' : 'off'}`;
    },
    fields: [
      {
        key: 'host',
        label: 'Bind address (non-loopback requires a token)',
        kind: 'string',
        schema: serverShape.host,
      },
      {
        key: 'port',
        label: 'Port (1-65535)',
        kind: 'int',
        schema: serverShape.port,
      },
      {
        key: 'path',
        label: 'HTTP path for the MCP endpoint',
        kind: 'string',
        schema: serverShape.path,
      },
      {
        key: 'token',
        label: 'Bearer token (empty = no auth, loopback only)',
        kind: 'string',
        schema: serverShape.token,
        emptyLabel: '(none — loopback only)',
        secret: true,
      },
      {
        key: 'allowed_hosts',
        label: 'Host-header allowlist for reverse proxies',
        kind: 'string-array',
        schema: serverShape.allowed_hosts,
        emptyLabel: '(loopback defaults)',
      },
    ],
  },
  {
    id: 'watcher',
    label: 'Watcher (IMAP IDLE)',
    resolve: (raw) => raw.settings.watcher as unknown as Record<string, unknown>,
    summarize: (raw) => {
      const w = raw.settings.watcher;
      return `${onOff(w.enabled)} | folders: ${w.folders.join(', ')} | idle ${w.idle_timeout}s`;
    },
    fields: [
      {
        key: 'enabled',
        label: 'Enable real-time IMAP IDLE watching',
        kind: 'boolean',
        schema: watcherShape.enabled,
      },
      {
        key: 'folders',
        label: 'Folders to watch per account',
        kind: 'string-array',
        schema: watcherShape.folders,
      },
      {
        key: 'idle_timeout',
        label: 'IDLE timeout in seconds (60-1740)',
        kind: 'int',
        schema: watcherShape.idle_timeout,
      },
    ],
  },
  {
    id: 'verification',
    label: 'Verification codes (OTP catch)',
    resolve: (raw) => raw.settings.verification as unknown as Record<string, unknown>,
    summarize: (raw) => {
      const v = raw.settings.verification;
      return `${onOff(v.enabled)} | auto-copy ${onOff(v.auto_copy)} | links: ${v.link_action}`;
    },
    fields: [
      {
        key: 'enabled',
        label: 'Enable verification-code catching',
        kind: 'boolean',
        schema: verificationShape.enabled,
      },
      {
        key: 'auto_copy',
        label: 'Copy caught codes/links to the clipboard',
        kind: 'boolean',
        schema: verificationShape.auto_copy,
      },
      {
        key: 'confirm_copy',
        label: 'Ask (native dialog) before touching the clipboard',
        kind: 'boolean',
        schema: verificationShape.confirm_copy,
      },
      {
        key: 'notify',
        label: 'Desktop notification when something is caught',
        kind: 'boolean',
        schema: verificationShape.notify,
      },
      {
        key: 'copy_links',
        label: 'Also catch sign-in magic links',
        kind: 'boolean',
        schema: verificationShape.copy_links,
      },
      {
        key: 'link_action',
        label: 'Caught links: offer to open, or copy like a code',
        kind: 'enum',
        schema: verificationShape.link_action,
        options: ['open', 'copy'],
      },
      {
        key: 'clear_after_seconds',
        label: 'Auto-clear clipboard after N seconds (0-3600, 0 = never)',
        kind: 'int',
        schema: verificationShape.clear_after_seconds,
      },
      {
        key: 'max_age_minutes',
        label: 'Ignore messages older than N minutes (1-1440)',
        kind: 'int',
        schema: verificationShape.max_age_minutes,
      },
      {
        key: 'accounts',
        label: 'Accounts to watch (empty = all)',
        kind: 'string-array',
        schema: verificationShape.accounts,
        emptyLabel: '(all)',
      },
      {
        key: 'sender_allowlist',
        label: 'Sender allowlist globs (empty = all senders)',
        kind: 'string-array',
        schema: verificationShape.sender_allowlist,
        emptyLabel: '(all senders)',
      },
      {
        key: 'sender_denylist',
        label: 'Sender denylist globs',
        kind: 'string-array',
        schema: verificationShape.sender_denylist,
        emptyLabel: '(none)',
      },
    ],
  },
  {
    id: 'cache',
    label: 'Cache (local mirror)',
    resolve: (raw) => raw.settings.cache as unknown as Record<string, unknown>,
    summarize: (raw) => {
      const c = raw.settings.cache;
      return `${onOff(c.enabled)} | ${c.mailboxes.join(', ')} | ${c.window_days}d window | sync ${c.sync_interval}s`;
    },
    fields: [
      {
        key: 'enabled',
        label: 'Enable the local SQLite mirror',
        kind: 'boolean',
        schema: cacheShape.enabled,
      },
      {
        key: 'mailboxes',
        label: 'Mailboxes synced proactively',
        kind: 'string-array',
        schema: cacheShape.mailboxes,
      },
      {
        key: 'window_days',
        label: 'How far back to mirror in days (0 = no limit)',
        kind: 'int',
        schema: cacheShape.window_days,
      },
      {
        key: 'body_messages',
        label: 'Newest N messages to prefetch bodies for',
        kind: 'int',
        schema: cacheShape.body_messages,
      },
      {
        key: 'max_size_mb',
        label: 'Mirror size backstop in MB (≥1)',
        kind: 'int',
        schema: cacheShape.max_size_mb,
      },
      {
        key: 'sync_interval',
        label: 'Seconds between background reconciles (≥30)',
        kind: 'int',
        schema: cacheShape.sync_interval,
      },
    ],
  },
  {
    id: 'hooks',
    label: 'Hooks (triage, auto-calendar)',
    resolve: (raw) => raw.settings.hooks as unknown as Record<string, unknown>,
    summarize: (raw) => {
      const h = raw.settings.hooks;
      return `${h.on_new_email} | ${h.preset} | batch ${h.batch_delay}s`;
    },
    fields: [
      {
        key: 'on_new_email',
        label: 'Action on new email',
        kind: 'enum',
        schema: hooksShape.on_new_email,
        options: ['triage', 'notify', 'none'],
      },
      {
        key: 'preset',
        label: 'AI triage preset',
        kind: 'enum',
        schema: hooksShape.preset,
        options: ['inbox-zero', 'gtd', 'priority-focus', 'notification-only', 'custom'],
      },
      {
        key: 'auto_label',
        label: 'Auto-apply AI-suggested labels',
        kind: 'boolean',
        schema: hooksShape.auto_label,
      },
      {
        key: 'auto_flag',
        label: 'Auto-flag urgent emails',
        kind: 'boolean',
        schema: hooksShape.auto_flag,
      },
      {
        key: 'batch_delay',
        label: 'Seconds to batch new mail before processing (1-60)',
        kind: 'int',
        schema: hooksShape.batch_delay,
      },
      {
        key: 'custom_instructions',
        label: 'Custom triage instructions (empty to unset)',
        kind: 'string',
        schema: hooksShape.custom_instructions,
        optional: true,
      },
      {
        key: 'system_prompt',
        label: 'Full system-prompt override (empty to unset)',
        kind: 'string',
        schema: hooksShape.system_prompt,
        optional: true,
      },
      {
        key: 'auto_calendar',
        label: 'Auto-add detected calendar events',
        kind: 'boolean',
        schema: hooksShape.auto_calendar,
      },
      {
        key: 'calendar_name',
        label: 'Target calendar name',
        kind: 'string',
        schema: hooksShape.calendar_name,
        emptyLabel: '(default calendar)',
      },
      {
        key: 'calendar_alarm_minutes',
        label: 'Minutes before event to alert (0-1440)',
        kind: 'int',
        schema: hooksShape.calendar_alarm_minutes,
      },
      {
        key: 'calendar_confirm',
        label: 'Confirmation dialog before adding events',
        kind: 'boolean',
        schema: hooksShape.calendar_confirm,
      },
    ],
  },
  {
    id: 'alerts',
    label: 'Alerts (desktop, sound, webhook)',
    resolve: (raw) => raw.settings.hooks.alerts as unknown as Record<string, unknown>,
    summarize: (raw) => {
      const a = raw.settings.hooks.alerts;
      return `desktop ${onOff(a.desktop)}, sound ${onOff(a.sound)} | threshold ${a.urgency_threshold}`;
    },
    fields: [
      {
        key: 'desktop',
        label: 'Desktop notifications',
        kind: 'boolean',
        schema: alertsShape.desktop,
      },
      {
        key: 'sound',
        label: 'Sound for urgent emails',
        kind: 'boolean',
        schema: alertsShape.sound,
      },
      {
        key: 'urgency_threshold',
        label: 'Minimum urgency for desktop alerts',
        kind: 'enum',
        schema: alertsShape.urgency_threshold,
        options: ['urgent', 'high', 'normal', 'low'],
      },
      {
        key: 'webhook_url',
        label: 'Webhook URL (empty to disable)',
        kind: 'string',
        schema: alertsShape.webhook_url,
        emptyLabel: '(none)',
      },
      {
        key: 'webhook_events',
        label: 'Urgencies that trigger the webhook',
        kind: 'enum-array',
        schema: alertsShape.webhook_events,
        options: ['urgent', 'high', 'normal', 'low'],
      },
    ],
  },
];

export function resolveSection(id: string | undefined): SectionDescriptor | undefined {
  return SETTINGS_SECTIONS.find((s) => s.id === id);
}

/** Render a field value as a single short line for menus and diffs. */
export function formatFieldValue(f: FieldDescriptor, value: unknown): string {
  if (value === undefined || value === null) return f.emptyLabel ?? '(not set)';
  if (f.secret && typeof value === 'string' && value !== '') return '••••••••';
  if (Array.isArray(value)) {
    if (value.length === 0) return f.emptyLabel ?? '(none)';
    return value.join(', ');
  }
  if (typeof value === 'string') {
    if (value === '') return f.emptyLabel ?? '(empty)';
    const oneLine = value.replace(/\s*\n\s*/g, ' ');
    return oneLine.length > MAX_RENDER_LENGTH
      ? `${oneLine.slice(0, MAX_RENDER_LENGTH - 1)}…`
      : oneLine;
  }
  return String(value);
}

/** Convert raw prompt input into the value stored in the config object. */
export function parseFieldInput(f: FieldDescriptor, input: string): unknown {
  switch (f.kind) {
    case 'int':
      return Number(input.trim());
    case 'string-array':
    case 'enum-array':
      return input
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    case 'boolean':
      return input === 'true';
    default: {
      const trimmed = input.trim();
      if (f.optional && trimmed === '') return undefined;
      return trimmed;
    }
  }
}

/** clack `validate` hook: parse, then let the field's zod schema judge. */
export function validateFieldInput(f: FieldDescriptor, input: string): string | undefined {
  const parsed = parseFieldInput(f, input);
  const result = f.schema.safeParse(parsed);
  if (result.success) return undefined;
  return result.error.issues[0]?.message ?? 'Invalid value';
}

/** Changed fields between two section objects, rendered for display. */
export function diffSection(
  section: SectionDescriptor,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const f of section.fields) {
    // Detect on raw values (secret fields render identically when masked),
    // display formatted.
    if (JSON.stringify(before[f.key]) !== JSON.stringify(after[f.key])) {
      changes.push({
        key: f.key,
        before: formatFieldValue(f, before[f.key]),
        after: formatFieldValue(f, after[f.key]),
      });
    }
  }
  return changes;
}
