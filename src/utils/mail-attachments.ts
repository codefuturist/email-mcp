/**
 * Converts validated AttachmentInput objects into the attachment shape
 * expected by nodemailer's transport/MailComposer, and builds raw RFC 822
 * messages (used for appending drafts with attachments over IMAP).
 */

import fs from 'node:fs/promises';
// nodemailer ships MailComposer as an internal (CJS) module; it is not part
// of the package's public "exports" map, so it must be imported by deep path.
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { MAX_ATTACHMENT_SIZE } from '../safety/validation.js';
import type { AttachmentInput } from '../types/index.js';

export interface MailAttachment {
  filename: string;
  content?: Buffer;
  path?: string;
  contentType?: string;
}

/**
 * Resolve outgoing attachments for nodemailer, decoding base64 content and
 * verifying local file paths exist and are within the per-file size limit.
 * @param attachments - Attachments as received from the MCP tool call.
 * @returns Attachments in nodemailer's expected shape, or `undefined` if none.
 */
export async function resolveAttachments(
  attachments: AttachmentInput[] | undefined,
): Promise<MailAttachment[] | undefined> {
  if (!attachments || attachments.length === 0) return undefined;

  return Promise.all(
    attachments.map(async (att): Promise<MailAttachment> => {
      if (att.path) {
        const stat = await fs.stat(att.path).catch(() => {
          throw new Error(`Attachment "${att.filename}": file not found at path "${att.path}"`);
        });
        if (!stat.isFile()) {
          throw new Error(`Attachment "${att.filename}": path "${att.path}" is not a file`);
        }
        if (stat.size > MAX_ATTACHMENT_SIZE) {
          throw new Error(
            `Attachment "${att.filename}" (${Math.round(stat.size / 1024 / 1024)}MB) exceeds the ${MAX_ATTACHMENT_SIZE / 1024 / 1024}MB per-file limit`,
          );
        }
        return { filename: att.filename, path: att.path, contentType: att.contentType };
      }

      return {
        filename: att.filename,
        content: Buffer.from(att.content as string, 'base64'),
        contentType: att.contentType,
      };
    }),
  );
}

/**
 * Build a raw RFC 822 message (headers + MIME body/attachments) without
 * sending it, for appending directly to an IMAP folder (e.g. Drafts).
 * @param mail - Message fields, in the same shape passed to nodemailer's `sendMail`.
 * @returns The raw message as a Buffer.
 */
export async function buildRawMessage(mail: {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: MailAttachment[];
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    new MailComposer(mail).compile().build((err: Error | null, message: Buffer) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(message);
    });
  });
}
