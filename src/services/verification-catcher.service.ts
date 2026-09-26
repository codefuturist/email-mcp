/**
 * VerificationCatcherService — the ambient "code just arrived" loop.
 *
 * Subscribes DIRECTLY to `email:new` (not through the hooks batch — its 5 s
 * delay defeats the point of an OTP catcher) and, for each fresh message:
 * cheap subject/sender pre-filter → one-shot dedup gate → single body fetch
 * → code/link extraction → concealed clipboard copy + desktop notification.
 *
 * Requires the IMAP IDLE watcher to be running to receive events at all;
 * app wiring logs when verification is enabled but the watcher is not.
 *
 * The extracted value is never written to logs — only its provenance.
 */

import { mcpLog } from '../logging.js';
import type { EmailAddress, EmailMeta, VerificationConfig } from '../types/index.js';
import { matchesPattern } from '../utils/glob.js';
import { stripHtml } from '../utils/html.js';
import { stripReplyChain } from '../utils/reply-chain.js';
import { extractVerificationCode } from '../utils/verification-code.js';
import { extractMagicLink } from '../utils/verification-link.js';
import { isVerificationProcessed, markVerificationProcessed } from '../utils/verification-state.js';
import type ClipboardService from './clipboard.service.js';
import type DialogService from './dialog.service.js';
import type { NewEmailEvent } from './event-bus.js';
import eventBus from './event-bus.js';
import type ImapService from './imap.service.js';
import type NotifierService from './notifier.service.js';

// Cheap screen applied to subject+sender BEFORE the body fetch, so ordinary
// mail (newsletters, threads) never costs an IMAP round trip.
const PRE_FILTER_RE =
  /\b(code|verif\w*|confirm\w*|sign.?in|log.?in|anmeld\w*|best[äa]tig\w*|sicherheit\w*|passcode|otp|2fa|einmal\w*|magic|token|auth\w*|tan|pin)\b/i;
const SUBJECT_TOKEN_RE = /(?<![A-Za-z0-9_-])\d{4,8}(?![A-Za-z0-9_-])/;

export interface VerificationHit {
  kind: 'code' | 'link';
  /** Canonical value for clipboard/paste. */
  value: string;
  /** Human-facing form (code as printed in the mail, or the URL). */
  display: string;
  from: EmailAddress;
  subject: string;
  /** Short sender label for notifications ("GitHub", "notion.so"). */
  service: string;
  account: string;
  mailbox: string;
  date: string;
  confidence?: 'high' | 'medium' | 'low';
  evidence?: string;
}

function passesPreFilter(meta: EmailMeta): boolean {
  const surface = `${meta.subject} ${meta.from.address}`;
  return PRE_FILTER_RE.test(surface) || SUBJECT_TOKEN_RE.test(meta.subject);
}

function serviceLabel(from: EmailAddress): string {
  const name = from.name?.trim();
  if (name) return name;
  return from.address.split('@')[1] ?? from.address;
}

function senderMatchesAny(patterns: string[], from: EmailAddress): boolean {
  const addr = from.address;
  const full = from.name ? `${from.name} <${addr}>` : addr;
  return patterns.some((p) => matchesPattern(p, addr) || matchesPattern(p, full));
}

/** Extract from an already-fetched body pair. */
function extractHit(
  meta: EmailMeta,
  account: string,
  mailbox: string,
  bodyText: string | undefined,
  bodyHtml: string | undefined,
  copyLinks: boolean,
): VerificationHit | undefined {
  const text = stripReplyChain(bodyText ?? (bodyHtml ? stripHtml(bodyHtml) : ''));

  const code = extractVerificationCode(meta.subject, text);
  if (code) {
    return {
      kind: 'code',
      value: code.code,
      display: code.display,
      from: meta.from,
      subject: meta.subject,
      service: serviceLabel(meta.from),
      account,
      mailbox,
      date: meta.date,
      confidence: code.confidence,
      evidence: code.evidence,
    };
  }

  if (copyLinks) {
    const link = extractMagicLink({ bodyHtml, bodyText, senderAddress: meta.from.address });
    if (link) {
      return {
        kind: 'link',
        value: link.link,
        display: link.link,
        from: meta.from,
        subject: meta.subject,
        service: serviceLabel(meta.from),
        account,
        mailbox,
        date: meta.date,
      };
    }
  }

  return undefined;
}

export default class VerificationCatcherService {
  private readonly config: VerificationConfig;

  private readonly imapService: ImapService;

  private readonly notifier: NotifierService;

  private readonly clipboard: ClipboardService;

  private readonly dialog: DialogService;

  /** Serializes event processing; also the drain point for settled(). */
  private queue: Promise<void> = Promise.resolve();

  private started = false;

  /**
   * Named handler so stop() detaches exactly this subscription — the channel
   * is shared with the sync engine and hooks.
   */
  private readonly onNewEmail = (event: NewEmailEvent): void => {
    this.queue = this.queue.then(() => this.processEvent(event)).catch(() => {});
  };

  constructor(
    config: VerificationConfig,
    imapService: ImapService,
    notifier: NotifierService,
    clipboard: ClipboardService,
    dialog: DialogService,
  ) {
    this.config = config;
    this.imapService = imapService;
    this.notifier = notifier;
    this.clipboard = clipboard;
    this.dialog = dialog;
  }

  start(): void {
    if (!this.config.enabled || this.started) return;
    this.started = true;
    eventBus.on('email:new', this.onNewEmail);
    mcpLog(
      'info',
      'verification',
      `Verification catcher active: auto_copy=${this.config.autoCopy}, notify=${this.config.notify}`,
    ).catch(() => {});
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    eventBus.off('email:new', this.onNewEmail);
    this.clipboard.stop();
  }

  /** Resolves when every event received so far has been fully processed. */
  async settled(): Promise<void> {
    await this.queue;
  }

  private async processEvent(event: NewEmailEvent): Promise<void> {
    for (const meta of event.emails) {
      try {
        await this.processMessage(event.account, event.mailbox, meta);
      } catch (err) {
        await mcpLog(
          'warning',
          'verification',
          `Failed to examine ${event.account}/${event.mailbox} uid ${meta.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ).catch(() => {});
      }
    }
  }

  private async processMessage(account: string, mailbox: string, meta: EmailMeta): Promise<void> {
    const cfg = this.config;

    if (cfg.accounts.length > 0 && !cfg.accounts.includes(account)) return;

    // Recency guard — IDLE reconnects can replay a window of "new" messages.
    const age = Date.now() - Date.parse(meta.date);
    if (!Number.isNaN(age) && age > cfg.maxAgeMinutes * 60_000) return;

    if (cfg.senderDenylist.length > 0 && senderMatchesAny(cfg.senderDenylist, meta.from)) return;
    if (cfg.senderAllowlist.length > 0 && !senderMatchesAny(cfg.senderAllowlist, meta.from)) {
      return;
    }

    if (!passesPreFilter(meta)) return;

    if (await isVerificationProcessed(account, mailbox, meta.id)) return;

    let hit: VerificationHit | undefined;
    try {
      const full = await this.imapService.getEmail(account, meta.id, mailbox);
      hit = extractHit(meta, account, mailbox, full.bodyText, full.bodyHtml, cfg.copyLinks);
      if (hit) await this.act(hit);
    } finally {
      // Marked regardless of outcome: each message costs at most one fetch.
      await markVerificationProcessed(account, mailbox, meta.id, hit !== undefined).catch(() => {});
    }
  }

  private async act(hit: VerificationHit): Promise<void> {
    const action = hit.kind === 'code' ? await this.actOnCode(hit) : await this.actOnLink(hit);

    // Provenance only — never the value itself.
    await mcpLog(
      'info',
      'verification',
      `Caught ${hit.kind} from ${hit.service} (${hit.account}/${hit.mailbox}, sender ${hit.from.address}, action=${action})`,
    ).catch(() => {});
  }

  private async actOnCode(hit: VerificationHit): Promise<string> {
    const cfg = this.config;
    if (!cfg.autoCopy) {
      await this.notifyFound(hit, 'auto-copy off');
      return 'notified';
    }

    if (cfg.confirmCopy) {
      const res = await this.dialog.confirmAction(
        `Code ${hit.display} from ${hit.service}`,
        'Copy to clipboard?',
        { buttons: ['Cancel', 'Copy'], defaultButton: 'Copy' },
      );
      if (res.outcome === 'declined') return 'declined';
      if (res.outcome === 'unavailable') {
        await this.notifyFound(hit, 'confirmation unavailable');
        return 'notified';
      }
    }

    return this.copyAndNotify(hit);
  }

  private async actOnLink(hit: VerificationHit): Promise<string> {
    const cfg = this.config;
    if (!cfg.autoCopy) {
      await this.notifyFound(hit, 'auto-copy off');
      return 'notified';
    }

    if (cfg.linkAction === 'open') {
      // Opening a link from mail content is always confirmed — the dialog IS
      // the offer; a spoofed sender must never auto-launch the browser.
      const shownUrl = hit.value.length > 100 ? `${hit.value.slice(0, 100)}…` : hit.value;
      const res = await this.dialog.confirmAction(
        `Sign-in link from ${hit.service}`,
        `Open in your default browser?\n\n${shownUrl}`,
        { buttons: ['Cancel', 'Copy', 'Open'], defaultButton: 'Open' },
      );
      if (res.outcome === 'declined') return 'declined';
      if (res.outcome === 'unavailable') {
        await this.notifyFound(hit, 'confirmation unavailable');
        return 'notified';
      }
      if (res.button === 'Open') {
        const opened = await this.dialog.openUrl(hit.value);
        if (opened) return 'opened';
        await this.notifyFound(hit, 'browser launch failed');
        return 'notified';
      }
      // 'Copy' button falls through to the clipboard path.
    } else if (cfg.confirmCopy) {
      const res = await this.dialog.confirmAction(
        `Sign-in link from ${hit.service}`,
        'Copy to clipboard?',
        { buttons: ['Cancel', 'Copy'], defaultButton: 'Copy' },
      );
      if (res.outcome === 'declined') return 'declined';
      if (res.outcome === 'unavailable') {
        await this.notifyFound(hit, 'confirmation unavailable');
        return 'notified';
      }
    }

    return this.copyAndNotify(hit);
  }

  private async copyAndNotify(hit: VerificationHit): Promise<string> {
    const cfg = this.config;
    const write = await this.clipboard.copyConcealed(hit.value, {
      clearAfterSeconds: cfg.clearAfterSeconds,
    });
    if (!write.ok) {
      await this.notifyFound(hit, 'auto-copy off');
      return 'copy-failed';
    }
    if (cfg.notify) {
      const clearsIn = cfg.clearAfterSeconds > 0 ? ` — clears in ${cfg.clearAfterSeconds}s` : '';
      const title =
        hit.kind === 'code'
          ? `✅ Code ${hit.display} from ${hit.service}`
          : `🔗 Sign-in link from ${hit.service}`;
      await this.notifier.notifyRaw(title, `Copied to clipboard${clearsIn}`);
    }
    return 'copied';
  }

  /** Notification-only outcome: the hit is surfaced but nothing was touched. */
  private async notifyFound(hit: VerificationHit, reason: string): Promise<void> {
    if (!this.config.notify) return;
    const title =
      hit.kind === 'code'
        ? `🔐 Code ${hit.display} from ${hit.service}`
        : `🔗 Sign-in link from ${hit.service}`;
    const noun = hit.kind === 'code' ? 'Code' : 'Link';
    await this.notifier.notifyRaw(title, `${noun} found (${reason})`);
  }
}

// ---------------------------------------------------------------------------
// On-demand scan — shared by the get_verification_code tool
// ---------------------------------------------------------------------------

/**
 * Scan recent messages for a code/link, newest first. Read-only and
 * idempotent: does NOT touch the one-shot dedup state. IMAP SINCE is
 * day-granular, so results are re-filtered client-side against `lookbackMs`.
 */
export async function scanRecent(
  imapService: ImapService,
  accounts: string[],
  mailbox: string,
  lookbackMs: number,
  opts: { copyLinks?: boolean; maxBodies?: number } = {},
): Promise<VerificationHit | undefined> {
  const cutoff = Date.now() - lookbackMs;
  const maxBodies = opts.maxBodies ?? 5;
  const copyLinks = opts.copyLinks ?? true;

  const candidates: { account: string; meta: EmailMeta }[] = [];
  for (const account of accounts) {
    try {
      const result = await imapService.listEmails(account, {
        mailbox,
        page: 1,
        pageSize: 20,
        since: new Date(cutoff).toISOString(),
      });
      for (const meta of result.items) {
        const at = Date.parse(meta.date);
        if (!Number.isNaN(at) && at < cutoff) continue;
        if (!passesPreFilter(meta)) continue;
        candidates.push({ account, meta });
      }
    } catch {
      // One unreachable account must not sink the scan of the others.
    }
  }

  candidates.sort((a, b) => {
    const dateDiff = Date.parse(b.meta.date) - Date.parse(a.meta.date);
    if (dateDiff !== 0) return dateDiff;
    // Date headers have second granularity; within one account the higher
    // UID is the later arrival, so back-to-back mails still order correctly.
    if (a.account === b.account) {
      return (Number(b.meta.id) || 0) - (Number(a.meta.id) || 0);
    }
    return 0;
  });

  for (const { account, meta } of candidates.slice(0, maxBodies)) {
    try {
      const full = await imapService.getEmail(account, meta.id, mailbox);
      const hit = extractHit(meta, account, mailbox, full.bodyText, full.bodyHtml, copyLinks);
      if (hit) return hit;
    } catch {
      // Skip unreadable messages; keep scanning older candidates.
    }
  }
  return undefined;
}

/**
 * Scan now, then wait up to `waitSeconds` for a code/link to arrive.
 *
 * Event-augmented polling: an `email:new` event (watcher running) wakes the
 * loop within ~1 s; without the watcher the 5 s poll is the correctness
 * backstop, so the tool works either way. Re-scans accept only messages
 * dated after the call started (minus one minute of clock slack) — the full
 * `lookbackMs` window applies to the initial scan only. The transient
 * listener is removed on every path.
 */
export async function waitForVerification(
  imapService: ImapService,
  accounts: string[],
  mailbox: string,
  lookbackMs: number,
  waitSeconds: number,
  opts: { copyLinks?: boolean } = {},
): Promise<VerificationHit | undefined> {
  const initial = await scanRecent(imapService, accounts, mailbox, lookbackMs, opts);
  if (initial || waitSeconds <= 0) return initial;

  const freshCutoff = Date.now() - 60_000;
  const deadline = Date.now() + waitSeconds * 1000;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();

    let wakeHandler: ((event: NewEmailEvent) => void) | undefined;
    let sleepTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve) => {
        wakeHandler = (event: NewEmailEvent): void => {
          if (accounts.length > 0 && !accounts.includes(event.account)) return;
          if (event.mailbox !== mailbox) return;
          resolve();
        };
        eventBus.on('email:new', wakeHandler);
        sleepTimer = setTimeout(resolve, Math.min(5000, remaining));
      });
    } finally {
      if (wakeHandler) eventBus.off('email:new', wakeHandler);
      if (sleepTimer) clearTimeout(sleepTimer);
    }

    const hit = await scanRecent(imapService, accounts, mailbox, Date.now() - freshCutoff, opts);
    if (hit && Date.parse(hit.date) >= freshCutoff) return hit;
  }
  return undefined;
}
