/**
 * Builds a raw RFC 822 message (headers + MIME body) without sending it.
 *
 * Used so the exact same bytes that go out over SMTP can also be
 * IMAP-appended to the account's Sent mailbox — the message is composed
 * once, then reused for both, rather than re-serialized from scratch.
 */

// nodemailer ships MailComposer as an internal (CJS) module; it is not part
// of the package's public "exports" map, so it must be imported by deep path.
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

export interface MailMessageInput {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  messageId?: string;
}

/**
 * Compile mail fields into a raw MIME message buffer.
 * @param mail - Message fields, in the same shape passed to nodemailer's `sendMail`.
 * @returns The raw message as a Buffer.
 */
export async function buildRawMessage(mail: MailMessageInput): Promise<Buffer> {
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
