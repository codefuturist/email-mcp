/**
 * Scheduler service — JSON file-based email scheduling queue.
 *
 * Manages scheduled emails with a local file queue.
 * Source of truth is the JSON files in XDG state directory.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SCHEDULED_DIR, SCHEDULED_SENT_DIR } from '../config/xdg.js';
import type { ScheduledEmail } from '../types/index.js';
import type ImapService from './imap.service.js';
import type SmtpService from './smtp.service.js';

// ---------------------------------------------------------------------------
// HMAC integrity — prevent unauthorized file injection
// ---------------------------------------------------------------------------

/**
 * Derive a stable HMAC key from machine-specific entropy.
 * This is NOT a secret key management system — it's a tamper-detection
 * mechanism to prevent trivial file injection by other local processes.
 */
function getHmacKey(): string {
  const machineId = `${os.hostname()}:${os.homedir()}:email-mcp-scheduler`;
  return crypto.createHash('sha256').update(machineId).digest('hex');
}

interface SignedScheduledEmail extends ScheduledEmail {
  hmacSignature?: string;
}

function computeHmac(data: ScheduledEmail): string {
  const key = getHmacKey();
  const payload = JSON.stringify({
    id: data.id,
    account: data.account,
    to: data.to,
    subject: data.subject,
    sendAt: data.sendAt,
    createdAt: data.createdAt,
  });
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

function verifyHmac(data: SignedScheduledEmail): boolean {
  if (!data.hmacSignature) return false;
  const expected = computeHmac(data);
  return crypto.timingSafeEqual(
    Buffer.from(data.hmacSignature, 'hex'),
    Buffer.from(expected, 'hex'),
  );
}

// ---------------------------------------------------------------------------

/** Max age (ms) for "sending" status before resetting to "pending" */
const STALE_LOCK_MS = 5 * 60 * 1000;

/** Max retry attempts before marking as "failed" */
const MAX_ATTEMPTS = 3;

export default class SchedulerService {
  constructor(
    private smtpService: SmtpService,
    private imapService: ImapService,
  ) {}

  // -------------------------------------------------------------------------
  // Schedule a new email
  // -------------------------------------------------------------------------

  async schedule(
    account: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      sendAt: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      inReplyTo?: string;
      references?: string[];
    },
  ): Promise<ScheduledEmail> {
    const sendAtDate = new Date(options.sendAt);
    if (Number.isNaN(sendAtDate.getTime())) {
      throw new Error(`Invalid send_at date: ${options.sendAt}`);
    }
    if (sendAtDate.getTime() <= Date.now()) {
      throw new Error('send_at must be in the future');
    }

    const scheduled: ScheduledEmail = {
      id: crypto.randomUUID(),
      account,
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      body: options.body,
      html: options.html ?? false,
      sendAt: sendAtDate.toISOString(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      inReplyTo: options.inReplyTo,
      references: options.references,
    };

    // Save IMAP draft (best-effort)
    try {
      const draftResult = await this.imapService.saveDraft(account, {
        to: options.to,
        subject: `[Scheduled: ${sendAtDate.toLocaleString()}] ${options.subject}`,
        body: options.body,
        cc: options.cc,
        html: options.html,
      });
      scheduled.draftMessageId = String(draftResult.id);
      scheduled.draftMailbox = draftResult.mailbox;
    } catch {
      // Draft mirror is best-effort
    }

    await SchedulerService.writeScheduledFile(scheduled);
    return scheduled;
  }

  // -------------------------------------------------------------------------
  // List scheduled emails
  // -------------------------------------------------------------------------

  // eslint-disable-next-line class-methods-use-this
  async list(
    options: { account?: string; status?: 'pending' | 'sent' | 'failed' | 'all' } = {},
  ): Promise<ScheduledEmail[]> {
    const status = options.status ?? 'pending';
    const emails: ScheduledEmail[] = [];

    // Read pending/sending/failed from main dir
    if (status !== 'sent') {
      const pending = await SchedulerService.readDir(SCHEDULED_DIR);
      emails.push(...pending);
    }

    // Read sent from sent/ subdir
    if (status === 'sent' || status === 'all') {
      const sent = await SchedulerService.readDir(SCHEDULED_SENT_DIR);
      emails.push(...sent);
    }

    // Filter by account if specified
    const filtered = options.account ? emails.filter((e) => e.account === options.account) : emails;

    // Filter by status unless "all"
    if (status !== 'all') {
      return filtered.filter((e) => e.status === status);
    }

    return filtered.sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime());
  }

  // -------------------------------------------------------------------------
  // Cancel a scheduled email
  // -------------------------------------------------------------------------

  async cancel(scheduleId: string): Promise<{ cancelled: boolean; draftDeleted: boolean }> {
    const filePath = path.join(SCHEDULED_DIR, `${scheduleId}.json`);
    let draftDeleted = false;

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const scheduled = JSON.parse(content) as ScheduledEmail;

      if (scheduled.status !== 'pending') {
        throw new Error(`Cannot cancel email with status "${scheduled.status}"`);
      }

      // Delete IMAP draft (best-effort)
      if (scheduled.draftMessageId && scheduled.draftMailbox) {
        try {
          await this.imapService.deleteEmail(
            scheduled.account,
            scheduled.draftMessageId,
            scheduled.draftMailbox,
          );
          draftDeleted = true;
        } catch {
          // Draft deletion is best-effort
        }
      }

      await fs.unlink(filePath);
      return { cancelled: true, draftDeleted };
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        throw new Error(`Scheduled email "${scheduleId}" not found`);
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Check and send overdue emails
  // -------------------------------------------------------------------------

  /* eslint-disable no-await-in-loop, no-continue -- Sequential file processing required */
  async checkAndSend(): Promise<{
    sent: number;
    failed: number;
    errors: string[];
  }> {
    const result = { sent: 0, failed: 0, errors: [] as string[] };
    await SchedulerService.ensureDirs();

    let files: string[];
    try {
      files = await fs.readdir(SCHEDULED_DIR);
    } catch {
      return result;
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    const now = Date.now();

    // Process files sequentially — must not double-send
    // eslint-disable-next-line no-restricted-syntax
    for (const file of jsonFiles) {
      const filePath = path.join(SCHEDULED_DIR, file);

      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const scheduled = JSON.parse(content) as SignedScheduledEmail;

        // Verify HMAC integrity — reject tampered or externally injected files
        if (!verifyHmac(scheduled)) {
          result.errors.push(
            `${file}: HMAC verification failed — file may have been tampered with`,
          );
          result.failed += 1;
          continue;
        }

        // Reset stale locks
        if (scheduled.status === 'sending' && scheduled.lastError !== undefined) {
          const lockAge = now - new Date(scheduled.createdAt).getTime();
          if (lockAge > STALE_LOCK_MS) {
            scheduled.status = 'pending';
          }
        } else if (scheduled.status === 'sending') {
          // Check if it's been sending too long (use sendAt as reference)
          continue;
        }

        // Skip non-pending
        if (scheduled.status !== 'pending') continue;

        // Skip if not yet due
        if (new Date(scheduled.sendAt).getTime() > now) continue;

        // Skip if max attempts exceeded
        if (scheduled.attempts >= MAX_ATTEMPTS) {
          scheduled.status = 'failed';
          scheduled.lastError = 'Max retry attempts exceeded';
          await SchedulerService.writeScheduledFile(scheduled);
          result.failed += 1;
          continue;
        }

        // Acquire lock
        scheduled.status = 'sending';
        scheduled.attempts += 1;
        await SchedulerService.writeScheduledFile(scheduled);

        // Send
        const sendResult = await this.smtpService.sendEmail(scheduled.account, {
          to: scheduled.to,
          subject: scheduled.subject,
          body: scheduled.body,
          cc: scheduled.cc,
          bcc: scheduled.bcc,
          html: scheduled.html,
        });

        // Mark as sent and move to sent dir
        scheduled.status = 'sent';
        scheduled.sentAt = new Date().toISOString();
        scheduled.sentMessageId = sendResult.messageId;

        const sentPath = path.join(SCHEDULED_SENT_DIR, file);
        await fs.writeFile(sentPath, JSON.stringify(scheduled, null, 2));
        await fs.unlink(filePath);

        // Delete draft (best-effort)
        if (scheduled.draftMessageId && scheduled.draftMailbox) {
          try {
            await this.imapService.deleteEmail(
              scheduled.account,
              scheduled.draftMessageId,
              scheduled.draftMailbox,
            );
          } catch {
            // Best-effort
          }
        }

        result.sent += 1;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        result.errors.push(`${file}: ${errorMsg}`);

        // Mark as failed in the file
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          const scheduled = JSON.parse(content) as ScheduledEmail;
          scheduled.status = scheduled.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
          scheduled.lastError = errorMsg;
          await fs.writeFile(filePath, JSON.stringify(scheduled, null, 2));
        } catch {
          // If we can't even update the file, skip
        }

        result.failed += 1;
      }
    }

    return result;
  }
  /* eslint-enable no-await-in-loop, no-continue */

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private static async ensureDirs(): Promise<void> {
    await fs.mkdir(SCHEDULED_DIR, { recursive: true });
    await fs.mkdir(SCHEDULED_SENT_DIR, { recursive: true });
  }

  private static async writeScheduledFile(scheduled: ScheduledEmail): Promise<void> {
    await SchedulerService.ensureDirs();
    const filePath = path.join(SCHEDULED_DIR, `${scheduled.id}.json`);
    const signed: SignedScheduledEmail = { ...scheduled, hmacSignature: computeHmac(scheduled) };
    await fs.writeFile(filePath, JSON.stringify(signed, null, 2));
  }

  private static async readDir(dirPath: string): Promise<ScheduledEmail[]> {
    const emails: ScheduledEmail[] = [];
    try {
      const files = await fs.readdir(dirPath);
      // eslint-disable-next-line no-restricted-syntax
      for (const file of files) {
        if (!file.endsWith('.json')) continue; // eslint-disable-line no-continue
        try {
          const content = await fs.readFile(path.join(dirPath, file), 'utf-8'); // eslint-disable-line no-await-in-loop
          emails.push(JSON.parse(content) as ScheduledEmail);
        } catch {
          // Skip corrupted files
        }
      }
    } catch {
      // Directory may not exist yet
    }
    return emails;
  }
}
