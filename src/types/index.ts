/**
 * Shared TypeScript types for the Email MCP Server.
 */

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

export interface EmailAddress {
  name?: string;
  address: string;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface Account {
  name: string;
  email: string;
  fullName?: string;
}

export interface ImapConfig {
  host: string;
  port: number;
  tls: boolean;
  starttls: boolean;
  verifySsl: boolean;
}

export interface SmtpConfig {
  host: string;
  port: number;
  tls: boolean;
  starttls: boolean;
  verifySsl: boolean;
  pool?: {
    enabled: boolean;
    maxConnections: number;
    maxMessages: number;
  };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface OAuth2Config {
  provider: 'google' | 'microsoft' | 'custom';
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  tokenExpiry?: number;
  // Custom provider endpoints (only when provider = "custom")
  tokenUrl?: string;
  authUrl?: string;
  scopes?: string[];
}

export interface AccountConfig {
  name: string;
  email: string;
  fullName?: string;
  username: string;
  password?: string;
  /**
   * The `keychain:`/`env:` reference `password` was resolved from, when it
   * was one — so a running server can re-resolve after a rotation instead
   * of holding the first value forever. Unset for a literal password.
   */
  passwordRef?: string;
  oauth2?: OAuth2Config;
  /** Optional per-account attachment cap (MB, base64-encoded total). */
  maxAttachmentMb?: number;
  /** Per-account override of settings.credentialAlerts.enabled. */
  credentialAlerts?: boolean;
  /**
   * Settles which folder `appendToSent` files a copy into, for a mailbox
   * that carries several sent-shaped folders (e.g. a leftover `Sent` beside
   * the server's actual `\Sent`-flagged one). Use the full IMAP path as
   * `list_mailboxes` reports it.
   */
  sentMailbox?: string;
  /**
   * Per-account override of the Sent-copy default. Unset defers to the
   * guess (file it, unless the server already does — see `appendToSent`);
   * `true`/`false` forces the decision for this account regardless of that
   * guess.
   */
  saveToSent?: boolean;
  imap: ImapConfig;
  smtp: SmtpConfig;
}

export interface WatcherConfig {
  enabled: boolean;
  folders: string[];
  idleTimeout: number;
}

/** Desktop notification when a server rejects an account's credentials. */
export interface CredentialAlertsConfig {
  enabled: boolean;
  sound: boolean;
  /** Remind again every N minutes while still broken; 0 = once per failure. */
  remindEveryMinutes: number;
  /** Also POST a `credential.rejected` event to the alerts webhook. */
  webhook: boolean;
}

// ---------------------------------------------------------------------------
// Hook Rules
// ---------------------------------------------------------------------------

export interface HookRuleMatch {
  from?: string;
  to?: string;
  subject?: string;
}

export interface HookRuleActions {
  labels?: string[];
  flag?: boolean;
  markRead?: boolean;
  alert?: boolean;
  /** Add the email's calendar event to the local calendar (triggers confirmation dialog). */
  addToCalendar?: boolean;
}

export interface HookRule {
  name: string;
  match: HookRuleMatch;
  actions: HookRuleActions;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export interface AlertsConfig {
  desktop: boolean;
  sound: boolean;
  urgencyThreshold: 'urgent' | 'high' | 'normal' | 'low';
  webhookUrl: string;
  webhookEvents: ('urgent' | 'high' | 'normal' | 'low')[];
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface HooksConfig {
  onNewEmail: 'triage' | 'notify' | 'none';
  preset: 'inbox-zero' | 'gtd' | 'priority-focus' | 'notification-only' | 'custom';
  autoLabel: boolean;
  autoFlag: boolean;
  batchDelay: number;
  customInstructions?: string;
  systemPrompt?: string;
  rules: HookRule[];
  alerts: AlertsConfig;
  /** Automatically add calendar events detected in new emails to the local calendar. */
  autoCalendar?: boolean;
  /** Target calendar name for auto-add (empty = default calendar). */
  calendarName?: string;
  /** Minutes before event to show an alert (default: 15). */
  calendarAlarmMinutes?: number;
  /** Show a native confirmation dialog before adding (default: true). */
  calendarConfirm?: boolean;
}

/** Streamable HTTP server binding — see ServerConfigSchema for precedence. */
export interface ServerConfig {
  host: string;
  port: number;
  path: string;
  /** Bearer token; empty = no auth (loopback only). */
  token: string;
  allowedHosts: string[];
}

/** Verification-code / magic-link catching — see VerificationConfigSchema. */
export interface VerificationConfig {
  enabled: boolean;
  autoCopy: boolean;
  /** Ask with a native dialog before touching the clipboard (macOS). */
  confirmCopy: boolean;
  notify: boolean;
  copyLinks: boolean;
  /** Caught links: offer to open in the browser, or copy like a code. */
  linkAction: 'open' | 'copy';
  clearAfterSeconds: number;
  maxAgeMinutes: number;
  accounts: string[];
  senderAllowlist: string[];
  senderDenylist: string[];
}

/** Outbound send settings — see SendConfigSchema for the cap rationale. */
export interface SendConfig {
  /** APPEND a copy of each sent message to the IMAP Sent folder (opt-in). */
  saveToSent: boolean;
  maxAttachmentMb: number;
}

/** Inbound attachment handling — see AttachmentsConfigSchema for scope. */
export interface AttachmentsConfig {
  autoDownload: boolean;
}

/**
 * Where `download_attachment`'s `save_to_download_dir` writes files.
 * Unset `dir` disables the option entirely — see AttachmentDownloadConfigSchema.
 */
export interface AttachmentDownloadConfig {
  dir?: string;
  allowedExtensions: string[];
  maxBytes: number;
}

/** Scheduler settings — see SchedulerConfigSchema for defaults and rationale. */
export interface SchedulerConfig {
  sentRetentionDays: number;
}

/** Local mirror settings — see CacheConfigSchema for defaults and rationale. */
export interface CacheConfig {
  enabled: boolean;
  mailboxes: string[];
  windowDays: number;
  bodyMessages: number;
  maxSizeMb: number;
  syncInterval: number;
}

export interface AppConfig {
  settings: {
    rateLimit: number;
    readOnly: boolean;
    server: ServerConfig;
    verification: VerificationConfig;
    credentialAlerts: CredentialAlertsConfig;
    send: SendConfig;
    attachments: AttachmentsConfig;
    attachmentDownload: AttachmentDownloadConfig;
    scheduler: SchedulerConfig;
    cache: CacheConfig;
    watcher: WatcherConfig;
    hooks: HooksConfig;
  };
  accounts: AccountConfig[];
}

// ---------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------

export interface Mailbox {
  name: string;
  path: string;
  specialUse?: string;
  /** Undefined when the IMAP STATUS call failed — distinct from a genuinely empty mailbox. */
  totalMessages?: number;
  /** Undefined when the IMAP STATUS call failed — distinct from "nothing unread". */
  unseenMessages?: number;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** How a message was originated, when its headers say so. */
export type BulkKind = 'newsletter' | 'automated';

export interface BulkSignal {
  kind: BulkKind;
  /** RFC 2919 list identifier, without its angle brackets. */
  listId?: string;
  /** Most actionable RFC 2369 unsubscribe URI (https preferred over mailto). */
  unsubscribe?: string;
  /** RFC 8058 one-click unsubscribe is supported. */
  oneClick: boolean;
}

export interface EmailMeta {
  id: string;
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  date: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
  labels: string[];
  preview?: string;
  /** Set only for list or machine-generated mail; absent for personal mail. */
  bulk?: BulkSignal;
}

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  /** BODYSTRUCTURE octet count — the ENCODED size, so ~33% above the real
   *  bytes for base64 parts. Treat as approximate. */
  size: number;
  /** IMAP part path ("2", "1.2") — the unambiguous way to download this part. */
  partId?: string;
  /** Content-Transfer-Encoding as reported by the server ("base64", …). */
  encoding?: string;
  /** Content-ID without angle brackets; what HTML `cid:` references point at. */
  contentId?: string;
  /** True for parts shipped as inline content (cid images) rather than as
   *  classic attachments. */
  inline?: boolean;
}

export interface Email extends EmailMeta {
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  bodyText?: string;
  bodyHtml?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  attachments: AttachmentMeta[];
  headers: Record<string, string>;
  /**
   * Machine-readable status of a bounce (multipart/report's
   * message/delivery-status part): Action, Status, Diagnostic-Code. Separate
   * from the body so it can never displace the human-readable explanation.
   */
  deliveryStatus?: string;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Outcome of filing a copy of a sent message in the Sent folder.
 *
 * A failed or skipped APPEND never fails the send itself — the message is
 * already delivered — so this is reported, never thrown, and callers that
 * ignore it lose nothing they had before.
 */
export type SentCopyResult =
  | { kind: 'filed'; path: string }
  | { kind: 'skipped' }
  | { kind: 'failed'; error: string };

export interface SendResult {
  messageId: string;
  status: 'sent' | 'failed';
  sentCopy?: SentCopyResult;
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Bulk Operations
// ---------------------------------------------------------------------------

export interface BulkResult {
  total: number;
  succeeded: number;
  failed: number;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface Contact {
  name?: string;
  email: string;
  frequency: number;
  lastSeen: string;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEntry {
  ts: string;
  tool: string;
  account: string;
  params: Record<string, unknown>;
  result: 'ok' | 'error';
  error?: string;
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export interface ThreadResult {
  threadId: string;
  messages: Email[];
  participants: EmailAddress[];
  messageCount: number;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface EmailTemplate {
  name: string;
  description?: string;
  subject: string;
  body: string;
  variables: string[];
  /** When true, the body is HTML and variables are HTML-escaped on apply. */
  html?: boolean;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  name: string;
  domains: string[];
  imap: ImapConfig;
  smtp: SmtpConfig;
  /** Documented total-message cap (MB, base64-encoded) this provider accepts. */
  maxAttachmentMb?: number;
  notes?: string;
  oauth2?: {
    authUrl: string;
    tokenUrl: string;
    scopes: string[];
  };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  uid: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
  organizer?: EmailAddress;
  attendees: EmailAddress[];
  status: 'TENTATIVE' | 'CONFIRMED' | 'CANCELLED';
  method?: string;
  recurrence?: string;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface SenderStat {
  email: string;
  name?: string;
  count: number;
}

export interface DailyVolume {
  date: string;
  count: number;
}

export interface EmailStats {
  period: 'day' | 'week' | 'month';
  dateRange: { from: string; to: string };
  totalReceived: number;
  unreadCount: number;
  flaggedCount: number;
  topSenders: SenderStat[];
  dailyVolume: DailyVolume[];
  hasAttachmentsCount: number;
  avgPerDay: number;
}

/**
 * Cheap mailbox counters for a dashboard-style snapshot — one IMAP STATUS
 * round trip plus a UID-only SEARCH, no envelope/flags/bodyStructure FETCH.
 */
export interface MailboxSnapshot {
  total: number;
  unread: number;
  receivedToday: number;
}

export interface QuotaInfo {
  usedMb: number;
  totalMb: number;
  percentage: number;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export type LabelStrategyType = 'protonmail' | 'gmail' | 'keyword' | 'unsupported';

export interface LabelInfo {
  name: string;
  path?: string;
  strategy: LabelStrategyType;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export interface ScheduledEmail {
  id: string;
  account: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  html: boolean;
  sendAt: string;
  createdAt: string;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  attempts: number;
  /**
   * When a runner claimed this entry. Lock staleness is measured from here,
   * not from createdAt — a long-scheduled email is not a stale lock.
   */
  claimedAt?: string;
  /**
   * Set immediately before handing the message to SMTP. Its presence after a
   * crash is what separates "never reached the server, safe to retry" from
   * "may already be delivered, must not be resent blindly".
   */
  sendStartedAt?: string;
  lastError?: string;
  draftMessageId?: string;
  draftMailbox?: string;
  inReplyTo?: string;
  references?: string[];
  sentAt?: string;
  sentMessageId?: string;
}
